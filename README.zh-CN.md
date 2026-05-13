# Codex OpenCode Go Bridge

> 一个适合 Windows 用户的小型本地桥接服务和模型切换面板，让 Codex 使用 OpenCode Go DeepSeek 模型。

一个很小的本地桥接工具，让 Windows 上的 Codex 可以使用 OpenCode Go 的 DeepSeek 模型，并提供本地网页面板切换默认模型。

它的目标是保持轻量：

- 支持 `deepseek-v4-flash`
- 支持 `deepseek-v4-pro`
- 保留切回 `gpt-5.5` 的能力
- 真实 OpenCode Go API Key 只放在 Windows 用户环境变量 `OPENCODE_GO_API_KEY`
- 不把真实 API Key 写进 Codex `config.toml`
- 提供本地控制台：`http://127.0.0.1:41425/`
- 控制台支持白天模式和深色模式

## 为什么做这个

Codex 可以配置自定义模型服务，但对很多 Windows 用户来说，手动改 `config.toml`、配环境变量、启动本地桥接服务并不直观。

这个项目把桥接服务、Codex profile 配置、网页切换面板放在一起，让配置过程更像一个小工具。

为了兼容 DeepSeek 的工具调用，桥接服务转发到 OpenCode Go 时会显式加入：

```js
thinking: { type: "disabled" }
```

这样可以避免 Codex 执行工具调用后 DeepSeek 报 `reasoning_content` 相关错误。

## 需要什么

- Windows 10 或 Windows 11
- Node.js LTS 或更新版本
- 已安装 Codex CLI/Desktop
- OpenCode Go API Key

检查 Node.js：

```powershell
node --version
```

## Windows 安装

下载或克隆这个仓库，然后在项目目录里打开 PowerShell。

运行：

```powershell
PowerShell -ExecutionPolicy Bypass -File .\windows\install-windows.ps1
```

如果希望 Windows 登录后自动启动桥接服务：

```powershell
PowerShell -ExecutionPolicy Bypass -File .\windows\install-windows.ps1 -RegisterStartup
```

设置 OpenCode Go API Key：

```powershell
setx OPENCODE_GO_API_KEY "你的 OpenCode Go API Key"
```

关闭当前 PowerShell，重新打开一个新的 PowerShell，然后启动桥接服务：

```powershell
PowerShell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.codex\start-opencode-go-bridge.ps1"
```

打开控制台：

```text
http://127.0.0.1:41425/
```

## 安装脚本会写入什么

文件：

```text
%USERPROFILE%\.codex\opencode-go-bridge\server.mjs
%USERPROFILE%\.codex\start-opencode-go-bridge.ps1
%USERPROFILE%\.codex\use-deepseek.ps1
%USERPROFILE%\.codex\use-deepseek-pro.ps1
%USERPROFILE%\.codex\use-gpt55.ps1
```

Codex 配置：

```toml
model = "deepseek-v4-flash"
model_provider = "opencode-go-bridge"
model_reasoning_effort = "medium"

[profiles.opencode-go]
model = "deepseek-v4-flash"
model_provider = "opencode-go-bridge"

[profiles.opencode-go-pro]
model = "deepseek-v4-pro"
model_provider = "opencode-go-bridge"

[model_providers.opencode-go-bridge]
name = "OpenCode Go Bridge"
base_url = "http://127.0.0.1:41425/v1"
api_key = "local-bridge"
wire_api = "responses"
```

`api_key = "local-bridge"` 只是本地占位符。真实 API Key 在 `OPENCODE_GO_API_KEY`。

## 切换模型

可以用网页控制台，也可以运行：

```powershell
PowerShell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.codex\use-deepseek.ps1"
PowerShell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.codex\use-deepseek-pro.ps1"
PowerShell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.codex\use-gpt55.ps1"
```

切换模型后，需要新开 Codex 聊天才会生效。

## 验证

健康检查：

```powershell
curl http://127.0.0.1:41425/health
```

状态接口：

```powershell
curl http://127.0.0.1:41425/api/state
```

Flash 测试：

```powershell
codex -p opencode-go exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --color never "Reply with exactly: pong"
```

Pro 测试：

```powershell
codex -p opencode-go-pro exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --color never "Reply with exactly: pro-pong"
```

## 安全说明

- 不要提交 OpenCode Go API Key
- 不要把真实 API Key 写进 `config.toml`
- 这个桥接服务只绑定 `127.0.0.1`，用于本机
- 网页控制台只改变以后新开的 Codex 聊天的默认模型

## 当前边界

这个项目故意保持很小。网页控制台只负责查看状态和切换默认模型，不打算做成完整的系统管理面板。

## 许可证

MIT
