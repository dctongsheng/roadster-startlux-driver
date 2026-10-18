import test from 'node:test';
import assert from 'node:assert/strict';

let instance = 0;
async function setup(storedConfig, waitForConfig, withGame = false) {
  const local = { config: storedConfig }, session = {};
  const id = 'test-extension';
  const listeners = {};
  const injected = [], pageMessages = [], storageWrites = [], bridgeOps = [];
  let actions = 0;
  const area = (data, name) => ({
    async get(key) { return key === undefined ? { ...data } : { [key]: data[key] }; },
    async set(value) { storageWrites.push(name); Object.assign(data, structuredClone(value)); },
    async remove(key) { delete data[key]; },
    async setAccessLevel(options) { assert.equal(options.accessLevel, 'TRUSTED_CONTEXTS'); },
  });
  const localApi = area(local, 'local');
  if (waitForConfig) localApi.get = async key => { await waitForConfig; return { [key]: local[key] }; };
  globalThis.chrome = {
    storage: { session: area(session, 'session'), local: localApi },
    runtime: {
      id, getURL: path => `chrome-extension://${id}/${path}`,
      onMessage: { addListener: fn => { listeners.message = fn; } },
    },
    action: { async setBadgeText() {} },
    tabs: Object.fromEntries(['onRemoved', 'onUpdated', 'onActivated'].map(name => [name, { addListener() {} }])),
  };
  if (withGame) {
    const observation = () => ({ source: 'game-telemetry', clockMode: 'realtime',
      epoch: 'test-epoch', observedAtMs: 1000, revision: `native:${actions}`,
      mode: actions && !withGame.keepPlaying ? 'crashed' : 'playing', score: actions ? 50 : 0,
      distance: actions ? 10 : 0, enginePaused: false, frozen: false, player: {} });
    Object.assign(globalThis.chrome.tabs, {
      query: async () => [{ id: 42, active: true, url: 'https://roadster-rush.ai.studio/' }],
      get: async () => ({ id: 42, active: true, url: 'https://roadster-rush.ai.studio/' }),
      sendMessage: async (tab, message) => { pageMessages.push({ tab, message: structuredClone(message) }); },
    });
    globalThis.chrome.scripting = { executeScript: async request => {
      if (request.files) { injected.push(request); return []; }
      const [op] = request.args;
      bridgeOps.push(op);
      if (op === 'peekLive') return [{ result: { ok: true, live: {
        epoch: 'test-epoch', observedAtMs: Date.now(), gameTime: 1, distance: actions ? 10 : 0,
        mode: 'playing', enginePaused: false,
        player: { alive: true, grounded: true, rolling: false, lane: 2, targetLane: 2,
          rollDirection: 0, rollProgress: 0, rollQueued: 0, thrusting: false, diving: false, boosting: false },
        observedInput: { thrustRemainingMs: 0, diveRemainingMs: 0, boostRemainingMs: 0,
          edges: { left: false, right: false, thrustPressed: false, rollLeft: false, rollRight: false } },
      } } }];
      if (op === 'act') { actions++; return [{ result: { ok: true, applied: true,
        durationMs: 200, observation: observation() } }]; }
      return [{ result: { ok: true, observation: observation() } }];
    } };
  }
  const module = await import(`../extension/worker.mjs?test=${++instance}`);
  const send = (message, sender = { id, url: `chrome-extension://${id}/popup.html` }) => new Promise(resolve => {
    const async = listeners.message(message, sender, resolve);
    if (!async) return;
  });
  return { send, local, session, listeners, injected, pageMessages, storageWrites, bridgeOps,
    LivePublisher: module.LivePublisher };
}

test('worker registers synchronously while storage loads, and invalid old config can be repaired', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await setup({ endpoint: 'http://unconfigured.invalid/v1/systemone' }, gate);
  assert.equal(typeof f.listeners.message, 'function');
  release();
  const before = await f.send({ type: 'STATUS' });
  assert.equal(before.ok, true);
  assert.equal(before.config.endpoint, 'http://127.0.0.1:18080/v1/systemone');
  assert.match(before.status.error, /旧设置/);
  assert.equal((await f.send({ type: 'SAVE_CONFIG', config: { stepMs: 300 } })).ok, true);
  assert.equal((await f.send({ type: 'STATUS' })).status.error, undefined);
});

