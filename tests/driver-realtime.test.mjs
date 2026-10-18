import test from 'node:test';
import assert from 'node:assert/strict';
import { Driver, DEFAULT_CONFIG, validateConfig } from '../extension/driver.mjs';
import { validateEndpoint } from '../extension/decision.mjs';

function deferred() {
  let resolve; const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Missing expected async boundary');
}
function fixture() {
  let wall = 1000;
  const state = { mode: 'playing', paused: false, score: 0, distance: 0, epoch: 'run-1', acquired: false, acted: [], requests: [] };
  const obs = () => ({ source: 'game-telemetry', clockMode: 'realtime', epoch: state.epoch,
    observedAtMs: wall, revision: `${wall}:${state.score}`, mode: state.mode,
    enginePaused: state.paused, frozen: false, score: state.score, distance: state.distance,
    player: { air: 100, lane: 2, grounded: true, rollCombo: 0 },
    realtimeMetrics: { wallElapsedMs: wall - 1000, gameElapsedMs: wall - 1000, gameToWallRatio: 1 },
  });
  const deps = {
    target: async () => ({ id: 1 }), install: async () => {}, checkTab: async () => {},
    now: () => wall, yield: () => new Promise(resolve => setImmediate(resolve)),
    bridge: async (_tab, op, args = {}) => {
      if (op === 'acquire') {
        assert.equal(args.clockMode, 'realtime'); state.acquired = true;
        if (state.mode === 'crashed') { state.mode = 'playing'; state.score = 0; state.epoch += '-retry'; }
      } else if (op === 'release') state.acquired = false;
      else if (op === 'act') {
        assert(!Object.hasOwn(args, 'expectedRevision'), 'real-time state is allowed to move');
        if (args.expectedEpoch !== state.epoch) return { ok: true, applied: false, reason: 'stale-epoch', observation: obs() };
        if (wall - args.observedAtMs > args.maxAgeMs) return { ok: true, applied: false, reason: 'stale-observation', observation: obs() };
        state.acted.push(args.action);
        return { ok: true, applied: true, frames: null, durationMs: args.action.startsWith('roll_') ? 533.333 : args.stepMs, observation: obs() };
      }
      return { ok: true, observation: obs() };
    },
    decide: async (_endpoint, _key, observation) => {
      state.requests.push(structuredClone(observation));
      return { action: 'roll_left', model: 'actual-model', confidence: .7 };
    },
  };
  return { driver: new Driver(deps), deps, state, obs,
    advance(ms) { wall += ms; if (state.mode === 'playing' && !state.paused) { state.score += ms / 10; state.distance += ms / 40; } },
  };
}
async function run(f, config = {}) {
  await f.driver.start({ ...DEFAULT_CONFIG, maxSteps: 1, ...config }, 'test-key');
  await f.driver.pending;
  return f.driver.snapshot();
}

test('real-time is the default and observation age bounds are explicit', () => {
  const c = validateConfig({}, validateEndpoint);
  assert.equal(c.clockMode, 'realtime'); assert.equal(c.maxDecisionAgeMs, 1500);
  assert.equal(validateConfig({ clockMode: 'step' }, validateEndpoint).clockMode, 'step');
  for (const input of [{ clockMode: 'unknown' }, { maxDecisionAgeMs: 0 }, { maxDecisionAgeMs: 5001 }]) {
    assert.throws(() => validateConfig(input, validateEndpoint));
  }
});

test('native motion continues during an unresolved decision and release leaves the game running', async () => {
  const f = fixture(), answer = deferred();
  f.deps.decide = async (_url, _key, observation) => { f.state.requests.push(observation); return answer.promise; };
  await f.driver.start({ ...DEFAULT_CONFIG, maxSteps: 1 }, 'test-key');
  await until(() => f.state.requests.length === 1);
  f.advance(800);
  assert.equal(f.obs().distance, 20); assert.equal(f.obs().frozen, false);
  answer.resolve({ action: 'roll_left', model: 'actual-model' });
  await f.driver.pending;
  assert.deepEqual(f.state.acted, ['roll_left']);
  assert.equal(f.driver.snapshot().steps, 1);
  assert.equal(f.state.acquired, false); assert.equal(f.state.paused, false);
  f.advance(100); assert.equal(f.obs().distance, 22.5);
});

