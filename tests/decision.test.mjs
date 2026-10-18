import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS, validateEndpoint, buildDecisionRequest, parseDecisionResponse, requestDecision,
} from '../extension/decision.mjs';

const URL = 'http://127.0.0.1:18081/v1/systemone';
const observation = { speed: 120, position: { x: 1.2, y: 0 }, obstacles: [{ x: 0.5, distance: 12 }] };
const decisionResponse = (action = 'left', extra = {}) => ({ answers: { action: { choice: action, ...extra } } });
const ACTION_IDS = ['coast', 'left', 'right', 'jump', 'fly', 'dive', 'boost',
  'roll_left', 'roll_right', 'roll_left_fly', 'roll_right_fly'];
const consequencesFor = (request, id) => JSON.parse(
  request.questions.action.criteria[id].split('\n本动作的条件后果：')[1]);
const restoreUncertainty = (candidate, summary) => {
  if (!Object.hasOwn(candidate, 'uncertainty_refs')) return candidate;
  const restored = { ...candidate,
    uncertainty: candidate.uncertainty_refs.map(index => summary.uncertaintyDictionary[index]) };
  delete restored.uncertainty_refs;
  return restored;
};

test('API URL allows only explicit hosts, ports and exact protocol path', () => {
  for (const endpoint of [URL, 'http://127.0.0.1:18080/v1/systemone',
    'http://localhost:18081/v1/systemone', 'https://api.typesafe.ai/v1/systemone']) {
    assert.equal(validateEndpoint(endpoint), endpoint);
  }
  for (const endpoint of [
    'https://evil.example/v1/systemone', 'http://192.0.2.10:18081/v1/systemone',
    'http://localhost:8080/v1/systemone', 'http://api.typesafe.ai/v1/systemone',
    'https://api.typesafe.ai.evil.example/v1/systemone',
    'http://localhost:18081/other', `${URL}/`, `${URL}?key=secret`, `${URL}#fragment`,
    'http://secret@localhost:18081/v1/systemone', 'ftp://localhost:18081/v1/systemone',
  ]) assert.throws(() => validateEndpoint(endpoint));
});

test('request uses disabled thinking by default and sends real telemetry without mutating input', () => {
  const original = structuredClone(observation);
  const result = buildDecisionRequest(observation, { previousDecision: 'right', latencyMs: 325 });
  assert.equal(result.think_mode, 'never');
  assert.equal(result.think_budget, 1);
  assert.equal(result.return_details, true);
  assert.equal('model' in result, false);
  const state = JSON.parse(result.state);
  assert.deepEqual(state.telemetry, observation);
  assert.equal(state.previous_decision, 'right');
  assert.equal(state.previous_latency_ms, 325);
  assert.deepEqual(observation, original);
  assert.equal(result.questions.action.type, 'choice');
  assert.equal(result.questions.action.allow_none, false);
  assert.equal(result.allow_none, false);
  assert.equal(state.target_score, 0);
  assert.equal(state.aspiration_score, 6000);
  assert.match(state.objective, /持续驾驶.*原生游戏积分.*不按分数暂停/);
  assert.deepEqual(Object.keys(result.questions.action.criteria), ACTION_IDS);
  assert.deepEqual(Object.keys(ACTIONS), ACTION_IDS);
  assert.deepEqual(ACTIONS.fly.keys, ['Space']);
  assert.deepEqual(ACTIONS.dive.keys, ['KeyS']);
  assert.deepEqual(ACTIONS.boost.keys, ['KeyW']);
  assert.deepEqual(ACTIONS.roll_left.keys, ['KeyQ']);
  assert.deepEqual(ACTIONS.roll_right.keys, ['KeyE']);
  assert.deepEqual(ACTIONS.roll_left_fly.keys, ['KeyQ', 'Space']);
  assert.deepEqual(ACTIONS.roll_right_fly.keys, ['KeyE', 'Space']);
});

