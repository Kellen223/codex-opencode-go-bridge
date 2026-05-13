# Dashboard 模型切换与显示修复说明

这份文档记录 Windows 端从“能切换模型”到“Dashboard 正确显示实际模型”的完整修复过程，方便在另一台 Mac 的 Codex 环境里对照修复。

Mac 端不要照抄本文里的 Windows 路径。Windows 路径示例是：

```text
C:\Users\admin\.codex\opencode-go-bridge\server.mjs
C:\Users\admin\.codex\config.toml
```

Mac 端通常对应为：

```text
~/.codex/opencode-go-bridge/server.mjs
~/.codex/config.toml
```

## 目标

Dashboard 最终要满足这些行为：

- 切换到 `deepseek-v4-flash` 后，新开的 Codex 会话实际走 Flash。
- 切换到 `deepseek-v4-pro` 后，新开的 Codex 会话实际走 Pro。
- Dashboard 顶部显示当前默认模型。
- Dashboard 顶部显示最近一次桥接服务实际转发的模型。
- 最近会话列表默认只显示“实际模型”。
- Codex Desktop 自己写入的原始模型记录默认隐藏，只在“详情”里展示。
- `thinking: { type: "disabled" }` 必须保留，避免 DeepSeek 工具调用后出现 `reasoning_content` 相关报错。

## 问题过程

最开始的切换按钮会改 `~/.codex/config.toml`，但 Codex Desktop 新开会话时可能仍把旧模型名写进会话文件。例如：

- Dashboard 已切到 `deepseek-v4-flash`
- 新会话实际已经由桥接服务转发到 Flash
- 但 Codex Desktop 会话日志里仍记录 `model: deepseek-v4-pro`

这会导致 Dashboard 如果只读 Codex 会话文件，就会误显示成 Pro。

后来为了修复这个问题，曾临时让所有桥接会话都显示“当前默认模型”。这又产生了第二个问题：

- 历史 Flash 会话在切到 Pro 后，也会被显示成 Pro
- 历史 Pro 会话在切到 Flash 后，也会被显示成 Flash

所以正确方案不能只读 Codex 会话文件，也不能用当前默认模型覆盖所有历史记录。

## 根因

Dashboard 里有三种“模型”需要分清：

- 当前默认模型：`config.toml` 顶部的 `model`
- Codex 原始记录：Codex Desktop 写进会话 jsonl 的 `turn_context.model`
- 桥接实际转发：`server.mjs` 实际发给 OpenCode Go API 的 `model`

真实调用以“桥接实际转发”为准。

Codex 原始记录只能当排查信息，不能当主显示。

## 最终设计

最终采用一个很轻的本地事件日志：

```text
~/.codex/opencode-go-bridge/events.jsonl
```

每次桥接服务收到 `/v1/responses` 请求并转发给 OpenCode Go 前，记录一行：

```json
{
  "timestamp": "2026-05-13T08:20:41.002Z",
  "response_id": "resp_xxx",
  "requested_model": "deepseek-v4-flash",
  "forwarded_model": "deepseek-v4-pro",
  "title": "用户第一条消息摘要"
}
```

Dashboard 读取最近会话时：

- 先读 Codex 会话 jsonl，拿到标题、时间、provider、Codex 原始模型。
- 再读 `events.jsonl`，按时间和标题匹配桥接事件。
- 如果匹配到桥接事件，最近会话主列显示 `forwarded_model`。
- 如果匹配不到桥接事件，退回显示 Codex 原始模型。
- 非 `opencode-go-bridge` 的会话不能匹配桥接事件，避免 OpenAI/GPT 会话被误标成 DeepSeek。

## 关键代码点

以下代码都在 `server.mjs`。

### 1. 增加事件日志路径

```js
const BRIDGE_EVENTS = join(CODEX_HOME, "opencode-go-bridge", "events.jsonl");
let lastForwardedModel = null;
let lastBridgeEvent = null;
```

### 2. 写入桥接事件

在处理 `/v1/responses` 的函数里，确定最终转发模型后记录事件：

```js
const config = await readCodexConfig();
const model = currentBridgeDefaultModel(config);
lastForwardedModel = model;
await appendBridgeEvent({
  timestamp: new Date().toISOString(),
  response_id: responseId,
  requested_model: body.model || null,
  forwarded_model: model,
  title: extractRequestTitle(body.input),
});
```

注意：这里的 `model` 必须来自当前 `config.toml` 默认模型，而不是盲信 `body.model`。这是为了绕过 Codex Desktop 可能缓存旧模型名的问题。

### 3. 读取事件日志要容错

`events.jsonl` 如果有坏行，不能让整个 Dashboard 状态接口失败：

```js
async function readBridgeEvents(limit = 200) {
  try {
    const text = await readFile(BRIDGE_EVENTS, "utf8");
    const events = [];
    for (const line of text.split(/\r?\n/).filter(Boolean).slice(-limit)) {
      try {
        const event = JSON.parse(line.replace(/^\uFEFF/, ""));
        if (event?.forwarded_model) events.push(event);
      } catch {
        // Ignore partial or corrupted bridge event lines.
      }
    }
    return events;
  } catch {
    return [];
  }
}
```

### 4. 只给桥接会话匹配桥接事件

这是一个重要防误判点。不能让 GPT/OpenAI 会话匹配到 DeepSeek 桥接事件。

```js
const bridgeEvent =
  provider === "opencode-go-bridge"
    ? findBridgeEventForSession(session, bridgeEvents)
    : null;
```

### 5. 最近会话主显示实际模型

