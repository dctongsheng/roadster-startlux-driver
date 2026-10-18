import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const panelSource = fs.readFileSync(new URL('../extension/page-panel.js', import.meta.url), 'utf8');
const popupSource = fs.readFileSync(new URL('../extension/popup.mjs', import.meta.url), 'utf8');

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this._text = ''; this.open = false; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get isConnected() { return Boolean(this.connected || this.parent?.isConnected); }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parent = null; }); this.children = []; this._text = ''; this.append(...nodes); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; } }
  attachShadow(options) { this.shadowOptions = options; this._shadow = new Element('#shadow-root'); this._shadow.parent = this; return this._shadow; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  click() { this.listeners.click?.(); }
}

const walk = node => [node, ...node.children.flatMap(walk), ...(node._shadow ? walk(node._shadow) : [])];
const find = (root, predicate) => walk(root).find(predicate);
const text = root => walk(root).filter(node => node.tagName !== 'style').map(node => node._text).join('\n');

function fixture(hostname = 'roadster-rush.ai.studio', { visible = true } = {}) {
  const html = new Element('html'); html.connected = true; html.scrollTop = 43;
  const head = new Element('head'); const body = new Element('body'); html.append(head, body);
  const canvas = new Element('canvas'); canvas.id = 'game'; canvas.width = 1440; canvas.height = 900;
  canvas.style = { width: '100vw', height: '100vh', position: 'fixed' };
  const hud = new Element('div'); hud.id = 'hud'; hud.style = { position: 'fixed' };
  body.append(canvas, hud);
  const messages = []; const downloads = []; const blobs = []; const scrolls = [];
  let now = 1000000; let timerId = 0;
  const timers = new Map(); const observers = [];
  const document = { documentElement: html, head, body,
    createElement: tag => {
      const node = new Element(tag);
      node.scrollIntoView = options => scrolls.push({ node, options });
      if (tag === 'a') node.click = () => downloads.push({ filename: node.download, href: node.href });
      return node;
    },
    getElementById: id => find(html, node => node.id === id),
  };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  class VisibilityObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; this.update(visible); }
    update(value) { this.callback([{ target: this.target, isIntersecting: value, intersectionRatio: value ? 1 : 0, intersectionRect: { height: value ? 200 : 0 } }]); }
  }
  const context = vm.createContext({ document, location: { hostname }, Date: ClockDate, IntersectionObserver: VisibilityObserver,
    chrome: { runtime: { id: 'our-extension', onMessage: { addListener: fn => messages.push(fn) },
      sendMessage: () => assert.fail('panel must never send a driving command') } },
    Blob,
    URL: { createObjectURL: blob => { blobs.push(blob); return `blob:test-${blobs.length}`; }, revokeObjectURL() {} },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame: () => assert.fail('panel must not own the game clock'),
    window: { scrollTo: () => assert.fail('panel must not scroll the page') },
    console,
  });
  const inject = () => vm.runInContext(panelSource, context);
  inject();
  return { document, html, body, canvas, hud, messages, downloads, blobs, scrolls, inject,
    now: () => now,
    advance(ms) {
      now += ms;
      for (let i = 0; i < 30; i++) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) return;
        const [id, timer] = due[0]; timers.delete(id); timer.fn();
      }
      assert.fail('UI timer did not settle');
    },
    visible: value => observers.forEach(observer => observer.update(value)),
    host: () => document.getElementById('roadster-extension-decision-panel'),
    liveHost: () => document.getElementById('roadster-extension-live-hud'),
    receive: (status, sender = { id: 'our-extension' }, type = 'ROADSTER_STATUS') => messages.forEach(fn => fn({ type, status }, sender)),
    live: (live, sender = { id: 'our-extension' }) => messages.forEach(fn => fn({ type: 'ROADSTER_LIVE', live }, sender)),
  };
}