test('only the extension popup can send commands, and the key never enters persistent config or status', async () => {
  const f = await setup();
  const key = 'test-only-not-a-real-api-key';
  assert.equal((await f.send({ type: 'SAVE_CONFIG', config: { apiKey: key } }, {
    id: 'test-extension', url: 'https://roadster-rush.ai.studio/',
  })).ok, false);
  assert.equal((await f.send({ type: 'SAVE_CONFIG', config: { apiKey: key, unexpected: 'ignored' } })).ok, true);
  assert.equal(f.session.apiKey, key);
  assert.equal(f.local.config.apiKey, undefined);
  assert.equal(f.local.config.unexpected, undefined);
  const status = await f.send({ type: 'STATUS' });
  assert.equal(status.config.hasKey, true);
  assert(!JSON.stringify(status).includes(key));
  await f.send({ type: 'CLEAR_KEY' });
  assert.equal(f.session.apiKey, undefined);
});

test('initial SAVE_CONFIG with an existing session key resolves before any game state exists, including after an idle STOP', { timeout: 1000 }, async () => {
  const f = await setup();
  const key = 'existing-session-dummy-key';
  f.session.apiKey = key;
  const initial = await f.send({ type: 'STATUS' });
  assert.equal(initial.status.observation, undefined);
  assert.equal(initial.status.epoch, undefined);
  assert.equal(initial.status.decisions, undefined);
  const saved = await f.send({ type: 'SAVE_CONFIG', config: { apiKey: key,
    endpoint: 'http://127.0.0.1:18080/v1/systemone', model: '', stepMs: 200,
    maxSteps: 1000, targetScore: 0, clockMode: 'realtime', autoRetry: false,
    thinkMode: 'off', thinkBudget: 0 } });
  assert.equal(saved.ok, true);
  assert.equal(saved.config.hasKey, true);
  assert.equal(f.session.apiKey, key);
  assert.equal(saved.config.apiKey, undefined);
  assert.equal(f.pageMessages.length, 0);
  assert.equal(f.bridgeOps.length, 0);
  const stopped = await f.send({ type: 'STOP' });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.status.phase, 'stopped');
  const resaved = await f.send({ type: 'SAVE_CONFIG', config: { apiKey: key } });
  assert.equal(resaved.ok, true);
  assert.equal(resaved.config.hasKey, true);
  assert.equal(f.pageMessages.length, 0, 'no inactive session should publish LIVE data');
  assert.equal(f.bridgeOps.length, 0, 'saving or stopping an idle driver must not inspect a game');
});

test('connection test exercises the real decision protocol and returns server model without moving a game', async () => {
  const f = await setup();
  await f.send({ type: 'SAVE_CONFIG', config: { apiKey: 'test-key' } });
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:18080/v1/systemone');
    const body = JSON.parse(options.body);
    assert.equal(body.think_mode, 'never');
    assert.equal(body.think_budget, 1);
    assert.equal(JSON.parse(body.state).telemetry.source, 'connection-test');
    return { ok: true, async json() { return { model: 'server-reported-model', answers: { action: { choice: 'coast' } } }; } };
  };
  try {
    const result = await f.send({ type: 'TEST_CONNECTION' });
    assert.equal(result.ok, true);
    assert.equal(result.status.actualModel, 'server-reported-model');
    assert.equal(calls, 1);
    assert.equal(result.status.steps, 0);
  } finally { globalThis.fetch = oldFetch; }
});

test('worker restart preserves a completed run and only marks an unfinished session interrupted', async () => {
  const f = await setup();
  f.session.lastStatus = { running: false, phase: 'stopped', reason: '本局结束', observation: { mode: 'crashed', score: 22176 } };
  let result = await f.send({ type: 'STATUS' });
  assert.equal(result.status.reason, '本局结束');
  assert.equal(result.status.observation.mode, 'crashed');
  f.session.lastStatus = { running: true, phase: 'deciding', observation: { mode: 'playing' } };
  result = await f.send({ type: 'STATUS' });
  assert.equal(result.status.running, false);
  assert.match(result.status.reason, /扩展服务已重启/);
});

