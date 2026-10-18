import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../extension/bridge.js', import.meta.url), 'utf8');

function setup({ hostname = 'roadster-rush.ai.studio', mode = 'playing', originalManual = false, originalSimPaused = false,
  raf = false } = {}) {
  let now = 100;
  const timers = new Map();
  const actions = [];
  const steps = [];
  const rafCallbacks = new Map();
  let rafSerial = 0;
  const g = {
    mode, paused: false, manual: originalManual, simPaused: originalSimPaused, acc: 1, lastNow: 10,
    score: 142, distance: 42, bolts: 10, mult: 1, time: 0,
    harness: { edges: { left: false, right: false, thrustPressed: false }, held: { thrust: 0, dive: 0, boost: 0 } },
    player: {
      position: { x: 0, y: 0, z: -42 }, velocity: { y: 0 }, lane: 2, targetLane: 2,
      speed: 26, air: 100, grounded: true, alive: true, shieldTimer: 0,
    },
    traffic: {
      vehicles: [{ active: true, type: 'bus', lane: 2, x: 0, z: -62, w: 2.5, h: 3.2, l: 12, spd: 15, roof: 3.2 }],
      skyCars: [{ active: true, lane: 1, x: -3.6, y: 8, z: -90, w: 1.9, h: 1.15, l: 4.3, vz: -20 }],
      pickups: [{ kind: 'bolt', x: 3.6, y: 1, z: -52 }],
    },
    world: { gantries: [{ position: { x: 0, y: 0, z: -120 } }] },
    input: { resets: 0, reset() { this.resets++; } },
    renderCount: 0,
  };
  function physicsTick(dt) {
    g.time += dt;
    for (const key of Object.keys(g.harness.edges)) g.harness.edges[key] = false;
    for (const key of Object.keys(g.harness.held)) g.harness.held[key] -= dt;
    g.player.position.z -= 26 * dt;
    g.distance += 26 * dt;
    g.score += 26 * dt;
  }
  g.nativeFrames = 0;
  g.frameTick = () => {
    if (!g.paused && !g.manual && !g.simPaused) { physicsTick(1 / 60); g.nativeFrames++; }
    g.renderCount++;
  };
  const h = {
    game: g,
    getState: () => ({
      mode: g.mode, paused: g.paused, score: g.score, distance: g.distance, bolts: g.bolts,
      multiplier: g.mult, chain: 0, best: 1000, difficulty: 0.1, activePreset: g.activePreset || null,
      player: { ...g.player.position, ...g.player, position: undefined, velocity: undefined },
    }),
    triggerAction(action, args = {}) {
      actions.push({ action, args });
      switch (action) {
        case 'start': case 'retry': g.mode = 'playing'; g.paused = false; g.simPaused = false; break;
        case 'left': case 'right': case 'rollLeft': case 'rollRight': g.harness.edges[action] = true; break;
        case 'hop': g.harness.edges.thrustPressed = true; g.harness.held.thrust = args.frames / 60 - 1e-6; break;
        case 'thrustHold': g.harness.edges.thrustPressed = true; g.harness.held.thrust = args.duration; break;
        case 'dive': case 'boost': g.harness.held[action] = args.duration; break;
        default: throw new Error('fake harness unknown action');
      }
    },
    step(dt, render) {
      steps.push({ dt, render, edges: { ...g.harness.edges }, held: { ...g.harness.held } });
      physicsTick(dt);
      return this.getState();
    },
    render() { g.renderCount++; },
  };
  const win = { __GAME__: h };
  const context = vm.createContext({
    window: win, location: { hostname }, Date: { now: () => now },
    setInterval: (fn) => { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id),
    ...(raf ? {
      requestAnimationFrame: fn => { const id = ++rafSerial; rafCallbacks.set(id, fn); return id; },
      cancelAnimationFrame: id => rafCallbacks.delete(id),
    } : {}),
  });
  vm.runInContext(script, context);
  return {
    g, h, win, actions, steps, timers, context, rafCallbacks,
    call: (op, args) => JSON.parse(JSON.stringify(win.__ROADSTER_DECISION_BRIDGE__.command(op, args))),
    advance(ms) { now += ms; for (const fn of timers.values()) fn(); },
    rafTick(time) {
      const pending = Array.from(rafCallbacks.values()); rafCallbacks.clear();
      for (const callback of pending) callback(time);
    },
  };
}