test('all consequences and confirmed transitions reach the model without ranking, filtering or mutation', () => {
  const candidates = Object.fromEntries([...ACTION_IDS].reverse().map((id, index) => [id, {
    frames: id.startsWith('roll_') ? 32 : 12,
    immediateExpectedRollPoints: id.startsWith('roll_') ? 240 : 0,
    predictedEndAir: 100 - index, risk: { unprotectedContactCount: index % 3, uncertain: true },
    uncertainty: [`Observed-only consequence for ${id}`],
  }]));
  const input = {
    ...observation, revision: 15, targetScore2000: 2000,
    confirmedHistory: [{ revision: 14, action: 'roll_left', before: { air: 80 }, after: { air: 72 } }],
    actionFacts: { horizon: 'Declared action duration only', rules: { scoring: 'native score' }, candidates },
  };
  const original = structuredClone(input);
  const request = buildDecisionRequest(input, { previousDecision: 'roll_left_fly' });
  const state = JSON.parse(request.state);
  const { actionFacts, ...originalNative } = original;
  const { actionFacts: summary, ...sentNative } = state.telemetry;
  assert.deepEqual(sentNative, originalNative);
  assert.deepEqual(summary.rules, actionFacts.rules);
  assert.equal(summary.horizon, actionFacts.horizon);
  assert.equal(Object.hasOwn(summary, 'candidates'), false);
  assert.match(summary.candidateConsequencesAt, /questions.action.criteria/);
  assert.deepEqual(state.telemetry.confirmedHistory, original.confirmedHistory);
  assert.equal(Object.hasOwn(state, 'recent_confirmed_actions'), false);
  assert.equal(state.observation_revision, 15);
  assert.equal(state.previous_decision, 'roll_left_fly');
  assert.deepEqual(input, original);
  assert.deepEqual(Object.keys(request.questions.action.criteria), ACTION_IDS);
  for (const id of ACTION_IDS) {
    assert.deepEqual(consequencesFor(request, id), candidates[id]);
  }
  assert.match(request.questions.action.instructions, /原始 choice/);
  assert.match(request.questions.action.instructions, /2000/);
  assert.match(request.questions.action.instructions, /null.*uncertain.*安全保证/);
});

test('realtime request describes continuing motion, observation age and bounded pending input without fabricating history', () => {
  const input = { ...observation, clockMode: 'realtime', epoch: 'game-3', observedAtMs: 123456,
    estimatedDecisionLatencyMs: 500,
    pendingAction: { action: 'fly', startedAtMs: 123400, durationMs: 200 },
    targetScore: 0,
    confirmedHistory: [{ action: 'left', before: { lane: 2, score: 12 }, after: { lane: 1, score: 18 } }],
  };
  const request = buildDecisionRequest(input);
  assert.deepEqual(JSON.parse(request.state).telemetry, input);
  const instructions = request.questions.action.instructions;
  assert.match(instructions, /realtime.*自然帧持续推进.*车辆继续前进/);
  assert.match(instructions, /observedAtMs.*epoch.*estimatedDecisionLatencyMs/);
  assert.match(instructions, /pendingAction.*仅保持原定输入时长后释放/);
  assert.match(instructions, /未补偿网络等待/);
  assert.match(instructions, /保护耗尽后的碰撞风险/);
  assert.doesNotMatch(instructions, /模型等待时游戏会冻结/);
  assert.doesNotMatch(instructions, /2000/);
  assert.equal(JSON.parse(request.state).target_score, 0);
  assert.equal(JSON.parse(request.state).aspiration_score, 6000);
  assert.match(instructions, /努力争取 6000 分/);
  assert.deepEqual(Object.keys(request.questions.action.criteria), ACTION_IDS);
  assert.equal(request.think_mode, 'never');
  assert.equal(request.think_budget, 1);
  assert.equal(request.questions.action.allow_none, false);
});

