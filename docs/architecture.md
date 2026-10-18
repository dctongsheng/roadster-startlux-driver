# 架构与模型接口

本扩展通过原游戏暴露的 `window.__GAME__` 接口读取状态和提交动作。模型服务由使用者单独提供，仓库不包含推理后端或模型权重。

## 数据流

```mermaid
flowchart LR
  G[原生游戏] --> B[bridge.js 状态采样]
  B --> F[facts.js 对称条件预测]
  F --> D[driver.mjs 会话与时效校验]
  D --> C[decision.mjs System One 请求]
  C --> M[使用者的模型服务]
  M --> D
  D --> B
  B --> G
  G --> L[100ms 只读实时状态]
  L --> U[右侧 HUD]
  D --> H[页面下方复盘与导出]
```

| 文件 | 职责 |
| --- | --- |
| `extension/worker.mjs` | 扩展后台、接口配置、Key 会话存储、受限消息入口、实时 UI 采样 |
| `extension/driver.mjs` | 单请求在途、START / STOP、局标识、响应时效、真实观测区间与动作回执 |
| `extension/decision.mjs` | 接口白名单、完整动作目录、请求序列化、响应校验与取消 / 超时 |
| `extension/bridge.js` | 在游戏 MAIN world 读取结构化状态、映射原生动作；两种时钟模式分离 |
| `extension/facts.js` | 对全部 11 项动作计算同口径条件后果，不排序、不删选、不推荐动作 |
| `extension/page-panel.js` | 隔离 world 的只读实时卡片、下方记录、按需详情与导出 |
| `extension/popup.*` | 模型连接、驾驶设置及显式控制操作 |

网页不能通过窗口消息启动驾驶或读取 Key。后台只接受来自同一扩展弹窗的控制命令，页面显示通过扩展运行时消息接收公开状态。

## 时钟与暂停

**实时驾驶**保留原生 `requestAnimationFrame` 时钟。模型等待期间游戏继续运行；动作提交只触发原生输入，不手动补帧，也不把网络耗时转换成较慢的游戏时间。模型返回后重新采样，校验局标识和观测时效，过期、跨局、终局或原生暂停情况下不执行旧响应。没有本地替代决策或并发投票。

**逐步实验**是显式选择的另一条路径。弹窗的「逐步实验」执行一次模型动作；设置中选择 `step` 后连续启动，也会使用等待时冻结的实验路径。它接管模拟推进，等待模型时冻结，再按声明帧数推进。其分数、物理帧数与墙钟时间不能与实时驾驶混算。

**原游戏的失焦暂停**独立于上述策略。适配时观察到原游戏在非手动模式下收到窗口 `blur` 或页面隐藏事件时主动暂停；浏览器也可能限制后台页面的动画。扩展不会循环取消这种暂停。切换标签页会结束驾驶接管；检测到原生暂停也会退出。保持游戏前台可减少此类中断，但不等于保证固定帧率。

实时模式点击停止、达到正数目标分或请求预算耗尽，只结束接管并清理输入，原游戏继续运行；原游戏本身已暂停时不会因停止而强制恢复。逐步实验退出时可保留实验暂停状态。

## 动作、条件预测与确认

固定动作目录：`coast`、`left`、`right`、`jump`、`fly`、`dive`、`boost`、`roll_left`、`roll_right`、`roll_left_fly`、`roll_right_fly`。

条件预测为每个候选提供位置、高度、能量、翻滚可用性、预计积分事件与几何风险等。候选顺序固定，不根据风险或能量删选。等待阶段纳入当前原生 held 输入与尚未消费的边沿输入；各候选覆盖声明的预测窗口，输入结束后按自然滑行推演，不追加后续动作。

预测是独立实现的行为近似，不是运行原游戏的完整未来副本：不读取未来随机生成，不完整模拟交通反应、碰撞反馈或新道具。`null`、未知字段和不确定性不能解释为安全或零消耗。