function liveSample(f, override = {}) {
  const now = f.now();
  return { sessionId: 'session-1', sessionStartedAtMs: 999000, epoch: 'epoch-1', seq: 1,
    observedAtMs: now, running: true, phase: 'deciding',
    instruction: { request: 1, action: 'roll_left_fly', requestEpoch: 'epoch-1', appliedAtMs: now, durationMs: 200 },
    native: { epoch: 'epoch-1', observedAtMs: now, gameTime: 2, distance: 40, mode: 'playing', enginePaused: false,
      player: { alive: true, grounded: true, rolling: false, rollDirection: 0, rollQueued: 0, thrusting: false, diving: false, boosting: false },
      observedInput: { thrustRemainingMs: 0, diveRemainingMs: 0, boostRemainingMs: 0, edges: { left: false, right: false, thrustPressed: false, rollLeft: false, rollRight: false } } },
    ...override };
}

function sample(decisions = []) {
  return { running: true, clockMode: 'realtime', epoch: 'epoch-1', requests: decisions.length, steps: decisions.length,
    staleResponses: 0, latencyMs: 401, actualModel: 'actual-model', aspirationScore: 6000,
    observation: { mode: 'playing', score: 321, distance: 12.345 },
    realtimeMetrics: { gameToWallRatio: 1.001 }, decisions, history: [] };
}

test('panel preserves a full fixed viewport and native clock, enabling only root scrolling below it', () => {
  const f = fixture();
  assert.equal(f.canvas.width, 1440); assert.equal(f.canvas.height, 900);
  assert.deepEqual(f.canvas.style, { width: '100vw', height: '100vh', position: 'fixed' });
  assert.deepEqual(f.hud.style, { position: 'fixed' }); assert.equal(f.html.scrollTop, 43);
  assert.equal(f.body.children[0], f.canvas); assert.equal(f.body.children[1], f.hud);
  assert.equal(f.host().shadowOptions.mode, 'closed');
  assert.equal(f.host().attributes['data-ui'], 'roadster-decision-records');
  let blocked = false;
  f.host()._shadow.listeners.keydown({ stopPropagation() { blocked = true; } });
  assert.equal(blocked, true, 'panel keyboard disclosure must not become a game input');
  const rootStyle = f.document.getElementById('roadster-extension-scroll-style').textContent;
  assert.match(rootStyle, /overflow-y:auto/); assert.doesNotMatch(rootStyle, /width:|height:|position:/);
  const panelStyle = find(f.host(), node => node.tagName === 'style').textContent;
  assert.match(panelStyle, /top:100vh/); assert.match(panelStyle, /z-index:20/);
  assert.equal(f.messages.length, 1);
  f.inject(); assert.equal(f.messages.length, 1, 'reinjection must not duplicate listeners or panels');
  assert.equal(walk(f.html).filter(node => node.id === f.host().id).length, 1);
});

test('only own-extension status messages render; hostile text is literal and details remain lazy', () => {
  const f = fixture();
  const d = { request: 1, requestEpoch: 'epoch-1', action: '<img src=x onerror=attack()>', applied: true, confidence: 0.8, latencyMs: 401 };
  f.receive(sample([d]), { id: 'foreign-extension' });
  assert.ok(!text(f.host()).includes(d.action));
  f.receive(sample([d]), { id: 'our-extension' }, 'START');
  assert.ok(!text(f.host()).includes(d.action));
  f.receive(sample([d]));
  const record = find(f.host(), node => node.tagName === 'details');
  assert.ok(record); assert.equal(find(record, node => node.className === 'detail-body').children.length, 0);
  assert.ok(text(f.host()).includes(d.action)); assert.equal(walk(f.host()).filter(node => node.tagName === 'img').length, 0);
  record.open = true; record.listeners.toggle();
  assert.match(text(record), /实际模型[\s\S]*未知/);
  assert.match(text(record), /未知（未记录该时刻状态）/);
  assert.match(text(record), /未记录该候选预测/);
  assert.match(text(f.host()), /6,000/);
});