test('restricted exact hostname and missing harness do not guess controls', () => {
  assert.equal(setup({ hostname: 'roadster-rush.ai.studio.attacker.test' }).win.__ROADSTER_DECISION_BRIDGE__, undefined);
  const fixture = setup();
  delete fixture.win.__GAME__;
  assert.deepEqual(fixture.call('inspect').available, false);
  assert.equal(fixture.call('acquire', { start: true }).ok, false);
  assert.equal(fixture.steps.length, 0);
});

test('observations read genuine score, bounded traffic, pickups and overhead hazards', () => {
  const f = setup();
  const obs = f.call('inspect').state;
  assert.equal(obs.source, 'game-telemetry');
  assert.equal(obs.score, 142);
  assert.equal(f.g.score, 142);
  assert.equal(obs.player.vy, 0);
  assert.equal(obs.nearby.find(item => item.category === 'ground-traffic').distanceAhead, 20);
  assert.equal(obs.nearby.find(item => item.category === 'collectible').lane, 3);
  assert.equal(obs.nearby.find(item => item.category === 'hazard').minCollisionY, 6.95);
  assert.equal(obs.nearby.find(item => item.category === 'air-traffic').y, 8);
  for (let i = 0; i < 40; i++) f.g.traffic.pickups.push({ kind: 'bolt', x: 0, y: 1, z: -50 - i });
  const crowded = f.call('inspect').state.nearby;
  assert.equal(crowded.filter(v => v.category === 'collectible').length, 20);
  assert.equal(crowded.some(v => v.category === 'hazard'), true);
});

test('lease freezes waiting, exact frames advance only on an allowed action', () => {
  const f = setup();
  assert.equal(f.call('acquire').ok, true);
  assert.equal(f.g.manual, true);
  assert.equal(f.g.simPaused, true);
  f.advance(10000);
  const waiting = f.call('observe').observation;
  assert.equal(waiting.distance, 42);
  assert.equal(f.steps.length, 0);
  const result = f.call('act', { action: 'left', stepMs: 200 });
  assert.equal(result.ok, true);
  assert.equal(result.frames, 12);
  assert.equal(f.steps.length, 12);
  assert.equal(f.steps.every(step => step.dt === 1 / 60 && step.render === false), true);
  assert.equal(f.steps[0].edges.left, true);
  assert.equal(f.steps[1].edges.left, false);
  assert.equal(f.g.harness.edges.left, false);
  assert.equal(result.observation.simulatedFrames, 12);
  assert.equal(f.call('observe').observation.distance, result.observation.distance);
  assert.equal(f.call('act', { action: 'pickup', stepMs: 200 }).ok, false);
  assert.equal(f.call('act', { action: 'crash', stepMs: 200 }).ok, false);
  assert.equal(f.call('act', { action: 'coast', stepMs: 90000 }).ok, false);
  assert.equal(f.steps.length, 12);
});

test('action mapping has no fallback policy and always cleans held input', () => {
  const f = setup();
  f.call('acquire');
  const bindings = { coast: null, left: 'left', right: 'right', jump: 'hop', fly: 'thrustHold', dive: 'dive', boost: 'boost' };
  for (const [action, binding] of Object.entries(bindings)) {
    const before = f.actions.length;
    assert.equal(f.call('act', { action, stepMs: 100 }).ok, true);
    assert.equal(f.actions.length, before + Number(binding !== null));
    if (binding) assert.equal(f.actions.at(-1).action, binding);
    assert.deepEqual(f.g.harness.held, { thrust: 0, dive: 0, boost: 0 });
  }
});

test('native roll macros execute one model-chosen roll and bounded thrust for exactly 32 frames', () => {
  for (const action of ['roll_left', 'roll_right', 'roll_left_fly', 'roll_right_fly']) {
    const f = setup();
    f.call('acquire');
    const revision = f.call('observe').observation.revision;
    const result = f.call('act', { action, stepMs: 200, expectedRevision: revision });
    assert.equal(result.ok, true);
    assert.equal(result.frames, 32);
    assert.equal(result.durationMs, 533.333);
    assert.equal(f.actions[0].action, action.startsWith('roll_left') ? 'rollLeft' : 'rollRight');
    assert.equal(f.actions.length, action.endsWith('_fly') ? 2 : 1);
    if (action.endsWith('_fly')) {
      assert.equal(f.actions[1].action, 'thrustHold');
      assert(f.steps[0].held.thrust > 0.53);
      assert(f.steps.at(-1).held.thrust > 0);
    }
    assert.notEqual(result.observation.revision, revision);
    assert.deepEqual(f.g.harness.held, { thrust: 0, dive: 0, boost: 0 });
  }
});

