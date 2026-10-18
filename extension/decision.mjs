/**
 * The supplied endpoint implements the SystemOne decision protocol.
 * A configured display name does not establish which model the server runs.
 * Thinking is off by default, mapped to the gateway's `never` wire mode.
 */

const action = (label, keys, description) => Object.freeze({
  label,
  keys: Object.freeze(keys),
  description,
});

export const ACTIONS = Object.freeze({
  coast: action('保持方向', [], '保持当前车道，不触发跳跃、加速或额外输入。'),
  left: action('向左换道', ['KeyA'], '向左切换一条车道，注意目标车道的近处车辆。'),
  right: action('向右换道', ['KeyD'], '向右切换一条车道，注意目标车道的近处车辆。'),
  jump: action('短跳', ['Space'], '触发一次短跳，推力持续约 3 帧，用于越过适合跳过的障碍。'),
  fly: action('喷气飞行', ['Space'], '在本动作期间持续按住空格向上喷气；考虑空中车辆及落地点。'),
  dive: action('向下俯冲', ['KeyS'], '在本动作期间向下喷气俯冲，注意地面车辆。'),
  boost: action('向前加速', ['KeyW'], '在本动作期间向前喷气加速，仅在前方有足够安全空间时使用。'),
  roll_left: action('向左翻滚', ['KeyQ'], '触发原生向左翻滚，控制窗口为 32 帧对应的约 533 ms；边界不再换道，能量不足不启动翻滚。'),
  roll_right: action('向右翻滚', ['KeyE'], '触发原生向右翻滚，控制窗口为 32 帧对应的约 533 ms；边界不再换道，能量不足不启动翻滚。'),
  roll_left_fly: action('向左翻滚并喷气', ['KeyQ', 'Space'], '触发原生向左翻滚，同时在约 533 ms 控制窗口持续向上喷气；分别消耗翻滚和喷气能量。'),
  roll_right_fly: action('向右翻滚并喷气', ['KeyE', 'Space'], '触发原生向右翻滚，同时在约 533 ms 控制窗口持续向上喷气；分别消耗翻滚和喷气能量。'),
});

const OWN = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const LOCAL_PORTS = new Set(['18080', '18081']);
const HTTPS_HOSTS = new Set(['api.typesafe.ai']);
// The raw snapshot contains duplicate per-candidate uncertainty text before
// lossless request compaction. Allow bounded room for latency forecasts.
const MAX_OBSERVATION_CHARS = 65536;

/** Return the canonical URL only for the explicitly supported API endpoints. */
export function validateEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('请填写决策接口 URL。');
  }
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError('决策接口 URL 无效。');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError('决策接口 URL 不得包含账号、密码、查询参数或片段。');
  }
  if (endpoint.pathname !== '/v1/systemone') {
    throw new TypeError('决策接口路径必须是 /v1/systemone。');
  }
  const local = endpoint.protocol === 'http:'
    && LOCAL_HOSTS.has(endpoint.hostname)
    && LOCAL_PORTS.has(endpoint.port);
  const hosted = endpoint.protocol === 'https:'
    && HTTPS_HOSTS.has(endpoint.hostname)
    && (endpoint.port === '' || endpoint.port === '443');
  if (!local && !hosted) {
    throw new TypeError('接口仅允许已配置的本机地址或 https://api.typesafe.ai。');
  }
  return endpoint.href;
}

function integerSetting(value, fallback, min, max, name) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new TypeError(`${name} 必须是 ${min} 到 ${max} 之间的整数。`);
  }
  return result;
}

function serializeObservation(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    throw new TypeError('游戏观测必须是一个 JSON 对象。');
  }
  let serialized;
  try {
    serialized = JSON.stringify(observation, (_key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new TypeError('观测数值必须是有限数。');
      }
      if (['function', 'symbol', 'bigint', 'undefined'].includes(typeof value)) {
        throw new TypeError('观测仅可包含 JSON 值。');
      }
      return value;
    });
  } catch {
    throw new TypeError('游戏观测必须是有效 JSON，数值必须有限，且不能包含循环引用。');
  }
  if (serialized.length > MAX_OBSERVATION_CHARS) {
    throw new TypeError(`游戏观测超过 ${MAX_OBSERVATION_CHARS} 字符。`);
  }
  return JSON.parse(serialized);
}