test('expanded receipts show recorded states, forecast unknowns and a later real outcome without inventing reasoning', () => {
  const f = fixture();
  const d = { request: 1, step: 1, run: 1, requestEpoch: 'epoch-1', action: 'roll_left_fly', applied: true,
    confidence: 0.25, model: 'model-1', latencyMs: 377, snapshotAgeMs: 380,
    requestObservation: { score: 10, air: 100, rollCombo: 0, lane: 2 },
    appliedObservation: { score: 15, air: 100, rollCombo: 0, lane: 2 },
    predictionSummary: { predictedEndHeight: null, risk: { uncertain: true }, rollAvailability: 'unknown' },
    latencyForecast: { expectedDistanceAhead: 10, uncertainty: 'snapshot-only' }, pendingAtRequest: null };
  const s = sample([d]); f.receive(s);
  const record = find(f.host(), node => node.tagName === 'details'); record.open = true; record.listeners.toggle();
  assert.match(text(record), /model-1/); assert.match(text(record), /"risk"[\s\S]*"uncertain": true/);
  assert.match(text(record), /"predictedEndHeight": null/); assert.match(text(record), /尚未确认/);
  s.history = [{ step: 1, run: 1, before: { score: 15, air: 100, rollCombo: 0 }, after: { score: 95, air: 83, rollCombo: 1 }, scoreDelta: 80, observedIntervalMs: 420, durationMs: 533, inputInterrupted: true, includesCoastingGap: false }];
  f.receive(s);
  assert.equal(find(f.host(), node => node.tagName === 'details'), record, 'keep an expanded record node');
  assert.match(text(record), /真实观察区间：后/); assert.match(text(record), /"score": 95/);
  assert.match(text(record), /实际分差[\s\S]*80/);
  assert.match(text(record), /不展示或编造模型思维过程/);
});

