/* MAIN-world adapter for the game's own public __GAME__ testing harness.
 * No network, credentials, DOM messages, evaluation, or replacement controller.
 * The model chooses every gameplay action. Realtime mode leaves the game's
 * own animation/physics clock running; explicit step mode is for experiments.
 */
(() => {
  'use strict';
  if (location.hostname !== 'roadster-rush.ai.studio') return;
  const NAME = '__ROADSTER_DECISION_BRIDGE__';
  if (window[NAME]?.version === 7 && typeof window[NAME].command === 'function') return;
  // Same-permission upgrades release the previous adapter before replacing it.
  window[NAME]?.command?.('release');

  const DT = 1 / 60;
  const WATCHDOG_MS = 20000;
  const ACTIONS = Object.freeze(['coast', 'left', 'right', 'jump', 'fly', 'dive', 'boost',
    'roll_left', 'roll_right', 'roll_left_fly', 'roll_right_fly']);
  const EDGE_KEYS = ['left', 'right', 'thrustPressed', 'rollLeft', 'rollRight', 'pausePressed', 'startPressed'];
  const HELD_KEYS = ['thrust', 'dive', 'boost'];
  const OBSERVED_EDGE_KEYS = ['left', 'right', 'thrustPressed', 'rollLeft', 'rollRight'];
  let lease = null;
  let lastRelease = null;
  let epochSerial = 0;
  const epochs = new WeakMap();

  function finishMetrics(current) {
    const metrics = current?.metrics;
    if (metrics && metrics.finishedAtMs === null
      && ['crashed', 'gameover'].includes(current.h.game.mode)) {
      metrics.finishedAtMs = Date.now();
      metrics.finishedGameTime = Number.isFinite(current.h.game.time) ? current.h.game.time : null;
    }
  }

  function startMetrics(current) {
    if (current.metrics?.rafId != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(current.metrics.rafId);
    }
    const metrics = current.metrics = {
      startedAtMs: Date.now(), startedGameTime: Number.isFinite(current.h.game.time) ? current.h.game.time : null,
      finishedAtMs: null, finishedGameTime: null,
      rafId: null, lastRafTime: null, frameTicks: 0, intervals: [], maxFrameGapMs: null,
    };
    if (typeof requestAnimationFrame !== 'function') return;
    const sample = time => {
      if (lease !== current) return;
      finishMetrics(current);
      if (metrics.finishedAtMs !== null) return;
      metrics.frameTicks++;
      if (metrics.lastRafTime !== null) {
        const gap = Math.max(0, time - metrics.lastRafTime);
        metrics.intervals.push(gap);
        if (metrics.intervals.length > 600) metrics.intervals.shift();
        metrics.maxFrameGapMs = Math.max(metrics.maxFrameGapMs ?? 0, gap);
      }
      metrics.lastRafTime = time;
      // Observe animation opportunities without wrapping the game's rAF,
      // invoking frameTick, moving physics, or rendering anything.
      metrics.rafId = requestAnimationFrame(sample);
    };
    metrics.rafId = requestAnimationFrame(sample);
  }

  function realtimeMetrics(h) {
    if (!lease || lease.h !== h || lease.clockMode !== 'realtime' || !lease.metrics) return null;
    finishMetrics(lease);
    const metrics = lease.metrics;
    const wallElapsedMs = Math.max(0, (metrics.finishedAtMs ?? Date.now()) - metrics.startedAtMs);
    const gameTime = metrics.finishedAtMs !== null ? metrics.finishedGameTime : h.game.time;
    const gameElapsedMs = Number.isFinite(gameTime) && metrics.startedGameTime !== null
      ? Math.max(0, (gameTime - metrics.startedGameTime) * 1000) : null;
    const sorted = metrics.intervals.slice().sort((a, b) => a - b);
    const percentile = ratio => sorted.length ? number(sorted[Math.ceil(sorted.length * ratio) - 1]) : null;
    return {
      wallElapsedMs, gameElapsedMs: number(gameElapsedMs),
      gameToWallRatio: wallElapsedMs > 0 && gameElapsedMs !== null ? number(gameElapsedMs / wallElapsedMs) : null,
      finished: metrics.finishedAtMs !== null,
      sampling: 'Independent read-only rAF callback; frameTicks counts animation opportunities, not physics steps.',
      frameTicks: metrics.lastRafTime === null ? null : metrics.frameTicks,
      frameTimeMedianMs: percentile(.5), frameTimeP95Ms: percentile(.95),
      maxFrameGapMs: number(metrics.maxFrameGapMs), intervalWindowSamples: sorted.length,
    };
  }

  function epoch(h, reset = false) {
    const g = h.game;
    const current = epochs.get(g);
    const time = Number.isFinite(g.time) ? g.time : null;
    const distance = Number.isFinite(g.distance) ? g.distance : null;
    const restarted = current && ((time !== null && current.time !== null && time < current.time)
      || (distance !== null && current.distance !== null && distance < current.distance)
      || (['crashed', 'gameover'].includes(current.mode) && g.mode === 'playing'));
    if (!current || reset || restarted) {
      const next = { id: `rr4-${++epochSerial}-${Date.now()}`, time, distance, mode: g.mode };
      epochs.set(g, next);
      if (restarted && lease?.h === h && lease.clockMode === 'realtime') startMetrics(lease);
      return next.id;
    }
    current.time = time; current.distance = distance; current.mode = g.mode;
    return current.id;
  }

  function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
  }

  function label(value) {
    return typeof value === 'string' ? value.slice(0, 80) : null;
  }

  function peekLive() {
    // HUD-only telemetry. Deliberately bypass observation(), getState(),
    // forecasts, epoch bookkeeping and lease/metrics lifecycle functions.
    const g = window.__GAME__?.game;
    if (!g || typeof g !== 'object') return { ok: true, live: null };
    const p = g.player;
    const held = g.harness?.held;
    const edges = g.harness?.edges;
    const boolean = value => typeof value === 'boolean' ? value : null;
    const remaining = value => typeof value === 'number' && Number.isFinite(value)
      ? number(Math.max(0, value) * 1000) : null;
    return { ok: true, live: {
      // This cache may remain from the previous run until the driver observes
      // the restart. Consumers must also invalidate on gameTime/distance rewind.
      epoch: epochs.get(g)?.id ?? null,
      observedAtMs: Date.now(), gameTime: number(g.time), distance: number(g.distance),
      mode: label(g.mode), enginePaused: boolean(g.paused),
      player: {
        alive: boolean(p?.alive), grounded: boolean(p?.grounded),
        lane: number(p?.lane), targetLane: number(p?.targetLane),
        rolling: boolean(p?.rolling), rollDirection: number(p?.rollDir),
        rollProgress: number(p?.rollT), rollQueued: number(p?._rollQueued),
        thrusting: boolean(p?.thrusting), diving: boolean(p?.diving), boosting: boolean(p?.boosting),
      },
      observedInput: {
        thrustRemainingMs: remaining(held?.thrust),
        diveRemainingMs: remaining(held?.dive), boostRemainingMs: remaining(held?.boost),
        edges: Object.fromEntries(OBSERVED_EDGE_KEYS.map(key => [key, boolean(edges?.[key])])),
      },
    } };
  }

  function harness() {
    const h = window.__GAME__;
    const g = h?.game;
    if (!h || !g || typeof h.getState !== 'function' || typeof h.step !== 'function'
      || typeof h.triggerAction !== 'function' || !g.harness?.edges || !g.harness?.held
      || !g.player?.position) return null;
    return h;
  }

  function clearInput(g) {
    for (const key of EDGE_KEYS) g.harness.edges[key] = false;
    for (const key of HELD_KEYS) g.harness.held[key] = 0;
    // reset also clears real keyboard/touch input so stale user presses cannot
    // become an unreported extra model action during the next explicit step.
    g.input?.reset?.();
  }

  function observation(h) {
    const g = h.game;
    const s = h.getState();
    const p = s.player || {};
    const actual = g.player;
    const pz = actual.position.z;
    const nearby = [];
    const traffic = g.traffic || {};

    function append(category, entity) {
      const position = category === 'hazard' ? entity.position : entity;
      if (!position || !Number.isFinite(position.z)) return;
      const distance = pz - position.z;
      if (distance < -12 || distance > 220 || entity.active === false) return;
      const x = number(position.x);
      // The game's source defines five lane centers as (lane - 2) * 3.6.
      const lane = Number.isFinite(entity.lane) ? entity.lane
        : category === 'hazard' || x === null ? null : Math.max(0, Math.min(4, Math.round(x / 3.6 + 2)));
      const item = {
        category, kind: label(entity.type || entity.kind || (category === 'hazard' ? 'overhead-sign' : 'roadster')),
        lane: number(lane), x, y: number(position.y ?? 0), z: number(position.z),
        distanceAhead: number(distance),
      };
      if (category === 'ground-traffic' || category === 'air-traffic') {
        item.width = number(entity.w);
        item.height = number(entity.h);
        item.length = number(entity.l);
        item.speed = number(entity.spd ?? (Number.isFinite(entity.vz) ? -entity.vz : undefined));
        item.roofY = number(entity.roof);
        if (entity.ramp) item.ramp = { length: number(entity.ramp.length), height: number(entity.ramp.height) };
        if (entity.changer) item.laneChange = {
          from: number(entity.changer.from), to: number(entity.changer.to),
          state: number(entity.changer.state),
        };
        if (entity.braker) item.braking = entity.braker.state === 1;
      }
      if (category === 'hazard') {
        // Read-only collision envelope from world.checkCollisions in the source.
        item.minCollisionY = 6.95;
        item.maxCollisionY = 11.1;
        item.spansAllLanes = true;
      }
      nearby.push(item);
    }

    for (const v of traffic.vehicles || []) append('ground-traffic', v);
    for (const v of traffic.skyCars || []) append('air-traffic', v);
    for (const v of traffic.pickups || []) append('collectible', v);
    for (const v of g.world?.gantries || []) append('hazard', v);
    nearby.sort((a, b) => Math.abs(a.distanceAhead) - Math.abs(b.distanceAhead));

    // Identity contains only current public telemetry, never a seed or RNG state.
    const revision = [lease?.frames ?? 0, s.mode, s.score, s.distance,
      actual.position.x, actual.position.y, actual.position.z, actual.air,
      actual.rollT, actual.rollCombo].join(':');
    const result = {
      source: 'game-telemetry', bridgeVersion: 7, mode: label(s.mode), revision,
      epoch: epoch(h), observedAtMs: Date.now(), clockMode: lease?.clockMode ?? 'native',
      realtimeMetrics: realtimeMetrics(h),
      actionStepMs: lease?.actionStepMs ?? 200,
      estimatedDecisionLatencyMs: lease?.estimatedDecisionLatencyMs ?? 500,
      pendingAction: lease?.pendingAction ? {
        action: lease.pendingAction.action,
        appliedAtMs: lease.pendingAction.appliedAtMs,
        durationMs: lease.pendingAction.durationMs,
        remainingMs: number(Math.max(0, lease.pendingAction.durationMs - (Date.now() - lease.pendingAction.appliedAtMs))),
      } : null,
      observedInput: {
        thrustRemainingMs: number(Math.max(0, g.harness.held.thrust) * 1000),
        diveRemainingMs: number(Math.max(0, g.harness.held.dive) * 1000),
        boostRemainingMs: number(Math.max(0, g.harness.held.boost) * 1000),
        // A submitted edge can still await the next native physics tick.
        // Metadata about the previous action cannot establish consumption.
        edges: Object.fromEntries(OBSERVED_EDGE_KEYS.map(key => [key, Boolean(g.harness.edges[key])])),
      },
      frozen: Boolean(lease && g.manual), enginePaused: Boolean(g.paused),
      score: number(s.score), distance: number(s.distance), bolts: number(s.bolts),
      multiplier: number(s.multiplier), chain: number(s.chain), best: number(s.best),
      difficulty: number(s.difficulty), crashWhat: label(s.crashWhat), activePreset: label(s.activePreset),
      chainTimer: number(g.chainTimer), airTime: number(g.airTime), airRolls: number(g.airRolls),
      simulatedFrames: lease?.clockMode === 'realtime' ? null : lease?.frames ?? 0,
      player: {
        x: number(p.x ?? actual.position.x), y: number(p.y ?? actual.position.y), z: number(p.z ?? pz),
        lane: number(p.lane), targetLane: number(p.targetLane),
        speed: number(p.speed), air: number(p.air), vy: number(actual.velocity?.y),
        vx: number(actual.velocity?.x), baseSpeed: number(actual.baseSpeed),
        grounded: Boolean(p.grounded), supportY: number(p.supportY), alive: p.alive !== false,
        rolling: Boolean(p.rolling), boosting: Boolean(p.boosting),
        rollCombo: number(actual.rollCombo), rollProgress: number(actual.rollT),
        rollDirection: number(actual.rollDir), rollQueued: number(actual._rollQueued),
        rollIframe: number(actual._rollIframe), graceTimer: number(actual.graceTimer),
        groundHoldMs: number(actual._groundHold * 1000),
        airTime: number(actual.airTime),
        thrusting: Boolean(actual.thrusting), diving: Boolean(actual.diving),
        invulnerable: Boolean(p.invulnerable), rocketTimer: number(p.rocketTimer),
        shieldTimer: number(actual.shieldTimer), magnetTimer: number(actual.magnetTimer),
        multiplierTimer: number(actual.multiplierTimer),
      },
      coordinateSystem: { forward: '-z', distanceAhead: 'player.z - object.z', laneCount: 5, laneWidth: 3.6,
        positionUnit: 'metres', speedUnit: 'metres/second', airRange: [0, 100] },
      // Bound each category separately, so dense collectibles cannot hide signs.
      nearby: nearby.filter((item, i, all) => all.slice(0, i).filter(v => v.category === item.category).length < 20),
      counts: {
        groundTraffic: (traffic.vehicles || []).length, airTraffic: (traffic.skyCars || []).length,
        collectibles: (traffic.pickups || []).length, nearbyTotal: nearby.length,
      },
    };
    result.actionFacts = window.__ROADSTER_FACTS__?.describe?.(result) ?? null;
    return result;
  }

  function release(reason = 'stop', resume = false) {
    if (!lease) return { ok: true, acquired: false, lastRelease };
    const current = lease;
    lease = null;
    clearInterval(current.watchdog);
    if (current.metrics?.rafId != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(current.metrics.rafId);
    }
    const g = current.h.game;
    clearInput(g);
    if (current.clockMode === 'realtime') {
      // Stop relinquishes the controls, not the game's original clock. Do not
      // reset rAF accumulator/timestamps or pause an independently running game.
      g.manual = false;
      g.simPaused = false;
    } else {
      g.manual = current.original.manual;
      g.simPaused = current.original.simPaused;
      g.acc = 0;
      g.lastNow = 0;
      // Step experiments stop on a paused live run; natural loss animations
      // can finish without accepting further driving inputs or scoring.
      g.paused = resume ? current.original.paused : !['crashed', 'gameover'].includes(g.mode);
    }
    g.hud?.showPause?.(g.paused && g.mode === 'playing');
    current.h.render?.();
    lastRelease = reason;
    return { ok: true, acquired: false, paused: Boolean(g.paused), clockMode: current.clockMode, lastRelease };
  }

  function requireLease(h) {
    if (!lease) throw new Error('请先开始自动驾驶。');
    if (lease.h !== h) {
      release('game-replaced');
      throw new Error('游戏实例已更换，请重新开始。');
    }
    lease.lastTouch = Date.now();
    if (lease.clockMode === 'realtime') {
      h.game.manual = false;
      h.game.simPaused = false;
    } else {
      h.game.manual = true;
      h.game.simPaused = true;
    }
  }

  function decisionContext(args) {
    if (!lease) return;
    if (Number.isFinite(args.estimatedDecisionLatencyMs)) {
      lease.estimatedDecisionLatencyMs = Math.max(0, Math.min(5000, args.estimatedDecisionLatencyMs));
    }
    if (Object.hasOwn(args, 'pendingAction')) {
      const p = args.pendingAction;
      lease.pendingAction = p && ACTIONS.includes(p.action)
        && Number.isFinite(p.appliedAtMs) && Number.isFinite(p.durationMs)
        && p.durationMs >= 0 && p.durationMs <= 1000
        ? { action: p.action, appliedAtMs: p.appliedAtMs, durationMs: p.durationMs } : null;
    }
  }

  function applyAction(h, action, durationMs) {
    const duration = durationMs / 1000 - 1e-6;
    switch (action) {
      case 'left': case 'right': h.triggerAction(action); break;
      case 'jump': h.triggerAction('hop', { frames: 3 }); break;
      case 'fly': h.triggerAction('thrustHold', { duration }); break;
      case 'dive': case 'boost': h.triggerAction(action, { duration }); break;
      case 'roll_left': case 'roll_right':
      case 'roll_left_fly': case 'roll_right_fly':
        h.triggerAction(action.startsWith('roll_left') ? 'rollLeft' : 'rollRight');
        if (action.endsWith('_fly')) h.triggerAction('thrustHold', { duration });
        break;
    }
  }

  function command(op, args = {}) {
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('无效命令参数。');
      if (op === 'peekLive') return peekLive();
      if (op === 'release') return release('stop', args.resume === true);
      const h = harness();
      if (op === 'inspect') {
        if (lease) lease.lastTouch = Date.now();
        return {
          ok: true, available: Boolean(h), acquired: Boolean(lease), actions: [...ACTIONS],
          watchdogMs: WATCHDOG_MS, lastRelease,
          state: h ? observation(h) : null,
        };
      }
      if (!h) throw new Error('游戏尚未加载，或 __GAME__ 接口已改变；请刷新并等待加载完成。');
      if (op === 'acquire') {
        const clockMode = args.clockMode ?? lease?.clockMode ?? 'step';
        if (!['step', 'realtime'].includes(clockMode)) throw new Error('clockMode 必须是 step 或 realtime。');
        if (h.game.activePreset) throw new Error('请进入正常游戏；不支持预设演示场景。');
        if (lease && lease.h !== h) release('game-replaced');
        if (lease && lease.clockMode !== clockMode) release('clock-mode-changed', true);
        if (!lease) {
          const mode = h.getState().mode;
          if (mode === 'title' && args.start !== true) throw new Error('标题画面需要显式 start:true。');
          if ((mode === 'crashed' || mode === 'gameover') && args.retry !== true) throw new Error('本局已结束，需要显式 retry:true。');
          lease = {
            h, original: { manual: h.game.manual, simPaused: h.game.simPaused, paused: h.game.paused },
            clockMode, frames: 0, actionStepMs: 200, lastTouch: Date.now(), watchdog: null,
          };
          lease.watchdog = setInterval(() => {
            if (lease && Date.now() - lease.lastTouch > WATCHDOG_MS) release('watchdog');
          }, 1000);
        }
        requireLease(h);
        decisionContext(args);
        if (Number.isFinite(args.stepMs) && args.stepMs >= 50 && args.stepMs <= 1000) lease.actionStepMs = args.stepMs;
        clearInput(h.game);
        const mode = h.getState().mode;
        let started = false;
        if ((mode === 'title' && args.start === true)
          || ((mode === 'crashed' || mode === 'gameover') && args.retry === true)) {
          h.triggerAction(mode === 'title' ? 'start' : 'retry');
          epoch(h, true);
          started = true;
        }
        h.game.paused = false;
        h.game.manual = clockMode === 'step';
        h.game.simPaused = clockMode === 'step';
        if (clockMode === 'step') h.game.acc = 0;
        if (clockMode === 'realtime' && (!lease.metrics || started)) startMetrics(lease);
        h.game.hud?.showPause?.(false);
        h.render?.();
        return { ok: true, observation: observation(h) };
      }
      if (op === 'observe') {
        requireLease(h);
        decisionContext(args);
        if (Number.isFinite(args.stepMs) && args.stepMs >= 50 && args.stepMs <= 1000) lease.actionStepMs = args.stepMs;
        return { ok: true, observation: observation(h) };
      }
      if (op === 'act') {
        if (!ACTIONS.includes(args.action)) throw new Error('不支持的游戏动作。');
        const stepMs = args.stepMs ?? 200;
        if (!Number.isFinite(stepMs) || stepMs < 50 || stepMs > 1000) throw new Error('stepMs 必须在 50 到 1000 毫秒之间。');
        requireLease(h);
        if (lease.clockMode === 'realtime') {
          const maxAgeMs = args.maxAgeMs ?? 1500;
          if (!Number.isInteger(maxAgeMs) || maxAgeMs < 250 || maxAgeMs > 5000) {
            throw new Error('maxAgeMs 必须在 250 到 5000 毫秒之间。');
          }
          const current = observation(h);
          const rejected = reason => ({ ok: true, applied: false, reason, observation: current });
          if (current.mode !== 'playing') return rejected('game-ended');
          if (current.enginePaused) return rejected('game-paused');
          if (args.expectedEpoch !== current.epoch) return rejected('stale-epoch');
          const ageMs = Date.now() - args.observedAtMs;
          if (!Number.isFinite(args.observedAtMs) || ageMs < 0 || ageMs > maxAgeMs) {
            return rejected('stale-observation');
          }
          lease.actionStepMs = stepMs;
          const durationMs = args.action.startsWith('roll_') ? 32 * DT * 1000 : stepMs;
          // Preserve only genuine, already submitted native edges that have
          // not reached a tick yet. OR-ing the new choice does not duplicate a
          // boolean edge or synthesize another action from history/metadata.
          const pendingEdges = Object.fromEntries(OBSERVED_EDGE_KEYS
            .map(key => [key, Boolean(h.game.harness.edges[key])]));
          clearInput(h.game);
          for (const key of OBSERVED_EDGE_KEYS) h.game.harness.edges[key] = pendingEdges[key];
          try {
            applyAction(h, args.action, durationMs);
          } catch (error) {
            clearInput(h.game);
            throw error;
          }
          // No step(), rAF wrapper, accumulator reset, rendering loop or wait.
          // The next native physics tick consumes edges and counts down held
          // input. This observation confirms application, not its consequence.
          return { ok: true, applied: true, actionId: args.action, appliedAtMs: Date.now(),
            durationMs: number(durationMs), frames: null, simulatedMs: 0, observation: observation(h) };
        }
        if (h.getState().mode !== 'playing') throw new Error('本局已结束，请停止或显式重试。');
        if (args.expectedRevision !== undefined && args.expectedRevision !== observation(h).revision) {
          throw new Error('模型等待期间游戏状态已改变；本次动作未执行。');
        }
        lease.actionStepMs = stepMs;
        // A native roll lasts 0.5 s. Two extra frames finish it despite floating
        // point accumulation; no automatic follow-up action is inserted.
        const frames = args.action.startsWith('roll_') ? 32
          : Math.max(3, Math.min(60, Math.round(stepMs / (DT * 1000))));
        clearInput(h.game);
        try {
          applyAction(h, args.action, frames * DT * 1000);
          for (let i = 0; i < frames; i++) {
            // The public step harness advances exactly one real physics frame.
            h.step(DT, false);
            lease.frames++;
          }
        } finally {
          clearInput(h.game);
          h.game.manual = true;
          h.game.simPaused = true;
          h.render?.();
        }
        return { ok: true, frames, durationMs: number(frames * DT * 1000),
          simulatedMs: number(frames * DT * 1000), observation: observation(h) };
      }
      throw new Error('未知桥接命令。');
    } catch (error) {
      return { ok: false, error: String(error?.message || error).slice(0, 300) };
    }
  }

  Object.defineProperty(window, NAME, { value: Object.freeze({ version: 7, command }), configurable: true });
})();