test('START installs an isolated page panel and streams only game status without the session key', async () => {
  const f = await setup(undefined, undefined, true);
  const key = 'test-secret-never-sent-to-page';
  await f.send({ type: 'SAVE_CONFIG', config: { apiKey: key, clockMode: 'realtime', maxSteps: 1 } });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ model: 'test-model', answers: { action: { choice: 'coast' } } }) });
  try {
    await f.send({ type: 'START' });
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setImmediate(resolve));
      if (!(await f.send({ type: 'STATUS' })).status.running) break;
    }
    assert(f.injected.some(r => r.world === 'MAIN' && r.files.includes('bridge.js')));
    assert(f.injected.some(r => r.world === 'ISOLATED' && r.files.includes('page-panel.js')));
    assert(f.pageMessages.length > 0);
    assert(f.pageMessages.every(m => m.tab === 42 && ['ROADSTER_STATUS', 'ROADSTER_LIVE'].includes(m.message.type)
      && !Object.hasOwn(m.message, 'config')));
    assert(!JSON.stringify(f.pageMessages).includes(key));
    assert.equal(f.pageMessages.filter(m => m.message.type === 'ROADSTER_STATUS').at(-1).message.status.observation.mode, 'crashed');
  } finally { globalThis.fetch = oldFetch; }
});

const settle = () => new Promise(resolve => setImmediate(resolve));
function liveFixture(LivePublisher) {
  let now = 1000, id = 0;
  const context = { active: true, tabId: 42, sessionId: 'session-1', sessionStartedAtMs: 900,
    epoch: 'epoch-1', phase: 'deciding', distance: 20,
    instruction: { request: 1, action: 'roll_left_fly', requestEpoch: 'epoch-1', appliedAtMs: 950,
      durationMs: 533.333, latencyMs: 412, confidence: .95, model: 'startlux-decision-27b-autothink',
      thinking: { used: false, tokens: 0, details: 'private-thought-marker' },
      fullResponse: 'private-response-marker' },
    model: { name: 'startlux-decision-27b-autothink', fullResponse: 'private-model-marker',
      latestResponse: { request: 2, requestEpoch: 'epoch-1', latencyMs: 621, confidence: .83,
        thinking: { used: true, tokens: 12, details: 'private-recent-thought-marker' },
        applied: false, reason: 'stale', raw: 'private-latest-response-marker' } } };
  const native = { epoch: 'epoch-1', observedAtMs: 1000, gameTime: 5, distance: 21,
    mode: 'playing', enginePaused: false, apiKey: 'private-key-marker',
    player: { alive: true, grounded: false, lane: 1, targetLane: 1, rolling: true,
      rollDirection: -1, rollProgress: .1, rollQueued: 0, thrusting: true, diving: false, boosting: false,
      unrelated: 'private-player-marker' },
    observedInput: { thrustRemainingMs: 450, diveRemainingMs: 0, boostRemainingMs: 0,
      edges: { left: false, right: false, thrustPressed: false, rollLeft: false, rollRight: false } },
    facts: 'private-facts-marker', history: 'private-history-marker' };
  const timers = new Map(), messages = [];
  let peeks = 0;
  const deps = { read: () => context, wallNow: () => now,
    peek: async () => { peeks++; return { live: structuredClone(native) }; },
    send: (_tab, message) => { messages.push(structuredClone(message)); },
    setInterval: (fn, delay) => { const handle = { id: ++id, fn, delay, unreferenced: false,
      unref() { this.unreferenced = true; } }; timers.set(handle.id, handle); return handle; },
    clearInterval: handle => timers.delete(handle.id),
  };
  const publisher = new LivePublisher(deps);
  return { publisher, deps, context, native, timers, messages, peeks: () => peeks,
    fire() { now += 100; native.observedAtMs = now; for (const timer of [...timers.values()]) timer.fn(); } };
}