test('latency-aware consequences retain delayed roll availability and energy risk without local action selection', () => {
  const candidates = Object.fromEntries(ACTION_IDS.map(id => [id, {
    durationMs: id.startsWith('roll_') ? 533.333 : 200,
    rollAvailability: { requested: id.startsWith('roll_'), canStartImmediately: false,
      inputEffect: id.startsWith('roll_') ? 'insufficient-air' : 'not-requested',
      airAtApplication: 7, airMarginAboveCost: -1, expectedStartAfterMs: null },
    predictedEndAir: id.endsWith('_fly') || id === 'fly' ? 0 : 7,
    predictedLandings: [{ atMs: 120, altitude: 0, lane: 2, x: 0 }],
    risk: { unprotectedContactCount: 1, firstUnprotectedAtMs: 180,
      firstUnprotectedFromObservationMs: 680, uncertain: true },
    uncertainty: ['Waiting and execution use current visible objects; actual delay can differ.'],
  }]));
  const input = { clockMode: 'realtime', epoch: 'latency-aware-1', observedAtMs: 3000,
    estimatedDecisionLatencyMs: 500, targetScore: 0,
    pendingAction: { action: 'roll_left_fly', remainingMs: 30 },
    player: { air: 8, grounded: false, rollCombo: 2 },
    confirmedHistory: [{ action: 'roll_left_fly', before: { air: 27, rollCombo: 1, score: 100 },
      after: { air: 8, rollCombo: 2, score: 340 }, scoreDelta: 240,
      feedbackKind: 'observed-realtime-interval', includesCoastingGap: true }],
    actionFacts: { model: 'latency-aware public physics', horizon: 'estimated wait then each action',
      rules: { rolling: 'cost 8; unavailable without enough air' },
      latencyForecast: { estimatedLatencyMs: 500, simulatedLatencyMs: 500, frames: 30,
        continuedInput: { action: 'roll_left_fly', remainingMs: 30 }, edgeInputsReplayed: false,
        applicationState: { air: 7, grounded: true, rollCombo: 0 },
        risk: { unprotectedContactCount: 1, firstUnprotectedAtMs: 300, uncertain: true },
        uncertainty: ['Waiting is conditional, not an observed future.'] }, candidates },
  };
  const request = buildDecisionRequest(input);
  const state = JSON.parse(request.state);
  assert.equal(state.target_score, 0);
  assert.equal(state.aspiration_score, 6000);
  assert.deepEqual(state.telemetry.actionFacts.latencyForecast, input.actionFacts.latencyForecast);
  assert.deepEqual(state.telemetry.confirmedHistory, input.confirmedHistory);
  assert.deepEqual(Object.keys(request.questions.action.criteria), ACTION_IDS);
  for (const id of ACTION_IDS) {
    assert.deepEqual(restoreUncertainty(consequencesFor(request, id), state.telemetry.actionFacts), candidates[id]);
  }
  const instructions = request.questions.action.instructions;
  assert.match(instructions, /latencyForecast.*响应前风险.*applicationState.*预计应用时状态/);
  assert.match(instructions, /真实 observedInput\.edges 一次.*不重放历史动作/);
  assert.match(instructions, /各候选从预计应用时刻.*coveredDurationMs.*effectiveHeldDurationMs.*自然滑行.*不是已发生事实/);
  assert.doesNotMatch(instructions, /候选是旧快照立即动作|未补偿网络等待/);
  assert.match(instructions, /无喷气翻滚也能得原生积分/);
  assert.match(instructions, /至少一次翻滚所需 8 能量.*安全落地恢复机会/);
  assert.match(instructions, /rollAvailability.*忽略.*避免.*不足能量或无效输入/);
  assert.match(instructions, /predictedEndAir.*predictedLandings/);
  assert.match(instructions, /真实观测区间.*滑行.*不是即时动作奖励/);
  assert(instructions.length < 850, 'control policy should remain concise enough for low-latency decisions');
  // Unavailable choices remain in the full catalog; the model, not this
  // request builder or parser, remains responsible for its eventual choice.
  assert.deepEqual(parseDecisionResponse(decisionResponse('roll_left_fly')), { action: 'roll_left_fly' });
});

test('step mode retains its actual frozen clock semantics and score goals follow the configured value', () => {
  const step = buildDecisionRequest({ ...observation, clockMode: 'step', targetScore: 7000 });
  assert.match(step.questions.action.instructions, /step.*模型等待时游戏会冻结/);
  assert.equal(JSON.parse(step.state).target_score, 7000);
  assert.match(step.questions.action.instructions, /7000/);
  const continuous = buildDecisionRequest({ ...observation, targetScore: 7000 }, { targetScore: 0 });
  assert.equal(JSON.parse(continuous.state).target_score, 0);
  assert.doesNotMatch(continuous.questions.action.instructions, /7000|2000/);
  assert.throws(() => buildDecisionRequest({ ...observation, clockMode: 'pretend-frozen' }), /clockMode/);
  for (const targetScore of [-1, 1.5, '2000', false]) {
    assert.throws(() => buildDecisionRequest(observation, { targetScore }), /targetScore/);
  }
});