test('latest 200 records are bounded, local clearing never sends commands, and export excludes configuration or secrets', async () => {
  const f = fixture();
  const decisions = Array.from({ length: 240 }, (_, i) => ({ request: 240 - i, requestEpoch: 'epoch-1', action: 'coast', applied: true, model: 'actual-model' }));
  const s = sample(decisions); s.requests = 240;
  s.config = { apiKey: 'secret-config' }; s.apiKey = 'secret-top';
  s.decisions[0].authorization = 'secret-nested';
  f.receive(s);
  assert.equal(walk(f.host()).filter(node => node.tagName === 'details').length, 200);
  const clear = find(f.host(), node => node.tagName === 'button' && node.textContent === '清理页面显示'); clear.click();
  assert.equal(walk(f.host()).filter(node => node.tagName === 'details').length, 0);
  const exportButton = find(f.host(), node => node.tagName === 'button' && node.textContent === '导出本局记录'); exportButton.click();
  assert.equal(f.downloads.length, 1); assert.match(f.downloads[0].filename, /^roadster-realtime-run-/);
  const json = await f.blobs[0].text(); const record = JSON.parse(json);
  assert.equal(record.status.decisions.length, 200, 'clearing the display preserves export data');
  assert.ok(!json.includes('secret-')); assert.equal(Object.hasOwn(record, 'config'), false);
  assert.equal(Object.hasOwn(record.status, 'config'), false);
  s.requests = 241; s.decisions.unshift({ request: 241, requestEpoch: 'epoch-1', action: 'fly', applied: true }); f.receive(s);
  assert.equal(walk(f.host()).filter(node => node.tagName === 'details').length, 1);
  assert.match(text(f.host()), /#241/);
});

test('unrelated hosts install no panel or messaging bridge', () => {
  const f = fixture('example.com'); assert.equal(f.host(), undefined); assert.equal(f.messages.length, 0);
});

test('stale native collision labels are hidden while playing and retained only for an ended game', () => {
  const f = fixture();
  const s = sample(); s.observation.crashWhat = 'hatch';
  f.receive(s);
  assert.equal(find(f.host(), node => node.className === 'status').textContent.includes('hatch'), false);
  assert.match(text(f.host()), /已提交动作/);
  for (const mode of ['crashed', 'gameover']) {
    s.observation.mode = mode; f.receive(s);
    assert.match(find(f.host(), node => node.className === 'status').textContent, /hatch/);
  }
});

test('unapplied receipts label response-time state and blank model metadata as unknown', () => {
  const f = fixture();
  const s = sample([{ request: 1, requestEpoch: 'epoch-1', action: 'coast', applied: false, reason: 'game-ended', model: '' }]);
  s.actualModel = '   '; f.receive(s);
  const toggle = find(f.host(), node => node.tagName === 'input' && node.type === 'checkbox');
  toggle.checked = true; toggle.listeners.change();
  assert.match(text(f.host()), /实际模型：未知/);
  const record = find(f.host(), node => node.tagName === 'details'); record.open = true; record.listeners.toggle();
  assert.match(text(record), /响应返回时真实状态/);
  assert.ok(!text(record).includes('执行时真实状态'));
  assert.match(text(record), /实际模型[\s\S]*未知/);
});

async function popupFixture({ rejectStart = false, initialStatus = {} } = {}) {
  const nodes = new Map(); let closed = 0; const operations = [];
  const document = { body: new Element('body'), createElement: tag => new Element(tag), getElementById(id) {
    if (!nodes.has(id)) {
      const node = new Element('input'); node.value = ''; node.checked = false;
      node.options = [{ value: 'http://127.0.0.1:18080/v1/systemone' }];
      node.classList = { toggle() {} }; node.reportValidity = () => true; nodes.set(id, node);
    }
    return nodes.get(id);
  } };
  vm.runInNewContext(popupSource, { document, window: { close() { closed++; }, addEventListener() {} },
    chrome: { runtime: { sendMessage: async ({ type }) => {
      operations.push(type);
      if (rejectStart && type === 'START') return { ok: false, error: 'start failed' };
      return { ok: true, config: { hasKey: true }, status: { running: type === 'START', clockMode: type === 'STEP' ? 'step' : 'realtime', ...initialStatus } };
    } } }, URL, Blob, setInterval() {}, clearInterval() {}, setTimeout() {} });
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, operations, closed: () => closed };
}

test('popup closes only after acknowledged START, leaving STEP and failed START visible', async () => {
  const ok = await popupFixture(); ok.nodes.get('start').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ok.closed(), 1); assert.deepEqual(ok.operations.slice(-2), ['SAVE_CONFIG', 'START']);
  const failed = await popupFixture({ rejectStart: true }); failed.nodes.get('start').click();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(failed.closed(), 0);
  const step = await popupFixture(); step.nodes.get('step').click();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(step.closed(), 0); assert.equal(step.operations.at(-1), 'STEP');
});

test('popup suppresses native stale collision names in playing state but preserves terminal collision names', async () => {
  const playing = await popupFixture({ initialStatus: { observation: { mode: 'playing', crashWhat: 'hatch' } } });
  assert.equal(playing.nodes.get('telemetry-status').textContent, '游戏状态：playing');
  for (const mode of ['crashed', 'gameover']) {
    const ended = await popupFixture({ initialStatus: { observation: { mode, crashWhat: 'hatch' } } });
    assert.equal(ended.nodes.get('telemetry-status').textContent, `游戏状态：${mode} · 碰撞：hatch`);
  }
});

