(() => {
  'use strict';
  if (location.hostname !== 'roadster-rush.ai.studio') return;
  const INSTALL = '__ROADSTER_ISOLATED_PAGE_PANEL__';
  const HOST_ID = 'roadster-extension-decision-panel';
  const HUD_ID = 'roadster-extension-live-hud';
  const STYLE_ID = 'roadster-extension-scroll-style';
  const LIMIT = 200;
  if (globalThis[INSTALL]?.isConnected) return;
  document.getElementById(HOST_ID)?.remove();
  document.getElementById(HUD_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();

  // The original canvas and HUD stay fixed at 100vw/100vh. Only enable root
  // scrolling; the independent panel begins one complete viewport below them.
  // No resize, scrolling, game input, simulation or animation callback is used.
  document.documentElement.setAttribute('data-roadster-decision-panel', '1');
  const scrollStyle = document.createElement('style');
  scrollStyle.id = STYLE_ID;
  scrollStyle.textContent = `
    html[data-roadster-decision-panel="1"] {overflow-y:auto!important;overflow-x:hidden!important;touch-action:pan-y!important}
    html[data-roadster-decision-panel="1"] body {overflow:visible!important;touch-action:pan-y!important}
    html[data-roadster-decision-panel="1"] #game,html[data-roadster-decision-panel="1"] #hud {touch-action:none!important}
  `;
  document.head.append(scrollStyle);
  const host = document.createElement('section');
  host.id = HOST_ID;
  host.setAttribute('aria-label', '实时决策记录');
  // Original touch controls explicitly exclude [data-ui]. Shadow retargeting
  // exposes this host to that handler, so reviewing logs cannot steer the car.
  host.setAttribute('data-ui', 'roadster-decision-records');
  document.body.append(host);
  globalThis[INSTALL] = host;
  const root = host.attachShadow({ mode: 'closed' });
  // Space/arrow keys may operate a focused disclosure/button without reaching
  // the game's window keydown handler. Keyup still releases prior game keys.
  root.addEventListener('keydown', event => event.stopPropagation());
  const css = document.createElement('style');
  css.textContent = `
    :host{display:block;position:absolute;top:100vh;left:0;right:0;z-index:20;min-height:100vh;padding:28px 24px 44px;background:#0d141c;color:#dce5ee;font:13px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;box-sizing:border-box;overflow-anchor:none;contain:layout style;touch-action:pan-y;user-select:text}
    *{box-sizing:border-box}main{max-width:1160px;margin:0 auto}h2,h3,p{margin:0}h2{font-size:23px;color:#f0f5fa;font-weight:650}h3{font-size:13px;margin:18px 0 7px;color:#b9d3e8}.header{display:flex;justify-content:space-between;gap:18px;align-items:center;flex-wrap:wrap}.muted{color:#8fa1b1}.hint{font-size:12px;margin:7px 0 18px}.actions{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;font-size:12px;border:1px solid #3a4d5d;border-radius:8px;background:#1b2a38;color:#dce9f4;padding:8px 13px;cursor:pointer}button:hover{background:#263a4d}button:focus-visible,summary:focus-visible{outline:2px solid #a3ff75;outline-offset:3px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px;margin:18px 0}.metric{padding:12px 14px;border:1px solid #2a3a49;border-radius:10px;background:#121e2a}.metric span{display:block;font-size:11px;color:#8fa5b9}.metric strong{font-size:20px;font-variant-numeric:tabular-nums;font-weight:600}.status{color:#a3ff75;overflow-wrap:anywhere}.records{display:grid;gap:8px;margin-top:16px}.record{border:1px solid #2c3e4e;border-radius:9px;background:#121e29;overflow:hidden}.record>summary{cursor:pointer;list-style:none;padding:12px 15px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.record>summary::-webkit-details-marker{display:none}.record>summary:before{content:'›';font-size:19px;color:#9abbcf}.record[open]>summary:before{transform:rotate(90deg)}.summary-main{flex:1;min-width:200px;font-weight:550}.summary-meta{color:#93aec4;font-size:12px;font-variant-numeric:tabular-nums}.detail-body{padding:0 16px 16px;border-top:1px solid #243543;overflow-wrap:anywhere}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}dl{display:grid;grid-template-columns:116px 1fr;gap:5px 10px;margin:12px 0}dt{color:#8fa6ba}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}pre{margin:0;padding:10px 12px;border-radius:7px;background:#0c151e;color:#bcd0e1;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.65 ui-monospace,SFMono-Regular,monospace;max-height:330px;overflow:auto;touch-action:pan-y}.empty{padding:22px 0;color:#8197ab}.notice{margin-top:12px;color:#93aabd;font-size:12px}.limit{font-size:11px;color:#7f96aa;margin-top:13px}
  `;
  root.append(css);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const main = el('main');
  const header = el('div', undefined, 'header');
  const heading = el('div');
  heading.append(el('h2', '实时决策记录'), el('p', '游戏保留完整画面；向下滚动查看。此处只展示记录，不发送驾驶命令。', 'muted hint'));
  const actions = el('div', undefined, 'actions');
  const exportButton = el('button', '导出本局记录'); exportButton.type = 'button';
  const clearButton = el('button', '清理页面显示'); clearButton.type = 'button';
  actions.append(exportButton, clearButton); header.append(heading, actions);
  const statusLine = el('p', '等待扩展推送本局记录。', 'status');
  statusLine.setAttribute('role', 'status');
  const metrics = el('div', undefined, 'metrics');
  const fields = {};
  for (const [id, label] of [['score', '本局积分'], ['distance', '距离 / 米'], ['ratio', '游戏 / 墙钟时间'], ['latency', '模型往返 / 毫秒'], ['requests', '模型请求'], ['steps', '已提交动作'], ['stale', '过期响应']]) {
    const card = el('div', undefined, 'metric');
    fields[id] = el('strong', '未知'); card.append(el('span', label), fields[id]); metrics.append(card);
  }
  const modelLine = el('p', '实际模型：未知', 'muted');
  const disclaimer = el('p', '展开项展示原始动作、输入事实和真实观测；未提供的字段标为未知，不生成模型思考过程。', 'muted hint');
  const records = el('div', undefined, 'records');
  const empty = el('p', '开始驾驶后，已提交的模型动作会记录在这里。', 'empty');
  const notice = el('p', '', 'notice'); notice.setAttribute('role', 'status');
  main.append(header, statusLine, metrics, modelLine, disclaimer, empty, records, notice,
    el('p', '默认只显示已提交动作；最近 200 次返回（含未提交响应）均保留在导出中。清理仅影响页面显示，不影响驾驶和导出。动画采样不是物理或 GPU 帧数。', 'limit'));
  root.append(main);

  // This host must be a body sibling: the lower panel's layout containment
  // would otherwise make a fixed descendant relative to the offscreen panel.
  const hudHost = el('aside'); hudHost.id = HUD_ID; hudHost.hidden = true;
  hudHost.setAttribute('data-ui', 'roadster-live-receipt');
  hudHost.setAttribute('aria-label', '当前驾驶指令');
  document.body.append(hudHost);
  const hudRoot = hudHost.attachShadow({ mode: 'closed' });
  for (const type of ['keydown', 'pointerdown', 'pointerup', 'click', 'touchstart', 'touchend']) {
    hudRoot.addEventListener(type, event => event.stopPropagation());
  }
  const hudStyle = el('style');
  hudStyle.textContent = `
    :host{position:fixed;right:16px;top:140px;width:200px;max-width:calc(100vw - 32px);z-index:21;display:block;pointer-events:none;color:#f5f9fc;font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;user-select:none}
    :host([hidden]){display:none!important}*{box-sizing:border-box}
    .card{position:relative;min-height:90px;max-height:104px;padding:7px;border:1px solid #ffffff25;border-radius:9px;background:rgba(10,18,27,.82);overflow:hidden}
    .hud-header{height:18px;line-height:18px;margin:0 0 2px;padding-right:48px;white-space:nowrap;overflow:hidden}
    .model-name{font-size:14px;font-weight:750;color:#f5f9fc}.model-size{margin-left:5px;font-size:9px;color:#9cb2c4}
    .response-stats{margin:0 0 2px;color:#9cb2c4;font-size:10px;line-height:14px;white-space:nowrap;font-variant-numeric:tabular-nums}
    .response-latency{color:#e7f2fb}.response-parameters{color:#9cb2c4}
    .command{margin:0;color:#67dbf6;font-size:16px;line-height:1.25;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:clip}.command-prefix{font-size:10px;font-weight:400}
    .vehicle{margin:4px 0 0;color:#c5d2dd;font-size:11px;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    button{position:absolute;right:5px;top:5px;width:48px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:#67dbf6;font:11px/20px sans-serif;pointer-events:auto;cursor:pointer}.detail-compact{display:none}
    .card.compact{min-height:32px;height:32px;padding:6px 28px 6px 8px;display:flex;align-items:center;gap:6px}
    .compact .vehicle,.compact .model-size,.compact .response-parameters{display:none}.compact .hud-header{height:auto;line-height:18px;padding:0;margin:0;flex-shrink:0;max-width:64px;text-overflow:ellipsis}.compact .model-name{font-size:11px}
    .compact .response-stats{margin:0;font-size:9px;line-height:18px;flex-shrink:0}.compact .command{font-size:10px;line-height:18px;min-width:0}.compact .command-prefix{display:none}
    .compact button{right:2px;top:1px;width:24px;height:28px;font:17px/28px sans-serif}.compact .detail-full{display:none}.compact .detail-compact{display:inline}button:focus-visible{outline:2px solid #67dbf6;outline-offset:-3px}
    @media(max-width:640px),(max-height:500px){:host{right:8px;top:112px;max-width:calc(100vw - 16px)}.card,.card.compact{min-height:32px;height:32px;padding:6px 26px 6px 8px;display:flex;align-items:center;gap:5px}.vehicle,.model-size,.response-parameters{display:none}.hud-header,.compact .hud-header{height:auto;line-height:18px;padding:0;margin:0;flex-shrink:0;max-width:64px;text-overflow:ellipsis}.model-name,.compact .model-name{font-size:10px}.response-stats,.compact .response-stats{margin:0;font-size:9px;line-height:18px;flex-shrink:0}.command,.compact .command{font-size:10px;line-height:18px;min-width:0}.command-prefix{display:none}button{right:2px;top:1px;width:24px;height:28px;font:17px/28px sans-serif}.detail-full{display:none}.detail-compact{display:inline}}
    @media(max-height:320px){:host{top:72px}}
  `;
  const hudCard = el('div', undefined, 'card compact');
  const hudHeader = el('p', '', 'hud-header');
  const hudModel = el('strong', '模型待确认', 'model-name');
  const hudModelSize = el('span', '', 'model-size');
  hudHeader.append(hudModel, hudModelSize);
  const hudStats = el('p', '', 'response-stats');
  const hudLatency = el('span', '', 'response-latency');
  const hudParameters = el('span', '', 'response-parameters');
  hudStats.append(hudLatency, hudParameters);
  const hudCommand = el('p', '', 'command');
  const hudPrefix = el('span', '', 'command-prefix');
  const hudAction = el('span', '', 'command-action');
  hudCommand.append(hudPrefix, hudAction);
  const hudVehicle = el('p', '', 'vehicle');
  const detailsButton = el('button'); detailsButton.type = 'button';
  detailsButton.append(el('span', '详情 ↓', 'detail-full'), el('span', '↓', 'detail-compact'));
  detailsButton.setAttribute('aria-label', '查看下方决策记录');
  detailsButton.title = '查看下方决策记录';
  hudCard.append(hudHeader, hudStats, hudCommand, hudVehicle, detailsButton); hudRoot.append(hudStyle, hudCard);

  const droppedLabel = el('label', undefined, 'muted');
  const droppedToggle = el('input'); droppedToggle.type = 'checkbox'; droppedToggle.checked = false;
  droppedLabel.append(droppedToggle, el('span', ' 显示未提交响应（默认隐藏）'));
  disclaimer.append(droppedLabel);

  const actionNames = { coast: '保持行驶', left: '向左换道', right: '向右换道', jump: '短跳', fly: '喷气飞行', dive: '向下俯冲', boost: '向前加速', roll_left: '向左翻滚', roll_right: '向右翻滚', roll_left_fly: '左翻滚并喷气', roll_right_fly: '右翻滚并喷气' };
  const numeric = (value, digits = 0) => typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '未知';
  const known = value => value === undefined || value === null || (typeof value === 'string' && !value.trim())
    ? '未知' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  const confidence = value => typeof value === 'number' && Number.isFinite(value)
    ? `${numeric(value <= 1 ? value * 100 : value, 1)}%` : '未知';
  const publicKeys = ['sessionId', 'sessionStartedAtMs', 'running', 'phase', 'reason', 'error', 'clockMode', 'steps', 'requests', 'runs', 'latencyMs', 'confidence', 'actualModel', 'action', 'observation', 'realtimeMetrics', 'staleResponses', 'decisions', 'history', 'epoch', 'source', 'targetReached', 'targetScore', 'aspirationScore'];
  const privateField = /^(?:api[-_]?key|authorization|key|config|endpoint)$/i;
  const publicStatus = status => {
    const value = Object.fromEntries(publicKeys.filter(key => Object.hasOwn(status, key)).map(key => [key,
      ['decisions', 'history'].includes(key) && Array.isArray(status[key]) ? status[key].slice(0, LIMIT) : status[key]]));
    return JSON.parse(JSON.stringify(value, (key, item) => privateField.test(key) ? undefined : item));
  };
  const stateSummary = value => {
    if (!value || typeof value !== 'object') return '未知（未记录该时刻状态）';
    const p = value.player ?? value;
    return JSON.stringify({
      score: value.score ?? null, distance: value.distance ?? null, mode: value.mode ?? null,
      air: p.air ?? null, lane: p.lane ?? null, grounded: p.grounded ?? null,
      rollCombo: p.rollCombo ?? null, rollProgress: p.rollProgress ?? null,
      x: p.x ?? null, y: p.y ?? null, vy: p.vy ?? null, speed: p.speed ?? null,
    }, null, 2);
  };
  const addPairs = (parent, pairs) => {
    const dl = el('dl');
    for (const [label, value] of pairs) dl.append(el('dt', label), el('dd', known(value)));
    parent.append(dl);
  };
  const block = (parent, label, text) => parent.append(el('h3', label), el('pre', text));
  let lastStatus = {};
  let lowerVisible = typeof IntersectionObserver !== 'function';
  let currentSession = null;
  let latestLive = null;
  let liveExpiryTimer = null;
  let lastStatusAtMs = -Infinity;
  const retiredEpochs = new Set();
  const terminalEpochs = new Set();
  let hiddenThrough = -1;
  let hiddenEpoch = null;
  let displayedKeys = '';
  const recordNodes = new Map();
  const recordKey = (d, index) => `${d.requestEpoch ?? lastStatus.epoch ?? 'unknown'}:${d.run ?? 1}:${d.request ?? `step-${d.step ?? index}`}`;
  const outcomeFor = decision => decision.outcome ?? (Array.isArray(lastStatus.history)
    ? lastStatus.history.find(item => decision.step != null && item.step === decision.step && (decision.run == null || item.run === decision.run)) : null);

  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const fresh = (at, now) => finite(at) && now >= at && now - at < 300;
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function acceptSession(value, legacyStatus = false) {
    const id = value.sessionId;
    const started = value.sessionStartedAtMs;
    if (typeof id !== 'string' || !id || !finite(started)) return legacyStatus && currentSession === null;
    if (currentSession && (started < currentSession.started || (id !== currentSession.id && started <= currentSession.started))) return false;
    if (!currentSession || id !== currentSession.id) {
      currentSession = { id, started, seq: -1, observedAtMs: -Infinity, epoch: null, instructionRequest: -1, statusStopped: false, stoppedEpoch: null };
      retiredEpochs.clear(); terminalEpochs.clear(); latestLive = null; lastStatusAtMs = -Infinity;
      hiddenThrough = -1; hiddenEpoch = null;
      lastStatus = { sessionId: id, sessionStartedAtMs: started, decisions: [], history: [] };
      clearTimeout(liveExpiryTimer); liveExpiryTimer = null; hudHost.hidden = true;
      if (lowerVisible) renderLower();
    }
    return started === currentSession.started;
  }

  function receiveLive(value) {
    if (!Number.isInteger(value.seq) || !finite(value.observedAtMs) || value.observedAtMs > Date.now()
      || typeof value.epoch !== 'string' || !value.epoch || !acceptSession(value)) return;
    if (value.seq <= currentSession.seq || value.observedAtMs < currentSession.observedAtMs || retiredEpochs.has(value.epoch)
      || (value.running === true && (terminalEpochs.has(value.epoch) || currentSession.statusStopped))) return;
    if (currentSession.epoch !== value.epoch) {
      if (currentSession.epoch !== null) retiredEpochs.add(currentSession.epoch);
      currentSession.epoch = value.epoch;
      currentSession.instructionRequest = -1;
    }
    currentSession.seq = value.seq; currentSession.observedAtMs = value.observedAtMs;
    if (value.running === false || (value.native?.epoch === value.epoch && fresh(value.native.observedAtMs, Date.now())
      && ['crashed', 'gameover'].includes(value.native.mode))) terminalEpochs.add(value.epoch);
    const instruction = value.instruction;
    if (instruction && Number.isInteger(instruction.request) && instruction.requestEpoch === value.epoch) {
      currentSession.instructionRequest = Math.max(currentSession.instructionRequest, instruction.request);
    }
    latestLive = value;
    renderHud();
  }

  function renderHud() {
    clearTimeout(liveExpiryTimer); liveExpiryTimer = null;
    const live = latestLive;
    const now = Date.now();
    if (lowerVisible || !live || live.running !== true || !fresh(live.observedAtMs, now)) { hudHost.hidden = true; return; }
    const native = live.native;
    const nativeFresh = native && native.epoch === live.epoch && fresh(native.observedAtMs, now);
    if (nativeFresh && (['crashed', 'gameover'].includes(native.mode) || native.enginePaused === true || native.player?.alive === false)) {
      hudHost.hidden = true; return;
    }
    const instruction = live.instruction;
    const instructionValid = instruction && Object.hasOwn(actionNames, instruction.action)
      && Number.isInteger(instruction.request) && instruction.request >= currentSession.instructionRequest
      && instruction.requestEpoch === live.epoch && finite(instruction.appliedAtMs)
      && finite(instruction.durationMs) && instruction.durationMs > 0 && instruction.durationMs <= 1000
      && now >= instruction.appliedAtMs && now < instruction.appliedAtMs + instruction.durationMs;
    const nativeReady = nativeFresh && native.mode === 'playing' && native.enginePaused === false && native.player?.alive === true;
    // Metrics describe this accepted instruction, or an explicitly labelled
    // previous response while waiting. Never reuse an expired action as text.
    const latestResponse = live.model?.latestResponse?.requestEpoch === live.epoch ? live.model.latestResponse : null;
    const response = instructionValid ? instruction : latestResponse;
    const actualModel = instructionValid
      ? typeof instruction.model === 'string' ? instruction.model.trim() : ''
      : typeof live.model?.name === 'string' ? live.model.name.trim() : '';
    const isStartLux = /^startlux(?:[-_/.]|$)/i.test(actualModel);
    setText(hudModel, isStartLux ? 'StartLux' : actualModel || '模型待确认');
    setText(hudModelSize, isStartLux ? actualModel.match(/(?:^|[-_/])(\d+(?:\.\d+)?)b(?:[-_/.]|$)/i)?.[1]?.concat('B') ?? '' : '');
    hudHeader.title = actualModel || '等待本次会话的真实模型响应';
    const latency = finite(response?.latencyMs) && response.latencyMs >= 0 ? `${Math.round(response.latencyMs)}ms` : '—ms';
    setText(hudLatency, instructionValid ? latency : `${latestResponse ? '上次' : ''}${latency}`);
    const responseConfidence = finite(response?.confidence) && response.confidence >= 0 && response.confidence <= 1
      ? `置信${Math.round(response.confidence * 100)}%` : '置信未知';
    const thinking = response?.thinking?.used === false ? '思考关' : response?.thinking?.used === true ? '思考开' : '思考未知';
    setText(hudParameters, ` · ${responseConfidence} · ${thinking}`);
    hudStats.title = `${instructionValid ? '当前已接受指令' : '最近响应'}往返耗时 ${latency}，${responseConfidence}，${thinking}；置信度不表示动作成功率。`;
    const labels = [];
    if (nativeReady) {
      const p = native.player;
      if (p.rolling === true) labels.push(p.rollDirection === -1 ? '左翻滚中' : p.rollDirection === 1 ? '右翻滚中' : '翻滚中（方向未知）');
      else if (finite(p.lane) && finite(p.targetLane) && p.lane !== p.targetLane) labels.push(p.targetLane < p.lane ? '向左换道中' : '向右换道中');
      if (p.rollQueued === -1 || p.rollQueued === 1) labels.push(p.rollQueued === -1 ? '左翻滚排队' : '右翻滚排队');
      const input = native.observedInput ?? {};
      if (finite(input.thrustRemainingMs) && input.thrustRemainingMs > 0) labels.push('喷气保持');
      else if (p.thrusting === true) labels.push('喷气中');
      if (finite(input.diveRemainingMs) && input.diveRemainingMs > 0) labels.push('俯冲保持');
      else if (p.diving === true) labels.push('俯冲中');
      if (finite(input.boostRemainingMs) && input.boostRemainingMs > 0) labels.push('加速保持');
      else if (p.boosting === true) labels.push('加速中');
      // Pending edges alone establish neither successful takeoff nor rolling.
    }
    setText(hudPrefix, instructionValid ? '指令 ' : '');
    setText(hudAction, instructionValid ? actionNames[instruction.action] : live.phase === 'deciding' ? '决策中' : '等待决策');
    const noHeld = nativeReady && ['thrustRemainingMs', 'diveRemainingMs', 'boostRemainingMs'].every(key => native.observedInput?.[key] === 0);
    setText(hudVehicle, labels.length ? `车辆 ${labels.slice(0, 3).join(' · ')}` : noHeld && native.player.rolling === false ? '车辆 无持续输入' : '车辆 未知');
    hudCard.className = instructionValid ? 'card' : 'card compact';
    hudHost.hidden = false;
    const deadlines = [live.observedAtMs + 300];
    if (nativeFresh) deadlines.push(native.observedAtMs + 300);
    if (instructionValid) deadlines.push(instruction.appliedAtMs + instruction.durationMs);
    const next = Math.min(...deadlines.filter(at => at > now));
    if (Number.isFinite(next)) liveExpiryTimer = setTimeout(renderHud, Math.max(1, next - now));
  }

  function renderDetail(body, decision) {
    body.replaceChildren();
    const outcome = outcomeFor(decision);
    addPairs(body, [
      ['原始返回动作', decision.action], ['置信度', confidence(decision.confidence)],
      ['提交情况', decision.applied === true ? '已提交原始输入' : decision.applied === false ? `未提交：${known(decision.reason)}` : '未知'],
      ['实际模型', decision.model], ['模型往返', `${numeric(decision.latencyMs)} ms`],
      ['对局 epoch', decision.requestEpoch], ['观测时效', `${numeric(decision.snapshotAgeMs)} ms`],
      ['请求观测时间', decision.requestObservedAtMs], ['输入应用时间', decision.appliedAtMs],
      ['请求观测版本', decision.requestRevision], ['应用观测版本', decision.appliedRevision],
    ]);
    const states = el('div', undefined, 'grid');
    const request = el('div'); block(request, '请求时真实状态（null 表示未知）', stateSummary(decision.requestObservation));
    const applied = el('div'); block(applied, `${decision.applied === false ? '响应返回时' : '执行时'}真实状态（null 表示未知）`, stateSummary(decision.appliedObservation));
    states.append(request, applied); body.append(states);
    if (outcome) {
      const observed = el('div', undefined, 'grid');
      const before = el('div'); block(before, '真实观察区间：前', stateSummary(outcome.before));
      const after = el('div'); block(after, '真实观察区间：后', stateSummary(outcome.after));
      observed.append(before, after); body.append(observed);
      addPairs(body, [['实际分差', outcome.scoreDelta], ['实际观察间隔', `${numeric(outcome.observedIntervalMs)} ms`],
        ['声明输入窗口', `${numeric(outcome.durationMs)} ms`], ['输入提前中断', outcome.inputInterrupted], ['包含自然前进间隙', outcome.includesCoastingGap]]);
      body.append(el('p', '这是已发生的观察区间，可能包含等待和自然前进；分差不能全部归因于单个输入。', 'muted hint'));
    } else body.append(el('p', '真实后续变化：未知（尚未确认，或该响应未执行）。', 'muted hint'));
    block(body, '所选候选的条件预测（不是实际结果）', decision.predictionSummary == null
      ? '未知（未记录该候选预测）；不能当作零风险。' : JSON.stringify(decision.predictionSummary, null, 2));
    block(body, '请求时的共同延迟估计', decision.latencyForecast == null
      ? '未知（未记录延迟预测）' : JSON.stringify(decision.latencyForecast, null, 2));
    addPairs(body, [['请求时预计模型时延', `${numeric(decision.estimatedDecisionLatencyMs)} ms`], ['请求时未完成输入', decision.pendingAtRequest]]);
    body.append(el('p', '预测里的 null、unknown、uncertain 及未实现的碰撞/生成条件均保留为未知，不能当作安全保证。这里不展示或编造模型思维过程。', 'muted hint'));
  }

  function render(status) {
    const epoch = typeof status.epoch === 'string' && status.epoch ? status.epoch : status.observation?.epoch;
    if (!acceptSession(status, true) || (epoch && retiredEpochs.has(epoch))) return;
    const at = status.observation?.observedAtMs;
    if (finite(at) && at < lastStatusAtMs) return;
    if (finite(at)) lastStatusAtMs = at;
    if (currentSession) {
      const newEpoch = typeof epoch === 'string' && epoch && epoch !== currentSession.epoch;
      if (currentSession.statusStopped && status.running === true && !newEpoch) return;
      if (newEpoch) {
        if (currentSession.epoch !== null) retiredEpochs.add(currentSession.epoch);
        currentSession.epoch = epoch; currentSession.instructionRequest = -1;
        latestLive = null; clearTimeout(liveExpiryTimer); liveExpiryTimer = null; hudHost.hidden = true;
      }
      if (status.running === false) {
        currentSession.statusStopped = true; currentSession.stoppedEpoch = currentSession.epoch;
        if (currentSession.epoch) terminalEpochs.add(currentSession.epoch);
        latestLive = null; clearTimeout(liveExpiryTimer); liveExpiryTimer = null; hudHost.hidden = true;
      } else if (status.running === true && newEpoch && epoch !== currentSession.stoppedEpoch) {
        currentSession.statusStopped = false;
      }
    }
    lastStatus = publicStatus(status);
    if (lowerVisible) renderLower();
  }

  function renderLower() {
    const obs = lastStatus.observation ?? {};
    const realtime = (lastStatus.clockMode ?? obs.clockMode) !== 'step';
    fields.score.textContent = numeric(obs.score);
    fields.distance.textContent = numeric(obs.distance, 3);
    fields.ratio.textContent = numeric(lastStatus.realtimeMetrics?.gameToWallRatio, 3);
    fields.latency.textContent = numeric(lastStatus.latencyMs);
    fields.requests.textContent = numeric(lastStatus.requests);
    fields.steps.textContent = numeric(lastStatus.steps);
    fields.stale.textContent = numeric(lastStatus.staleResponses);
    statusLine.textContent = `${realtime ? '实时驾驶' : '逐步实验（冻结等待，成绩单独记录）'} · ${lastStatus.running ? '运行中' : known(lastStatus.reason || lastStatus.phase || '等待开始')}`
      + (obs.mode ? ` · 游戏 ${obs.mode}` : '') + (['crashed', 'gameover'].includes(obs.mode) && obs.crashWhat ? ` / ${obs.crashWhat}` : '')
      + (lastStatus.aspirationScore > 0 ? ` · 努力目标 ${numeric(lastStatus.aspirationScore)} 分` : '');
    modelLine.textContent = `实际模型：${known(lastStatus.actualModel)}${lastStatus.error ? ` · ${lastStatus.error}` : ''}`;
    const decisions = (Array.isArray(lastStatus.decisions) ? lastStatus.decisions : []).slice(0, LIMIT)
      .filter(decision => droppedToggle.checked || decision.applied === true)
      .filter(decision => !(hiddenEpoch === (decision.requestEpoch ?? lastStatus.epoch ?? null)
        && typeof decision.request === 'number' && decision.request <= hiddenThrough));
    const keep = new Set();
    const nodes = decisions.map((decision, index) => {
      const key = recordKey(decision, index); keep.add(key);
      let entry = recordNodes.get(key);
      if (!entry) {
        const details = el('details', undefined, 'record');
        const summary = el('summary');
        const title = el('span', '', 'summary-main');
        const meta = el('span', '', 'summary-meta');
        const body = el('div', undefined, 'detail-body');
        summary.append(title, meta); details.append(summary, body);
        entry = { details, title, meta, body, decision };
        details.addEventListener('toggle', () => { if (details.open) renderDetail(body, entry.decision); });
        recordNodes.set(key, entry);
      }
      entry.decision = decision;
      entry.title.textContent = `#${known(decision.request)} ${actionNames[decision.action] ?? known(decision.action)} · ${decision.applied === true ? '已提交' : decision.applied === false ? '未提交' : '未知'}`;
      entry.meta.textContent = `${confidence(decision.confidence)} · ${numeric(decision.latencyMs)} ms`;
      if (entry.details.open) renderDetail(entry.body, decision);
      return entry.details;
    });
    for (const key of recordNodes.keys()) if (!keep.has(key)) recordNodes.delete(key);
    const keys = [...keep].join('|');
    if (keys !== displayedKeys) { records.replaceChildren(...nodes); displayedKeys = keys; }
    empty.hidden = nodes.length > 0;
    if (!nodes.length && hiddenThrough >= 0) empty.textContent = '页面显示已清理；后续返回会继续显示，驾驶和导出记录不受影响。';
  }

  clearButton.addEventListener('click', () => {
    hiddenEpoch = lastStatus.epoch ?? lastStatus.decisions?.[0]?.requestEpoch ?? null;
    hiddenThrough = Math.max(lastStatus.requests ?? 0, ...(lastStatus.decisions ?? []).map(d => typeof d.request === 'number' ? d.request : 0));
    render(lastStatus);
    notice.textContent = '仅清理页面显示，驾驶和导出记录不受影响。';
  });
  droppedToggle.addEventListener('change', () => { if (lowerVisible) renderLower(); });
  detailsButton.addEventListener('click', event => {
    event?.stopPropagation?.();
    host.scrollIntoView({ block: 'start', behavior: 'auto' });
  });
  exportButton.addEventListener('click', () => {
    const exportedAt = new Date().toISOString();
    const data = JSON.stringify({ exportedAt, source: 'isolated-page-panel', status: lastStatus }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const link = el('a'); link.href = url;
    link.download = `roadster-${lastStatus.clockMode === 'step' ? 'step' : 'realtime'}-run-${exportedAt.replaceAll(':', '-')}.json`;
    link.hidden = true; root.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice.textContent = '已导出本局公开运行记录，不含连接配置或 API Key。';
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender?.id !== chrome.runtime.id) return;
    try {
      if (message?.type === 'ROADSTER_LIVE' && message.live && typeof message.live === 'object' && !Array.isArray(message.live)) receiveLive(message.live);
      else if (message?.type === 'ROADSTER_STATUS' && message.status && typeof message.status === 'object' && !Array.isArray(message.status)) render(message.status);
    } catch { notice.textContent = '收到的记录格式无效，已保留现有显示。'; }
  });
  if (typeof IntersectionObserver === 'function') {
    const visibility = new IntersectionObserver(entries => {
      const entry = entries.find(item => item.target === host);
      if (!entry) return;
      lowerVisible = entry.isIntersecting === true && (entry.intersectionRatio > 0 || entry.intersectionRect?.height > 0);
      renderHud();
      if (lowerVisible) renderLower();
    }, { threshold: [0, 0.001] });
    visibility.observe(host);
  }
})();
