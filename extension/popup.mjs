const $ = (id) => document.getElementById(id);
const form = $('config-form');
const defaults = {
  endpoint: 'http://127.0.0.1:18080/v1/systemone',
  model: '', stepMs: 200, maxSteps: 300, targetScore: 0, autoRetry: false,
  clockMode: 'realtime', maxDecisionAgeMs: 1500,
  thinkMode: 'off', thinkBudget: 0, hasKey: false,
};
const actionNames = {
  left: '向左变道', right: '向右变道', jump: '跳跃', fly: '喷气飞行', dive: '向下俯冲', boost: '喷气加速',
  roll_left: '向左翻滚', roll_right: '向右翻滚', roll_left_fly: '向左翻滚并喷气', roll_right_fly: '向右翻滚并喷气',
  brake: '刹车', coast: '保持行驶', none: '保持行驶', stay: '保持行驶',
  straight: '直行', forward: '前进', accelerate: '加速', idle: '等待',
  restart: '重新开始', start: '开始游戏',
};
let dirty = false;
let loaded = false;
let busy = false;
let polling = false;
let pendingDrive = false;
let stopping = false;
let driveEpoch = 0;
let lastStatus = {};
let currentConfig = { ...defaults };

function actionLabel(action) {
  if (!action) return '等待出发';
  const value = typeof action === 'string' ? action : JSON.stringify(action);
  return actionNames[value.toLowerCase()] || value;
}

function number(value, suffix = '') {
  return Number.isFinite(Number(value)) && value !== null && value !== '' && value !== undefined
    ? `${Math.round(Number(value)).toLocaleString('zh-CN')}${suffix}` : '—';
}

function confidence(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const amount = Number(value);
  return `${Math.round(amount <= 1 ? amount * 100 : amount)}%`;
}

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}

function notice(message) {
  $('notice').textContent = message;
}

function clockMode(status = lastStatus) {
  return status.clockMode ?? status.observation?.clockMode ?? currentConfig.clockMode;
}

function targetNotice(status) {
  return `目标完成：获得 ${number(status.observation?.score)} 分，${clockMode(status) === 'realtime'
    ? '驾驶输入已停止，游戏继续运行。' : '逐步实验已暂停。'}`;
}

function updateClockMode() {
  const realtime = $('clock-mode').value === 'realtime';
  $('start').textContent = realtime ? '开始实时驾驶 ↗' : '开始逐步实验 ↗';
  $('step-ms-label').textContent = realtime ? '普通输入保持 / 毫秒' : '普通动作推进 / 毫秒';
  $('clock-help').textContent = realtime
    ? '游戏按原生时钟持续运行，模型等待期间也会前进；过期响应不执行。'
    : '逐步实验会在模型等待时冻结模拟，成绩须与实时驾驶分别记录。';
}

function updateButtons() {
  const running = Boolean(lastStatus.running);
  $('start').disabled = busy || stopping || running;
  $('step').disabled = busy || stopping || running;
  $('stop').disabled = stopping || !(running || pendingDrive);
  for (const id of ['test', 'save', 'clear-key']) $(id).disabled = busy || stopping;
  $('clear-key').disabled = busy || stopping || (!currentConfig.hasKey && !$('api-key').value);
}

function updateThinking() {
  let official = false;
  try {
    const url = new URL($('endpoint').value.trim());
    official = url.protocol === 'https:' && url.hostname === 'api.typesafe.ai';
  } catch {
    // Endpoint validation runs before saving; keep draft fields editable.
  }
  $('think-mode').disabled = official;
  $('think-budget').disabled = official || $('think-mode').value === 'off';
  $('thinking-help').textContent = official
    ? '官方接口不发送自定义思考参数；此处不控制官方后端的思考方式。'
    : '思考参数仅用于局域网兼容服务；实际支持以服务端为准。';
}

function updatePreset() {
  const endpoint = $('endpoint').value.trim();
  const match = [...$('endpoint-preset').options].some((option) => option.value === endpoint);
  $('endpoint-preset').value = match ? endpoint : 'custom';
}

function renderConfig(config) {
  currentConfig = { ...defaults, ...config };
  $('key-state').textContent = currentConfig.hasKey
    ? currentConfig.keySource === 'env' ? '本机 .env · 自动载入' : '已保存 · 浏览器会话内有效'
    : '会话输入 / 本机 .env';
  $('api-key').placeholder = currentConfig.hasKey ? '已保存密钥；填写可替换' : '输入密钥，仅保存在会话中';
  if (loaded && dirty) return;
  $('endpoint').value = currentConfig.endpoint;
  $('model').value = currentConfig.model || '';
  $('step-ms').value = currentConfig.stepMs;
  $('max-steps').value = currentConfig.maxSteps;
  $('target-score').value = currentConfig.targetScore;
  $('clock-mode').value = currentConfig.clockMode;
  $('auto-retry').checked = Boolean(currentConfig.autoRetry);
  $('think-mode').value = currentConfig.thinkMode;
  $('think-budget').value = currentConfig.thinkBudget;
  updatePreset();
  updateThinking();
  updateClockMode();
  loaded = true;
}