function actionCriteria(telemetry) {
  const facts = telemetry.actionFacts;
  if (facts !== undefined) {
    const candidates = facts?.candidates;
    if (!candidates || typeof candidates !== 'object' || Array.isArray(candidates)
      || Object.keys(candidates).length !== Object.keys(ACTIONS).length
      || !Object.keys(ACTIONS).every(id => OWN(candidates, id)
        && candidates[id] && typeof candidates[id] === 'object' && !Array.isArray(candidates[id]))) {
      throw new TypeError('actionFacts 必须包含完整的 11 项动作后果；不能删选或补猜动作。');
    }
  }
  // Only repeated prose is interned. Numeric forecasts, unknown markers and
  // contact/protection evidence remain inside each action's consequences.
  const uncertaintyCounts = new Map();
  if (facts !== undefined) {
    for (const id of Object.keys(ACTIONS)) {
      const uncertainty = facts.candidates[id].uncertainty;
      if (Array.isArray(uncertainty) && uncertainty.every(value => typeof value === 'string')) {
        for (const text of uncertainty) uncertaintyCounts.set(text, (uncertaintyCounts.get(text) ?? 0) + 1);
      }
    }
  }
  const dictionary = [...uncertaintyCounts.values()].some(count => count > 1)
    ? [...uncertaintyCounts.keys()] : null;
  const consequence = id => {
    const candidate = facts.candidates[id];
    if (!dictionary || !Array.isArray(candidate.uncertainty)
      || !candidate.uncertainty.every(value => typeof value === 'string')) return candidate;
    const compact = { ...candidate,
      uncertainty_refs: candidate.uncertainty.map(text => dictionary.indexOf(text)) };
    delete compact.uncertainty;
    return compact;
  };
  // Preserve the declared native catalog order regardless of facts key order.
  // Each candidate receives its own unranked consequences in the same format.
  const criteria = Object.fromEntries(Object.entries(ACTIONS).map(([id, metadata]) => [id,
    `${metadata.label}：${metadata.description}\n本动作的条件后果：${facts === undefined
      ? 'unknown（未提供预测，不能视为安全或零消耗）'
      : JSON.stringify(consequence(id))}`]));
  if (facts !== undefined) {
    // Lossless relocation: candidate consequences appear once, in criteria.
    // Keep every non-candidate fact, including rule and horizon definitions.
    const summary = { ...facts };
    delete summary.candidates;
    summary.candidateConsequencesAt = 'questions.action.criteria[actionId] 的“本动作的条件后果”JSON';
    if (dictionary) {
      summary.uncertaintyDictionary = dictionary;
      summary.uncertaintyRefsMeaning = '每项后果的 uncertainty_refs 按原顺序引用本 uncertaintyDictionary；null、risk.uncertain 和保护耗尽证据仍在各项后果内。';
    }
    telemetry.actionFacts = summary;
  }
  return criteria;
}

/**
 * Pure request builder. `state` is a JSON string because the supplied API uses
 * a text state field. Optional previousDecision and latencyMs can be supplied
 * in config (or in observation) to account for the previous control and delay.
 */
