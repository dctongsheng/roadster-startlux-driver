import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../extension/facts.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {} });
vm.runInContext(source, context);
const describe = observation => JSON.parse(JSON.stringify(context.window.__ROADSTER_FACTS__.describe(observation)));
const IDS = ['coast', 'left', 'right', 'jump', 'fly', 'dive', 'boost',
  'roll_left', 'roll_right', 'roll_left_fly', 'roll_right_fly'];
const base = () => ({ distance: 0, chain: 0, chainTimer: 0, actionStepMs: 200,
  player: { x: 0, y: 0, z: 0, vy: 0, vx: 0, speed: 26, baseSpeed: 26,
    air: 100, lane: 2, targetLane: 2, grounded: true, supportY: 0,
    rollCombo: 0, rollProgress: 0, rollQueued: 0 }, nearby: [] });

test('every candidate is retained in fixed order with declared controls and horizons', () => {
  const facts = describe(base());
  assert.deepEqual(Object.keys(facts.candidates), IDS);
  assert.equal(facts.candidates.coast.frames, 12);
  for (const id of IDS.slice(7)) assert.equal(facts.candidates[id].frames, 32);
  assert.equal(facts.candidates.roll_left.controls.rollEdge, -1);
  assert.equal(facts.candidates.roll_right.controls.rollEdge, 1);
  assert.equal(facts.candidates.roll_left.controls.thrust, false);
  assert.equal(facts.candidates.roll_left_fly.controls.thrust, true);
  assert.equal(facts.candidates.roll_right_fly.controls.thrust, true);
  assert.equal('recommendedAction' in facts, false);
  assert.equal('bestAction' in facts, false);
});

test('forecasts are pure and macro duration is independent of normal decision interval', () => {
  const observation = base(); observation.actionStepMs = 1000;
  const before = structuredClone(observation);
  const facts = describe(observation);
  assert.deepEqual(observation, before);
  assert.equal(facts.candidates.coast.frames, 60);
  assert.equal(facts.candidates.roll_left_fly.frames, 32);
  assert.equal(facts.candidates.roll_left_fly.durationMs, 533.333);
});

test('roll scoring follows air combo and post-trick chain multiplier symmetrically', () => {
  const observation = base();
  let facts = describe(observation);
  for (const id of IDS.slice(7)) assert.equal(facts.candidates[id].immediateExpectedRollPoints, 80);
  observation.player.grounded = false; observation.player.y = 4;
  observation.player.rollCombo = 2; observation.chain = 2; observation.chainTimer = 3;
  facts = describe(observation);
  for (const id of IDS.slice(7)) {
    assert.equal(facts.candidates[id].immediateExpectedRollPoints, 720);
    assert.equal(facts.candidates[id].predictedEndCombo, 3);
  }
  observation.player.multiplierTimer = 4;
  assert.equal(describe(observation).candidates.roll_right_fly.immediateExpectedRollPoints, 1440);
});

test('roll forecast accounts for energy and active-roll queuing without fabricating an immediate reward', () => {
  const observation = base(); observation.player.air = 7;
  let facts = describe(observation);
  assert.equal(facts.candidates.roll_left.immediateExpectedRollPoints, 0);
  assert.equal(facts.candidates.roll_right.immediateExpectedRollPoints, 0);
  observation.player.air = 60; observation.player.grounded = false;
  observation.player.y = 5; observation.player.rolling = true;
  observation.player.rollProgress = .6; observation.player.rollCombo = 2;
  observation.chain = 2; observation.chainTimer = 3;
  facts = describe(observation);
  assert.equal(facts.candidates.roll_left_fly.immediateExpectedRollPoints, 0);
  assert.equal(facts.candidates.roll_left_fly.expectedRollPointsDuringAction, 720);
  assert.equal(facts.candidates.roll_left_fly.expectedRollEvents[0].combo, 3);
});

test('flight roll predicts actual flat-ground control physics, not a score mutation', () => {
  const candidate = describe(base()).candidates.roll_left_fly;
  assert.equal(candidate.predictedEndHeight, 4.792);
  assert.equal(candidate.predictedEndAir, 81.333);
  assert.equal(candidate.predictedAirCost, 18.667);
  assert.equal(candidate.predictedEndLane, 1);
  assert.equal(candidate.immediateExpectedRollPoints, 80);
  assert.deepEqual(candidate.risk.geometricContacts, []);
});