```js
function effectiveSessionModel(provider, model, bridgeEvent) {
  if (provider === "opencode-go-bridge" && bridgeEvent?.forwarded_model) {
    return bridgeEvent.forwarded_model;
  }
  return model || null;
}
```

### 6. Dashboard 详情默认隐藏

表格主行只显示：

```js
session.effective_model || session.model || "-"
```

原始记录放进详情行：

```js
appendDetailLine(detailGrid, "实际模型", session.effective_model || session.model);
appendDetailLine(detailGrid, "Codex 原始记录", session.model);
appendDetailLine(detailGrid, "Codex 请求模型", session.bridge_requested_model);
appendDetailLine(detailGrid, "桥接实际转发", session.bridge_forwarded_model);
appendDetailLine(detailGrid, "Provider", session.provider);
appendDetailLine(detailGrid, "文件", session.file);
```

详情行默认隐藏：

```js
detailRow.hidden = true;
```

点击按钮切换：

```js
details.onclick = () => {
  detailRow.hidden = !detailRow.hidden;
  details.textContent = detailRow.hidden ? "详情" : "收起";
};
```

## Mac 端修复步骤

在 Mac 上按这个顺序做。

### 1. 备份文件

```bash
cp ~/.codex/opencode-go-bridge/server.mjs ~/.codex/opencode-go-bridge/server.mjs.bak
cp ~/.codex/config.toml ~/.codex/config.toml.bak
```

### 2. 对照 Windows 修复版 server.mjs

重点检查这些函数或变量是否存在：

- `BRIDGE_EVENTS`
- `lastForwardedModel`
- `lastBridgeEvent`
- `appendBridgeEvent`
- `readBridgeEvents`
- `findBridgeEventForSession`
- `effectiveSessionModel(provider, model, bridgeEvent)`
- `readRecentSessions()` 中只给 `opencode-go-bridge` 匹配桥接事件
- `handleResponses()` 中用 `currentBridgeDefaultModel(config)` 作为实际转发模型
- Dashboard 表格有“详情/收起”按钮
- `thinking: { type: "disabled" }`

### 3. 检查 config.toml

Flash 默认：

```toml
model = "deepseek-v4-flash"
model_provider = "opencode-go-bridge"
model_reasoning_effort = "medium"
```

Pro 默认：

```toml
model = "deepseek-v4-pro"
model_provider = "opencode-go-bridge"
model_reasoning_effort = "medium"
```

Provider 要类似：

```toml
[model_providers.opencode-go-bridge]
name = "OpenCode Go Bridge"
base_url = "http://127.0.0.1:41425/v1"
api_key = "local-bridge"
wire_api = "responses"
```

### 4. 重启 Mac 桥接服务

如果 Mac 端是手动启动：

```bash
pkill -f "opencode-go-bridge/server.mjs" || true
OPENCODE_GO_API_KEY="$OPENCODE_GO_API_KEY" node ~/.codex/opencode-go-bridge/server.mjs
```

如果 Mac 端用了 LaunchAgent，就重载对应 plist。注意这只适用于 Mac，Windows 端不要用 LaunchAgent。

### 5. 验证健康状态

```bash
curl http://127.0.0.1:41425/health
curl http://127.0.0.1:41425/api/state
```

检查：

- `bridge.default_model` 是当前默认模型
- `bridge.last_forwarded_model` 在跑过一次测试后会显示最近实际转发模型
- `codex.model` 和 `config.toml` 顶部一致

### 6. 验证 Flash 显示

先在 Dashboard 切到 Flash，然后故意用 Pro profile 启动测试：

```bash
codex -p opencode-go-pro exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --color never "Reply with exactly: flash-display-check"
```

预期：

- 命令输出 `flash-display-check`
- Codex 日志可能仍写 `model: deepseek-v4-pro`
- Dashboard 最近会话主列应显示 `deepseek-v4-flash`
- 点详情后可以看到 Codex 原始记录是 Pro，但桥接实际转发是 Flash

### 7. 验证 Pro 显示

在 Dashboard 切到 Pro，然后故意用 Flash profile 启动测试：

```bash
codex -p opencode-go exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --color never "Reply with exactly: pro-display-check"
```

预期：

- 命令输出 `pro-display-check`
- Dashboard 最近会话主列应显示 `deepseek-v4-pro`
- 点详情后可以看到 Codex 原始记录可能是 Flash，但桥接实际转发是 Pro

## 常见误解

### Dashboard 主列和详情里不一致，以哪个为准？

看主列的“实际模型”。

详情里的“Codex 原始记录”只是 Codex Desktop 写入会话文件的记录，可能因为缓存或 profile 参数显示旧模型。

### 为什么切换后需要新开聊天？

Codex 会话启动时会读取模型配置。已打开的会话不会中途换模型。

### 为什么要记录 events.jsonl？

因为 Codex 原始会话日志不一定等于桥接服务真实转发的模型。`events.jsonl` 是桥接服务自己写的记录，更接近真实调用。

### 旧会话为什么还有可能显示不准？

只有修复后产生的新会话，才会有桥接事件记录。修复前的旧会话如果没有事件记录，只能退回读 Codex 原始记录。

## 最终判断标准

Mac 端修复完成后，Dashboard 应该满足：

- 顶部当前默认模型和按钮选中状态一致。
- 顶部最近实际转发模型和最后一次测试一致。
- 最近会话主列显示实际模型。
- `Codex 原始记录` 默认隐藏在详情里。
- 切 Flash 后，即使 Codex 原始记录写 Pro，主列仍显示 Flash。
- 切 Pro 后，即使 Codex 原始记录写 Flash，主列仍显示 Pro。
