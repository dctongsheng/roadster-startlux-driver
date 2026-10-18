# 演示媒体 / Demo media

这些媒体展示真实游戏画面，没有合成模型参数、指令或成绩。

| 文件 / File | 来源及处理 / Source and processing |
| --- | --- |
| `live-driving.jpg` | 2026-10-18 使用公开版 v0.4.3 扩展进行原生实时驾驶时的浏览器截图；裁去浏览器栏并缩放。 / Browser screenshot from native real-time driving with the public v0.4.3 extension; browser chrome cropped, image resized. |
| `startlux-hud.jpg` | 上述同一帧中决策卡片的原始像素裁剪。 / Pixel crop of the live decision card from the same frame. |
| `startlux-waiting.jpg` | 同一次运行中，指令到期后的真实单行提示。 / The compact status line after that instruction expired in the same run. |
| `demo-preview.gif` | 用户提供的另一局游戏录屏的前 4 秒；原速、12 fps、无音频 GIF。 / First 4 seconds of a separate user-provided gameplay recording, at original speed; 12 fps silent GIF. |

完整视频 / Full video: [startlux-roadster-demo.mp4](https://github.com/dctongsheng/roadster-startlux-driver/releases/download/v0.4.3/startlux-roadster-demo.mp4)

视频保留完整约 16 秒游戏过程和音频，裁去浏览器栏及桌面 Dock，转为 H.264 / AAC MP4；没有加速或叠加决策卡片。该录屏不含右侧 HUD，README 中的 HUD 截图来自另一次实时驾驶运行。

The full recording retains approximately 16 seconds of gameplay and audio. Browser chrome and the desktop Dock are cropped, and the video is encoded as H.264 / AAC MP4. No speed changes or decision-card overlays were added. The recording does not show the HUD; the README's HUD screenshots come from a separate live driving run.

图中 `731ms`、置信度和思考状态是该帧对应响应的实际显示值，不代表平均性能或动作成功率。分数也是运行当时的画面，不构成基准测试或保证。

The `731ms`, confidence, and thinking status shown are the values displayed for that response, not average performance or an action success rate. Visible scores are individual gameplay moments, not benchmark results or guarantees.

游戏画面、音频和品牌权利见 [第三方说明 / Third-party notices](../../THIRD_PARTY_NOTICES.md)。
