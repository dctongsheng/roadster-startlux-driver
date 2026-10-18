# Third-party notices / 第三方来源与许可边界

本仓库的 [MIT License](LICENSE) 授权本项目自有的扩展实现、测试、工具和文档。它不授予第三方游戏、模型、服务、商标或素材的权利。

## Roadster Rush

- 外部游戏入口：[https://roadster-rush.ai.studio/](https://roadster-rush.ai.studio/)。
- 扩展在使用者打开的游戏页面中通过其现有结构化接口读取状态、提交原生动作，游戏仍由该站点加载运行。
- 本仓库不分发原游戏 JavaScript 包、Three.js 等游戏依赖或可复用的游戏资源包，也不提供包含原游戏的离线版本。
- `docs/media/` 中的截图与 GIF、Release 中的演示视频记录实际游戏运行，仅用于展示扩展效果及游戏过程。游戏画面、角色、车辆外观、音频等第三方内容仍归相应权利人；本项目的 MIT 许可不将这些内容重新授权为 MIT。
- 条件预测与控制适配是本项目对已观察接口及行为的独立实现，不代表游戏作者授权本项目重新许可原游戏。
- 游戏、车辆外观及 Tesla / Roadster 等相关名称或标识归各自权利人所有。本项目与 Tesla 或游戏作者无官方隶属、赞助或认可关系。

Gameplay screenshots, GIFs in `docs/media/`, and the demo video hosted in Releases show actual gameplay. Third-party visuals, vehicle designs, audio, and trademarks remain the property of their respective owners and are not relicensed under this project's MIT license. The repository does not distribute the original game program or a reusable game asset bundle. This project has no official affiliation with Tesla or the game's author.

## StartLux / System One / TypeSafe

扩展支持 System One 风格的决策协议和列明的服务入口。这些名称仅说明兼容目标；本仓库不包含服务端、训练代码、模型权重或服务凭据，也不转授模型或服务许可证。模型服务的使用条件、计费及服务端数据保留规则由各服务提供方确定。

界面中的模型名称与思考遥测取自接口响应，不构成对实际权重、参数规模或官方身份的独立认证。

## 开发与运行依赖

扩展未捆绑第三方 JavaScript 库，没有 npm 第三方依赖。扩展使用浏览器提供的标准 API；测试和检查使用 Node.js 标准库，打包使用 Python 标准库。浏览器、Node.js 和 Python 分别受其自身许可证约束，未随本项目再分发。

第三方项目的许可不因本仓库使用 MIT 而改变。贡献时请保留必要署名，不提交无权公开的上游代码、游戏素材、模型权重或真实凭据。