function renderHistory(history) {
  const list = $('history');
  list.replaceChildren();
  const recent = Array.isArray(history) ? history.slice(0, 5) : [];
  if (!recent.length) {
    const item = document.createElement('li');
    item.className = 'empty-history';
    item.textContent = '开始后，这里会显示模型的驾驶记录。';
    list.append(item);
    return;
  }
  for (const item of recent) {
    const row = document.createElement('li');
    const step = document.createElement('span');
    step.className = 'history-step';
    step.textContent = `#${item.step ?? '—'}`;
    const action = document.createElement('span');
    action.className = 'history-action';
    action.textContent = actionLabel(item.action);
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    meta.textContent = `${item.scoreDelta === null || item.scoreDelta === undefined ? confidence(item.confidence) : `${item.scoreDelta >= 0 ? '+' : ''}${number(item.scoreDelta)} 分`} · ${number(item.latencyMs, ' ms')}`;
    row.append(step, action, meta);
    list.append(row);
  }
}

function renderStatus(status = {}) {
  const previous = lastStatus;
  lastStatus = status;
  const phases = { connecting: '连接中', deciding: '决策中', acting: '执行中', stopping: '停止中', error: '出错', stopped: '已停止', success: '已达标' };
  $('run-state').classList.toggle('running', Boolean(status.running));
  $('run-label').textContent = phases[status.phase] || (status.running ? '驾驶中' : '待命');
  $('steps').textContent = `${number(status.steps ?? 0)} 次决策`;
  $('runs').textContent = `${number(status.runs ?? 0)} 局`;
  $('action').textContent = actionLabel(status.action);
  $('score').textContent = number(status.observation?.score);
  $('distance').textContent = number(status.observation?.distance, ' m');
  $('latency').textContent = number(status.latencyMs, ' ms');
  $('confidence').textContent = confidence(status.confidence);
  $('model-status').textContent = status.actualModel
    ? `实际模型：${status.actualModel}` : '实际模型：等待接口返回';
  $('telemetry-status').textContent = status.observation
    ? `游戏状态：${status.observation.mode}${['crashed', 'gameover'].includes(status.observation.mode) && status.observation.crashWhat ? ` · 碰撞：${status.observation.crashWhat}` : ''}`
    : '游戏状态：等待观测';
  const realtime = clockMode(status) === 'realtime';
  $('clock-status').textContent = `${realtime ? '实时驾驶 · 原生游戏时钟' : '逐步实验 · 冻结模拟'} · 已丢弃 ${number(status.staleResponses ?? 0)} 次过期响应`;
  const metrics = status.realtimeMetrics;
  $('realtime-status').hidden = !realtime || !metrics;
  if (metrics) {
    const ratio = Number.isFinite(metrics.gameToWallRatio) ? metrics.gameToWallRatio.toFixed(3) : '—';
    $('realtime-status').textContent = `游戏 ${number(metrics.gameElapsedMs, ' ms')} / 墙钟 ${number(metrics.wallElapsedMs, ' ms')} · 比值 ${ratio}`
      + ` · 动画采样 ${number(metrics.frameTicks)} · P95 间隔 ${number(metrics.frameTimeP95Ms, ' ms')}`
      + ` · 最大间隔 ${number(metrics.maxFrameGapMs, ' ms')}`;
  }
  $('target-status').textContent = status.targetReached
    ? `已达到 ${number(status.targetScore)} 分目标，${realtime ? '驾驶输入已停止。' : '逐步实验已暂停。'}`
    : (status.targetScore ?? currentConfig.targetScore) > 0
      ? `目标 ${number(status.targetScore ?? currentConfig.targetScore)} 分 · 达标后停止驾驶输入`
      : '不按分数停止';
  renderHistory(status.history);
  if (status.error) showError(status.error);
  if (!status.running && status.reason && (previous.running || previous.reason !== status.reason || previous.phase !== status.phase)) {
    notice(status.targetReached ? targetNotice(status) : `驾驶员已停止：${status.reason}${realtime ? '。已清理驾驶输入，原游戏继续运行。' : ''}`);
  }
  updateButtons();
}

async function request(type, config) {
  const requestEpoch = driveEpoch;
  const response = await chrome.runtime.sendMessage(config ? { type, config } : { type });
  if (!response?.ok) throw new Error(response?.error || '扩展未返回有效响应，请重新加载扩展后重试。');
  if (response.config) renderConfig(response.config);
  if (response.status && requestEpoch === driveEpoch) renderStatus(response.status);
  return response;
}

function collectConfig() {
  if (!form.reportValidity()) throw new Error('请检查接口地址和设置范围。');
  const config = {
    endpoint: $('endpoint').value.trim(),
    model: $('model').value.trim(),
    stepMs: Number($('step-ms').value),
    maxSteps: Number($('max-steps').value),
    targetScore: Number($('target-score').value),
    clockMode: $('clock-mode').value,
    maxDecisionAgeMs: currentConfig.maxDecisionAgeMs ?? defaults.maxDecisionAgeMs,
    autoRetry: $('auto-retry').checked,
    thinkMode: $('think-mode').value,
    thinkBudget: $('think-mode').value === 'off' ? 0 : Number($('think-budget').value),
  };
  if ($('api-key').value.trim()) config.apiKey = $('api-key').value.trim();
  return config;
}