test('HUD highlights the actual StartLux model and accepted instruction response metrics', () => {
  const f = fixture(undefined, { visible: false });
  const first = liveSample(f);
  first.model = { name: 'startlux-decision-27b-autothink', latestResponse: {
    request: 2, requestEpoch: 'epoch-1', latencyMs: 999, confidence: .9, thinking: { used: true, tokens: 42 },
  } };
  first.instruction = { ...first.instruction, model: 'startlux-decision-27b-autothink', latencyMs: 735,
    confidence: .293, thinking: { used: false, tokens: 0 } };
  f.live(first);
  const node = name => find(f.liveHost(), value => value.className === name);
  assert.equal(node('model-name').textContent, 'StartLux');
  assert.equal(node('model-size').textContent, '27B');
  assert.equal(node('response-latency').textContent, '735ms', 'newer unsubmitted response cannot replace accepted instruction metrics');
  assert.equal(node('response-parameters').textContent, ' · 置信29% · 思考关');
  assert.match(node('response-stats').title, /当前已接受指令/);
  assert.match(node('response-stats').title, /不表示动作成功率/);
  f.advance(200);
  assert.equal(node('command').textContent, '决策中');
  assert.equal(node('response-latency').textContent, '上次999ms');
  assert.match(node('response-stats').title, /最近响应/);
  assert.equal(node('card compact').children.length > 0, true);
});

test('HUD never invents confirmed StartLux identity, confidence, thinking or latency', () => {
  const f = fixture(undefined, { visible: false });
  const first = liveSample(f);
  f.live(first);
  const node = name => find(f.liveHost(), value => value.className === name);
  assert.equal(node('model-name').textContent, '模型待确认');
  assert.equal(node('response-latency').textContent, '—ms');
  assert.equal(node('response-parameters').textContent, ' · 置信未知 · 思考未知');
  f.live({ ...first, seq: 2, instruction: { ...first.instruction, model: 'other-model', latencyMs: -1,
    confidence: null, thinking: { used: true, tokens: 200 } } });
  assert.equal(node('model-name').textContent, 'other-model');
  assert.equal(node('model-size').textContent, '');
  assert.equal(node('response-latency').textContent, '—ms');
  assert.equal(node('response-parameters').textContent, ' · 置信未知 · 思考开');
  f.live({ ...first, seq: 3, model: { name: 'newer-unsubmitted-model', latestResponse: null } });
  assert.equal(node('model-name').textContent, '模型待确认', 'a valid receipt without model identity must not borrow a newer response model');
});

test('HUD excludes old-epoch response metrics while keeping the active session model truthful', () => {
  const f = fixture(undefined, { visible: false });
  f.live(liveSample(f, { instruction: null, model: { name: 'startlux-decision-27b-autothink',
    latestResponse: { request: 99, requestEpoch: 'previous-epoch', latencyMs: 876, confidence: .8, thinking: { used: false, tokens: 0 } } } }));
  assert.equal(find(f.liveHost(), value => value.className === 'response-latency').textContent, '—ms');
  assert.equal(find(f.liveHost(), value => value.className === 'command').textContent, '决策中');
  assert.ok(!text(f.liveHost()).includes('876ms'));
});

test('HUD receipt expires on its own absolute duration without replaying identical status updates', () => {
  const f = fixture(undefined, { visible: false });
  const first = liveSample(f); f.live(first);
  const command = find(f.liveHost(), node => node.className === 'command');
  assert.equal(f.liveHost().hidden, false); assert.match(command.textContent, /指令 左翻滚并喷气/);
  f.advance(190);
  f.live({ ...first, seq: 2, observedAtMs: f.now() });
  assert.match(command.textContent, /指令 左翻滚并喷气/);
  f.advance(10);
  assert.equal(command.textContent, '决策中', 'new messages must not restart the accepted receipt lifetime');
  assert.equal(find(f.liveHost(), node => node.className === 'card compact').children.length > 0, true);
  f.advance(300);
  assert.equal(f.liveHost().hidden, true, 'an unrefreshed live envelope cannot keep claiming to run');
});

