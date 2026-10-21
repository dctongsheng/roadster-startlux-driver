import { ACTIONS, requestDecision, validateEndpoint } from './decision.mjs';
import { DEFAULT_CONFIG, validateConfig, Driver } from './driver.mjs';
import { readLocalKey } from './local-env.mjs';

const GAME_ORIGIN = 'https://roadster-rush.ai.studio';
let configWarning = '';
let config = { ...DEFAULT_CONFIG };
async function restoreLocalKey(explicit = false) {
  const session = await chrome.storage.session.get('apiKey');
  if (session.apiKey) return;
  const { localEnvDisabled } = await chrome.storage.local.get('localEnvDisabled');
  if (localEnvDisabled && !explicit) return;
  const apiKey = await readLocalKey(chrome.runtime);
  if (!apiKey) return;
  await chrome.storage.session.set({ apiKey, apiKeySource: 'env' });
  if (explicit) await chrome.storage.local.remove('localEnvDisabled');
}
const configReady = (async () => {
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const { config } = await chrome.storage.local.get('config');
  try { return validateConfig({ ...DEFAULT_CONFIG, ...config }, validateEndpoint); }
  catch {
    configWarning = '旧设置无效，已恢复默认值；请重新保存接口设置。';
    return { ...DEFAULT_CONFIG };
  }
})().then(async saved => { config = saved; await restoreLocalKey(); }).catch(() => {
  configWarning = '无法读取旧设置，已使用默认值；请重新保存接口设置。';
});
let persisted = Promise.resolve();
const isGame = url => { try { return new URL(url).origin === GAME_ORIGIN; } catch { return false; } };
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;
const shortText = value => typeof value === 'string' && value.length <= 200 ? value : null;

const compactThinking = value => ({ used: boolean(value?.used), tokens: finite(value?.tokens) });
function compactModel(value, epoch) {
  const response = value?.latestResponse;
  return {
    name: shortText(value?.name) || null,
    latestResponse: response?.requestEpoch === epoch ? {
      request: finite(response.request), requestEpoch: shortText(response.requestEpoch),
      latencyMs: finite(response.latencyMs), confidence: finite(response.confidence),
      thinking: compactThinking(response.thinking),
    } : null,
  };
}

function compactNative(value) {
  if (!value || typeof value !== 'object') return null;
  const player = value.player ?? {}, input = value.observedInput ?? {};
  return {
    epoch: shortText(value.epoch), observedAtMs: finite(value.observedAtMs),
    gameTime: finite(value.gameTime), distance: finite(value.distance),
    mode: shortText(value.mode), enginePaused: boolean(value.enginePaused),
    player: {
      ...Object.fromEntries(['alive', 'grounded', 'rolling', 'thrusting', 'diving', 'boosting']
        .map(key => [key, boolean(player[key])])),
      ...Object.fromEntries(['lane', 'targetLane', 'rollDirection', 'rollProgress', 'rollQueued']
        .map(key => [key, finite(player[key])])),
    },
    observedInput: {
      ...Object.fromEntries(['thrustRemainingMs', 'diveRemainingMs', 'boostRemainingMs']
        .map(key => [key, finite(input[key])])),
      edges: Object.fromEntries(['left', 'right', 'thrustPressed', 'rollLeft', 'rollRight']
        .map(key => [key, boolean(input.edges?.[key])])),
    },
  };
}