test('stale observation revisions are rejected without advancing the game', () => {
  const f = setup();
  f.call('acquire');
  const revision = f.call('observe').observation.revision;
  f.g.score++;
  const result = f.call('act', { action: 'roll_left_fly', expectedRevision: revision });
  assert.equal(result.ok, false);
  assert.equal(f.actions.length, 0);
  assert.equal(f.steps.length, 0);
});

test('facts receive current public telemetry and the configured step duration', () => {
  const f = setup();
  f.win.__ROADSTER_FACTS__ = { describe: obs => ({ step: obs.actionStepMs, revision: obs.revision }) };
  f.call('acquire', { stepMs: 300 });
  const obs = f.call('observe', { stepMs: 400 }).observation;
  assert.equal(obs.actionFacts.step, 400);
  assert.equal(obs.actionFacts.revision, obs.revision);
});

test('facts see real held inputs and pending timing before predicting model latency', () => {
  const f = setup();
  f.win.__ROADSTER_FACTS__ = { describe: obs => ({
    delay: obs.estimatedDecisionLatencyMs, pending: obs.pendingAction, held: obs.observedInput,
  }) };
  f.call('acquire', { clockMode: 'realtime' });
  f.g.harness.held.thrust = .25;
  const obs = f.call('observe', { estimatedDecisionLatencyMs: 450,
    pendingAction: { action: 'roll_left_fly', appliedAtMs: 0, durationMs: 533 } }).observation;
  assert.equal(obs.actionFacts.delay, 450);
  assert.equal(obs.actionFacts.pending.remainingMs, 433);
  assert.equal(obs.actionFacts.held.thrustRemainingMs, 250);
  assert.equal(f.steps.length, 0);
  f.advance(1000);
  assert.equal(f.call('observe').observation.pendingAction.remainingMs, 0);
});

test('start/retry are explicit; preset scenes are rejected without changing score', () => {
  const f = setup({ mode: 'title' });
  assert.equal(f.call('acquire').ok, false);
  assert.equal(f.g.manual, false);
  assert.equal(f.call('acquire', { start: true }).ok, true);
  assert.equal(f.actions[0].action, 'start');
  f.g.mode = 'crashed';
  assert.equal(f.call('act', { action: 'coast', stepMs: 200 }).ok, false);
  assert.equal(f.call('acquire', { retry: true }).ok, true);
  assert.equal(f.actions.at(-1).action, 'retry');
  f.call('release');
  f.g.activePreset = 'scene_01';
  assert.equal(f.call('acquire', { start: true }).ok, false);
  assert.equal(f.g.score, 142);
});

test('stop restores manual/simPaused flags and pauses the normal game', () => {
  for (const originalManual of [false, true]) for (const originalSimPaused of [false, true]) {
    const f = setup({ originalManual, originalSimPaused });
    f.call('acquire');
    f.call('acquire'); // Idempotent acquisition must preserve the original flags.
    f.call('act', { action: 'fly', stepMs: 100 });
    assert.equal(f.call('release').ok, true);
    assert.equal(f.g.manual, originalManual);
    assert.equal(f.g.simPaused, originalSimPaused);
    assert.equal(f.g.paused, true);
    assert.equal(f.g.lastNow, 0);
    assert.deepEqual(f.g.harness.held, { thrust: 0, dive: 0, boost: 0 });
    assert.equal(f.timers.size, 0);
    assert.equal(f.call('act', { action: 'coast' }).ok, false);
  }
});

test('a natural crash releases the clock so the original loss animation can finish', () => {
  const f = setup();
  f.call('acquire');
  f.g.mode = 'crashed';
  const score = f.g.score;
  f.call('release');
  assert.equal(f.g.paused, false);
  assert.equal(f.g.manual, false);
  assert.equal(f.g.simPaused, false);
  assert.equal(f.g.mode, 'crashed');
  assert.equal(f.g.score, score);
  assert.equal(f.steps.length, 0);
});