async function saveConfig() {
  const config = collectConfig();
  const response = await request('SAVE_CONFIG', config);
  $('api-key').value = '';
  dirty = false;
  if (response.config) renderConfig(response.config);
  updateButtons();
}

async function runOperation(operation, message, { save = false } = {}) {
  if (busy || stopping) return;
  const operationEpoch = driveEpoch;
  const isDrive = operation === 'START' || operation === 'STEP';
  busy = true;
  showError('');
  updateButtons();
  try {
    if (save) await saveConfig();
    if (operationEpoch !== driveEpoch) return;
    if (isDrive) {
      pendingDrive = true;
      notice('模型决策中，可以随时停止。');
      updateButtons();
    }
    const response = operation ? await request(operation) : null;
    if (operationEpoch !== driveEpoch) return;
    notice(response?.status?.targetReached
      ? targetNotice(response.status)
      : typeof message === 'function' ? message(response) : message);
    // START is acknowledged by the worker before this popup closes. The
    // driver's state and page-panel messages remain owned by the worker.
    if (operation === 'START') window.close();
  } catch (error) {
    if (operationEpoch !== driveEpoch) return;
    showError(error instanceof Error ? error.message : String(error));
    notice('操作未完成，请根据上方提示检查。');
  } finally {
    pendingDrive = false;
    busy = false;
    updateButtons();
  }
}

async function stopDriving() {
  if (stopping || !(lastStatus.running || pendingDrive)) return;
  stopping = true;
  driveEpoch += 1;
  pendingDrive = false;
  showError('');
  notice('正在停止驾驶…');
  updateButtons();
  try {
    await request('STOP');
    notice(clockMode() === 'realtime' ? '已停止并清理驾驶输入，原游戏继续运行。' : '逐步实验已停止，模拟保持暂停。');
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    notice('停止未完成，可以再次点击停止。');
  } finally {
    stopping = false;
    updateButtons();
  }
}

function exportRun() {
  const exportedAt = new Date().toISOString();
  const config = Object.fromEntries(Object.keys(defaults)
    .filter(key => key !== 'hasKey')
    .map(key => [key, currentConfig[key]]));
  const record = { exportedAt, config, status: lastStatus };
  // Export only public status/config. Never inspect the key input or export a
  // nested authentication field even if a future status payload adds one.
  const json = JSON.stringify(record, (key, value) => /^(?:api[-_]?key|authorization)$/i.test(key) ? undefined : value, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `roadster-${clockMode() === 'realtime' ? 'realtime' : 'step'}-run-${exportedAt.replaceAll(':', '-')}.json`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notice('已导出本局公开设置与完整运行记录，不含 API Key。');
}

form.addEventListener('input', () => { dirty = true; updateButtons(); });
form.addEventListener('change', () => { dirty = true; });
$('endpoint').addEventListener('input', () => { updatePreset(); updateThinking(); });
$('endpoint-preset').addEventListener('change', () => {
  if ($('endpoint-preset').value !== 'custom') $('endpoint').value = $('endpoint-preset').value;
  else $('endpoint').focus();
  updateThinking();
});
$('think-mode').addEventListener('change', () => {
  if ($('think-mode').value === 'auto' && Number($('think-budget').value) < 1) {
    $('think-budget').value = 4096;
  }
  updateThinking();
});
$('clock-mode').addEventListener('change', updateClockMode);
form.addEventListener('submit', (event) => {
  event.preventDefault();
  void runOperation(null, '设置已保存。支持从本机 .env 自动载入；手动输入的密钥仅保留在会话中。', { save: true });
});
$('start').addEventListener('click', () => void runOperation('START', () => currentConfig.clockMode === 'realtime'
  ? '实时驾驶已开始，决策记录在游戏页面下方。请保持游戏标签页可见。'
  : '逐步实验已开始，等待模型时冻结模拟，成绩单独记录。', { save: true }));
$('stop').addEventListener('click', () => void stopDriving());
$('step').addEventListener('click', () => void runOperation('STEP', '逐步实验已完成一次决策，模拟暂停等待下一步。该成绩不属于实时驾驶。', { save: true }));
$('test').addEventListener('click', () => void runOperation('TEST_CONNECTION', '模型连接成功，已收到有效决策响应。', { save: true }));
$('clear-key').addEventListener('click', () => {
  $('api-key').value = '';
  void runOperation('CLEAR_KEY', '已清除会话密钥并停用 .env 自动载入；保存设置可重新载入本机文件。');
});
$('export-run').addEventListener('click', exportRun);

async function poll() {
  if (polling) return;
  polling = true;
  try {
    await request('STATUS');
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    polling = false;
  }
}

void poll();
const pollingTimer = setInterval(() => void poll(), 1000);
window.addEventListener('pagehide', () => clearInterval(pollingTimer), { once: true });