test('candidate relocation and shared uncertainty references are lossless and reduce duplicated request content', () => {
  const common = [
    'Collision responses, pickups and future spawns are not simulated. '.repeat(5),
    'Traffic extrapolates at current velocity; future braking and lane changes are uncertain. '.repeat(4),
  ];
  const candidates = Object.fromEntries(ACTION_IDS.map((id, index) => [id, {
    uniqueMarker: `consequence-only-${id}`, frames: id.startsWith('roll_') ? 32 : 12,
    predictedEndAir: index === 2 ? null : 90 - index,
    predictedEndHeight: index === 3 ? null : index,
    risk: { uncertain: true, unprotectedContactCount: index === 2 ? null : 1,
      geometricContacts: [{ protectedByCurrentAction: false, everUnprotected: true,
        firstUnprotectedAtMs: 140, atMs: 30 }] },
    uncertainty: index === 2 ? [...common, 'Missing current shield expiry for this projection.'] : [...common],
  }]));
  const input = { ...observation, clockMode: 'realtime', epoch: 2, observedAtMs: 98765,
    estimatedDecisionLatencyMs: 735, pendingAction: { action: 'roll_right', expiresAtMs: 99000 },
    confirmedHistory: [{ action: 'coast', before: { air: 0 }, after: { air: 1 } }],
    actionFacts: { horizon: 'Immediate execution from this observation only', model: 'public physical projection',
      rules: { scoring: 'native points', honesty: 'unranked complete catalog' }, candidates },
  };
  const original = structuredClone(input);
  const request = buildDecisionRequest(input);
  const state = JSON.parse(request.state);
  const summary = state.telemetry.actionFacts;
  assert.equal(Object.hasOwn(summary, 'candidates'), false);
  assert.equal(summary.model, input.actionFacts.model);
  assert.equal(summary.horizon, input.actionFacts.horizon);
  assert.deepEqual(summary.rules, input.actionFacts.rules);
  assert.match(summary.candidateConsequencesAt, /criteria/);
  for (const id of ACTION_IDS) {
    const compact = consequencesFor(request, id);
    assert.equal(Object.hasOwn(compact, 'uncertainty'), false);
    assert.deepEqual(restoreUncertainty(compact, summary), candidates[id]);
    assert.deepEqual(compact.risk, candidates[id].risk);
    assert.equal(Object.hasOwn(state.telemetry, candidates[id].uniqueMarker), false);
  }
  const { actionFacts: _originalFacts, ...nativeBefore } = input;
  const { actionFacts: _sentFacts, ...nativeSent } = state.telemetry;
  assert.deepEqual(nativeSent, nativeBefore);
  assert.deepEqual(input, original);
  const redundantRequest = {
    ...request, state: JSON.stringify({ ...state, telemetry: original }),
    questions: { action: { ...request.questions.action, criteria: Object.fromEntries(ACTION_IDS.map(id => [id,
      `${ACTIONS[id].label}：${ACTIONS[id].description}\n本动作的条件后果：${JSON.stringify(candidates[id])}`])) } },
  };
  assert(JSON.stringify(request).length < JSON.stringify(redundantRequest).length * 0.65,
    'duplicated projections and repeated uncertainty should not consume most of the request');
});

test('missing forecasts stay unknown and incomplete supplied forecasts fail instead of pruning actions', () => {
  const request = buildDecisionRequest(observation);
  for (const id of ACTION_IDS) {
    assert.match(request.questions.action.criteria[id], /unknown.*不能视为安全或零消耗/);
  }
  for (const actionFacts of [null, {}, { candidates: [] }, { candidates: { coast: {} } }, {
    candidates: Object.fromEntries(ACTION_IDS.map(id => [id, id === 'jump' ? null : {}])),
  }, {
    candidates: Object.fromEntries([...ACTION_IDS, 'locally_chosen_safe_action'].map(id => [id, {}])),
  }]) assert.throws(() => buildDecisionRequest({ ...observation, actionFacts }), /完整.*11/);
});