已提交回执只证明桥接层接受了原始输入。真实结果来自后续观测，可能包括输入结束后的自然前进、原生排队或能量不足。最近六个已确认的本局观测区间可进入后续模型请求，不能把所有分差都归为即时动作奖励。

## 模型协议

接口范围、认证及 UI 配置见 [README](../README.md#受支持的接口)。请求为 `POST` JSON，认证头为 `Authorization: Bearer <API_KEY>`；不跟随重定向，不发送浏览器凭据。默认超时 5000 ms，单次请求失败不自动换思考模式、重试或改选动作。

请求包含：

- `state`：**JSON 字符串**，包括游戏名、目标、结构化遥测、真实历史和条件预测摘要。
- `questions.action`：`type: "choice"`，完整的 11 项 `criteria`；各候选后果放在各自描述中。
- `model`：可选，留空时不发送，交由服务端选择。
- 本机兼容服务扩展：`think_mode`、`think_budget`、`return_details`、顶层及动作题的 `allow_none`。

以下生成一个**虚拟连接示例**，使用项目本身的请求构造器，输出完整 11 项选择题；结果不会执行游戏动作。示例 Key 为占位符，正常使用可直接在扩展 UI 填写现有 Key。

```sh
node --input-type=module > /tmp/roadster-request.json <<'JS'
import { buildDecisionRequest } from './extension/decision.mjs';
const request = buildDecisionRequest({
  source: 'connection-example',
  clockMode: 'realtime', mode: 'playing', score: 0, distance: 0,
  player: { lane: 2, targetLane: 2, speed: 26, x: 0, y: 0, z: 0,
    grounded: true, air: 100 },
  note: '虚拟空旷道路，仅验证接口；结果不执行游戏动作。',
}, { clockMode: 'realtime', thinkMode: 'off', thinkBudget: 0 });
console.log(JSON.stringify(request));
JS

curl --noproxy 127.0.0.1 \
  http://127.0.0.1:18080/v1/systemone \
  -H 'Authorization: Bearer YOUR_EXISTING_API_KEY' \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/roadster-request.json
```

本机服务关闭思考时发送 `think_mode: "never"`、`think_budget: 1`；预算 1 是兼容服务的最小值，客户端不把它当成开启思考。自动思考发送 `auto` 与配置预算。若关闭思考时响应明确报告 `used: true` 或正数思考 token，客户端拒绝执行动作；缺失遥测显示未知。

HTTPS 官方接口由 `requestDecision()` 自动移除上述兼容扩展字段，仅发送 `state`、`questions` 和可选 `model`。上面的 curl 示例针对本机兼容服务，不能直接用它的扩展字段代表官方协议。

兼容响应示例（数值仅演示结构）：

```json
{
  "model": "startlux-decision-27b-autothink",
  "answers": {
    "action": {
      "choice": "coast",
      "confidence": 0.9,
      "details": { "thought": { "used": false, "tokens": 0 } }
    }
  }
}
```

必需 `answers.action.choice` 且属于上述动作目录；非法动作直接报错。`confidence` 可省略，也兼容 `probability`，若存在须为 0–1 的有限数。模型名与 `details.thought` 可省略，不猜测缺失内容。显示的实际模型是服务返回的 `model` 字符串；参数规模只从该字符串解析，不验证后端权重。

## 实时显示与数据边界

HUD 使用独立 `ROADSTER_LIVE` 消息，100 ms 只读取最小原生状态，不重新计算候选预测、不请求模型、不触碰驾驶时钟或看门狗。它和下方复盘分别遵守[显示时效规则](realtime-hud.md)。

Key 存于扩展受信任上下文可见的会话存储；页面消息和导出不含连接配置或 Key。弹窗导出另包含公开配置，但不包含 Key。运行记录是有界缓冲区，不是服务端完整归档；模型接口是否归档由其自身规则决定。

独立动画间隔指标来自只读 rAF 采样，不等于 GPU 帧率或物理步数。本仓库的单元测试验证状态、协议和边界；它们不代表真实网络、模型能力、设备性能或单局成绩保证。