export function buildDecisionRequest(observation, config = {}) {
  const telemetry = serializeObservation(observation);
  const clockMode = telemetry.clockMode ?? config.clockMode ?? 'step';
  if (!['step', 'realtime'].includes(clockMode)) throw new TypeError('clockMode 仅支持 step 或 realtime。');
  const targetScore = integerSetting(config.targetScore ?? telemetry.targetScore ?? telemetry.targetScore2000,
    0, 0, 10000000, 'targetScore');
  // This is a policy aspiration, never a score-triggered stop configuration.
  const aspirationScore = Math.max(6000, targetScore);
  const thinkMode = config.thinkMode ?? 'off';
  if (!['off', 'auto'].includes(thinkMode)) {
    throw new TypeError('thinkMode 仅支持 off 或 auto。');
  }
  const budget = integerSetting(config.thinkBudget, thinkMode === 'auto' ? 4096 : 0,
    thinkMode === 'auto' ? 1 : 0, 32768, 'thinkBudget');
  const previousDecision = config.previousDecision ?? observation.previousDecision;
  if (previousDecision !== undefined && previousDecision !== null
    && !OWN(ACTIONS, previousDecision)) {
    throw new TypeError('previousDecision 必须是允许的动作。');
  }
  const latencyMs = config.latencyMs ?? observation.latencyMs;
  if (latencyMs !== undefined && (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 600000)) {
    throw new TypeError('latencyMs 必须是 0 到 600000 之间的有限数。');
  }
  const state = {
    game: 'Roadster Rush',
    objective: targetScore > 0
      ? `争取原生积分至少 ${aspirationScore}；配置停止分数为 ${targetScore}，优先生存、续链与能量可持续。`
      : '持续驾驶并尽量提高原生游戏积分，努力争取 6000 分；优先生存、续链与能量可持续，不按分数暂停。',
    target_score: targetScore,
    aspiration_score: aspirationScore,
    telemetry,
  };
  if (telemetry.revision !== undefined) state.observation_revision = telemetry.revision;
  if (previousDecision !== undefined && previousDecision !== null) {
    state.previous_decision = previousDecision;
  }
  if (latencyMs !== undefined) state.previous_latency_ms = latencyMs;

  const criteria = actionCriteria(telemetry);
  const latencyAware = telemetry.actionFacts?.latencyForecast
    && typeof telemetry.actionFacts.latencyForecast === 'object';
  const clockInstructions = clockMode === 'realtime'
    ? 'realtime：自然帧持续推进，等待时车辆继续前进，不冻结。telemetry 是 observedAtMs/epoch 旧快照；estimatedDecisionLatencyMs 是估计。'
      + 'pendingAction 仅保持原定输入时长后释放，不延长或自动重复。'
      + (latencyAware
        ? 'latencyForecast：risk 为响应前风险，applicationState 为预计应用时状态；仅消费真实 observedInput.edges 一次，不重放历史动作。各候选从预计应用时刻覆盖 coveredDurationMs，输入保持 effectiveHeldDurationMs，随后自然滑行；不是已发生事实。'
        : '候选是旧快照立即动作的假设，未补偿网络等待或 pendingAction 变化，不能当成到达时已验证安全。')
      + '需分别核对等待期、执行期及保护耗尽后的碰撞风险；时延变化会使预测失准。'
    : '当前为 step：模型等待时游戏会冻结，之前的接口延迟不代表车辆继续行驶；选定动作后才推进声明的模拟时长。';
  const request = {
    state: JSON.stringify(state),
    questions: {
      action: {
        type: 'choice',
        instructions: `持续存活并尽量提高原生积分，努力争取 ${aspirationScore} 分；`
          + (targetScore > 0 ? `配置停止分数为 ${targetScore}。` : 'target_score=0 不按分数暂停。')
          + clockInstructions
          + '优先生存及可持续续链。无喷气翻滚也能得原生积分；喷气仅用于必要高度或续链，保留至少一次翻滚所需 8 能量及安全落地恢复机会。'
          + 'rollAvailability 表示预计应用时能否启动、排队或被忽略；避免把不足能量或无效输入当成保护/收益。结合 predictedEndAir、predictedLandings 和真实历史评估恢复及下次决策前的生存。'
          + '车向 -z 前进，distanceAhead 为正表示前方。rules 给出原生计分和能量规则；null 或 uncertain 不是安全保证，未来随机生成未知。'
          + '候选后果仅在 criteria 各项中；uncertainty_refs 引用 actionFacts.uncertaintyDictionary。confirmedHistory 是真实观测区间，可能含输入结束后的滑行，不是即时动作奖励。'
          + '比较全部 11 项，选一个原生动作；不生成代码或额外动作。目录未过滤排序，宿主只执行你的原始 choice。',
        criteria,
        allow_none: false,
      },
    },
    // Keep saved/UI off + 0 compatible. The gateway validates budget >= 1 even
    // for never mode; its unused minimum does not enable thinking.
    think_mode: thinkMode === 'off' ? 'never' : thinkMode,
    think_budget: thinkMode === 'off' ? 1 : budget,
    return_details: true,
    allow_none: false,
  };
  if (config.model !== undefined && config.model !== null && config.model !== '') {
    if (typeof config.model !== 'string' || !config.model.trim() || config.model.length > 200) {
      throw new TypeError('model 必须是最多 200 字符的非空字符串。');
    }
    request.model = config.model.trim();
  }
  return request;
}