test('stale responses are discarded and a fresh request is made without a replacement move', async () => {
  const f = fixture(); let calls = 0;
  f.deps.decide = async (_url, _key, observation) => {
    f.state.requests.push(observation); f.advance(++calls === 1 ? 1600 : 100);
    return { action: calls === 1 ? 'fly' : 'right', model: 'actual-model' };
  };
  const s = await run(f, { maxSteps: 2 });
  assert.deepEqual(f.state.acted, ['right']); assert.equal(s.staleResponses, 1);
  assert.equal(s.requests, 2); assert.equal(s.steps, 1);
  assert.equal(s.decisions[1].reason, 'stale-observation');
  assert(f.state.requests[1].observedAtMs > f.state.requests[0].observedAtMs);
});

test('a new game epoch invalidates the response even within its time budget', async () => {
  const f = fixture();
  f.deps.decide = async () => { f.state.epoch = 'new-run'; f.advance(100); return { action: 'fly' }; };
  const s = await run(f);
  assert.deepEqual(f.state.acted, []); assert.equal(s.decisions[0].reason, 'stale-epoch');
});

test('a natural crash during inference is captured without executing the late decision', async () => {
  const f = fixture();
  f.deps.decide = async () => { f.advance(500); f.state.mode = 'crashed'; return { action: 'roll_left' }; };
  const s = await run(f);
  assert.equal(s.reason, '本局结束'); assert.equal(s.observation.mode, 'crashed');
  assert.equal(s.observation.score, 50); assert.equal(s.steps, 0);
  assert.deepEqual(f.state.acted, []); assert.equal(s.decisions[0].reason, 'game-ended');
});

test('Stop aborts control ownership and a late model response cannot drive or pause the game', async () => {
  const f = fixture(), answer = deferred(); let waiting = false;
  f.deps.decide = async () => { waiting = true; return answer.promise; };
  await f.driver.start({ ...DEFAULT_CONFIG }, 'test-key');
  await until(() => waiting);
  const stopping = f.driver.stop();
  await until(() => !f.state.acquired);
  f.advance(400); answer.resolve({ action: 'fly' }); await stopping;
  assert.deepEqual(f.state.acted, []); assert.equal(f.state.paused, false);
  assert.equal(f.obs().distance, 10); assert.equal(f.driver.snapshot().reason, '手动停止');
});

test('feedback is observed after real time advances, and pending input reaches the next request', async () => {
  const f = fixture(); let calls = 0;
  f.deps.decide = async (_url, _key, observation) => {
    f.state.requests.push(structuredClone(observation)); f.advance(++calls === 1 ? 100 : 300);
    return { action: calls === 1 ? 'roll_left_fly' : 'coast', model: 'actual-model' };
  };
  const s = await run(f, { maxSteps: 2 });
  assert.equal(f.state.requests[0].clockMode, 'realtime');
  assert.deepEqual(f.state.requests[0].confirmedHistory, []);
  assert.equal(f.state.requests[1].pendingAction.action, 'roll_left_fly');
  const previous = s.history.find(h => h.step === 1);
  assert.equal(previous.before.score, 10); assert.equal(previous.after.score, 40);
  assert.equal(previous.feedbackKind, 'observed-realtime-interval');
  assert.equal(previous.observedIntervalMs, 300); assert.equal(previous.inputInterrupted, true);
  assert.equal(previous.frames, null); assert.equal(previous.scoreDelta, 30);
  const receipt = s.decisions.find(d => d.step === 1);
  assert.equal(receipt.requestObservation.score, 0);
  assert.equal(receipt.appliedObservation.score, 10);
  assert.equal(receipt.outcome.scoreDelta, 30);
  assert.equal(receipt.confidence, null);
  assert.equal(receipt.model, 'actual-model');
});