test('live HUD uses 100ms nonoverlapping read-only samples with an allowlisted private-data-free envelope', async () => {
  const { LivePublisher } = await setup();
  const f = liveFixture(LivePublisher);
  let resolve;
  f.deps.peek = () => { f.peekCalls = (f.peekCalls ?? 0) + 1; return new Promise(yes => { resolve = yes; }); };
  f.publisher.sync();
  assert.equal([...f.timers.values()][0].delay, 100);
  assert.equal([...f.timers.values()][0].unreferenced, true);
  f.fire(); f.fire(); await f.publisher.poll();
  assert.equal(f.peekCalls, 1, 'an unresolved peek must not overlap another');
  assert.equal(f.messages.length, 0);
  resolve({ live: f.native }); await settle();
  assert.equal(f.messages.length, 1);
  const { live } = f.messages[0];
  assert.equal(f.messages[0].type, 'ROADSTER_LIVE');
  assert.deepEqual(Object.keys(live).sort(), ['sessionId', 'sessionStartedAtMs', 'epoch', 'seq',
    'observedAtMs', 'running', 'phase', 'instruction', 'native', 'model'].sort());
  assert.equal(live.instruction.durationMs, 533.333);
  assert.equal(live.native.player.rollDirection, -1);
  assert.equal(live.native.observedInput.thrustRemainingMs, 450);
  assert(!JSON.stringify(live).includes('private-'));
  assert.equal(Object.hasOwn(live.native, 'facts'), false);
  f.context.active = false; f.publisher.sync();
  assert.equal(f.timers.size, 0);
});

test('live model metrics keep latest response separate from the accepted instruction and only copy whitelisted scalars', async () => {
  const { LivePublisher } = await setup();
  const f = liveFixture(LivePublisher);
  f.publisher.sync(); await settle();
  const { live } = f.messages.at(-1);
  assert.deepEqual(live.model, { name: 'startlux-decision-27b-autothink',
    latestResponse: { request: 2, requestEpoch: 'epoch-1', latencyMs: 621, confidence: .83,
      thinking: { used: true, tokens: 12 } } });
  assert.deepEqual(live.instruction, { request: 1, requestEpoch: 'epoch-1',
    action: 'roll_left_fly', appliedAtMs: 950, durationMs: 533.333, latencyMs: 412,
    confidence: .95, model: 'startlux-decision-27b-autothink', thinking: { used: false, tokens: 0 } });
  assert(!JSON.stringify(live).includes('private-'));
  assert.equal(live.model.latestResponse.applied, undefined);
  assert.equal(live.model.latestResponse.reason, undefined);
  f.context.active = false; f.publisher.sync();
});

test('live telemetry rejects old-epoch response metrics and represents missing or invalid fields as unknown', async () => {
  const { LivePublisher } = await setup();
  const f = liveFixture(LivePublisher);
  f.context.model.latestResponse.requestEpoch = 'old-epoch';
  f.context.model.name = 'actual-other-model';
  Object.assign(f.context.instruction, { latencyMs: Infinity, confidence: '0.99', model: {},
    thinking: { used: 'false', tokens: NaN } });
  f.publisher.sync(); await settle();
  const { live } = f.messages.at(-1);
  assert.deepEqual(live.model, { name: 'actual-other-model', latestResponse: null });
  assert.equal(live.instruction.latencyMs, null);
  assert.equal(live.instruction.confidence, null);
  assert.equal(live.instruction.model, null);
  assert.deepEqual(live.instruction.thinking, { used: null, tokens: null });
  f.context.model = null; f.context.instruction = null; f.fire(); await settle();
  assert.deepEqual(f.messages.at(-1).live.model, { name: null, latestResponse: null });
  f.context.active = false; f.publisher.sync();
});