test('watchdog releases stalled extension ownership, heartbeat keeps an active request frozen', () => {
  const f = setup();
  f.call('acquire');
  f.advance(19000);
  assert.equal(f.call('observe').ok, true);
  f.advance(19000);
  assert.equal(f.g.manual, true);
  f.advance(2000);
  assert.equal(f.g.manual, false);
  assert.equal(f.g.paused, true);
  assert.equal(f.call('inspect').lastRelease, 'watchdog');
  assert.equal(f.steps.length, 0);
});

test('reinjecting the adapter preserves its lease and a failed physics step still clears input', () => {
  const f = setup();
  f.call('acquire');
  const bridge = f.win.__ROADSTER_DECISION_BRIDGE__;
  vm.runInContext(script, f.context);
  assert.equal(f.win.__ROADSTER_DECISION_BRIDGE__, bridge);
  f.h.step = () => { throw new Error('simulation failed'); };
  assert.equal(f.call('act', { action: 'fly', stepMs: 200 }).ok, false);
  assert.deepEqual(f.g.harness.held, { thrust: 0, dive: 0, boost: 0 });
  assert.equal(f.g.manual, true);
  assert.equal(f.g.simPaused, true);
  assert.equal(f.call('release').ok, true);
});

test('realtime observations, rejected actions and release respect the original user pause', () => {
  const f = setup();
  f.call('acquire', { clockMode: 'realtime' });
  f.g.paused = true;
  const o = f.call('observe').observation;
  assert.equal(o.enginePaused, true);
  const r = f.call('act', { action: 'fly', expectedEpoch: o.epoch, observedAtMs: o.observedAtMs });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'game-paused');
  f.call('release');
  assert.equal(f.g.paused, true);
  assert.equal(f.actions.length, 0);
});

test('realtime acquisition and observation leave the native clock and its accumulator running', () => {
  const f = setup();
  const before = { acc: f.g.acc, lastNow: f.g.lastNow };
  const acquired = f.call('acquire', { clockMode: 'realtime' });
  assert.equal(f.win.__ROADSTER_DECISION_BRIDGE__.version, 7);
  assert.equal(acquired.observation.bridgeVersion, 7);
  assert.equal(acquired.observation.clockMode, 'realtime');
  assert.equal(acquired.observation.observedAtMs, 100);
  assert.equal(typeof acquired.observation.epoch, 'string');
  assert.equal(acquired.observation.frozen, false);
  assert.equal(acquired.observation.simulatedFrames, null);
  assert.equal(f.g.manual, false);
  assert.equal(f.g.simPaused, false);
  for (let i = 0; i < 12; i++) f.g.frameTick();
  f.advance(200);
  const observed = f.call('observe').observation;
  assert(observed.distance > acquired.observation.distance + 5);
  assert.equal(observed.epoch, acquired.observation.epoch);
  assert.equal(f.g.nativeFrames, 12);
  assert.equal(f.steps.length, 0);
  assert.deepEqual({ acc: f.g.acc, lastNow: f.g.lastNow }, before);
});

test('realtime actions only apply the chosen native controls and never step, freeze or invent outcomes', () => {
  const bindings = { coast: [], left: ['left'], right: ['right'], jump: ['hop'],
    fly: ['thrustHold'], dive: ['dive'], boost: ['boost'], roll_left: ['rollLeft'],
    roll_right: ['rollRight'], roll_left_fly: ['rollLeft', 'thrustHold'],
    roll_right_fly: ['rollRight', 'thrustHold'] };
  for (const [action, expected] of Object.entries(bindings)) {
    const f = setup();
    const observed = f.call('acquire', { clockMode: 'realtime' }).observation;
    f.h.step = () => { throw new Error('Realtime must never call step'); };
    // A genuine native frame can change revision without making this recent
    // observation invalid; realtime checks epoch and age instead.
    f.g.frameTick();
    const scoreAtApply = f.g.score;
    const distanceAtApply = f.g.distance;
    const result = f.call('act', { action, stepMs: 230, expectedEpoch: observed.epoch,
      observedAtMs: observed.observedAtMs, expectedRevision: 'intentionally-old' });
    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(result.actionId, action);
    assert.equal(result.frames, null);
    assert.equal(result.simulatedMs, 0);
    assert.equal(result.durationMs, action.startsWith('roll_') ? 533.333 : 230);
    assert.deepEqual(f.actions.map(entry => entry.action), expected);
    assert.equal(f.g.score, scoreAtApply);
    assert.equal(f.g.distance, distanceAtApply);
    assert.equal(f.g.manual, false);
    assert.equal(f.g.simPaused, false);
    assert.equal(f.g.paused, false);
    assert.equal(f.steps.length, 0);
    if (action.endsWith('_fly')) assert(f.g.harness.held.thrust > .53);
    if (action === 'fly') assert(f.g.harness.held.thrust > .229);
  }
});

