# Roadster StartLux Driver

[简体中文](README.md) · [English](README.en.md)

[![CI](https://github.com/dctongsheng/roadster-startlux-driver/actions/workflows/ci.yml/badge.svg)](https://github.com/dctongsheng/roadster-startlux-driver/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.4.4-22b8b0.svg)](https://github.com/dctongsheng/roadster-startlux-driver/releases/tag/v0.4.4)

**Watch StartLux drive in real time—with the model, decision latency, and current action visible in the game.**

A Chrome / Edge Manifest V3 extension for [Roadster Rush](https://roadster-rush.ai.studio/), connected to a StartLux / System One-compatible decision service. The game runs on its native real-time clock while model decisions arrive asynchronously. A small card on the right shows the current valid instruction alongside the car's actual state. Current version: **0.4.4**.

## Live demo

![StartLux driving Roadster Rush: full game view with the live decision card on the right](docs/media/live-driving.jpg)

*A browser screenshot from a real-time driving run with the public v0.4.3 extension. The card sits near the upper-right edge, keeping the central road, car, and native controls visible.*

| Valid current instruction | Instruction expired; waiting for the next decision |
| --- | --- |
| ![Close-up of the StartLux card: model name, latency in milliseconds, current instruction, and native vehicle state](docs/media/startlux-hud.jpg) | ![Compact waiting card after expiry: StartLux, previous response latency, and decision status](docs/media/startlux-waiting.jpg) |

*Both close-ups come from the same real browser run. A valid instruction shows its own response metadata. Once it expires, the action clears and only the explicitly labeled previous latency and waiting status remain.*

### Gameplay video

[![Roadster Rush gameplay preview; click for the full video](docs/media/demo-preview.gif)](https://github.com/dctongsheng/roadster-startlux-driver/releases/download/v0.4.3/startlux-roadster-demo.mp4)

*The extension screenshots above and this video are from different runs. This user-supplied gameplay recording does not contain the decision card. Click the preview for the full video with audio.*

**[Watch / download the gameplay MP4](https://github.com/dctongsheng/roadster-startlux-driver/releases/download/v0.4.3/startlux-roadster-demo.mp4)** · [Download the extension](https://github.com/dctongsheng/roadster-startlux-driver/releases/tag/v0.4.3)

## What you can see in real time

| Display | Meaning |
| --- | --- |
| **StartLux / model size** | Highlights the model reported by the response; names containing a size such as `27b` receive the corresponding label |
| **Decision latency · ms** | Client-measured round-trip time for the current instruction, including network and server processing |
| **Current instruction** | The latest accepted model choice while its display window is still valid, such as a roll, flight input, or lane change |
| **Native vehicle state** | Independently reads the actual roll direction, queued rolls, lane changes, and held inputs such as flight |
| **Confidence / thinking** | Reports response confidence and actual thinking telemetry; missing values remain unknown |

The **instruction** and **vehicle** rows are independent. If the model requests a left roll while the car is finishing a right roll, both rows report that state. An accepted input is not proof that a maneuver completed. **The ms value is request round-trip latency, not inference-only time. Confidence is not an action success rate.**

The game keeps moving while the model responds. New instructions replace old ones, and each instruction clears when its display window ends. With no valid instruction, the card becomes a compact status line and explicitly labels the latency as the previous request. The card hides when driving stops or the game ends. Predictions, history, and audit details stay below the game; the page scrolls there only when you click **详情** (“Details”).

The model receives the complete set of **11 actions and consistently computed conditional predictions**. The extension submits the model's original choice only while it remains valid. The live display uses a separate read-only 100 ms sample; it does not make extra model calls or change the driving strategy. See the [HUD rules](docs/realtime-hud.md) and [architecture and API](docs/architecture.md) (technical documents in Chinese).

This repository provides the browser extension, tests, and documentation. Supply your own model backend, weights, and API Key. Demo images and video show actual gameplay; see [third-party notices](THIRD_PARTY_NOTICES.md) for the game-media licensing boundary. Model names are reported by the endpoint and do not verify the underlying weights, parameter count, or official affiliation. This project is not an official product of Tesla, Roadster Rush, or a model provider.

## Install and drive

1. Download the extension ZIP from [Releases](https://github.com/dctongsheng/roadster-startlux-driver/releases), download the repository source ZIP, or clone it:

   ```sh
   gh repo clone dctongsheng/roadster-startlux-driver
   cd roadster-startlux-driver
   ```

2. Use a current stable version of Chrome or Edge. Extract the ZIP, open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, and choose **Load unpacked**. Select the project's **`extension` directory**.
3. Open [Roadster Rush](https://roadster-rush.ai.studio/) and wait for the game to load. Refresh the game tab after installing or updating the extension.
4. Click the extension icon in the browser toolbar. Enter your System One URL and existing API Key, then save. Leave the model name blank to use the server's default.
5. Optionally click **测试模型连接** (“Test model connection”) to check authentication and response format. This makes one real model request and may consume model usage; the test does not execute a game action.
6. Set **游戏时钟** (“Game clock”) to **实时驾驶** (“Real-time driving”), then click **开始实时驾驶** (“Start real-time driving”). The popup closes after a successful start and the live card appears on the right. Click **详情** (“Details”) or scroll down to inspect records.
7. To release control, reopen the extension and click **停止** (“Stop”). The extension cancels the in-flight request and clears its inputs; the native game continues. Automatic restart after game over is disabled by default.

Keep the game tab in the foreground. The game may pause itself when its window loses focus or the page becomes hidden. The extension releases control when it detects a native pause; start driving again after returning to the game. This is separate from the explicit step experiment that freezes simulation while waiting for the model. See [clock and pause behavior](docs/architecture.md#时钟与暂停).

## Local .env: no repeated Key entry

[Setup and troubleshooting guide](docs/local-env.md)

Copy `.env.example` to `.env` inside the **extension directory you loaded**, then set:

```dotenv
STARTLUX_API_KEY=YOUR_EXISTING_API_KEY
```

Reload the extension at `chrome://extensions`. Fresh browser sessions automatically load the file; the popup shows the local `.env` source. A manually entered session Key takes priority. Reload the extension after editing the file.

The local file stores the Key in plain text and is excluded from Git and public ZIP builds. Do not share it. Only the extension background reads it; the Key is never sent to the game page or exported records. **Clear** removes the session copy and disables automatic loading; **Save settings** can load the file again.

## Supported endpoints

| Type | URL |
| --- | --- |
| Local compatible service | `http://127.0.0.1:18080/v1/systemone` |
| Local compatible service | `http://127.0.0.1:18081/v1/systemone` |
| Local compatible service | `http://localhost:18080/v1/systemone`, `http://localhost:18081/v1/systemone` |
| TypeSafe HTTPS endpoint | `https://api.typesafe.ai/v1/systemone` |

The path must be exactly `/v1/systemone`, with no trailing slash, query, fragment, or embedded username/password. HTTP is restricted to the local hosts and ports above. HTTPS is restricted to `api.typesafe.ai` on its default port 443. Arbitrary remote server addresses are not allowed by this release. `127.0.0.1` and `localhost` refer to the computer running the extension; the extension does not start a local service or create a tunnel.

Thinking is disabled by default for local compatible services: the UI setting `off / 0` maps to `think_mode: "never"` and `think_budget: 1`. The service must support these fields. If a response explicitly reports thinking was used, the extension refuses to execute that action. Requests to the official HTTPS endpoint omit the compatible-service extension fields; the local thinking switch is not guaranteed to control that service. See [request and response examples](docs/architecture.md#模型协议).

## Defaults

| Setting | Default | Meaning |
| --- | --- | --- |
| Game clock | `realtime` | Native real-time, asynchronous driving |
| Ordinary input hold | `200 ms` | Range: 50–1000 ms; roll actions declare a display window of about 533 ms |
| Maximum observation age | `1500 ms` | Discards responses based on stale observations without choosing a replacement locally; not a separate popup field |
| Maximum decisions | `300` | Releases control when the request budget is exhausted |
| Target score | `0` | No score-based stop; a positive target releases driving inputs when reached |
| Automatic restart | Off | Must be enabled explicitly to continue across games |
| Thinking mode / budget | `off / 0` | Disables thinking on a local compatible service |

Predictions approximate observed objects and physical behavior. Latency, traffic reactions, and random spawning can make them inaccurate. Submitting an instruction does not guarantee a successful roll, lane change, or collision avoidance. No single-game score is guaranteed.

## Data and permissions

- Manually entered API Keys use `chrome.storage.session`, accessible to trusted extension contexts. An optional local `.env` stores the Key in plain text and restores it in fresh browser sessions. Neither source writes the Key into persistent configuration, the page card, or exported records. Clearing the Key stops driving, removes the session copy, and disables file auto-loading.
- Other connection and driving settings use `chrome.storage.local`. Runtime status is kept in the extension session and displayed in the game page.
- Game telemetry and the action question are sent to the configured model endpoint. The extension does not send screenshots or other webpage content. The service may archive requests under its own rules.
- The history list shows submitted instructions by default. Exports retain unsubmitted receipts and audit fields from the current bounded buffer, up to 200 decisions; this is not an unlimited history.
- Permissions are `activeTab`, `scripting`, and `storage`. Host scopes are defined in [manifest.json](extension/manifest.json). The extension supports only the specified game site and endpoint allowlist.

## Local development

Requires **Node.js 22+** and **Python 3**. There are no third-party npm dependencies, so no dependency installation is needed:

```sh
npm run check
npm test
npm run package
```

Checks and unit tests do not call a live model or launch the game. Packaging produces `dist/roadster-startlux-driver-v0.4.4.zip`; after extraction, load its `extension` directory. Changes to the game's internal interface may break compatibility. Report errors with reproduction steps and omit your API Key.

## License

Project-owned code and documentation are available under the [MIT License](LICENSE). Third-party games, brands, and services are not relicensed under MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