test('Stop clears live data immediately and discards a late poll across a new session', async () => {
  const { LivePublisher } = await setup();
  const f = liveFixture(LivePublisher);
  let resolve;
  f.deps.peek = () => new Promise(yes => { resolve = yes; });
  f.publisher.sync();
  f.context.active = false; f.context.phase = 'stopping'; f.publisher.sync();
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].live.running, false);
  assert.equal(f.messages[0].live.native, null);
  assert.equal(f.messages[0].live.instruction, null);
  assert.equal(f.timers.size, 0);
  f.context.active = true; f.context.sessionId = 'session-2'; f.context.sessionStartedAtMs = 1200;
  f.context.epoch = 'epoch-2'; f.context.distance = 0; f.publisher.sync();
  resolve({ live: f.native }); await settle();
  assert.equal(f.messages.length, 1, 'old poll completion cannot revive old native state');
  f.native.epoch = 'epoch-2'; f.native.distance = 1; f.native.gameTime = .1;
  f.deps.peek = async () => ({ live: f.native }); f.fire(); await settle();
  assert.equal(f.messages.at(-1).live.sessionId, 'session-2');
  assert.equal(f.messages.at(-1).live.epoch, 'epoch-2');
  assert.equal(f.messages.at(-1).live.instruction, null, 'old receipt cannot appear in the new epoch');
  assert(f.messages.at(-1).live.seq > f.messages[0].live.seq);
  f.context.active = false; f.publisher.sync();
});

test('time or distance rewinds suppress cached-epoch native state until the driver confirms a new epoch', async () => {
  const { LivePublisher } = await setup();
  for (const field of ['gameTime', 'distance']) {
    const f = liveFixture(LivePublisher);
    f.publisher.sync(); await settle();
    f.native[field] = 0; f.fire(); await settle();
    assert.equal(f.messages.at(-1).live.native, null);
    assert.equal(f.messages.at(-1).live.instruction, null);
    f.native.gameTime = 10; f.native.distance = 100; f.fire(); await settle();
    assert.equal(f.messages.at(-1).live.native, null, 'a rewound cached epoch stays blocked');
    f.context.epoch = f.native.epoch = 'confirmed-new-epoch'; f.context.distance = 0;
    f.context.instruction = null; f.publisher.sync(); await settle();
    assert.equal(f.messages.at(-1).live.native.epoch, 'confirmed-new-epoch');
    f.context.active = false; f.publisher.sync();
  }
});

test('driver observations advancing during an awaited peek do not masquerade as native rewind', async () => {
  const { LivePublisher } = await setup();
  const f = liveFixture(LivePublisher);
  let resolve;
  f.deps.peek = () => new Promise(yes => { resolve = yes; });
  f.publisher.sync();
  assert.equal(f.context.distance, 20);
  f.context.distance = 30;
  // This native peek is newer than the request's anchor (20), but older than
  // the driver's later observation (30). Both belong to the same live epoch.
  resolve({ live: f.native }); await settle();
  assert.equal(f.messages.at(-1).live.native.distance, 21);
  assert.equal(f.publisher.blockedEpoch, null);
  f.deps.peek = async () => ({ live: { ...f.native, distance: 31, gameTime: 6 } });
  f.fire(); await settle();
  assert.equal(f.messages.at(-1).live.native.distance, 31);
  f.context.active = false; f.publisher.sync();
});

test('unknown acquisition epochs and UI peek failures stay silent without changing driving or fabricating native data', async () => {
  const { LivePublisher } = await setup();
  const f = liveFixture(LivePublisher);
  f.native.epoch = null; f.publisher.sync(); await settle();
  assert.equal(f.messages.length, 0);
  f.deps.peek = async () => { throw new Error('page UI unavailable'); };
  f.fire(); await settle();
  assert.equal(f.messages.length, 0);
  assert.equal(f.context.active, true);
  assert.equal(f.timers.size, 1);
  f.context.active = false; f.publisher.sync();
});