test('HUD uses accepted duration rather than the 1500 ms API age limit and accepts a new identical action receipt', () => {
  const f = fixture(undefined, { visible: false });
  const first = liveSample(f, { instruction: { request: 1, action: 'fly', requestEpoch: 'epoch-1', appliedAtMs: f.now(), durationMs: 50, requestObservedAtMs: f.now() - 1490 } });
  f.live(first); f.advance(50);
  const command = find(f.liveHost(), node => node.className === 'command');
  assert.equal(command.textContent, '决策中');
  f.live({ ...first, seq: 2, observedAtMs: f.now(), instruction: { ...first.instruction, request: 2, appliedAtMs: f.now() } });
  assert.equal(command.textContent, '指令 喷气飞行');
  f.advance(50); assert.equal(command.textContent, '决策中');
});

test('HUD rejects foreign senders, old sessions, retired epochs, old sequences and backwards timestamps', () => {
  const f = fixture(undefined, { visible: false });
  const first = liveSample(f); f.live(first, { id: 'foreign-extension' }); assert.equal(f.liveHost().hidden, true);
  f.live({ ...first, seq: 2 });
  const command = find(f.liveHost(), node => node.className === 'command');
  f.live({ ...first, seq: 1, instruction: { ...first.instruction, action: 'right' } });
  assert.equal(command.textContent, '指令 左翻滚并喷气');
  const newer = { ...first, sessionId: 'session-2', sessionStartedAtMs: first.sessionStartedAtMs + 1,
    epoch: 'epoch-2', seq: 3, instruction: { ...first.instruction, action: 'right', requestEpoch: 'epoch-2' }, native: null };
  f.live(newer); assert.equal(command.textContent, '指令 向右换道');
  f.live({ ...first, seq: 99 }); assert.equal(command.textContent, '指令 向右换道');
  f.live({ ...newer, epoch: 'epoch-3', seq: 4, instruction: { ...newer.instruction, action: 'left', requestEpoch: 'epoch-3' } });
  f.live({ ...newer, seq: 5 }); assert.equal(command.textContent, '指令 向左换道');
  f.live({ ...newer, epoch: 'epoch-3', seq: 6, observedAtMs: f.now() - 1 });
  assert.equal(command.textContent, '指令 向左换道');
});

test('HUD physical state keeps its independent native direction and never treats a pending edge as successful rolling', () => {
  const f = fixture(undefined, { visible: false });
  const first = liveSample(f);
  first.instruction.action = 'roll_right_fly';
  first.native.player.rolling = true; first.native.player.rollDirection = -1;
  first.native.observedInput.thrustRemainingMs = 180;
  f.live(first);
  const command = find(f.liveHost(), node => node.className === 'command');
  const vehicle = find(f.liveHost(), node => node.className === 'vehicle');
  assert.equal(command.textContent, '指令 右翻滚并喷气');
  assert.equal(vehicle.textContent, '车辆 左翻滚中 · 喷气保持');
  const idleNative = { ...first.native, player: { ...first.native.player, rolling: false, thrusting: false, air: 0 },
    observedInput: { ...first.native.observedInput, thrustRemainingMs: 0, edges: { rollRight: true } } };
  f.live({ ...first, seq: 2, native: idleNative });
  assert.ok(!vehicle.textContent.includes('翻滚中'), 'edge pending or low energy does not establish a physical roll');
  f.live({ ...first, seq: 3, native: { ...idleNative, player: { ...idleNative.player, rollQueued: 1 } } });
  assert.equal(vehicle.textContent, '车辆 右翻滚排队');
});

test('HUD expires stale native labels independently and does not end physical rolling with the instruction timer', () => {
  const f = fixture(undefined, { visible: false });
  const first = liveSample(f);
  first.instruction.durationMs = 50;
  first.native.player.rolling = true; first.native.player.rollDirection = -1;
  f.live(first); f.advance(50);
  assert.equal(find(f.liveHost(), node => node.className === 'command').textContent, '决策中');
  assert.match(find(f.liveHost(), node => node.className === 'vehicle').textContent, /左翻滚中/);
  assert.ok(find(f.liveHost(), node => node.className === 'card compact'), 'physical rolling cannot extend the current instruction card');
  f.live({ ...first, seq: 2, observedAtMs: f.now(), instruction: { ...first.instruction, request: 2, appliedAtMs: f.now(), durationMs: 533 } });
  f.advance(250);
  assert.equal(find(f.liveHost(), node => node.className === 'vehicle').textContent, '车辆 未知');
  assert.equal(f.liveHost().hidden, false, 'fresh instruction can remain after the native snapshot expires');
  f.live({ ...first, seq: 3, observedAtMs: f.now(), native: { epoch: 'epoch-1', observedAtMs: f.now(), mode: 'playing' }, instruction: null });
  assert.equal(find(f.liveHost(), node => node.className === 'card compact').children.length > 0, true);
});