test('sign collision envelope includes player height, all lanes, and roll protection', () => {
  const observation = base();
  observation.nearby = [{ category: 'hazard', kind: 'overhead-sign', x: 0, y: 0,
    z: -4, distanceAhead: 4, minCollisionY: 6.95, maxCollisionY: 11.1, spansAllLanes: true }];
  assert.deepEqual(describe(observation).candidates.coast.risk.geometricContacts, []);
  observation.player.y = 6; observation.player.grounded = false; observation.player.vy = 3;
  let facts = describe(observation);
  assert.equal(facts.candidates.coast.risk.geometricContacts[0].category, 'overhead');
  assert(facts.candidates.coast.risk.unprotectedContactCount > 0);
  assert.equal(facts.candidates.roll_left_fly.risk.geometricContacts[0].protectedByCurrentAction, true);
  assert.equal(facts.candidates.roll_left_fly.risk.unprotectedContactCount, 0);
  observation.player.x = -7.2; observation.player.lane = observation.player.targetLane = 0;
  facts = describe(observation);
  assert.equal(facts.candidates.coast.risk.geometricContacts[0].category, 'overhead');
});

test('missing telemetry produces explicit unknown forecasts while preserving every action', () => {
  const facts = describe({ player: {}, nearby: [] });
  assert.deepEqual(Object.keys(facts.candidates), IDS);
  for (const candidate of Object.values(facts.candidates)) {
    assert.equal(candidate.predictedEndHeight, null);
    assert.equal(candidate.immediateExpectedRollPoints, null);
    assert(candidate.uncertainty[0].includes('Missing player fields'));
  }
});

test('a protected first sign contact still reports later contact after grace expires', () => {
  const observation = base();
  Object.assign(observation.player, { z: -141, y: 8, vy: 0, grounded: false, graceTimer: .05 });
  observation.nearby = [{ category: 'hazard', kind: 'overhead-sign', x: 0, y: 0,
    z: -145, distanceAhead: 4, minCollisionY: 6.95, maxCollisionY: 11.1, spansAllLanes: true }];
  const contact = describe(observation).candidates.coast.risk.geometricContacts[0];
  assert.equal(contact.atMs, 50);
  assert(contact.firstUnprotectedAtMs > contact.atMs);
  assert.equal(contact.everUnprotected, true);
  assert.equal(contact.protectedByCurrentAction, false);
  assert.equal(describe(observation).candidates.coast.risk.unprotectedContactCount, 1);
});

test('carrier ramp support marks unimplemented launch consequences unknown for affected controls', () => {
  const observation = base();
  Object.assign(observation.player, { y: 1.29, supportY: 1.29 });
  observation.nearby = [{ category: 'ground-traffic', kind: 'carrier', lane: 2, x: 0, y: 0,
    z: -8.5, distanceAhead: 8.5, speed: 5, width: 2.6, height: 3.6, length: 17,
    roofY: 3.6, ramp: { length: 6, height: 3.6 } }];
  const facts = describe(observation);
  const coast = facts.candidates.coast;
  for (const key of ['predictedEndHeight', 'predictedEndVerticalSpeed', 'predictedGrounded',
    'predictedEndAir', 'predictedAirCost', 'predictedEndCombo']) assert.equal(coast[key], null);
  assert.equal(coast.risk.trajectoryUncertain, true);
  assert.equal(coast.risk.unprotectedContactCount, null);
  assert(coast.uncertainty.some(message => message.includes('automatic ramp launch')));
  // Jumping before support/climbing does not use the omitted ramp-launch path.
  assert.equal(typeof facts.candidates.roll_left_fly.predictedEndHeight, 'number');
  assert.deepEqual(Object.keys(facts.candidates), IDS);
});

test('a distant or laterally unrelated ramp does not make every forecast unknown', () => {
  for (const [x, z] of [[0, -100], [7.2, -8.5]]) {
    const observation = base();
    observation.nearby = [{ category: 'ground-traffic', kind: 'carrier', lane: x === 0 ? 2 : 4,
      x, y: 0, z, distanceAhead: -z, speed: 5, width: 2.6, height: 3.6, length: 17,
      roofY: 3.6, ramp: { length: 6, height: 3.6 } }];
    const facts = describe(observation);
    for (const id of ['coast', 'fly', 'roll_left_fly']) {
      assert.equal(typeof facts.candidates[id].predictedEndHeight, 'number');
      assert.equal(facts.candidates[id].risk.trajectoryUncertain, false);
    }
  }
});

