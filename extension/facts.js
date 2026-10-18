/* Source-derived consequences, not a controller. Every catalog action is
 * returned in its original order. No sorting, filtering or preferred action.
 * Forecasts use only current telemetry and deterministic public physics; they
 * never inspect the game's RNG or modify gameplay state. */
(() => {
  'use strict';
  const DT = 1 / 60;
  const IDS = Object.freeze(['coast', 'left', 'right', 'jump', 'fly', 'dive', 'boost',
    'roll_left', 'roll_right', 'roll_left_fly', 'roll_right_fly']);
  const MACRO_FRAMES = 32;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const value = (input, fallback) => finite(input) ? input : fallback;
  const round = input => finite(input) ? Math.round(input * 1000) / 1000 : null;
  const clamp = (input, low, high) => Math.max(low, Math.min(high, input));
  const center = lane => (lane - 2) * 3.6;
  const SHARED_UNCERTAINTY = Object.freeze([
    'All candidates use a collision-free control trajectory. Contact responses, pickups and new spawns are not simulated; projected state after an unprotected contact may be unreachable.',
    'Observed traffic extrapolates at current speed. Future braking, lane changes, sky motion and inference/frame timing are uncertain. Candidate-specific uncertainty below adds to these shared limitations.',
  ]);

  function controls(action) {
    const roll = action.startsWith('roll_');
    return {
      laneEdge: action === 'left' ? -1 : action === 'right' ? 1 : 0,
      rollEdge: roll ? (action.includes('_left') ? -1 : 1) : 0,
      thrust: action === 'fly' || action.endsWith('_fly'),
      hop: action === 'jump', dive: action === 'dive', boost: action === 'boost',
    };
  }

  function continuedInput(observation) {
    const observed = observation.observedInput;
    const edges = Object.fromEntries(['left', 'right', 'thrustPressed', 'rollLeft', 'rollRight']
      .map(key => [key, Boolean(observed?.edges?.[key])]));
    if (observed && typeof observed === 'object') return {
      source: 'observed-native-held-input',
      thrustRemainingMs: clamp(value(observed.thrustRemainingMs, 0), 0, 5000),
      diveRemainingMs: clamp(value(observed.diveRemainingMs, 0), 0, 5000),
      boostRemainingMs: clamp(value(observed.boostRemainingMs, 0), 0, 5000),
      edges,
    };
    const pending = observation.pendingAction;
    const known = pending && IDS.includes(pending.action);
    const previous = controls(known ? pending.action : 'coast');
    const remaining = known ? clamp(value(pending.remainingMs, 0), 0, 5000) : 0;
    // A previous hop holds thrust for only three native frames, even when the
    // decision interval is longer. Never replay its original press edge.
    const hopRemaining = previous.hop
      ? Math.max(0, 50 - (value(pending.durationMs, 50) - remaining)) : 0;
    return { source: known ? 'pending-action-held-input-estimate' : 'no-held-input-observed',
      thrustRemainingMs: previous.thrust ? remaining : hopRemaining,
      diveRemainingMs: previous.dive ? remaining : 0,
      boostRemainingMs: previous.boost ? remaining : 0, edges };
  }

  function forecast(observation, action, frames, latencyFrames = 0, continued = continuedInput(observation),
    coveredFrames = frames) {
    const p = observation.player;
    const candidateInput = controls(action);
    const entities = Array.isArray(observation.nearby) ? observation.nearby : [];
    const missing = ['x', 'y', 'z', 'speed', 'air', 'vy', 'targetLane']
      .filter(key => !finite(p?.[key]));
    if (missing.length) return {
      applicationDelayMs: round(latencyFrames * DT * 1000),
      rollAvailability: { requested: Boolean(candidateInput.rollEdge), canStartImmediately: null,
        inputEffect: 'unknown', airAtApplication: null, airMarginAboveCost: null,
        groundedRechargeMsToCost: null, expectedStartAfterMs: null },
      predictedEndLane: null, predictedAirCost: null, predictedEndHeight: null,
      immediateExpectedRollPoints: null, risk: { geometricContacts: [], uncertain: true },
      predictedLandings: null,
      latencyForecast: { estimatedLatencyMs: finite(observation.estimatedDecisionLatencyMs)
        ? observation.estimatedDecisionLatencyMs : null,
      simulatedLatencyMs: round(latencyFrames * DT * 1000), frames: latencyFrames,
      continuedInput: continued, edgeInputsReplayed: false, applicationState: null,
      applicationStateMayNotBeReachable: true,
      risk: { geometricContacts: [], unprotectedContactCount: null,
        firstUnprotectedAtMs: null, trajectoryUncertain: true, uncertain: true },
      predictedLandings: null, existingQueuedRollEvents: null,
      uncertainty: [`Missing player fields: ${missing.join(', ')}`] },
      uncertainty: [`Missing player fields: ${missing.join(', ')}`],
    };
    const state = {
      x: p.x, y: p.y, z: p.z, speed: p.speed, air: p.air, vy: p.vy,
      laneVelocity: value(p.vx, value(p.laneVelocity, 0)),
      lane: value(p.lane, p.targetLane), targetLane: p.targetLane,
      baseSpeed: value(p.baseSpeed, Math.max(26, 26 + value(observation.elapsedSeconds, 0) * .16)),
      grounded: Boolean(p.grounded), supportY: value(p.supportY, 0),
      rolling: Boolean(p.rolling), rollT: value(p.rollProgress, 0),
      rollCombo: value(p.rollCombo, 0), rollQueued: value(p.rollQueued, 0),
      rollQueuedOrigin: 'already-queued',
      rollIframe: value(p.rollIframe, 0), rocket: value(p.rocketTimer, 0),
      shield: value(p.shieldTimer, 0), grace: value(p.graceTimer, 0),
      chain: value(observation.chain, 0), chainTimer: value(observation.chainTimer, 0),
      multiplierTimer: value(p.multiplierTimer, 0),
      groundHold: value(p.groundHoldMs, 0) / 1000,
      airTime: value(p.airTime, value(observation.airTime, 0)),
    };
    const initialDistance = value(observation.distance, 0);
    const startZ = state.z;
    const contacts = [];
    const contactsByEntity = new Map();
    const rollEvents = [];
    const waitContacts = [];
    const waitContactsByEntity = new Map();
    const waitRollEvents = [];
    const landings = [];
    const waitLandings = [];
    let immediatePoints = 0;
    let airSpent = 0;
    let airRecovered = 0;
    let rampPhysicsUncertain = false;
    let application = null;
    let waitRiskUncertain = false;
    let rollAvailability = null;
    let candidateStartZ = state.z;
    let candidateSpentBefore = 0;
    let candidateRecoveredBefore = 0;
    const uncertainty = [];
    if (!finite(p.vx) && !finite(p.laneVelocity) && p.lane !== p.targetLane) {
      uncertainty.push('Current lateral velocity unavailable during a lane change.');
    }
    if (p.rolling && !finite(p.rollProgress)) uncertainty.push('Active roll progress unavailable.');
    if (state.rocket > 0) uncertainty.push('Rocket flight is forecast from its current remaining timer.');
    if (latencyFrames && state.grounded && continued.thrustRemainingMs > 0 && !finite(p.groundHoldMs)) {
      uncertainty.push('Existing grounded held-thrust timer is unobserved; its native 0.12 s takeoff delay is estimated from zero.');
    }

    function snapshot() {
      return { x: round(state.x), y: rampPhysicsUncertain ? null : round(state.y), z: round(state.z),
        vy: rampPhysicsUncertain ? null : round(state.vy), speed: round(state.speed),
        air: rampPhysicsUncertain ? null : round(state.air), lane: state.lane, targetLane: state.targetLane,
        grounded: rampPhysicsUncertain ? null : state.grounded,
        rolling: state.rolling, rollProgress: round(state.rollT), rollCombo: rampPhysicsUncertain ? null : state.rollCombo,
        rollQueued: state.rollQueued, supportY: rampPhysicsUncertain ? null : round(state.supportY),
        chain: state.chain, chainTimer: round(state.chainTimer) };
    }

    function captureApplication() {
      if (application) return;
      application = snapshot();
      waitRiskUncertain = rampPhysicsUncertain;
      candidateStartZ = state.z;
      candidateSpentBefore = airSpent;
      candidateRecoveredBefore = airRecovered;
      const requested = Boolean(candidateInput.rollEdge);
      const effect = !requested ? 'not-requested' : rampPhysicsUncertain ? 'unknown'
        : state.rolling ? state.rollT > .5 ? 'queues-after-current-roll' : 'ignored-during-first-half'
          : state.air < 8 ? 'insufficient-air' : 'starts-now';
      rollAvailability = { requested,
        canStartImmediately: !requested || rampPhysicsUncertain ? null : effect === 'starts-now',
        inputEffect: effect, airAtApplication: application.air,
        airMarginAboveCost: application.air === null ? null : round(state.air - 8),
        groundedRechargeMsToCost: application.air === null || !state.grounded ? null
          : round(Math.max(0, 8 - state.air) / 7 * 1000),
        effectiveDirection: latencyFrames === 0 && continued.edges.rollLeft ? -1
          : candidateInput.rollEdge || (latencyFrames === 0 && continued.edges.rollRight ? 1 : 0),
        expectedStartAfterMs: effect === 'starts-now' ? 0 : null };
    }

    function spend(amount) { const spent = Math.min(state.air, amount); state.air -= spent; airSpent += spent; }
    function recover(amount) { const gain = Math.min(100 - state.air, amount); state.air += gain; airRecovered += gain; }
    function changeLane(direction) {
      const target = state.targetLane + direction;
      if (target >= 0 && target < 5) state.targetLane = target;
      else state.laneVelocity -= direction * 3;
    }
    function startRoll(direction, frame, origin = 'candidate-input') {
      if (state.air < 8) return;
      spend(8);
      state.rolling = true; state.rollT = 0;
      state.rollCombo = state.grounded ? 1 : state.rollCombo + 1;
      // Unlike a normal lane-change key, rolling at the boundary does not
      // apply the _changeLane edge-bump impulse in the original engine.
      if (state.targetLane + direction >= 0 && state.targetLane + direction < 5) state.targetLane += direction;
      state.chain++; state.chainTimer = 4;
      const multiplier = (1 + Math.min(7, Math.floor(state.chain / 3)))
        * (state.multiplierTimer > 0 ? 2 : 1);
      const points = Math.round((state.rollCombo === 1 ? 80 : 120 * state.rollCombo) * multiplier);
      const duringWait = frame < latencyFrames;
      const atMs = round((duringWait ? frame : frame - latencyFrames) * DT * 1000);
      (duringWait ? waitRollEvents : rollEvents).push({ atMs, combo: state.rollCombo, points, origin });
      if (frame === latencyFrames) immediatePoints += points;
      if (state.grounded) { state.grounded = false; state.vy = 7.5; state.supportY = 0; }
      else if (state.vy < 2) state.vy = 2;
    }
    function positionAt(entity, seconds) {
      const speed = value(entity.speed, 0);
      return {
        x: value(entity.x, finite(entity.lane) ? center(entity.lane) : 0),
        y: value(entity.y, 0),
        z: finite(entity.z) ? entity.z - speed * seconds
          : startZ - value(entity.distanceAhead, 0) - speed * seconds,
      };
    }
    function supportAt(height, seconds) {
      let support = 0;
      for (const entity of entities) {
        if (entity.category !== 'ground-traffic') continue;
        const position = positionAt(entity, seconds);
        const length = value(entity.length, 4.6);
        if (Math.abs(position.x - state.x) > value(entity.width, 1.9) / 2 + .35
          || position.z - length / 2 >= state.z + 2.15
          || position.z + length / 2 <= state.z - 2.15) continue;
        let roof = value(entity.roofY, value(entity.height, 1.45));
        if (entity.ramp && finite(entity.ramp.length) && finite(entity.ramp.height)) {
          const rampAlong = position.z + length / 2 - Math.max(state.z - 2.15, position.z - length / 2);
          roof = rampAlong >= entity.ramp.length ? roof
            : entity.ramp.height * Math.max(0, rampAlong) / entity.ramp.length;
        }
        if (roof <= height + .7) {
          support = Math.max(support, roof);
          // The real engine retains climb time/rate and can automatically
          // launch from a carrier ramp/crest. Those state variables are not
          // observed here. Only a ramp that can actually support this control
          // trajectory makes its height/landing/resource forecast unknown.
          if (entity.ramp && (state.grounded
            || state.vy <= 0 && state.y + state.vy * DT <= roof)) {
            rampPhysicsUncertain = true;
          }
        }
      }
      return support;
    }
    function contact(entity, index, frame, category, protectedNow) {
      const key = `${index}:${category}`;
      const duringWait = frame < latencyFrames;
      const atMs = round((duringWait ? frame + 1 : frame - latencyFrames + 1) * DT * 1000);
      const map = duringWait ? waitContactsByEntity : contactsByEntity;
      const collection = duringWait ? waitContacts : contacts;
      const previous = map.get(key);
      if (previous) {
        // A protected first contact does not protect the rest of the action.
        // Keep inspecting every overlapping frame after shields/roll grace
        // expire instead of hiding a later, unprotected collision.
        if (!protectedNow) {
          previous.everUnprotected = true;
          previous.protectedByCurrentAction = false;
          if (previous.firstUnprotectedAtMs === null) previous.firstUnprotectedAtMs = atMs;
        }
        return;
      }
      const item = { category, kind: typeof entity.kind === 'string' ? entity.kind : category,
        atMs, protectedByCurrentAction: protectedNow, everUnprotected: !protectedNow,
        firstUnprotectedAtMs: protectedNow ? null : atMs };
      map.set(key, item);
      collection.push(item);
    }
    for (let frame = 0; frame < latencyFrames + coveredFrames; frame++) {
      const duringWait = frame < latencyFrames;
      if (!duringWait) captureApplication();
      const actionFrame = frame - latencyFrames;
      const input = duringWait ? {
        laneEdge: 0, rollEdge: 0, hop: false,
        thrust: frame * DT * 1000 < continued.thrustRemainingMs,
        dive: frame * DT * 1000 < continued.diveRemainingMs,
        boost: frame * DT * 1000 < continued.boostRemainingMs,
      } : actionFrame < frames ? candidateInput : controls('coast');
      // Only actual unconsumed booleans are merged. A historical action is
      // never replayed. When latency is zero, native OR semantics merge the
      // existing edge with the new candidate on this same first tick.
      const observedEdges = frame === 0 ? continued.edges : {};
      const candidateEdge = !duringWait && actionFrame === 0;
      const left = Boolean(observedEdges.left || candidateEdge && input.laneEdge < 0);
      const right = Boolean(observedEdges.right || candidateEdge && input.laneEdge > 0);
      const rollLeft = Boolean(observedEdges.rollLeft || candidateEdge && input.rollEdge < 0);
      const rollRight = Boolean(observedEdges.rollRight || candidateEdge && input.rollEdge > 0);
      const effectiveRoll = rollLeft ? -1 : rollRight ? 1 : 0;
      const seconds = (frame + 1) * DT;
      state.shield = Math.max(0, state.shield - DT);
      state.grace = Math.max(0, state.grace - DT);
      state.rollIframe = Math.max(0, state.rollIframe - DT);
      state.multiplierTimer = Math.max(0, state.multiplierTimer - DT);
      if (state.rocket > 0) {
        state.rocket = Math.max(0, state.rocket - DT);
        if (state.rocket === 0) state.grace = Math.max(state.grace, 1.2);
      }
      const rocket = state.rocket > 0;
      state.baseSpeed = Math.min(64, state.baseSpeed + .16 * DT);
      const difficulty = clamp((initialDistance + startZ - state.z) / 3000, 0, 1);
      const speedTarget = Math.max(state.baseSpeed, 26 + 38 * difficulty)
        * (rocket ? 1.5 : input.boost ? 1.45 : 1);
      state.speed += (speedTarget - state.speed)
        * (1 - Math.exp(-(speedTarget > state.speed ? 5.2 : 5) * DT));
      if (input.boost && !rocket && !state.grounded && state.air > 20) spend(Math.min(10 * DT, state.air - 20));
      // This is the original Player.update order: left, then right, then roll;
      // rollLeft wins over rollRight when both booleans are present.
      if (left) changeLane(-1);
      if (right) changeLane(1);
      if (effectiveRoll) {
          const origin = observedEdges.rollLeft || observedEdges.rollRight && !rollLeft
            ? 'observed-pending-edge' : 'candidate-input';
          if (state.rolling) { if (state.rollT > .5) {
            state.rollQueued = effectiveRoll; state.rollQueuedOrigin = origin;
          } }
          else startRoll(effectiveRoll, frame, origin);
      }
      if (state.rolling) {
        state.rollT += DT / .5;
        if (state.rollT >= 1) {
          state.rolling = false; state.rollT = 0; state.rollIframe = .12;
          if (state.rollQueued) {
            const queued = state.rollQueued; state.rollQueued = 0;
            startRoll(queued, frame, state.rollQueuedOrigin);
          }
        }
      }
      const spring = state.rolling ? 17 : 26;
      state.laneVelocity += (spring * spring * (center(state.targetLane) - state.x)
        - 2 * spring * state.laneVelocity) * DT;
      state.x += state.laneVelocity * DT;
      if (state.lane !== state.targetLane && Math.abs(center(state.targetLane) - state.x) < 1.08) {
        state.lane = state.targetLane;
      }
      const thrust = input.thrust || input.hop && actionFrame < 3;
      const pressThrust = Boolean(observedEdges.thrustPressed
        || candidateEdge && (input.thrust || input.hop));
      let justHopped = false;
      if (rocket) {
        state.vy += (30 * (14 - state.y) - 9 * state.vy) * DT;
        state.grounded = false; recover(7 * DT);
        state.y = Math.min(24, Math.max(0, state.y + state.vy * DT));
      } else {
        if (state.grounded) {
          const support = supportAt(state.y, frame * DT);
          if (pressThrust) {
            spend(6); state.grounded = false; state.vy = 12; state.supportY = 0; state.groundHold = 0; justHopped = true;
          } else if (thrust && state.air > 0 && (state.groundHold += DT) > .12) {
            state.grounded = false; state.vy = 9; state.supportY = 0; state.groundHold = 0;
          } else if (support < state.supportY - .05) {
            state.grounded = false; state.vy = 0;
          } else {
            state.y = support; state.supportY = support; state.vy = 0;
            if (!input.boost) recover(7 * DT);
          }
          if (!thrust || state.air <= 0) state.groundHold = 0;
        }
        if (!state.grounded) {
          state.airTime += DT;
          if (thrust && state.air > 0 && !input.dive && !justHopped) {
            spend(20 * DT);
            state.vy = state.vy < 9 ? Math.min(9, state.vy + 62 * DT) : Math.max(9, state.vy - 30 * DT);
            if (24 - state.y < 3) state.vy = Math.min(state.vy, Math.max(0, 24 - state.y) * 3);
          } else if (input.dive) state.vy = Math.max(-26, state.vy - 90 * DT);
          else state.vy = Math.max(-16, state.vy - (Math.abs(state.vy) < 3.5 ? 21.6 : 30) * DT);
          const support = supportAt(state.y, frame * DT);
          if (state.vy < -9 && state.y - support < 3.2 && !input.dive) state.vy += 55 * DT;
          state.y += state.vy * DT;
          if (state.y > 24) { state.y = 24; state.vy = Math.min(state.vy, 0); }
          if (state.vy <= 0 && state.y <= support) {
            (duringWait ? waitLandings : landings).push({
              atMs: round((duringWait ? frame + 1 : actionFrame + 1) * DT * 1000),
              altitude: round(support), lane: state.lane, x: round(state.x),
            });
            if (state.airTime >= 1.6) { state.chain++; state.chainTimer = 4; }
            state.airTime = 0;
            state.y = support; state.supportY = support; state.grounded = true;
            state.vy = 0; state.rollCombo = 0;
          }
        }
      }
      state.z -= state.speed * DT;
      state.chainTimer = Math.max(0, state.chainTimer - DT);
      if (state.chainTimer === 0) state.chain = 0;
      const protectedNow = state.rolling || state.rollIframe > 0 || state.shield > 0 || state.grace > 0 || rocket;
      for (let index = 0; index < entities.length; index++) {
        const entity = entities[index];
        if (entity.category === 'collectible') continue;
        const position = positionAt(entity, seconds);
        const longitudinal = Math.abs(state.z - position.z);
        if (entity.category === 'hazard') {
          const minZ = state.z - 2.15, maxZ = state.z + 2.15;
          if (minZ <= position.z + .65 + state.speed * DT * .7 && maxZ >= position.z - 1.15
            && Math.abs(state.x) <= 11.8
            && state.y + 1.15 > value(entity.minCollisionY, 6.95)
            && state.y < value(entity.maxCollisionY, 11.1)) {
            contact(entity, index, frame, 'overhead', protectedNow);
          }
        } else if (entity.category === 'ground-traffic') {
          if (longitudinal < (value(entity.length, 4.6) + 4.3) / 2
            && Math.abs(state.x - position.x) < (value(entity.width, 1.9) + 1.9) / 2
            && state.y < value(entity.roofY, value(entity.height, 1.45)) - .7) {
            contact(entity, index, frame, 'ground-traffic', protectedNow);
          }
        } else if (entity.category === 'air-traffic' && !(state.grounded && state.supportY < .5)) {
          if (longitudinal < (value(entity.length, 4.3) + 4.3) / 2 + .35 + state.speed * DT * .65
            && Math.abs(state.x - position.x) < value(entity.width, 2) * .54 + .95
            && state.y < position.y + value(entity.height, 1.15) + 1.15
            && state.y + 1.15 > position.y - .85) {
            contact(entity, index, frame, 'air-traffic', protectedNow);
          }
        }
      }
    }
    captureApplication();
    const nextRequestedRoll = rollEvents.find(event => event.origin === 'candidate-input');
    if (nextRequestedRoll && !waitRiskUncertain) rollAvailability.expectedStartAfterMs = nextRequestedRoll.atMs;
    if (rampPhysicsUncertain) uncertainty.push(
      'This trajectory contacts a carrier ramp/crest. Native automatic ramp launch depends on unobserved climb history; height, vertical speed, landing, energy and later combo forecasts are unknown. Contact estimates below use the nominal trajectory only.');
    function summarizeRisk(items, trajectoryUncertain, offsetMs = 0) {
      const unprotected = items.filter(item => item.everUnprotected);
      const first = unprotected.length ? Math.min(...unprotected.map(item => item.firstUnprotectedAtMs)) : null;
      return { geometricContacts: items.slice(0, 6),
        unprotectedContactCount: trajectoryUncertain ? null : unprotected.length,
        firstUnprotectedAtMs: trajectoryUncertain ? null : first,
        firstUnprotectedFromObservationMs: trajectoryUncertain || first === null ? null : round(offsetMs + first),
        trajectoryUncertain, uncertain: true };
    }
    const waitRisk = summarizeRisk(waitContacts, waitRiskUncertain);
    return {
      applicationDelayMs: round(latencyFrames * DT * 1000),
      rollAvailability,
      predictedEndLane: state.targetLane, predictedEndX: round(state.x),
      predictedEndHeight: rampPhysicsUncertain ? null : round(state.y),
      predictedEndVerticalSpeed: rampPhysicsUncertain ? null : round(state.vy),
      predictedEndAir: rampPhysicsUncertain ? null : round(state.air),
      predictedAirCost: rampPhysicsUncertain ? null : round(airSpent - candidateSpentBefore),
      predictedAirRecovery: rampPhysicsUncertain ? null : round(airRecovered - candidateRecoveredBefore),
      predictedDistance: round(candidateStartZ - state.z),
      immediateExpectedRollPoints: waitRiskUncertain ? null : immediatePoints,
      expectedRollPointsDuringAction: waitRiskUncertain || rampPhysicsUncertain && rollEvents.some(event => event.atMs > 0)
        ? null : rollEvents.reduce((sum, event) => sum + event.points, 0),
      expectedRollEvents: waitRiskUncertain ? null : rollEvents,
      predictedEndCombo: rampPhysicsUncertain ? null : state.rollCombo,
      predictedGrounded: rampPhysicsUncertain ? null : state.grounded,
      predictedLandings: rampPhysicsUncertain ? null : landings.slice(0, 2),
      risk: summarizeRisk(contacts, rampPhysicsUncertain, latencyFrames * DT * 1000),
      latencyForecast: {
        estimatedLatencyMs: finite(observation.estimatedDecisionLatencyMs) ? observation.estimatedDecisionLatencyMs : null,
        simulatedLatencyMs: round(latencyFrames * DT * 1000), frames: latencyFrames,
        continuedInput: continued, edgeInputsReplayed: false,
        observedPendingEdgesConsumedOnce: continued.edges,
        applicationState: application,
        applicationStateMayNotBeReachable: waitRisk.unprotectedContactCount > 0 || waitRiskUncertain,
        risk: waitRisk, predictedLandings: waitRiskUncertain ? null : waitLandings.slice(0, 2),
        existingQueuedRollEvents: waitRiskUncertain ? null : waitRollEvents,
        uncertainty: [
          'Estimated latency is rounded to 60 Hz; actual response/frame timing can differ. Future traffic reactions, pickups and new spawns are unknown.',
          'Existing held inputs expire during the wait. Actual observed pending edge booleans are consumed once on the first tick; no edge is recreated from prior-action metadata. Native rolling/queued state continues.',
          ...(waitRisk.unprotectedContactCount > 0 ? ['An unprotected contact is predicted BEFORE this choice could be applied; no candidate can undo that delay-window contact.'] : []),
          ...(waitRiskUncertain ? ['A carrier ramp/crest affects the wait; the application height, energy and landing state are unknown.'] : []),
          ...(observation.clockMode === 'realtime' && !finite(observation.estimatedDecisionLatencyMs)
            ? ['Decision latency was not supplied. A zero-delay compatibility forecast is not a guarantee of realtime safety.'] : []),
        ],
      },
      uncertainty,
    };
  }

  function describe(observation) {
    if (!observation || typeof observation !== 'object') throw new TypeError('Observation must be an object.');
    const normalFrames = clamp(Math.round(value(observation.actionStepMs, 200) / (DT * 1000)), 3, 60);
    const latencyFrames = observation.clockMode === 'realtime'
      ? Math.round(clamp(value(observation.estimatedDecisionLatencyMs, 0), 0, 5000) / (DT * 1000)) : 0;
    const continued = continuedInput(observation);
    const candidates = {};
    let latencyForecast = null;
    for (const action of IDS) {
      const frames = action.startsWith('roll_') ? MACRO_FRAMES : normalFrames;
      const coveredFrames = observation.clockMode === 'realtime' ? Math.max(frames, latencyFrames) : frames;
      const prediction = forecast(observation, action, frames, latencyFrames, continued, coveredFrames);
      latencyForecast ??= prediction.latencyForecast ?? null;
      delete prediction.latencyForecast;
      candidates[action] = {
        durationMs: round(frames * DT * 1000), frames, controls: controls(action),
        effectiveHeldDurationMs: action === 'jump' ? 50
          : controls(action).thrust || controls(action).boost || controls(action).dive ? round(frames * DT * 1000) : 0,
        coveredDurationMs: round(coveredFrames * DT * 1000),
        afterHeldExpiry: coveredFrames > frames ? 'All candidate-held controls expire; native coasting continues until the covered horizon. No follow-up action is chosen.' : null,
        ...prediction,
      };
    }
    return {
      horizon: 'In realtime, current held input and actual pending native edges continue through estimated latency. Candidate effects then cover max(control duration, estimated next-decision latency); controls expire at effectiveHeldDurationMs and remaining time is native coasting. No follow-up action is chosen.',
      model: 'Source-derived 60 Hz vehicle physics; latency-aware constant-current-velocity observed traffic; no future RNG.',
      uncertainty: [...SHARED_UNCERTAINTY],
      latencyForecast,
      rules: {
        scoring: 'Distance earns current multiplier points per metre. Airborne roll combo n earns (n=1 ? 80 : 120*n) times the multiplier AFTER adding that trick to chain. Multiplier=(1+min(7,floor(chain/3)))*(active multiplier pickup ? 2 : 1). Landing resets airborne roll combo; chain expires after 4 seconds without another trick.',
        rolling: 'A roll costs 8 air, lasts 0.5 s, and grants invulnerability while rolling plus 0.12 s afterward. It changes one lane when possible. A roll on ground hops at vy=7.5; an airborne roll raises vy to at least 2. Input during the second half of a roll queues one further roll.',
        thrust: 'Held thrust costs 20 air/s while airborne, reaches upward vy=9 and altitude limit 24. A fresh thrust press on ground hops at cost 6. Grounded coasting restores 7 air/s. roll_*_fly means the roll edge plus held thrust for all 32 frames.',
        latency: 'Candidate consequences and rollAvailability start at the ESTIMATED application state, after continuing observed held input and consuming actual observed pending edges once. No edge is recreated from prior-action metadata. A roll with air<8 does not start or protect; a roll input in the first half of an active roll is ignored; in the second half it queues and still needs 8 air when starting. groundedRechargeMsToCost assumes remaining grounded without boosting. coveredDurationMs includes native coasting after effectiveHeldDurationMs expires, without a chosen follow-up. Compare shared wait risk and candidate risk; timing and omitted traffic reactions remain uncertain.',
        overhead: 'Overhead signs span every lane: collision if player top>6.95 and bottom<11.1 during longitudinal overlap. A grounded car passes below. Current invulnerability protects against sign collisions.',
        honesty: 'All 11 actions remain available in fixed catalog order. Consequences are estimates, not recommendations. Only the external model selects the executed action. No score, RNG, preset, vehicle position or collision state is changed.',
      },
      candidates,
    };
  }
  const api = Object.freeze({ version: 4, describe });
  Object.defineProperty(window, '__ROADSTER_FACTS__', { value: api, configurable: true });
})();