test('a native restart discards pending old-run feedback and isolates confirmed history', async () => {
  const f = fixture(); let calls = 0;
  f.deps.decide = async (_url, _key, observation) => {
    f.state.requests.push(structuredClone(observation)); ++calls;
    f.advance(100);
    if (calls === 2) { f.state.epoch = 'new-run'; f.state.score = 0; f.state.distance = 0; }
    return { action: 'roll_left', model: 'actual-model' };
  };
  const s = await run(f, { maxSteps: 3 });
  assert.equal(s.runs, 2);
  assert.deepEqual(f.state.requests[2].confirmedHistory, []);
  assert.equal(f.state.requests[2].pendingAction, null);
  assert.equal(s.decisions[1].reason, 'stale-epoch');
  assert.equal(s.history.some(h => h.run === 1 && h.after.score === 0), false);
});

test('automatic retry works when the car crashes while a model request is in flight', async () => {
  const f = fixture(); let calls = 0;
  f.deps.decide = async () => {
    f.advance(100); if (++calls === 1) f.state.mode = 'crashed';
    return { action: 'left', model: 'actual-model' };
  };
  const s = await run(f, { maxSteps: 2, autoRetry: true });
  assert.equal(s.runs, 2); assert.equal(calls, 2);
  assert.deepEqual(f.state.acted, ['left']);
});

test('each START has distinct UI session identity and monotonically increasing stable start time', async () => {
  const f = fixture();
  let serial = 0;
  f.deps.wallNow = () => 5000;
  f.deps.createSessionId = () => `ui-session-${++serial}`;
  const first = await run(f);
  assert.equal(first.sessionId, 'ui-session-1');
  assert.equal(first.sessionStartedAtMs, 5000);
  const second = await run(f);
  assert.equal(second.sessionId, 'ui-session-2');
  assert.equal(second.sessionStartedAtMs, 5001);
  for (const payload of f.state.requests) {
    assert.equal(Object.hasOwn(payload, 'sessionId'), false);
    assert.equal(Object.hasOwn(payload, 'sessionStartedAtMs'), false);
  }
});

test('HUD receipts use actual bridge duration and native application time without altering model observations or input timing', async () => {
  const f = fixture();
  const bridge = f.deps.bridge;
  let call = 0;
  f.deps.decide = async (_url, _key, observation) => {
    f.state.requests.push(structuredClone(observation));
    f.advance(100);
    return { action: ++call === 1 ? 'fly' : 'coast', model: 'actual-model' };
  };
  f.deps.bridge = async (...args) => {
    const result = await bridge(...args);
    if (args[1] === 'act' && result.applied) result.appliedAtMs = result.observation.observedAtMs - 2;
    return result;
  };
  const s = await run(f, { maxSteps: 2 });
  const receipt = s.decisions.find(item => item.step === 1);
  assert.equal(receipt.appliedAtMs, 1098);
  assert.equal(receipt.durationMs, 200);
  // The native timestamp is new UI receipt metadata only. Keep the previous
  // observation-derived pending timing and the model request shape unchanged.
  assert.equal(f.state.requests[1].pendingAction.appliedAtMs, 1100);
  assert.equal(f.state.requests[1].pendingAction.remainingMs, 200);
  assert.equal(Object.hasOwn(f.state.requests[1], 'sessionId'), false);
  assert.deepEqual(f.state.acted, ['fly', 'coast']);
  assert.deepEqual(Object.keys(f.state.requests[0]).sort(), ['source', 'clockMode', 'epoch', 'observedAtMs',
    'revision', 'mode', 'enginePaused', 'frozen', 'score', 'distance', 'player', 'realtimeMetrics',
    'targetScore', 'actionStepMs', 'estimatedDecisionLatencyMs', 'pendingAction', 'confirmedHistory'].sort());
});