test('realtime transit continues only remaining held input and never replays a pending roll edge', () => {
  const observation = base();
  observation.clockMode = 'realtime'; observation.estimatedDecisionLatencyMs = 500;
  Object.assign(observation.player, { y: 4, vy: 9, grounded: false, rollCombo: 2 });
  observation.pendingAction = { action: 'roll_left_fly', remainingMs: 200, durationMs: 533.333 };
  observation.observedInput = { thrustRemainingMs: 100, diveRemainingMs: 0, boostRemainingMs: 0 };
  const before = structuredClone(observation);
  const facts = describe(observation);
  assert.deepEqual(observation, before);
  assert.equal(facts.latencyForecast.simulatedLatencyMs, 500);
  assert.equal(facts.latencyForecast.edgeInputsReplayed, false);
  assert.equal(facts.latencyForecast.continuedInput.source, 'observed-native-held-input');
  assert.equal(facts.latencyForecast.applicationState.air, 98);
  assert.equal(facts.latencyForecast.applicationState.targetLane, 2);
  assert.equal(facts.latencyForecast.applicationState.rollCombo, 2);
  assert.deepEqual(facts.latencyForecast.existingQueuedRollEvents, []);
  assert.deepEqual(Object.keys(facts.candidates), IDS);
  for (const candidate of Object.values(facts.candidates)) assert.equal(candidate.applicationDelayMs, 500);
});

test('roll availability uses energy and native roll phase at estimated application time', () => {
  const observation = base();
  observation.clockMode = 'realtime'; observation.estimatedDecisionLatencyMs = 500;
  Object.assign(observation.player, { y: 10, vy: 9, grounded: false, air: 12 });
  observation.observedInput = { thrustRemainingMs: 500, diveRemainingMs: 0, boostRemainingMs: 0 };
  let facts = describe(observation);
  assert.equal(facts.latencyForecast.applicationState.air, 2);
  for (const id of IDS.slice(7)) {
    assert.equal(facts.candidates[id].rollAvailability.canStartImmediately, false);
    assert.equal(facts.candidates[id].rollAvailability.inputEffect, 'insufficient-air');
    assert.equal(facts.candidates[id].rollAvailability.airMarginAboveCost, -6);
    assert.equal(facts.candidates[id].immediateExpectedRollPoints, 0);
  }
  // Already-grounded coasting can recharge during the wait; this is not a
  // hidden recovery action selected by the host.
  Object.assign(observation.player, { y: 0, vy: 0, grounded: true, air: 5 });
  observation.observedInput.thrustRemainingMs = 0;
  facts = describe(observation);
  assert.equal(facts.latencyForecast.applicationState.air, 8.5);
  assert.equal(facts.candidates.roll_left.rollAvailability.canStartImmediately, true);
  Object.assign(observation.player, { y: 10, grounded: false, air: 60,
    rolling: true, rollProgress: .1, rollCombo: 2 });
  observation.estimatedDecisionLatencyMs = 0;
  facts = describe(observation);
  assert.equal(facts.candidates.roll_left.rollAvailability.inputEffect, 'ignored-during-first-half');
  observation.player.rollProgress = .7;
  facts = describe(observation);
  assert.equal(facts.candidates.roll_left.rollAvailability.inputEffect, 'queues-after-current-roll');
  assert(facts.candidates.roll_left.rollAvailability.expectedStartAfterMs > 0);
  observation.estimatedDecisionLatencyMs = 200;
  facts = describe(observation);
  assert.equal(facts.candidates.roll_left.rollAvailability.inputEffect, 'starts-now');
});

test('latency-window collision risk is shared and cannot be hidden by a later protective roll', () => {
  const observation = base();
  observation.clockMode = 'realtime'; observation.estimatedDecisionLatencyMs = 200;
  Object.assign(observation.player, { z: -141, y: 8, vy: 0, grounded: false, graceTimer: .05 });
  observation.nearby = [{ category: 'hazard', kind: 'overhead-sign', x: 0, y: 0,
    z: -145, distanceAhead: 4, minCollisionY: 6.95, maxCollisionY: 11.1, spansAllLanes: true }];
  const facts = describe(observation);
  assert.equal(facts.latencyForecast.risk.unprotectedContactCount, 1);
  assert.equal(facts.latencyForecast.risk.firstUnprotectedAtMs, 66.667);
  assert.equal(facts.latencyForecast.applicationStateMayNotBeReachable, true);
  assert(facts.latencyForecast.uncertainty.some(message => message.includes('BEFORE')));
  assert.equal(facts.candidates.roll_left_fly.risk.unprotectedContactCount, 0);
});

test('landing predictions identify altitude and lane and retain existing queued rolls without replay', () => {
  const observation = base();
  observation.clockMode = 'realtime'; observation.estimatedDecisionLatencyMs = 500;
  Object.assign(observation.player, { y: 1, vy: -10, grounded: false, rollCombo: 2,
    air: 60, rolling: true, rollProgress: .7, rollQueued: 1 });
  const facts = describe(observation);
  assert.equal(facts.latencyForecast.existingQueuedRollEvents.length, 1);
  assert.equal(facts.latencyForecast.existingQueuedRollEvents[0].origin, 'already-queued');
  observation.player.rolling = false; observation.player.rollQueued = 0;
  const landing = describe(observation).latencyForecast.predictedLandings[0];
  assert.equal(landing.altitude, 0);
  assert.equal(landing.lane, 2);
  assert(landing.atMs > 0 && landing.atMs <= 500);
});