test('Stop and natural end hide the HUD and late same-epoch packets cannot resurrect it', () => {
  for (const stop of ['stop', 'crash']) {
    const f = fixture(undefined, { visible: false });
    const first = liveSample(f); f.live(first);
    const ended = stop === 'stop' ? { ...first, seq: 2, running: false, native: null, instruction: null }
      : { ...first, seq: 2, native: { ...first.native, mode: 'crashed' } };
    f.live(ended); assert.equal(f.liveHost().hidden, true);
    f.live({ ...first, seq: 1 }); assert.equal(f.liveHost().hidden, true);
    f.live({ ...first, seq: 3 }); assert.equal(f.liveHost().hidden, true);
  }
});

test('offscreen lower history defers DOM while retaining fresh exports and default submitted-only filtering', async () => {
  const f = fixture(undefined, { visible: false });
  const s = sample([{ request: 2, action: 'fly', applied: false, reason: 'stale-observation' }, { request: 1, action: 'coast', applied: true }]);
  f.receive(s);
  assert.equal(walk(f.host()).filter(node => node.tagName === 'details').length, 0);
  const exportButton = find(f.host(), node => node.tagName === 'button' && node.textContent === '导出本局记录'); exportButton.click();
  const exported = JSON.parse(await f.blobs.at(-1).text());
  assert.equal(exported.status.decisions.length, 2); assert.equal(exported.status.decisions[0].reason, 'stale-observation');
  f.visible(true);
  assert.equal(walk(f.host()).filter(node => node.tagName === 'details').length, 1);
  assert.ok(!text(f.host()).includes('#2'));
  const toggle = find(f.host(), node => node.tagName === 'input' && node.type === 'checkbox'); toggle.checked = true; toggle.listeners.change();
  assert.equal(walk(f.host()).filter(node => node.tagName === 'details').length, 2);
});