/** Independent UI telemetry only: no model calls, driver snapshots or storage. */
export class LivePublisher {
  constructor(deps) {
    this.deps = deps;
    this.generation = 0;
    this.seq = 0;
    this.timer = null;
    this.key = null;
    this.context = null;
    this.busy = false;
    this.baseline = null;
    this.blockedEpoch = null;
    this.terminal = false;
  }
  identity(context) {
    return context?.active && context.sessionId && context.epoch && context.tabId
      ? `${context.sessionId}:${context.tabId}:${context.epoch}` : null;
  }
  send(context, native, instruction, running = context.active) {
    if (!context?.tabId || !context.sessionId) return;
    const live = {
      sessionId: context.sessionId, sessionStartedAtMs: context.sessionStartedAtMs,
      epoch: context.epoch ?? null, seq: ++this.seq,
      observedAtMs: this.deps.wallNow?.() ?? Date.now(),
      running: Boolean(running), phase: context.phase,
      instruction, native, model: compactModel(context.model, context.epoch),
    };
    try { Promise.resolve(this.deps.send(context.tabId, { type: 'ROADSTER_LIVE', live })).catch(() => {}); }
    catch { /* An unavailable panel must not affect driving. */ }
  }
  sync() {
    const context = this.deps.read();
    const key = this.identity(context);
    if (key === this.key) return;
    const previous = this.context;
    ++this.generation;
    if (this.timer !== null) (this.deps.clearInterval ?? clearInterval)(this.timer);
    this.timer = null;
    this.key = key;
    this.context = context ? { ...context } : null;
    this.baseline = null;
    this.blockedEpoch = null;
    this.terminal = false;
    if (previous?.active) this.send({ ...previous, phase: context?.phase ?? 'stopped' }, null, null, false);
    if (!key) return;
    this.timer = (this.deps.setInterval ?? setInterval)(() => { void this.poll(); }, 100);
    this.timer?.unref?.();
    void this.poll();
  }
  async poll() {
    if (this.busy || !this.key || this.terminal) return;
    const generation = this.generation;
    const key = this.key;
    const context = { ...this.deps.read() };
    if (this.identity(context) !== key) { this.sync(); return; }
    this.busy = true;
    try {
      const reply = await this.deps.peek(context.tabId);
      if (generation !== this.generation || key !== this.key) return;
      const latest = this.deps.read();
      if (this.identity(latest) !== key) { this.sync(); return; }
      const native = compactNative(reply?.live);
      // A peek never creates an epoch. During acquisition, unknown native
      // identity stays silent and the panel's freshness guard hides old data.
      if (!native?.epoch || native.observedAtMs === null) return;
      const rewound = (a, b) => a !== null && b !== null && a + .001 < b;
      if (native.epoch !== latest.epoch
        || rewound(native.gameTime, this.baseline?.gameTime ?? null)
        || rewound(native.distance, this.baseline?.distance ?? null)
        // Only compare a peek with state sampled before that peek started.
        // The driver can advance its observation while this IPC is pending.
        || rewound(native.distance, finite(context.distance))) this.blockedEpoch = latest.epoch;
      if (this.blockedEpoch === latest.epoch) {
        this.send(latest, null, null);
        return;
      }
      if (['crashed', 'gameover'].includes(native.mode) || native.player.alive === false) {
        // Clear the UI as soon as native loss is observed, even if a model
        // request is still pending. This never stops the driver or its HTTP.
        this.send(latest, null, null, false);
        this.terminal = true;
        if (this.timer !== null) (this.deps.clearInterval ?? clearInterval)(this.timer);
        this.timer = null;
        return;
      }
      this.baseline = { gameTime: native.gameTime, distance: native.distance };
      const receipt = latest.instruction;
      const instruction = native.mode === 'playing' && native.enginePaused === false
        && receipt?.requestEpoch === latest.epoch && Object.hasOwn(ACTIONS, receipt.action)
        ? { request: finite(receipt.request), action: receipt.action, requestEpoch: receipt.requestEpoch,
          appliedAtMs: finite(receipt.appliedAtMs), durationMs: finite(receipt.durationMs),
          latencyMs: finite(receipt.latencyMs), confidence: finite(receipt.confidence),
          model: shortText(receipt.model) || null, thinking: compactThinking(receipt.thinking) } : null;
      this.send(latest, native, instruction);
    } catch { /* Keep driving; the panel hides data after its freshness limit. */ }
    finally { this.busy = false; }
  }
}