test('a step experiment stays zero-delay, and a previous hop hold is never extended through the decision interval', () => {
  const observation = base();
  observation.clockMode = 'step'; observation.estimatedDecisionLatencyMs = 500;
  assert.equal(describe(observation).latencyForecast.frames, 0);
  observation.clockMode = 'realtime';
  observation.pendingAction = { action: 'jump', durationMs: 200, remainingMs: 100 };
  assert.equal(describe(observation).latencyForecast.continuedInput.thrustRemainingMs, 0);
});

test('actual pending native roll edges are consumed on the first waiting frame exactly once', () => {
  const observation = base();
  observation.clockMode = 'realtime'; observation.estimatedDecisionLatencyMs = 500;
  observation.pendingAction = { action: 'roll_left_fly', durationMs: 533.333, remainingMs: 527 };
  observation.observedInput = { thrustRemainingMs: 533.332, diveRemainingMs: 0, boostRemainingMs: 0,
    edges: { left: false, right: false, thrustPressed: true, rollLeft: true, rollRight: false } };
  const facts = describe(observation);
  const transit = facts.latencyForecast;
  assert.equal(transit.applicationState.targetLane, 1);
  assert.equal(transit.existingQueuedRollEvents.length, 1);
  assert.equal(transit.existingQueuedRollEvents[0].atMs, 0);
  assert.equal(transit.existingQueuedRollEvents[0].origin, 'observed-pending-edge');
  assert.equal(transit.applicationState.rollCombo, 1);
  assert.equal(transit.applicationState.air, 82);
  assert.equal(transit.observedPendingEdgesConsumedOnce.rollLeft, true);
  observation.observedInput.edges.rollLeft = false;
  observation.observedInput.edges.thrustPressed = false;
  const consumed = describe(observation).latencyForecast;
  assert.deepEqual(consumed.existingQueuedRollEvents, []);
  assert.equal(consumed.applicationState.targetLane, 2);
});

test('zero-delay edge OR uses native lane ordering and rollLeft precedence without duplication', () => {
  const observation = base();
  observation.clockMode = 'realtime'; observation.estimatedDecisionLatencyMs = 0;
  observation.observedInput = { thrustRemainingMs: 0, diveRemainingMs: 0, boostRemainingMs: 0,
    edges: { left: false, right: false, thrustPressed: true, rollLeft: true, rollRight: true } };
  let facts = describe(observation);
  const right = facts.candidates.roll_right_fly;
  assert.equal(right.predictedEndLane, 1, 'Pending left OR candidate right means native left wins');
  assert.equal(right.expectedRollEvents.length, 1);
  assert.equal(right.immediateExpectedRollPoints, 80);
  assert.equal(right.rollAvailability.effectiveDirection, -1);
  observation.observedInput.edges.rollLeft = false;
  observation.observedInput.edges.rollRight = false;
  observation.observedInput.edges.thrustPressed = false;
  observation.observedInput.edges.left = true;
  observation.observedInput.edges.right = true;
  observation.player.lane = observation.player.targetLane = 0; observation.player.x = -7.2;
  facts = describe(observation);
  assert.equal(facts.candidates.coast.predictedEndLane, 1,
    'Native left at lane0 bumps, then right advances to lane1; edges are not reduced to a net zero');
});

test('forecast covers the next response window while candidate holds still expire on time', () => {
  const observation = base();
  observation.clockMode = 'realtime'; observation.estimatedDecisionLatencyMs = 500;
  Object.assign(observation.player, { y: 10, vy: 9, grounded: false });
  const facts = describe(observation);
  assert.equal(facts.candidates.coast.durationMs, 200);
  assert.equal(facts.candidates.coast.coveredDurationMs, 500);
  assert.equal(facts.candidates.coast.effectiveHeldDurationMs, 0);
  assert.equal(facts.candidates.fly.effectiveHeldDurationMs, 200);
  assert.equal(facts.candidates.jump.effectiveHeldDurationMs, 50);
  assert.equal(facts.candidates.roll_left_fly.coveredDurationMs, 533.333);
  assert.equal(facts.candidates.fly.predictedAirCost, 4,
    'Only 200ms of the 500ms horizon may spend held-thrust energy');
  assert(facts.candidates.coast.afterHeldExpiry.includes('No follow-up action'));
  assert.deepEqual(Object.keys(facts.candidates), IDS);
});