test('realtime stale epoch, age, future timestamp and ended game reject without new controls', () => {
  const f = setup();
  const observed = f.call('acquire', { clockMode: 'realtime' }).observation;
  const baseArgs = { action: 'roll_left_fly', expectedEpoch: observed.epoch, observedAtMs: observed.observedAtMs };
  assert.equal(f.call('act', { ...baseArgs, expectedEpoch: 'previous-run' }).reason, 'stale-epoch');
  assert.equal(f.call('act', { ...baseArgs, observedAtMs: 101 }).reason, 'stale-observation');
  f.advance(1501);
  const old = f.call('act', baseArgs);
  assert.equal(old.ok, true);
  assert.equal(old.applied, false);
  assert.equal(old.reason, 'stale-observation');
  assert.equal(f.call('act', { ...baseArgs, maxAgeMs: 249 }).ok, false);
  assert.equal(f.call('act', { ...baseArgs, maxAgeMs: 5001 }).ok, false);
  f.g.mode = 'crashed';
  const ended = f.call('act', { ...baseArgs, observedAtMs: 1601 });
  assert.equal(ended.applied, false);
  assert.equal(ended.reason, 'game-ended');
  assert.equal(f.actions.length, 0);
  assert.equal(f.steps.length, 0);
});

test('realtime explicit and native restarts change epoch and reject decisions from a previous run', () => {
  const f = setup();
  const first = f.call('acquire', { clockMode: 'realtime' }).observation;
  f.g.mode = 'crashed';
  const retried = f.call('acquire', { clockMode: 'realtime', retry: true }).observation;
  assert.notEqual(retried.epoch, first.epoch);
  const rejected = f.call('act', { action: 'fly', expectedEpoch: first.epoch, observedAtMs: first.observedAtMs });
  assert.equal(rejected.reason, 'stale-epoch');
  f.g.mode = 'gameover'; f.call('observe');
  f.g.mode = 'playing';
  const nativeRetry = f.call('observe').observation;
  assert.notEqual(nativeRetry.epoch, retried.epoch);
});

test('realtime Stop and watchdog clear pending controls and continue the original game clock', () => {
  for (const reason of ['stop', 'watchdog']) {
    const f = setup();
    const observed = f.call('acquire', { clockMode: 'realtime' }).observation;
    f.call('act', { action: 'roll_left_fly', expectedEpoch: observed.epoch, observedAtMs: observed.observedAtMs });
    assert(f.g.harness.held.thrust > .53);
    const before = { acc: f.g.acc, lastNow: f.g.lastNow, distance: f.g.distance };
    if (reason === 'stop') f.call('release');
    else f.advance(20001);
    assert.equal(f.g.harness.edges.rollLeft, false);
    assert.deepEqual(f.g.harness.held, { thrust: 0, dive: 0, boost: 0 });
    assert.equal(f.g.manual, false);
    assert.equal(f.g.simPaused, false);
    assert.equal(f.g.paused, false);
    assert.equal(f.g.acc, before.acc);
    assert.equal(f.g.lastNow, before.lastNow);
    assert.equal(f.timers.size, 0);
    f.g.frameTick();
    assert(f.g.distance > before.distance);
    assert.equal(f.steps.length, 0);
    assert.equal(f.call('inspect').lastRelease, reason);
  }
});

test('realtime metrics compare wall and native game time and stop at natural loss', () => {
  const f = setup({ raf: true });
  f.call('acquire', { clockMode: 'realtime' });
  const beforeSampling = f.g.distance;
  f.rafTick(100); f.rafTick(116.667); f.rafTick(150);
  assert.equal(f.g.distance, beforeSampling, 'Read-only rAF sampling must not advance physics');
  for (let i = 0; i < 12; i++) f.g.frameTick();
  f.advance(200);
  let metrics = f.call('observe').observation.realtimeMetrics;
  assert.equal(metrics.wallElapsedMs, 200);
  assert.equal(metrics.gameElapsedMs, 200);
  assert.equal(metrics.gameToWallRatio, 1);
  assert.equal(metrics.frameTicks, 3);
  assert.equal(metrics.frameTimeMedianMs, 16.667);
  assert.equal(metrics.frameTimeP95Ms, 33.333);
  assert.equal(metrics.maxFrameGapMs, 33.333);
  f.g.mode = 'crashed';
  metrics = f.call('observe').observation.realtimeMetrics;
  assert.equal(metrics.finished, true);
  f.advance(900);
  assert.equal(f.call('observe').observation.realtimeMetrics.wallElapsedMs, 200);
  f.call('release');
  assert.equal(f.rafCallbacks.size, 0);
});

