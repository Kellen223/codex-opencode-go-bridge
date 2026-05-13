# Codex OpenCode Go Bridge

> Windows-friendly local bridge and dashboard for using OpenCode Go DeepSeek models in Codex.

A small local bridge for using OpenCode Go DeepSeek models in Codex, with a local dashboard for switching the default model.

It is designed to stay simple:

- Supports `deepseek-v4-flash`
- Supports `deepseek-v4-pro`
- Keeps the ability to switch back to `gpt-5.5`
- Stores the real OpenCode Go API key in the Windows user environment variable `OPENCODE_GO_API_KEY`
- Does not write the real API key into Codex `config.toml`
- Includes a local dashboard at `http://127.0.0.1:41425/`
- Supports light and dark mode in the dashboard

## Why this exists

Codex can use custom model providers, but configuring them by hand is not friendly for many Windows users. This project packages the bridge, Codex profile setup, and model switching dashboard into one small local tool.

The bridge uses Codex's Responses API shape on the Codex side and forwards requests to OpenCode Go. For DeepSeek tool-call compatibility, requests sent to OpenCode Go explicitly include:

```js
thinking: { type: "disabled" }
```

This avoids DeepSeek `reasoning_content` errors after Codex tool calls.

## Requirements

- Windows 10 or Windows 11
- Node.js LTS or newer
- Codex CLI/Desktop installed
- OpenCode Go API key

Check Node.js:

```powershell
node --version
```

## Install on Windows

Download or clone this repository, then open PowerShell in the project folder.

Run:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\windows\install-windows.ps1
```

To also create a Windows login startup shortcut:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\windows\install-windows.ps1 -RegisterStartup
```

Then set your OpenCode Go API key:

```powershell
setx OPENCODE_GO_API_KEY "your-opencode-go-api-key"
```

Close PowerShell, open a new PowerShell window, and start the bridge:

```powershell
PowerShell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.codex\start-opencode-go-bridge.ps1"
```

Open the dashboard:

```text
http://127.0.0.1:41425/
```

## What the installer writes

Files:

```text
%USERPROFILE%\.codex\opencode-go-bridge\server.mjs
%USERPROFILE%\.codex\start-opencode-go-bridge.ps1
%USERPROFILE%\.codex\use-deepseek.ps1
%USERPROFILE%\.codex\use-deepseek-pro.ps1
%USERPROFILE%\.codex\use-gpt55.ps1
```

Codex config:

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

`api_key = "local-bridge"` is only a local placeholder. The real key stays in `OPENCODE_GO_API_KEY`.

## Switch models

Use the dashboard, or run:

```powershell
PowerShell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.codex\use-deepseek.ps1"
PowerShell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.codex\use-deepseek-pro.ps1"
PowerShell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.codex\use-gpt55.ps1"
```

Model changes affect new Codex chats only. Open a new Codex chat after switching.

## Verify

Health check:

```powershell
curl http://127.0.0.1:41425/health
```

Dashboard state:

```powershell
curl http://127.0.0.1:41425/api/state
```

Flash test:

```powershell
codex -p opencode-go exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --color never "Reply with exactly: pong"
```

Pro test:

```powershell
codex -p opencode-go-pro exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --color never "Reply with exactly: pro-pong"
```

## Security notes

- Do not commit your OpenCode Go API key.
- Do not put your real API key in `config.toml`.
- This bridge binds to `127.0.0.1` and is meant for local use.
- The dashboard changes only the default model for future Codex chats.

## Current scope

This is intentionally small. The dashboard is for checking status and switching the default model. It is not intended to become a full system management panel.

## License

MIT