function publishToPage(status) {
  // The isolated script receives game telemetry only. Config and session keys
  // are never sent to a website or to the page's MAIN JavaScript world.
  if (status.tabId) chrome.tabs.sendMessage(status.tabId, { type: 'ROADSTER_STATUS', status }).catch(() => {});
}

async function bridge(tabId, op, args = {}) {
  const result = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: (operation, options) => {
      const adapter = window.__ROADSTER_DECISION_BRIDGE__;
      if (!adapter) return { ok: false, error: '游戏适配器未加载。' };
      return adapter.command(operation, options);
    }, args: [op, args],
  });
  const reply = result?.[0]?.result;
  if (!reply?.ok) throw new Error(reply?.error || '无法读取游戏，请等待加载完成后重试。');
  return reply;
}

async function checkTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isGame(tab.url)) throw new Error('目标页面已离开 Roadster Rush，已停止。');
  if (!tab.active) throw new Error('游戏标签页已切换，已暂停驾驶。');
}

const driver = new Driver({
  target: async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !isGame(tab.url)) throw new Error('请先切换到 Roadster Rush 游戏标签页。');
    return tab;
  },
  checkTab,
  install: async tabId => {
    await Promise.all([
      chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['facts.js', 'bridge.js'] }),
      chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: ['page-panel.js'] }),
    ]);
    publishToPage(driver.snapshot());
  },
  bridge, decide: requestDecision, now: () => performance.now(),
  yield: () => new Promise(resolve => setTimeout(resolve, 0)),
  publish: status => {
    // A compact session snapshot survives worker restarts. Keys and observations
    // are not put in local persistent storage; no game state goes to the page UI.
    persisted = persisted.then(() => chrome.storage.session.set({ lastStatus: status })).catch(() => {});
    chrome.action.setBadgeText({ text: status.running ? 'ON' : '' }).catch(() => {});
    publishToPage(status);
    livePublisher.sync();
  },
});

const livePublisher = new LivePublisher({
  read: () => {
    // Read selected scalars directly; the 100 ms loop never deep-clones the
    // driver's histories, candidate forecasts, model inputs or response data.
    const status = driver.status;
    const epoch = shortText(status.observation?.epoch);
    const instruction = status.decisions?.find(receipt => receipt.applied === true && receipt.requestEpoch === epoch);
    const latestResponse = status.decisions?.[0]?.requestEpoch === epoch ? status.decisions[0] : null;
    return {
      active: Boolean(status.running && status.clockMode === 'realtime' && driver.session?.tabId && epoch),
      tabId: driver.session?.tabId ?? status.tabId,
      sessionId: status.sessionId, sessionStartedAtMs: status.sessionStartedAtMs,
      epoch, phase: status.phase, distance: status.observation?.distance,
      instruction: instruction ? { request: instruction.request, action: instruction.action,
        requestEpoch: instruction.requestEpoch, appliedAtMs: instruction.appliedAtMs,
        durationMs: instruction.durationMs, latencyMs: instruction.latencyMs,
        confidence: instruction.confidence, model: instruction.model,
        thinking: compactThinking(instruction.thinking) } : null,
      model: { name: latestResponse?.model || status.actualModel || null,
        latestResponse: latestResponse ? { request: latestResponse.request,
          requestEpoch: latestResponse.requestEpoch, latencyMs: latestResponse.latencyMs,
          confidence: latestResponse.confidence, thinking: compactThinking(latestResponse.thinking) } : null },
    };
  },
  peek: tabId => bridge(tabId, 'peekLive'),
  send: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
});

async function publicConfig() {
  const { apiKey } = await chrome.storage.session.get('apiKey');
  const { apiKeySource } = await chrome.storage.session.get('apiKeySource');
  return { ...config, hasKey: !!apiKey, keySource: apiKey ? apiKeySource === 'env' ? 'env' : 'session' : null };
}