test('read-only rAF interval storage is bounded and absent rAF leaves sampling fields unknown', () => {
  const f = setup({ raf: true });
  f.call('acquire', { clockMode: 'realtime' });
  for (let i = 0; i < 700; i++) f.rafTick(i * 16.667);
  const metrics = f.call('observe').observation.realtimeMetrics;
  assert.equal(metrics.frameTicks, 700);
  assert.equal(metrics.intervalWindowSamples, 600);
  f.call('release');
  assert.equal(f.rafCallbacks.size, 0);
  const noRaf = setup();
  const unknown = noRaf.call('acquire', { clockMode: 'realtime' }).observation.realtimeMetrics;
  assert.equal(unknown.frameTicks, null);
  assert.equal(unknown.frameTimeMedianMs, null);
  assert.equal(noRaf.steps.length, 0);
});

test('observed pending native edges are explicit before facts and only pending booleans survive a same-tick choice', () => {
  const f = setup();
  f.win.__ROADSTER_FACTS__ = { describe: observation => ({ edges: observation.observedInput.edges }) };
  const first = f.call('acquire', { clockMode: 'realtime' }).observation;
  f.call('act', { action: 'roll_left_fly', expectedEpoch: first.epoch, observedAtMs: first.observedAtMs });
  let observation = f.call('observe').observation;
  assert.deepEqual(observation.observedInput.edges,
    { left: false, right: false, thrustPressed: true, rollLeft: true, rollRight: false });
  assert.deepEqual(observation.actionFacts.edges, observation.observedInput.edges);
  f.call('act', { action: 'roll_right_fly', expectedEpoch: observation.epoch, observedAtMs: observation.observedAtMs });
  observation = f.call('observe').observation;
  assert.equal(observation.observedInput.edges.rollLeft, true);
  assert.equal(observation.observedInput.edges.rollRight, true);
  assert.equal(observation.observedInput.edges.thrustPressed, true);
  assert.equal(f.actions.length, 4, 'Only two roll edges and their requested thrust holds were submitted');
  assert.equal(f.steps.length, 0);
  f.g.frameTick();
  observation = f.call('observe').observation;
  assert(Object.values(observation.observedInput.edges).every(value => value === false));
  f.call('act', { action: 'coast', expectedEpoch: observation.epoch, observedAtMs: observation.observedAtMs });
  assert(Object.values(f.g.harness.edges).every(value => value === false));
  assert.equal(f.actions.length, 4, 'Consumed edges must never be recreated from previous action metadata');
});