test('HUD stays outside contained lower history, adapts narrowly, and scrolls only after the explicit details click', () => {
  const f = fixture(undefined, { visible: false });
  f.live(liveSample(f));
  assert.equal(f.liveHost().parent, f.body); assert.notEqual(f.liveHost().parent, f.host());
  const style = find(f.liveHost(), node => node.tagName === 'style').textContent;
  assert.match(style, /width:200px/); assert.match(style, /right:16px;top:140px/);
  assert.match(style, /font-size:16px/); assert.match(style, /font-size:11px/);
  assert.match(style, /\.command\{[^}]*color:#67dbf6/);
  assert.match(style, /\.vehicle\{[^}]*color:#c5d2dd/);
  assert.match(style, /top:5px;width:48px;height:20px/);
  assert.match(style, /\.hud-header\{height:18px/);
  assert.match(style, /\.compact \.detail-full\{display:none\}/);
  assert.match(find(f.liveHost(), node => node.className === 'detail-full').textContent, /详情 ↓/);
  assert.match(text(f.liveHost()), /模型待确认/);
  assert.match(style, /\.compact \.vehicle,\.compact \.model-size,\.compact \.response-parameters\{display:none\}/);
  assert.match(style, /max-width:640px/); assert.match(style, /height:32px/);
  assert.match(style, /pointer-events:none/); assert.match(style, /width:24px;height:28px/);
  assert.ok(!style.includes('animation:') && !style.includes('backdrop-filter') && !style.includes('transition:'));
  assert.equal(f.scrolls.length, 0);
  const button = find(f.liveHost(), node => node.tagName === 'button'); button.click();
  assert.equal(f.scrolls.length, 1); assert.equal(f.scrolls[0].node, f.host());
  assert.equal(f.scrolls[0].options.block, 'start');
  assert.equal(f.liveHost().attributes['data-ui'], 'roadster-live-receipt');
  let stopped = false; f.liveHost()._shadow.listeners.keydown({ stopPropagation() { stopped = true; } }); assert.equal(stopped, true);
  f.visible(true); assert.equal(f.liveHost().hidden, true, 'do not cover the expanded lower records');
});

test('a new STATUS epoch immediately clears the HUD and retires old LIVE traffic before the next sample', () => {
  const f = fixture(undefined, { visible: false });
  const first = liveSample(f); f.live(first); assert.equal(f.liveHost().hidden, false);
  f.advance(1);
  f.receive({ ...sample(), sessionId: first.sessionId, sessionStartedAtMs: first.sessionStartedAtMs, epoch: 'epoch-2', observation: { mode: 'playing', epoch: 'epoch-2', observedAtMs: f.now() } });
  assert.equal(f.liveHost().hidden, true);
  f.live({ ...first, seq: 99, observedAtMs: f.now() }); assert.equal(f.liveHost().hidden, true);
  f.live({ ...first, seq: 100, observedAtMs: f.now(), epoch: 'epoch-2', native: null,
    instruction: { ...first.instruction, action: 'right', requestEpoch: 'epoch-2', appliedAtMs: f.now() } });
  assert.equal(f.liveHost().hidden, false);
  assert.equal(find(f.liveHost(), node => node.className === 'command').textContent, '指令 向右换道');
});

test('stopped STATUS latches the old epoch even against higher-sequence LIVE, while a true new-epoch retry unlocks it', () => {
  const f = fixture(undefined, { visible: false });
  const first = liveSample(f); f.live(first);
  const status = { ...sample(), sessionId: first.sessionId, sessionStartedAtMs: first.sessionStartedAtMs,
    epoch: first.epoch, observation: { epoch: first.epoch, observedAtMs: f.now(), mode: 'playing' } };
  f.receive({ ...status, running: false }); assert.equal(f.liveHost().hidden, true);
  f.live({ ...first, seq: 99 }); assert.equal(f.liveHost().hidden, true);
  f.receive({ ...status, running: true });
  f.live({ ...first, seq: 100 }); assert.equal(f.liveHost().hidden, true);
  f.receive({ ...status, running: true, epoch: 'epoch-2', observation: { ...status.observation, epoch: 'epoch-2' } });
  f.live({ ...first, seq: 101, epoch: 'epoch-2', native: null, instruction: { ...first.instruction, requestEpoch: 'epoch-2' } });
  assert.equal(f.liveHost().hidden, false);
});

test('fresh native lane changes and physical dive/boost are shown independently from held input, bounded to three items', () => {
  const f = fixture(undefined, { visible: false });
  const first = liveSample(f);
  first.native.player.lane = 2; first.native.player.targetLane = 1;
  first.native.player.diving = true; first.native.player.boosting = true;
  f.live(first);
  const vehicle = find(f.liveHost(), node => node.className === 'vehicle');
  assert.equal(vehicle.textContent, '车辆 向左换道中 · 俯冲中 · 加速中');
  const second = { ...first, seq: 2, native: { ...first.native, player: { ...first.native.player, targetLane: 3 },
    observedInput: { ...first.native.observedInput, thrustRemainingMs: 150, diveRemainingMs: 150, boostRemainingMs: 150 } } };
  f.live(second);
  assert.equal(vehicle.textContent, '车辆 向右换道中 · 喷气保持 · 俯冲保持');
  assert.equal(vehicle.textContent.split(' · ').length, 3);
});