async function handle(message) {
  // Register listeners synchronously: extension service workers cannot use
  // top-level await. Individual messages wait for settings initialization.
  await configReady;
  if (!message || typeof message.type !== 'string') throw new Error('无效的扩展消息。');
  switch (message.type) {
    case 'STATUS': {
      let status = driver.snapshot();
      if (!driver.pending && !status.tabId) {
        const { lastStatus } = await chrome.storage.session.get('lastStatus');
        if (lastStatus) status = lastStatus.running
          ? { ...lastStatus, running: false, phase: 'stopped', reason: lastStatus.clockMode === 'realtime'
            ? '扩展服务已重启；输入会自动到期，原游戏继续运行'
            : '扩展服务已重启；游戏看门狗会暂停旧会话' }
          : lastStatus;
      }
      if (configWarning && !status.error) status.error = configWarning;
      return { ok: true, status, config: await publicConfig() };
    }
    case 'SAVE_CONFIG': {
      if (driver.status.running || driver.pending) throw new Error('请先停止驾驶，再修改连接配置。');
      const next = validateConfig({ ...config, ...message.config }, validateEndpoint);
      const key = message.config?.apiKey;
      if (key !== undefined && key !== '') {
        if (typeof key !== 'string' || key.length > 8192 || /[\r\n]/.test(key)) throw new Error('API Key 格式无效。');
        await chrome.storage.session.set({ apiKey: key.trim(), apiKeySource: 'session' });
      }
      await restoreLocalKey(true);
      config = next;
      configWarning = '';
      await chrome.storage.local.set({ config });
      return { ok: true, config: await publicConfig() };
    }
    case 'CLEAR_KEY':
      await driver.stop();
      await chrome.storage.session.remove('apiKey');
      await chrome.storage.session.remove('apiKeySource');
      await chrome.storage.local.set({ localEnvDisabled: true });
      return { ok: true, config: await publicConfig() };
    case 'START':
    case 'STEP': {
      const { apiKey } = await chrome.storage.session.get('apiKey');
      const status = await driver.start({ ...config }, apiKey, message.type === 'STEP');
      return { ok: !status.error, status, ...(status.error ? { error: status.error } : {}) };
    }
    case 'STOP': return { ok: true, status: await driver.stop() };
    case 'TEST_CONNECTION': {
      if (driver.status.running || driver.pending) throw new Error('请先停止驾驶，再测试接口。');
      const { apiKey } = await chrome.storage.session.get('apiKey');
      const started = performance.now();
      const decision = await requestDecision(config.endpoint, apiKey, {
        source: 'connection-test', mode: 'playing', score: 0, distance: 0,
        player: { lane: 2, targetLane: 2, speed: 26, x: 0, y: 0, z: 0, grounded: true, air: 1 },
        vehicles: [], hazards: [], pickups: [],
        note: '接口测试用的虚拟空旷道路，本次结果不执行游戏动作。',
      }, config);
      const status = { ...driver.snapshot(), latencyMs: Math.round(performance.now() - started), actualModel: decision.model || '', phase: 'connection-ok', error: null };
      Object.assign(driver.status, status);
      driver.publish();
      return { ok: true, status, model: decision.model || '', latencyMs: status.latencyMs };
    }
    default: throw new Error('未知扩展消息。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's popup can command the driver. No website message API.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) {
    sendResponse({ ok: false, error: '仅允许扩展控制面板调用。' });
    return false;
  }
  handle(message).then(sendResponse, error => sendResponse({ ok: false, error: error.message || '操作失败。' }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => { if (driver.status.tabId === tabId) driver.stop().catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (driver.status.tabId === tabId && (change.status === 'loading' || (change.url && !isGame(change.url)))) driver.stop().catch(() => {});
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (driver.status.running && driver.status.tabId !== tabId) driver.stop().catch(() => {});
});
