# 本机 Key 自动载入 / Local Key auto-loading

## 配置 / Setup

在 Chrome 实际加载的 `extension` 目录中操作，而不是仓库根目录：

Use the `extension` directory actually loaded in Chrome, not the repository root:

```sh
cp extension/.env.example extension/.env
chmod 600 extension/.env
```

编辑 `extension/.env`，将占位符替换为自己的现有 Key：

Edit `extension/.env` and replace the placeholder with your existing Key:

```dotenv
STARTLUX_API_KEY=YOUR_EXISTING_API_KEY
```

在 `chrome://extensions` 找到 Roadster 决策驾驶员，点击重新加载。打开插件后应显示 **本机 .env · 自动载入**；点击测试模型连接，确认接口成功。重开浏览器后会自动读取，不需要重复输入。

Reload Roadster Decision Driver at `chrome://extensions`. The popup should show **本机 .env · 自动载入** (loaded automatically from the local file). Test the model connection. Fresh browser sessions load the file automatically.

## 读取规则 / Loading rules

- 手动输入的会话 Key 优先；文件只在没有会话 Key 时加载。 / A manually entered session Key takes priority; the file loads only when the session has no Key.
- 编辑文件后重新加载扩展，以免继续使用旧的会话副本。 / Reload after editing so the old session copy is replaced.
- 点击清除会停止驾驶、删除会话副本，并记住停用文件自动载入。再次保存设置可从文件恢复。清除按钮不会删除磁盘上的 `.env`；彻底移除需要自行删除该文件。 / Clear stops driving, removes the session copy, and disables file auto-loading across restarts. Save settings can restore it. Clear does not delete the file from disk; remove it separately to erase the saved Key.
- 支持单行未引用、单引号或双引号值；不执行命令、不展开环境变量。 / Single-line bare, single-quoted, and double-quoted values are supported. No commands or variable interpolation are executed.
- 这只保存认证 Key，不会启动模型服务或 SSH 隧道。连接仍需可用。 / This stores authentication only; it does not start a model service or SSH tunnel.

## 本机与云端 / Local and public files

真实 `.env` 是本机明文文件，Git 忽略规则与 ZIP 打包都会排除它。云端只包含无密钥的 `.env.example` 和加载代码；换电脑后需单独配置自己的 Key。Key 不进入游戏页面、HUD 或运行记录导出。

The real `.env` is a local plain-text file excluded by Git and ZIP packaging. The public repository contains only a credential-free `.env.example` and the loader. Configure your own Key on another computer. The Key is never included in the game page, HUD, or run exports.

## 无法载入时 / Troubleshooting

1. 确认文件叫 `.env`，不是 `.env.txt`，并且在实际加载的扩展目录里。 / Check the filename is `.env`, not `.env.txt`, in the loaded extension directory.
2. 确认只有一条非空的 `STARTLUX_API_KEY`，不要重复声明。 / Use exactly one nonempty `STARTLUX_API_KEY` assignment.
3. 如果曾点击清除，点击保存设置重新启用，再测试连接。 / After Clear, save settings to restore file loading, then test the connection.
4. 文件不存在或无效时仍可在弹窗手动输入；接口错误还需检查 URL、服务和隧道。 / Missing or invalid files allow manual popup entry. For API errors, check the URL, service, and tunnel as well.