test('thinking, model, and previous decision settings are explicit and validated', () => {
  const result = buildDecisionRequest(observation, { thinkMode: 'auto', thinkBudget: 2048, model: ' chosen-model ' });
  assert.equal(result.think_mode, 'auto');
  assert.equal(result.think_budget, 2048);
  assert.equal(result.model, 'chosen-model');
  assert.equal(buildDecisionRequest(observation, { thinkMode: 'off', thinkBudget: 4096 }).think_budget, 1);
  for (const config of [
    { thinkMode: 'false' }, { thinkBudget: -1 }, { thinkBudget: 32769 }, { thinkBudget: NaN },
    { thinkBudget: 2.5 }, { thinkMode: 'auto', thinkBudget: 0 },
    { model: 123 }, { previousDecision: 'eval' }, { latencyMs: Infinity },
    { latencyMs: -1 },
  ]) assert.throws(() => buildDecisionRequest(observation, config));
});

test('disabled thinking retains never mode with gateway minimum budget regardless of saved off budget', () => {
  for (const thinkBudget of [undefined, 0, 4096]) {
    const disabled = buildDecisionRequest(observation, { thinkMode: 'off', thinkBudget });
    assert.equal(disabled.think_mode, 'never');
    assert.equal(disabled.think_budget, 1);
  }
  const automatic = buildDecisionRequest(observation, { thinkMode: 'auto', thinkBudget: 2048 });
  assert.equal(automatic.think_mode, 'auto');
  assert.equal(automatic.think_budget, 2048);
  assert.equal(buildDecisionRequest(observation, { thinkMode: 'auto' }).think_budget, 4096);
  assert.throws(() => buildDecisionRequest(observation, { thinkMode: 'auto', thinkBudget: 0 }), /1.*32768/);
});

test('invalid, cyclic or oversized telemetry is rejected rather than silently truncated', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  for (const invalid of [null, [], 'screenshot', { speed: NaN }, { value: undefined },
    { code: () => {} }, cyclic, { text: 'x'.repeat(65537) }]) {
    assert.throws(() => buildDecisionRequest(invalid));
  }
});

test('response parser accepts only allowlisted supported actions and finite confidence', () => {
  for (const selected of ACTION_IDS) {
    assert.deepEqual(parseDecisionResponse(decisionResponse(selected)), { action: selected });
  }
  assert.deepEqual(parseDecisionResponse(decisionResponse('left', { probability: 0.7 })),
    { action: 'left', confidence: 0.7 });
  assert.deepEqual(parseDecisionResponse(decisionResponse('right', { confidence: 0 })),
    { action: 'right', confidence: 0 });
  assert.deepEqual(parseDecisionResponse(decisionResponse('jump', { confidence: 1 })),
    { action: 'jump', confidence: 1 });
  for (const invalid of [null, {}, { action: 'left' }, { answers: { action: 'left' } },
    { answers: { action: { value: 'left' } } }, decisionResponse('eval(alert(1))'),
    decisionResponse('__proto__'), decisionResponse('brake'), decisionResponse('LEFT')]) {
    assert.throws(() => parseDecisionResponse(invalid));
  }
  for (const value of [NaN, Infinity, -0.1, 1.1, '0.8', null]) {
    assert.throws(() => parseDecisionResponse(decisionResponse('left', { confidence: value })));
    assert.throws(() => parseDecisionResponse(decisionResponse('left', { probability: value })));
  }
});

test('optional thinking telemetry is validated and preserves the raw model choice', () => {
  assert.deepEqual(parseDecisionResponse(decisionResponse('roll_right_fly', {
    details: { thought: { used: false, tokens: 0 } },
  })), { action: 'roll_right_fly', thinking: { used: false, tokens: 0 } });
  for (const thought of [null, [], { used: 0 }, { tokens: -1 }, { tokens: 1.5 }, { tokens: '0' }]) {
    assert.throws(() => parseDecisionResponse(decisionResponse('roll_left', { details: { thought } })), /思考遥测/);
  }
});