test('peekLive reads only native fields and leaves missing values unknown without invoking heavy paths', () => {
  const f = setup();
  Object.assign(f.g.player, { alive: true, grounded: false, lane: 3, targetLane: 2,
    rolling: true, rollDir: -1, rollT: .6, _rollQueued: 1,
    thrusting: true, diving: false, boosting: false });
  f.g.time = 12.3456; f.g.paused = true;
  f.g.harness.held = { thrust: .233333, dive: -.01, boost: .5 };
  Object.assign(f.g.harness.edges, { left: false, right: true, thrustPressed: true,
    rollLeft: true, rollRight: false });
  const impossible = () => { throw new Error('peekLive invoked an expensive or mutating path'); };
  f.h.getState = impossible; f.h.step = impossible; f.h.render = impossible;
  f.h.triggerAction = impossible; f.g.frameTick = impossible; f.g.input.reset = impossible;
  f.win.__ROADSTER_FACTS__ = { describe: impossible };
  const before = { score: f.g.score, time: f.g.time, distance: f.g.distance,
    renderCount: f.g.renderCount, inputResets: f.g.input.resets,
    held: { ...f.g.harness.held }, edges: { ...f.g.harness.edges },
    manual: f.g.manual, simPaused: f.g.simPaused, acc: f.g.acc, lastNow: f.g.lastNow };
  const result = f.call('peekLive');
  assert.equal(result.ok, true);
  assert.equal(result.live.epoch, null, 'HUD peeking must not initialize epoch bookkeeping');
  assert.equal(result.live.observedAtMs, 100);
  assert.equal(result.live.gameTime, 12.346);
  assert.equal(result.live.enginePaused, true);
  assert.deepEqual(result.live.player, { alive: true, grounded: false, lane: 3, targetLane: 2,
    rolling: true, rollDirection: -1, rollProgress: .6, rollQueued: 1,
    thrusting: true, diving: false, boosting: false });
  assert.equal(result.live.observedInput.thrustRemainingMs, 233.333);
  assert.equal(result.live.observedInput.diveRemainingMs, 0);
  assert.equal(result.live.observedInput.boostRemainingMs, 500);
  assert.equal(result.live.player.boosting, false, 'Held boost is not proof of physical boosting');
  assert.deepEqual(result.live.observedInput.edges, before.edges);
  assert.deepEqual({ score: f.g.score, time: f.g.time, distance: f.g.distance,
    renderCount: f.g.renderCount, inputResets: f.g.input.resets,
    held: { ...f.g.harness.held }, edges: { ...f.g.harness.edges },
    manual: f.g.manual, simPaused: f.g.simPaused, acc: f.g.acc, lastNow: f.g.lastNow }, before);
  assert.equal(f.steps.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.rafCallbacks.size, 0);
  // A partial native game is still readable, without inventing false/zero.
  f.win.__GAME__ = { game: { player: { alive: 'true', lane: NaN }, harness: { held: { boost: .2 } } } };
  const unknown = f.call('peekLive').live;
  assert.equal(unknown.epoch, null);
  assert.equal(unknown.gameTime, null);
  assert.equal(unknown.mode, null);
  assert.equal(unknown.player.alive, null);
  assert.equal(unknown.player.lane, null);
  assert.equal(unknown.player.boosting, null);
  assert.equal(unknown.observedInput.boostRemainingMs, 200);
  assert(Object.values(unknown.observedInput.edges).every(value => value === null));
  delete f.win.__GAME__;
  assert.deepEqual(f.call('peekLive'), { ok: true, live: null });
});

test('peekLive does not renew watchdog ownership or reset epoch and realtime metrics on a native restart', () => {
  const f = setup({ raf: true });
  const initial = f.call('acquire', { clockMode: 'realtime' }).observation;
  const rafBefore = Array.from(f.rafCallbacks.keys());
  f.g.distance = 0; f.g.time = 0;
  const peek = f.call('peekLive').live;
  assert.equal(peek.epoch, initial.epoch, 'Only the driver observation may establish the new epoch');
  assert.equal(peek.distance, 0);
  assert.deepEqual(Array.from(f.rafCallbacks.keys()), rafBefore, 'No startMetrics/cancel/restart from HUD polling');
  const observed = f.call('observe').observation;
  assert.notEqual(observed.epoch, initial.epoch, 'Driver still detects the rewind after read-only peeking');
  f.advance(19000);
  f.call('peekLive');
  f.advance(1500);
  assert.equal(f.timers.size, 0, 'HUD polling must not keep a stalled driver lease alive');
  assert.equal(f.rafCallbacks.size, 0);
  assert.equal(f.steps.length, 0);
});

test('peekLive does not latch end-of-run metrics or alter the native pause/clock flags', () => {
  const f = setup();
  f.call('acquire', { clockMode: 'realtime' });
  f.advance(200); f.g.mode = 'crashed'; f.g.paused = true;
  const before = { acc: f.g.acc, lastNow: f.g.lastNow, manual: f.g.manual,
    simPaused: f.g.simPaused, renderCount: f.g.renderCount };
  assert.equal(f.call('peekLive').live.mode, 'crashed');
  f.advance(700);
  const metrics = f.call('observe').observation.realtimeMetrics;
  assert.equal(metrics.wallElapsedMs, 900, 'Heavy driver observation, not peekLive, finishes metrics');
  assert.equal(f.g.paused, true);
  assert.deepEqual({ acc: f.g.acc, lastNow: f.g.lastNow, manual: f.g.manual,
    simPaused: f.g.simPaused, renderCount: f.g.renderCount }, before);
});
