import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, Driver, validateConfig } from '../extension/driver.mjs';
import { buildDecisionRequest, validateEndpoint } from '../extension/decision.mjs';

test('saved off/zero stays compatible but automatic thinking requires a positive budget', () => {
  const defaults = validateConfig({}, validateEndpoint);
  assert.equal(defaults.thinkMode, 'off');
  assert.equal(defaults.thinkBudget, 0);
  const request = buildDecisionRequest({ source: 'regression-test' }, defaults);
  assert.equal(request.think_mode, 'never');
  assert.equal(request.think_budget, 1);
  assert.equal(validateConfig({ thinkMode: 'off', thinkBudget: 4096 }, validateEndpoint).thinkBudget, 0);
  assert.throws(() => validateConfig({ thinkMode: 'auto', thinkBudget: 0 }, validateEndpoint), /自动思考.*1.*4096/);
  assert.equal(validateConfig({ thinkMode: 'auto', thinkBudget: 4096 }, validateEndpoint).thinkBudget, 4096);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let turn = 0; turn < 100; turn++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Driver did not reach the expected lifecycle boundary.');
}

function fixture({ decisions = ['left'], crashEveryAct = false, mode = 'playing', initialScore = 0, scorePerAct = 10 } = {}) {
  const events = [];
  const snapshots = [];
  const state = { leased: false, frozen: false, mode, simMs: 0, frames: 0, score: initialScore, acted: [], decisionCalls: 0, requests: [] };
  const observation = () => ({
    source: 'game-telemetry', mode: state.mode, frozen: state.frozen,
    score: state.score, distance: state.simMs / 10, revision: `frames:${state.frames}:score:${state.score}`,
    player: { lane: 2, speed: 26, grounded: state.frames === 0, air: 100 - state.frames / 10, rollCombo: state.acted.length }, nearby: [],
  });
  const deps = {
    target: async () => { events.push('target'); return { id: 42 }; },
    install: async () => { events.push('install'); },
    checkTab: async tabId => { assert.equal(tabId, 42); events.push('check-tab'); },
    bridge: async (tabId, op, args = {}) => {
      assert.equal(tabId, 42);
      events.push(op);
      if (op === 'acquire') {
        state.leased = true;
        state.frozen = true;
        if (state.mode === 'crashed' && args.retry) { state.score = 0; state.frames = 0; state.simMs = 0; }
        if (args.start || args.retry) state.mode = 'playing';
      } else if (op === 'observe') {
        assert.equal(state.leased, true);
      } else if (op === 'act') {
        assert.equal(state.leased, true, 'must acquire before acting');
        assert.equal(state.frozen, true, 'the model should own the simulation clock');
        assert.equal(args.expectedRevision, observation().revision, 'apply only the revision the model observed');
        state.acted.push(args.action);
        state.simMs += args.stepMs;
        state.frames += Math.round(args.stepMs * 60 / 1000);
        state.score += scorePerAct;
        if (crashEveryAct) state.mode = 'crashed';
      } else if (op === 'release') {
        state.leased = false;
        state.frozen = false;
      } else {
        assert.fail(`Unexpected bridge operation: ${op}`);
      }
      return {
        ok: true, observation: observation(),
        ...(op === 'act' ? { frames: Math.round(args.stepMs * 60 / 1000), simulatedMs: args.stepMs } : {}),
      };
    },
    decide: async (_endpoint, _key, suppliedObservation) => {
      events.push('decide');
      assert.equal(suppliedObservation.frozen, true);
      state.requests.push(structuredClone(suppliedObservation));
      const action = decisions[state.decisionCalls % decisions.length];
      state.decisionCalls++;
      return { action, confidence: 0.8, model: 'actual-server-model' };
    },
    now: () => state.decisionCalls * 10,
    yield: () => new Promise(resolve => setImmediate(resolve)),
    publish: status => snapshots.push(status),
  };
  return { driver: new Driver(deps), deps, state, events, snapshots };
}

async function finish(driver, config = {}, single = false, key = 'test-only-key') {
  await driver.start({ ...DEFAULT_CONFIG, clockMode: 'step', ...config }, key, single);
  if (driver.pending) await driver.pending;
  return driver.snapshot();
}

test('simulation stays frozen with no movement while awaiting the model', async () => {
  const f = fixture();
  const answer = deferred();
  f.deps.decide = async (_endpoint, key, observation) => {
    f.events.push('decide-wait');
    assert.equal(key, 'test-only-key');
    assert.equal(observation.frozen, true);
    return answer.promise;
  };
  await f.driver.start({ ...DEFAULT_CONFIG, clockMode: 'step', maxSteps: 1 }, 'test-only-key');
  await until(() => f.events.includes('decide-wait'));
  assert.equal(f.state.leased, true);
  assert.equal(f.state.frozen, true);
  assert.equal(f.state.simMs, 0);
  assert.deepEqual(f.state.acted, []);
  answer.resolve({ action: 'fly', model: 'actual-server-model' });
  await f.driver.pending;
  assert.deepEqual(f.state.acted, ['fly']);
  assert.equal(f.state.simMs, DEFAULT_CONFIG.stepMs);
  assert.equal(f.state.leased, false);
  assert.equal(f.driver.snapshot().actualModel, 'actual-server-model');
});

test('every gameplay move matches a separate model result and the step cap is enforced', async () => {
  const f = fixture({ decisions: ['right', 'jump', 'dive'] });
  const status = await finish(f.driver, { maxSteps: 3 });
  assert.deepEqual(f.state.acted, ['right', 'jump', 'dive']);
  assert.equal(f.state.decisionCalls, 3);
  assert.equal(status.steps, 3);
  assert.equal(status.reason, '达到步数上限');
  assert.equal(status.running, false);
  assert.equal(f.events.filter(value => value === 'release').length, 1);
  assert.equal(f.state.leased, false);
});

test('Stop releases immediately and a late model result can never act', async () => {
  const f = fixture();
  const answer = deferred();
  let receivedSignal;
  f.deps.decide = async (_endpoint, _key, _observation, _config, signal) => {
    f.events.push('decide-wait');
    receivedSignal = signal;
    return answer.promise; // Deliberately emulate a transport that ignores abort.
  };
  await f.driver.start({ ...DEFAULT_CONFIG }, 'test-only-key');
  await until(() => f.events.includes('decide-wait'));
  const stopped = f.driver.stop();
  await until(() => f.events.includes('release'));
  assert.equal(receivedSignal.aborted, true);
  assert.equal(f.state.leased, false);
  answer.resolve({ action: 'boost' });
  const status = await stopped;
  assert.deepEqual(f.state.acted, []);
  assert.equal(status.steps, 0);
  assert.equal(status.running, false);
  assert.equal(status.phase, 'stopped');
  assert.equal(status.reason, '手动停止');
  assert.equal(f.driver.pending, null);
});

test('Stop during asynchronous acquisition waits and releases the newly acquired lease', async () => {
  const f = fixture();
  const acquisition = deferred();
  const originalBridge = f.deps.bridge;
  f.deps.bridge = async (tabId, op, args) => {
    if (op === 'acquire') {
      f.events.push('acquire-wait');
      await acquisition.promise;
    }
    return originalBridge(tabId, op, args);
  };
  await f.driver.start({ ...DEFAULT_CONFIG }, 'test-only-key');
  await until(() => f.events.includes('acquire-wait'));
  const stopped = f.driver.stop();
  assert.equal(f.state.leased, false);
  acquisition.resolve();
  const status = await stopped;
  assert.deepEqual(f.state.acted, []);
  assert.equal(f.state.decisionCalls, 0);
  assert.equal(f.state.leased, false);
  assert.equal(f.driver.session, null);
  assert.equal(status.phase, 'stopped');
  assert.ok(f.events.lastIndexOf('release') > f.events.lastIndexOf('acquire'),
    'the lease must be released after the pending acquisition actually finishes');
});

test('a model timeout ends the session without a heuristic or retry move', async () => {
  const f = fixture();
  let calls = 0;
  f.deps.decide = async () => {
    calls++;
    const error = new Error('decision timed out');
    error.name = 'TimeoutError';
    throw error;
  };
  const status = await finish(f.driver, { autoRetry: true, maxSteps: 10 });
  assert.equal(calls, 1);
  assert.equal(status.error, 'decision timed out');
  assert.equal(status.phase, 'error');
  assert.equal(status.steps, 0);
  assert.deepEqual(f.state.acted, []);
  assert.equal(f.state.leased, false);
});

test('acquisition failure after allocating a lease still releases the game', async () => {
  const f = fixture();
  const originalBridge = f.deps.bridge;
  f.deps.bridge = async (tabId, op, args) => {
    const result = await originalBridge(tabId, op, args);
    if (op === 'acquire') throw new Error('acquire reply failed after allocation');
    return result;
  };
  const status = await finish(f.driver);
  assert.equal(status.error, 'acquire reply failed after allocation');
  assert.equal(f.state.leased, false);
  assert.equal(f.events.filter(value => value === 'release').length, 1);
  assert.equal(f.state.decisionCalls, 0);
  assert.deepEqual(f.state.acted, []);
});

test('unknown model actions fail closed and release the game', async () => {
  const f = fixture();
  f.deps.decide = async () => ({ action: 'executeJavascript' });
  const status = await finish(f.driver);
  assert.match(status.error, /未知动作/);
  assert.deepEqual(f.state.acted, []);
  assert.equal(f.state.leased, false);
});

test('automatic game retries still consume the bounded total decision budget', async () => {
  const f = fixture({ crashEveryAct: true });
  const status = await finish(f.driver, { autoRetry: true, maxSteps: 3 });
  assert.equal(status.steps, 3);
  assert.equal(status.runs, 3);
  assert.equal(f.state.decisionCalls, 3);
  assert.equal(f.events.filter(value => value === 'acquire').length, 3);
  assert.equal(status.reason, '本局结束');
  assert.equal(f.state.leased, false);
});

test('a crash ends the session with automatic retry disabled', async () => {
  const f = fixture({ crashEveryAct: true });
  const status = await finish(f.driver, { maxSteps: 3 });
  assert.equal(status.steps, 1);
  assert.equal(status.runs, 1);
  assert.equal(f.state.decisionCalls, 1);
  assert.equal(f.events.filter(value => value === 'acquire').length, 1);
  assert.equal(status.reason, '本局结束');
  assert.equal(f.state.leased, false);
});

test('single step completes exactly one decision even when auto retry is enabled', async () => {
  const f = fixture({ crashEveryAct: true });
  const status = await finish(f.driver, { maxSteps: 50, autoRetry: true }, true);
  assert.equal(status.steps, 1);
  assert.equal(status.runs, 1);
  assert.equal(status.reason, '本局结束');
  assert.equal(f.state.leased, false);
});

test('keys and configured model names never appear as actual model or public status', async () => {
  const f = fixture();
  const key = 'unique-secret-key-must-stay-private';
  f.deps.decide = async (_endpoint, suppliedKey) => {
    assert.equal(suppliedKey, key);
    return { action: 'coast' }; // No server model provenance was returned.
  };
  const status = await finish(f.driver, { maxSteps: 1, model: 'Jev-configured-name' }, false, key);
  assert.equal(status.actualModel, '');
  assert.equal(JSON.stringify([status, ...f.snapshots]).includes(key), false);
  assert.equal(JSON.stringify([status, ...f.snapshots]).includes('Jev-configured-name'), false);
});

test('tab loss stops before requesting or applying a move and releases the lease', async () => {
  const f = fixture();
  f.deps.checkTab = async () => { throw new Error('target tab navigated'); };
  const status = await finish(f.driver);
  assert.equal(status.error, 'target tab navigated');
  assert.equal(f.state.decisionCalls, 0);
  assert.deepEqual(f.state.acted, []);
  assert.equal(f.state.leased, false);
});

test('target score is bounded and zero explicitly disables the target', () => {
  assert.equal(validateConfig({}, validateEndpoint).targetScore, 0);
  assert.equal(validateConfig({ targetScore: 0 }, validateEndpoint).targetScore, 0);
  assert.equal(validateConfig({ targetScore: 10000000 }, validateEndpoint).targetScore, 10000000);
  for (const targetScore of [-1, 0.5, 10000001, '2000', NaN]) {
    assert.throws(() => validateConfig({ targetScore }, validateEndpoint), /targetScore/);
  }
});

test('actual target achievement stops before requesting or executing another action', async () => {
  const f = fixture({ decisions: ['jump', 'fly', 'right'], scorePerAct: 1000 });
  const status = await finish(f.driver, { maxSteps: 20, targetScore: 2000, autoRetry: true });
  assert.deepEqual(f.state.acted, ['jump', 'fly']);
  assert.equal(f.state.decisionCalls, 2);
  assert.equal(status.observation.score, 2000);
  assert.equal(status.targetReached, true);
  assert.equal(status.phase, 'success');
  assert.equal(status.reason, '达到目标分数');
  assert.equal(status.running, false);
  assert.equal(f.state.leased, false);
  assert.equal(f.events.filter(value => value === 'release').length, 1);
});

test('an acquired game already at target releases without any model call or action', async () => {
  const f = fixture({ initialScore: 2056 });
  const status = await finish(f.driver, { targetScore: 2000 });
  assert.equal(f.state.decisionCalls, 0);
  assert.deepEqual(f.state.acted, []);
  assert.equal(status.targetReached, true);
  assert.equal(status.steps, 0);
  assert.equal(status.observation.score, 2056);
  assert.equal(status.reason, '达到目标分数');
  assert.equal(f.state.leased, false);
});

test('disabled target leaves the bounded model action loop running above 2000', async () => {
  const f = fixture({ scorePerAct: 2000 });
  const status = await finish(f.driver, { maxSteps: 3, targetScore: 0 });
  assert.equal(status.steps, 3);
  assert.equal(status.observation.score, 6000);
  assert.equal(status.targetReached, false);
  assert.equal(status.reason, '达到步数上限');
});

test('confirmed feedback contains only observed before/after outcomes and actual simulation duration', async () => {
  const f = fixture({ decisions: ['jump', 'fly'], scorePerAct: 40 });
  const status = await finish(f.driver, { maxSteps: 8, stepMs: 300, targetScore: 2000 });
  assert.deepEqual(f.state.requests[0].confirmedHistory, []);
  assert.equal(f.state.requests[0].targetScore, 2000);
  assert.equal(f.state.requests[0].actionStepMs, 300);
  const confirmed = f.state.requests[1].confirmedHistory;
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].action, 'jump');
  assert.equal(confirmed[0].scoreDelta, 40);
  assert.equal(confirmed[0].frames, 18);
  assert.equal(confirmed[0].durationMs, 300);
  assert.equal(confirmed[0].beforeRevision, 'frames:0:score:0');
  assert.equal(confirmed[0].afterRevision, 'frames:18:score:40');
  assert.equal(confirmed[0].before.score, 0);
  assert.equal(confirmed[0].after.score, 40);
  assert.equal(confirmed[0].before.grounded, true);
  assert.equal(confirmed[0].after.grounded, false);
  assert.equal(confirmed[0].before.rollCombo, 0);
  assert.equal(confirmed[0].after.rollCombo, 1);
  assert.equal(confirmed[0].before.air, 100);
  assert.equal(confirmed[0].after.air, 98.2);
  assert.deepEqual(f.state.requests[7].confirmedHistory.map(item => item.step), [2, 3, 4, 5, 6, 7]);
  assert.equal(status.history[0].step, 8);
  assert.equal(status.history[0].scoreDelta, 40);
  assert.deepEqual(f.state.acted, ['jump', 'fly', 'jump', 'fly', 'jump', 'fly', 'jump', 'fly']);
});

test('confirmed model feedback starts empty after a retry rather than reusing the previous run', async () => {
  const f = fixture({ crashEveryAct: true });
  const status = await finish(f.driver, { autoRetry: true, maxSteps: 3 });
  assert.equal(f.state.requests.length, 3);
  for (const request of f.state.requests) assert.deepEqual(request.confirmedHistory, []);
  assert.deepEqual(status.history.map(item => item.run), [3, 2, 1]);
});

test('a crash on the final allowed action is reported as the game ending', async () => {
  const f = fixture({ crashEveryAct: true });
  const status = await finish(f.driver, { maxSteps: 1 });
  assert.equal(status.steps, 1);
  assert.equal(status.reason, '本局结束');
  assert.equal(status.observation.mode, 'crashed');
});