/** Parse the documented answers.action.choice response; never guess a move. */
export function parseDecisionResponse(data) {
  const answer = data?.answers?.action;
  const selected = answer?.choice;
  if (typeof selected !== 'string' || !OWN(ACTIONS, selected)) {
    throw new TypeError('接口未返回合法的 answers.action.choice 动作。');
  }
  const result = { action: selected };
  for (const field of ['confidence', 'probability']) {
    if (OWN(answer, field)) {
      const value = answer[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new TypeError(`接口的 ${field} 必须是 0 到 1 之间的有限数。`);
      }
    }
  }
  if (OWN(answer, 'confidence')) result.confidence = answer.confidence;
  else if (OWN(answer, 'probability')) result.confidence = answer.probability;
  if (typeof data.model === 'string') {
    const model = data.model.trim();
    if (model && model.length <= 200) result.model = model;
  }
  const thought = answer.details?.thought;
  if (thought !== undefined) {
    if (!thought || typeof thought !== 'object' || Array.isArray(thought)
      || (OWN(thought, 'used') && typeof thought.used !== 'boolean')
      || (OWN(thought, 'tokens') && (!Number.isInteger(thought.tokens) || thought.tokens < 0))) {
      throw new TypeError('接口的思考遥测格式无效。');
    }
    const thinking = {};
    if (OWN(thought, 'used')) thinking.used = thought.used;
    if (OWN(thought, 'tokens')) thinking.tokens = thought.tokens;
    if (Object.keys(thinking).length) result.thinking = thinking;
  }
  return result;
}

/**
 * One request, with no retries or alternate think_mode. Redirects are rejected
 * before forwarding authorization. fetchImpl is injectable for isolated tests.
 */
export async function requestDecision(url, apiKey, observation, config = {}, signal,
  fetchImpl = globalThis.fetch) {
  const endpoint = validateEndpoint(url);
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
    throw new TypeError('请填写有效的 API Key。');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch 不可用。');
  const timeoutMs = integerSetting(config.timeoutMs, 5000, 250, 15000, 'timeoutMs');
  const request = buildDecisionRequest(observation, config);
  if (new URL(endpoint).origin === 'https://api.typesafe.ai') {
    // These fields belong to the supplied local compatibility service, not the
    // official API schema. Do not imply its thinking mode can be controlled.
    delete request.think_mode;
    delete request.think_budget;
    delete request.return_details;
    delete request.allow_none;
    delete request.questions.action.allow_none;
  }
  const body = JSON.stringify(request);
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal?.aborted) {
    controller.abort(signal.reason);
  } else {
    signal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    if (controller.signal.aborted) {
      const error = new Error('决策调用已取消。');
      error.name = 'AbortError';
      throw error;
    }
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body,
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      throw new Error(`决策接口返回 HTTP ${response.status}，本次请求未重试。`);
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new TypeError('决策接口未返回有效 JSON。');
    }
    const result = parseDecisionResponse(data);
    if (request.think_mode === 'never'
      && (result.thinking?.used === true || result.thinking?.tokens > 0)) {
      throw new TypeError('接口未遵守关闭思考设置；未执行动作。');
    }
    return result;
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error(`决策接口调用超时（${timeoutMs} 毫秒）。`);
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
