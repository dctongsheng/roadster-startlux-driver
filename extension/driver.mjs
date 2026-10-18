import { ACTIONS } from './decision.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  endpoint: 'http://127.0.0.1:18080/v1/systemone',
  model: '', stepMs: 200, maxSteps: 300, targetScore: 0, autoRetry: false,
  thinkMode: 'off', thinkBudget: 0, clockMode: 'realtime', maxDecisionAgeMs: 1500,
});

export function validateConfig(input, validateEndpoint) {
  const c = { ...DEFAULT_CONFIG, ...input };
  c.endpoint = validateEndpoint(c.endpoint);
  if (typeof c.model !== 'string' || c.model.length > 200) throw new Error('模型名称无效。');
  c.model = c.model.trim();
  for (const [name, min, max] of [['stepMs', 50, 1000], ['maxSteps', 1, 10000], ['targetScore', 0, 10000000], ['thinkBudget', 0, 32768], ['maxDecisionAgeMs', 250, 5000]]) {
    if (!Number.isInteger(c[name]) || c[name] < min || c[name] > max) {
      throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数。`);
    }
  }
  if (typeof c.autoRetry !== 'boolean' || !['off', 'auto'].includes(c.thinkMode)) throw new Error('运行配置无效。');
  if (!['realtime', 'step'].includes(c.clockMode)) throw new Error('clockMode 必须为 realtime 或 step。');
  if (c.thinkMode === 'auto' && c.thinkBudget < 1) {
    throw new Error('自动思考的 thinkBudget 必须是 1 到 32768 之间的整数；建议使用 4096。');
  }
  if (c.thinkMode === 'off') c.thinkBudget = 0;
  return Object.fromEntries(Object.keys(DEFAULT_CONFIG).map(k => [k, c[k]]));
}

const ended = observation => ['crashed', 'gameover'].includes(observation.mode);
const actualNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const confirmedState = observation => ({
  score: actualNumber(observation.score), distance: actualNumber(observation.distance),
  mode: observation.mode ?? null, chain: actualNumber(observation.chain),
  multiplier: actualNumber(observation.multiplier),
  lane: actualNumber(observation.player?.lane),
  targetLane: actualNumber(observation.player?.targetLane),
  x: actualNumber(observation.player?.x), y: actualNumber(observation.player?.y),
  speed: actualNumber(observation.player?.speed), vy: actualNumber(observation.player?.vy),
  grounded: typeof observation.player?.grounded === 'boolean' ? observation.player.grounded : null,
  air: actualNumber(observation.player?.air),
  rollCombo: actualNumber(observation.player?.rollCombo),
  rollProgress: actualNumber(observation.player?.rollProgress),
});

/** Native time runs independently in realtime mode; every input is a raw model choice. */
export class Driver {
  constructor(deps) {
    this.deps = deps;
    this.generation = 0;
    this.controller = null;
    this.pending = null;
    this.session = null;
    this.status = { running: false, steps: 0, runs: 0, history: [], source: 'game-telemetry' };
  }
  snapshot() { return structuredClone(this.status); }
  publish() { this.deps.publish?.(this.snapshot()); }
  async start(config, key, single = false) {
    if (this.status.running || this.pending) throw new Error('驾驶员正在运行，请先停止。');
    if (!key) throw new Error('请先填写并保存 API Key。');
    const generation = ++this.generation;
    const controller = this.controller = new AbortController();
    const sessionStartedAtMs = Math.max(this.deps.wallNow?.() ?? Date.now(),
      (this.status.sessionStartedAtMs ?? -1) + 1);
    const sessionId = this.deps.createSessionId?.() ?? globalThis.crypto?.randomUUID?.()
      ?? `roadster-${sessionStartedAtMs}-${generation}-${Math.random().toString(36).slice(2)}`;
    this.status = {
      sessionId, sessionStartedAtMs,
      running: true, steps: 0, runs: 1, history: [], source: 'game-telemetry', phase: 'connecting',
      targetScore: config.targetScore ?? DEFAULT_CONFIG.targetScore, targetReached: false,
      clockMode: single ? 'step' : (config.clockMode ?? DEFAULT_CONFIG.clockMode),
      requests: 0, staleResponses: 0, decisions: [],
      aspirationScore: 6000,
    };
    this.publish();
    // Assign immediately, so Stop can await acquisition and cannot leak a lock.
    this.pending = this.run(generation, config, key, single, controller.signal)
      .catch(error => {
        if (generation === this.generation) this.status.error = error.message || '运行失败。';
      })
      .finally(async () => {
        const session = this.session;
        if (session) {
          try { await this.deps.bridge(session.tabId, 'release'); } catch { /* page watchdog handles a lost tab */ }
          if (this.session === session) this.session = null;
        }
        if (generation === this.generation) {
          this.status.running = false;
          this.status.phase = this.status.error ? 'error' : this.status.targetReached ? 'success' : 'stopped';
        }
        this.pending = null;
        this.publish();
      });
    if (single) await this.pending;
    return this.snapshot();
  }
  async run(generation, config, key, single, signal) {
    if (!single && (config.clockMode ?? DEFAULT_CONFIG.clockMode) === 'realtime') {
      return this.runRealtime(generation, config, key, signal);
    }
    return this.runStepped(generation, config, key, single, signal);
  }
  async runRealtime(generation, config, key, signal) {
    const current = () => {
      if (signal.aborted || generation !== this.generation) {
        const error = new Error('运行已停止。'); error.name = 'AbortError'; throw error;
      }
    };
    const tab = await this.deps.target(); current();
    this.status.tabId = tab.id;
    await this.deps.install(tab.id); current();
    this.session = { tabId: tab.id };
    let { observation } = await this.deps.bridge(tab.id, 'acquire', {
      clockMode: 'realtime', start: true, retry: true, stepMs: config.stepMs,
    });
    current();
    let pendingAction = null;
    const observeOptions = () => ({
      stepMs: config.stepMs,
      estimatedDecisionLatencyMs: this.status.latencyMs ?? 500,
      pendingAction: pendingAction ? { action: pendingAction.action,
        appliedAtMs: pendingAction.appliedAtMs, durationMs: pendingAction.durationMs } : null,
    });
    let currentEpoch = observation.epoch;
    const update = obs => {
      if (currentEpoch !== undefined && obs.epoch !== undefined && obs.epoch !== currentEpoch) {
        // A native retry can happen during an in-flight request. Never turn
        // two different games into a fabricated before/after transition.
        pendingAction = null;
        this.status.runs++;
        this.status.action = null;
      }
      currentEpoch = obs.epoch;
      this.status.epoch = obs.epoch ?? null;
      this.status.observation = obs;
      this.status.realtimeMetrics = obs.realtimeMetrics ?? null;
    };
    // These are confirmed observation intervals, not instantaneous action
    // rewards. They may include a coasting gap after a held input has expired.
    const confirm = (obs, interrupt = false) => {
      if (!pendingAction) return;
      const elapsed = actualNumber(obs.observedAtMs) === null ? null : Math.max(0, obs.observedAtMs - pendingAction.appliedAtMs);
      if (!interrupt && !ended(obs) && (elapsed === null || elapsed < pendingAction.durationMs)) return;
      const before = pendingAction.before;
      const after = confirmedState(obs);
      const confirmed = {
        step: pendingAction.step, run: this.status.runs, action: pendingAction.action,
        confidence: pendingAction.confidence, latencyMs: pendingAction.latencyMs,
        beforeRevision: pendingAction.beforeRevision, afterRevision: obs.revision ?? null,
        before, after, score: obs.score, distance: obs.distance,
        scoreDelta: before.score === null || after.score === null ? null : after.score - before.score,
        frames: null, durationMs: pendingAction.durationMs, observedIntervalMs: elapsed,
        inputInterrupted: elapsed !== null && elapsed < pendingAction.durationMs,
        includesCoastingGap: elapsed !== null && elapsed > pendingAction.durationMs,
        feedbackKind: 'observed-realtime-interval', at: Date.now(),
      };
      this.status.history.unshift(confirmed);
      const receipt = this.status.decisions.find(item => item.step === pendingAction.step && item.run === this.status.runs);
      if (receipt) receipt.outcome = confirmed;
      this.status.history.length = Math.min(50, this.status.history.length);
      pendingAction = null;
    };
    const target = obs => this.status.targetScore > 0 && actualNumber(obs.score) !== null && obs.score >= this.status.targetScore;
    update(observation); this.publish();
    const limit = config.maxSteps ?? DEFAULT_CONFIG.maxSteps;
    for (let request = 0; request < limit; request++) {
      current(); await this.deps.checkTab(tab.id); current();
      ({ observation } = await this.deps.bridge(tab.id, 'observe', observeOptions())); current();
      update(observation); confirm(observation);
      if (ended(observation)) {
        confirm(observation, true);
        if (!config.autoRetry) { this.status.reason = '本局结束'; return; }
        ({ observation } = await this.deps.bridge(tab.id, 'acquire', {
          clockMode: 'realtime', retry: true, stepMs: config.stepMs,
        })); current();
        pendingAction = null; update(observation);
      }
      if (target(observation)) {
        confirm(observation, true); this.status.targetReached = true;
        this.status.reason = '达到目标分数，已退出接管（游戏继续）'; return;
      }
      if (observation.mode !== 'playing' || observation.enginePaused) {
        confirm(observation, true); this.status.reason = '原游戏已暂停或离开驾驶状态，已退出接管'; return;
      }
      const begin = this.deps.now();
      const suppliedObservation = {
        ...observation, clockMode: 'realtime', targetScore: this.status.targetScore,
        actionStepMs: config.stepMs,
        estimatedDecisionLatencyMs: this.status.latencyMs ?? 500,
        pendingAction: pendingAction ? {
          action: pendingAction.action, appliedAtMs: pendingAction.appliedAtMs,
          durationMs: pendingAction.durationMs,
          remainingMs: Math.max(0, pendingAction.durationMs - (observation.observedAtMs - pendingAction.appliedAtMs)),
        } : null,
        confirmedHistory: this.status.history.filter(item => item.run === this.status.runs).slice(0, 6).toReversed(),
      };
      this.status.phase = 'deciding'; this.status.requests++; this.publish();
      // One in-flight request. The browser's own rAF keeps running throughout.
      const result = await this.deps.decide(config.endpoint, key, suppliedObservation, {
        ...config, previousDecision: this.status.action, latencyMs: this.status.latencyMs,
      }, signal);
      current();
      if (!Object.hasOwn(ACTIONS, result.action)) throw new Error('模型返回了未知动作。');
      await this.deps.checkTab(tab.id); current();
      const latencyMs = Math.round(this.deps.now() - begin);
      this.status.latencyMs = latencyMs;
      this.status.actualModel = result.model || this.status.actualModel || '';
      ({ observation } = await this.deps.bridge(tab.id, 'observe', observeOptions())); current();
      update(observation);
      const receipt = {
        request: this.status.requests, run: this.status.runs, action: result.action,
        confidence: result.confidence ?? null, model: result.model || '', latencyMs,
        thinking: result.thinking ?? null,
        requestRevision: suppliedObservation.revision, requestEpoch: suppliedObservation.epoch,
        requestObservedAtMs: suppliedObservation.observedAtMs,
        requestObservation: confirmedState(suppliedObservation),
        appliedObservation: confirmedState(observation),
        estimatedDecisionLatencyMs: suppliedObservation.estimatedDecisionLatencyMs,
        pendingAtRequest: suppliedObservation.pendingAction,
        latencyForecast: suppliedObservation.actionFacts?.latencyForecast ?? null,
        predictionSummary: suppliedObservation.actionFacts?.candidates?.[result.action] ?? null,
        snapshotAgeMs: Number.isFinite(observation.observedAtMs) && Number.isFinite(suppliedObservation.observedAtMs)
          ? observation.observedAtMs - suppliedObservation.observedAtMs : null,
      };
      if (ended(observation)) {
        confirm(observation, true);
        this.status.decisions.unshift({ ...receipt, step: null, applied: false, reason: 'game-ended', appliedRevision: null });
        if (!config.autoRetry) { this.status.reason = '本局结束'; return; }
        continue;
      }
      if (observation.enginePaused) {
        confirm(observation, true); this.status.reason = '原游戏已暂停，已退出接管'; return;
      }
      const applied = await this.deps.bridge(tab.id, 'act', {
        action: result.action, stepMs: config.stepMs, expectedEpoch: suppliedObservation.epoch,
        observedAtMs: suppliedObservation.observedAtMs,
        maxAgeMs: config.maxDecisionAgeMs ?? DEFAULT_CONFIG.maxDecisionAgeMs,
      }); current();
      update(applied.observation);
      this.status.decisions.unshift({ ...receipt,
        step: applied.applied ? this.status.steps + 1 : null,
        applied: applied.applied === true, reason: applied.reason ?? null,
        appliedRevision: applied.observation.revision ?? null,
        appliedAtMs: actualNumber(applied.appliedAtMs) ?? actualNumber(applied.observation.observedAtMs),
        durationMs: actualNumber(applied.durationMs) });
      this.status.decisions.length = Math.min(200, this.status.decisions.length);
      if (applied.applied) {
        confirm(observation, true);
        this.status.steps++; this.status.action = result.action;
        this.status.confidence = result.confidence ?? null;
        pendingAction = {
          step: this.status.steps, action: result.action, confidence: result.confidence ?? null,
          latencyMs, before: confirmedState(observation), beforeRevision: observation.revision ?? null,
          appliedAtMs: applied.observation.observedAtMs, durationMs: applied.durationMs,
        };
      } else {
        confirm(applied.observation);
        this.status.staleResponses++;
        if (applied.reason === 'game-ended') {
          confirm(applied.observation, true);
          if (!config.autoRetry) { this.status.reason = '本局结束'; return; }
        }
      }
      this.status.phase = 'acting'; this.publish();
      await this.deps.yield();
    }
    ({ observation } = await this.deps.bridge(tab.id, 'observe', observeOptions())); current();
    update(observation); confirm(observation, true);
    this.status.reason = ended(observation) ? '本局结束' : '达到决策次数上限，已退出接管（游戏继续）';
  }
  async runStepped(generation, config, key, single, signal) {
    const assertCurrent = () => {
      if (signal.aborted || generation !== this.generation) {
        const error = new Error('运行已停止。'); error.name = 'AbortError'; throw error;
      }
    };
    const reachedTarget = observation => {
      if (!(this.status.targetScore > 0) || actualNumber(observation.score) === null || observation.score < this.status.targetScore) return false;
      this.status.observation = observation;
      this.status.targetReached = true;
      this.status.reason = '达到目标分数';
      return true;
    };
    const tab = await this.deps.target();
    assertCurrent();
    this.status.tabId = tab.id;
    await this.deps.install(tab.id);
    assertCurrent();
    // Track a provisional lease before acquire, so even a lost Chrome reply
    // is followed by best-effort release rather than waiting for the watchdog.
    this.session = { tabId: tab.id };
    const acquired = await this.deps.bridge(tab.id, 'acquire', { clockMode: 'step', start: true, retry: true, stepMs: config.stepMs });
    assertCurrent();
    this.status.observation = acquired.observation;
    this.publish();
    if (reachedTarget(acquired.observation)) return;
    const limit = single ? 1 : config.maxSteps;
    let endReason;
    for (let step = 0; step < limit; step++) {
      assertCurrent();
      await this.deps.checkTab(tab.id);
      assertCurrent();
      let { observation } = await this.deps.bridge(tab.id, 'observe', { stepMs: config.stepMs });
      if (reachedTarget(observation)) return;
      if (ended(observation)) {
        this.status.observation = observation;
        if (!config.autoRetry || single) { endReason = '本局结束'; break; }
        ({ observation } = await this.deps.bridge(tab.id, 'acquire', { retry: true, stepMs: config.stepMs }));
        this.status.runs++;
        if (reachedTarget(observation)) return;
      }
      if (observation.mode !== 'playing') throw new Error(`游戏尚未进入驾驶状态（${observation.mode}）。`);
      this.status.phase = 'deciding';
      this.status.observation = observation;
      this.publish();
      const begin = this.deps.now();
      const decisionObservation = {
        ...observation,
        targetScore: this.status.targetScore,
        actionStepMs: config.stepMs,
        confirmedHistory: this.status.history.filter(item => item.run === this.status.runs).slice(0, 6).toReversed(),
      };
      const result = await this.deps.decide(config.endpoint, key, decisionObservation, {
        ...config, previousDecision: this.status.action, latencyMs: this.status.latencyMs,
      }, signal);
      assertCurrent();
      if (!Object.hasOwn(ACTIONS, result.action)) throw new Error('模型返回了未知动作。');
      await this.deps.checkTab(tab.id);
      assertCurrent();
      const latencyMs = Math.round(this.deps.now() - begin);
      const applied = await this.deps.bridge(tab.id, 'act', {
        action: result.action, stepMs: config.stepMs, expectedRevision: observation.revision,
      });
      assertCurrent();
      this.status.steps++;
      this.status.phase = 'acting';
      this.status.action = result.action;
      this.status.confidence = result.confidence ?? null;
      this.status.latencyMs = latencyMs;
      this.status.actualModel = result.model || this.status.actualModel || '';
      this.status.observation = applied.observation;
      const before = confirmedState(observation);
      const after = confirmedState(applied.observation);
      this.status.history.unshift({
        step: this.status.steps, run: this.status.runs, action: result.action, confidence: result.confidence ?? null,
        latencyMs, score: applied.observation.score, distance: applied.observation.distance, at: Date.now(),
        beforeRevision: observation.revision ?? null, afterRevision: applied.observation.revision ?? null,
        frames: actualNumber(applied.frames), durationMs: actualNumber(applied.simulatedMs),
        before, after, scoreDelta: before.score === null || after.score === null ? null : after.score - before.score,
      });
      this.status.history.length = Math.min(50, this.status.history.length);
      this.publish();
      if (reachedTarget(applied.observation)) return;
      if (ended(applied.observation) && (!config.autoRetry || single || this.status.steps >= limit)) {
        endReason = '本局结束';
        break;
      }
      // An event-loop boundary lets Stop/navigation messages interrupt repeated fast replies.
      await this.deps.yield();
    }
    this.status.reason = endReason || (single ? '单步完成' : this.status.steps >= limit ? '达到步数上限' : '本局结束');
  }
  async stop() {
    ++this.generation;
    this.controller?.abort();
    this.status.running = false;
    this.status.phase = 'stopping';
    this.publish();
    // Release immediately while a decision is in flight. run() checks generation
    // again after network return, so a late response can never move the car.
    const session = this.session;
    if (session) {
      try { await this.deps.bridge(session.tabId, 'release'); } catch { /* tab may be gone */ }
    }
    if (this.pending) await this.pending;
    this.status.phase = 'stopped';
    this.status.reason = '手动停止';
    this.publish();
    return this.snapshot();
  }
}