test('model provenance is taken only from a bounded server model field', () => {
  assert.deepEqual(parseDecisionResponse({ ...decisionResponse('left'), model: ' startlux-systemone ' }),
    { action: 'left', model: 'startlux-systemone' });
  for (const model of [undefined, null, 123, '', '   ', 'x'.repeat(201)]) {
    assert.deepEqual(parseDecisionResponse({ ...decisionResponse('left'), model }), { action: 'left' });
  }
});

test('transport sends one authorized JSON request and rejects redirects and credential cookies', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, URL);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(JSON.parse(options.body).think_mode, 'never');
    assert.equal(JSON.parse(options.body).think_budget, 1);
    assert.equal(JSON.parse(options.body).return_details, true);
    assert.equal(JSON.parse(options.body).allow_none, false);
    assert.equal(JSON.parse(options.body).questions.action.allow_none, false);
    return { ok: true, json: async () => decisionResponse('fly', { confidence: 0.9 }) };
  };
  assert.deepEqual(await requestDecision(URL, 'test-key', observation, {}, undefined, fetchImpl),
    { action: 'fly', confidence: 0.9 });
  assert.equal(calls, 1);
});

test('official API receives only its documented payload without local thinking extensions', async () => {
  let calls = 0;
  await requestDecision('https://api.typesafe.ai/v1/systemone', 'test-key', observation,
    { model: 'chosen-official-model', thinkMode: 'auto', thinkBudget: 1024 }, undefined,
    async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
      assert.deepEqual(Object.keys(body.questions.action).sort(), ['criteria', 'instructions', 'type']);
      assert.equal(body.model, 'chosen-official-model');
      assert.deepEqual(JSON.parse(body.state).telemetry, observation);
      return { ok: true, json: async () => decisionResponse('coast') };
    });
  assert.equal(calls, 1);
  // Pure builder retains the local compatibility-service schema.
  assert.equal(buildDecisionRequest(observation).think_mode, 'never');
});

test('reported thinking in never mode is rejected before an action is returned, with no retry', async () => {
  let calls = 0;
  await assert.rejects(requestDecision(URL, 'test-key', observation, {}, undefined, async () => {
    calls++;
    return { ok: true, json: async () => decisionResponse('roll_left', {
      details: { thought: { used: true, tokens: 2 } },
    }) };
  }), /关闭思考/);
  assert.equal(calls, 1);
});

test('HTTP failures surface once with no automatic thinking fallback', async () => {
  let calls = 0;
  await assert.rejects(requestDecision(URL, 'test-key', observation, {}, undefined, async () => {
    calls += 1;
    return { ok: false, status: 422 };
  }), /HTTP 422/);
  assert.equal(calls, 1);
});

test('malformed JSON and unknown decisions fail instead of selecting a fallback', async () => {
  await assert.rejects(requestDecision(URL, 'test-key', observation, {}, undefined, async () => ({
    ok: true, json: async () => { throw new SyntaxError('not json'); },
  })), /JSON/);
  await assert.rejects(requestDecision(URL, 'test-key', observation, {}, undefined, async () => ({
    ok: true, json: async () => decisionResponse('launchMissile'),
  })), /choice/);
});

test('invalid transport config and already cancelled requests never reach fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; };
  const controller = new AbortController();
  controller.abort();
  for (const [endpoint, key, config, signal] of [
    ['https://evil.example/v1/systemone', 'test-key', {}, undefined],
    [URL, '', {}, undefined], [URL, 'test-key\r\nInjected: value', {}, undefined],
    [URL, 'test-key', { timeoutMs: 15001 }, undefined],
    [URL, 'test-key', { timeoutMs: 249 }, undefined],
    [URL, 'test-key', {}, controller.signal],
  ]) {
    await assert.rejects(requestDecision(endpoint, key, observation, config, signal, fetchImpl));
  }
  assert.equal(calls, 0);
});

test('in-flight caller abort is forwarded without retries', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = requestDecision(URL, 'test-key', observation, {}, controller.signal,
    async (_url, { signal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        reject(new DOMException('cancelled', 'AbortError'));
      }, { once: true }));
    });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('timeout aborts fetch and returns a distinct timeout error', async () => {
  let aborted = false;
  await assert.rejects(requestDecision(URL, 'test-key', observation, { timeoutMs: 250 }, undefined,
    async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    })), { name: 'TimeoutError' });
  assert.equal(aborted, true);
});