test('native loss clears the HUD and its polling immediately without stopping an in-flight driver', async () => {
  const { LivePublisher } = await setup();
  const f = liveFixture(LivePublisher);
  f.publisher.sync(); await settle();
  f.native.mode = 'crashed'; f.native.player.alive = false;
  f.fire(); await settle();
  assert.equal(f.messages.at(-1).live.running, false);
  assert.equal(f.messages.at(-1).live.native, null);
  assert.equal(f.messages.at(-1).live.instruction, null);
  assert.equal(f.context.active, true, 'UI loss observation must not modify driver state');
  assert.equal(f.timers.size, 0);
  f.publisher.sync();
  assert.equal(f.timers.size, 0, 'the same terminal epoch must not restart the UI timer');
  f.context.epoch = f.native.epoch = 'auto-retried-epoch';
  f.native.mode = 'playing'; f.native.player.alive = true; f.context.instruction = null;
  f.publisher.sync(); await settle();
  assert.equal(f.timers.size, 1);
  assert.equal(f.messages.at(-1).live.running, true);
  f.context.active = false; f.publisher.sync();
});

test('actual worker LIVE sampling leaves model requests, storage writes and control bridge operations unchanged', async () => {
  const f = await setup(undefined, undefined, true);
  await f.send({ type: 'SAVE_CONFIG', config: { apiKey: 'test-key', clockMode: 'realtime', maxSteps: 1 } });
  const oldFetch = globalThis.fetch;
  let resolve, calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise(yes => { resolve = yes; });
    return { ok: true, json: async () => ({ answers: { action: { choice: 'coast' } } }) };
  };
  try {
    await f.send({ type: 'START' });
    for (let i = 0; i < 20 && !resolve; i++) await settle();
    assert.equal(calls, 1);
    await settle();
    const beforeWrites = f.storageWrites.length;
    const controlOps = f.bridgeOps.filter(op => op !== 'peekLive');
    await new Promise(yes => setTimeout(yes, 230));
    assert(f.bridgeOps.filter(op => op === 'peekLive').length >= 3);
    assert.deepEqual(f.bridgeOps.filter(op => op !== 'peekLive'), controlOps);
    assert.equal(calls, 1);
    assert.equal(f.storageWrites.length, beforeWrites);
    const stop = f.send({ type: 'STOP' });
    await settle();
    assert.equal(f.pageMessages.filter(message => message.message.type === 'ROADSTER_LIVE').at(-1).message.live.running, false);
    resolve(); await stop;
  } finally { resolve?.(); globalThis.fetch = oldFetch; }
});

test('actual worker projects server model and response metrics into LIVE without changing its next model request', async () => {
  const f = await setup(undefined, undefined, { keepPlaying: true });
  await f.send({ type: 'SAVE_CONFIG', config: { apiKey: 'test-key', clockMode: 'realtime', maxSteps: 2 } });
  const oldFetch = globalThis.fetch;
  let resolve, calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    if (calls > 1) await new Promise(yes => { resolve = yes; });
    const body = JSON.parse(options.body);
    assert.equal(body.model, undefined, 'UI branding must not introduce a model routing parameter');
    return { ok: true, json: async () => ({ model: 'startlux-decision-27b-autothink',
      answers: { action: { choice: 'coast', confidence: .97, details: { thought: { used: false, tokens: 0 } } } } }) };
  };
  try {
    await f.send({ type: 'START' });
    for (let i = 0; i < 100 && !resolve; i++) await settle();
    assert.equal(calls, 2);
    await new Promise(yes => setTimeout(yes, 120));
    const live = f.pageMessages.filter(item => item.message.type === 'ROADSTER_LIVE'
      && item.message.live.instruction).at(-1)?.message.live;
    assert(live, 'an accepted instruction should appear in the next lightweight poll');
    assert.equal(live.model.name, 'startlux-decision-27b-autothink');
    assert.equal(live.model.latestResponse.request, 1);
    assert.equal(live.model.latestResponse.confidence, .97);
    assert(Number.isFinite(live.model.latestResponse.latencyMs));
    assert.deepEqual(live.model.latestResponse.thinking, { used: false, tokens: 0 });
    assert.equal(live.instruction.model, live.model.name);
    assert.equal(live.instruction.latencyMs, live.model.latestResponse.latencyMs);
    assert.equal(calls, 2, 'telemetry must not initiate a model request');
    const stop = f.send({ type: 'STOP' }); await settle(); resolve(); await stop;
  } finally { resolve?.(); globalThis.fetch = oldFetch; }
});
