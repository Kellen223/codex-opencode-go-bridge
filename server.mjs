#!/usr/bin/env node
import http from "node:http";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const PORT = Number(process.env.OPENCODE_GO_BRIDGE_PORT || 41425);
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const CODEX_CONFIG = join(CODEX_HOME, "config.toml");
const CODEX_SESSIONS = join(CODEX_HOME, "sessions");
const CODEX_SESSIONS_ARCHIVE = join(CODEX_HOME, "sessions-archive");
const BRIDGE_EVENTS = join(CODEX_HOME, "opencode-go-bridge", "events.jsonl");
const OPENCODE_BASE_URL =
  process.env.OPENCODE_GO_BASE_URL || "https://opencode.ai/zen/go/v1";
const DEFAULT_OPENCODE_MODEL =
  process.env.OPENCODE_GO_MODEL || "deepseek-v4-flash";
const SUPPORTED_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
let lastForwardedModel = null;
let lastBridgeEvent = null;
const SELECTABLE_MODELS = [
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    provider: "opencode-go-bridge",
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "opencode-go-bridge",
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    provider: null,
  },
];

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "input_text" || part?.type === "output_text") {
        return part.text || "";
      }
      if (part?.text) return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeRole(role) {
  if (role === "developer") return "system";
  return role || "user";
}

function responsesInputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];

  const messages = [];
  let pendingToolCalls = [];
  const flushPendingToolCalls = () => {
    if (!pendingToolCalls.length) return;
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: pendingToolCalls,
    });
    pendingToolCalls = [];
  };

  for (const item of input) {
    if (!item) continue;

    if (item.type === "message" || item.role) {
      flushPendingToolCalls();
      messages.push({
        role: normalizeRole(item.role),
        content: normalizeContent(item.content),
      });
      continue;
    }

    if (item.type === "function_call") {
      pendingToolCalls.push({
        id: item.call_id || item.id || randomUUID(),
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments || "{}",
        },
      });
      continue;
    }

    if (item.type === "function_call_output") {
      flushPendingToolCalls();
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content:
          typeof item.output === "string"
            ? item.output
            : JSON.stringify(item.output ?? ""),
      });
    }
  }
  flushPendingToolCalls();
  return messages;
}

function responsesToolsToChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const chatTools = tools
    .filter((tool) => tool?.type === "function")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.parameters || {},
      },
    }));
  return chatTools.length ? chatTools : undefined;
}

async function readCodexConfig() {
  const text = await readFile(CODEX_CONFIG, "utf8");
  const topLevel = text.split(/\n(?=\[)/, 1)[0];
  const model = topLevel.match(/^model = "([^"]+)"/m)?.[1] || null;
  const provider =
    topLevel.match(/^model_provider = "([^"]+)"/m)?.[1] || null;
  return { text, model, provider, path: CODEX_CONFIG };
}

function updateTopLevelSetting(text, key, value) {
  const match = text.match(/\n(?=\[)/);
  const splitIndex = match ? match.index + 1 : text.length;
  let topLevel = text.slice(0, splitIndex);
  const rest = text.slice(splitIndex);
  const pattern = new RegExp(`^${key} = ".*"$`, "m");
  if (value === null) {
    topLevel = topLevel.replace(new RegExp(`^${key} = ".*"\\r?\\n`, "m"), "");
    return topLevel + rest;
  }
  const line = `${key} = "${value}"`;
  if (pattern.test(topLevel)) {
    topLevel = topLevel.replace(pattern, line);
  } else {
    const modelLine = topLevel.match(/^model = ".*"\r?\n/m);
    if (key === "model_provider" && modelLine) {
      topLevel = topLevel.replace(modelLine[0], `${modelLine[0]}${line}\n`);
    } else {
      topLevel = `${line}\n${topLevel}`;
    }
  }
  return topLevel + rest;
}

async function setDefaultModel(model) {
  const selected = SELECTABLE_MODELS.find((item) => item.id === model);
  if (!selected) {
    throw new Error(`Unsupported model: ${model}`);
  }

  const config = await readCodexConfig();
  let text = updateTopLevelSetting(config.text, "model", selected.id);
  text = updateTopLevelSetting(text, "model_provider", selected.provider);
  await writeFile(CODEX_CONFIG, text);
  return readCodexConfig();
}

async function collectSessionFiles(dir, limit = 24) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSessionFiles(path, limit)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const info = await stat(path);
      files.push({ path, mtimeMs: info.mtimeMs });
    }
  }

  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function summarizeText(text, maxLength = 64) {
  const requestMatch = String(text || "").match(/## My request for Codex:\s*([\s\S]+)/);
  const source = requestMatch ? requestMatch[1] : text;
  const normalized = String(source || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "无标题会话";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}...`
    : normalized;
}

function isUsefulTitle(text) {
  const normalized = String(text || "").trim();
  return normalized && !normalized.startsWith("<environment_context>");
}

function extractInputText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (item?.type === "input_text" || item?.type === "text") {
        return item.text || "";
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function extractRequestTitle(input) {
  if (typeof input === "string") return summarizeText(input, 96);
  if (!Array.isArray(input)) return "";
  for (const item of input) {
    if (item?.role === "user") {
      const text = extractInputText(item.content);
      if (
        text &&
        !text.trim().startsWith("<environment_context>") &&
        !text.trim().startsWith("<permissions instructions>")
      ) {
        return summarizeText(text, 96);
      }
    }
    if (item?.type === "input_text" || item?.type === "text") {
      return summarizeText(item.text, 96);
    }
  }
  return "";
}

async function appendBridgeEvent(event) {
  lastBridgeEvent = event;
  await mkdir(join(CODEX_HOME, "opencode-go-bridge"), { recursive: true });
  await appendFile(BRIDGE_EVENTS, `${JSON.stringify(event)}\n`, "utf8");
}

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

function findBridgeEventForSession(session, events) {
  const sessionTime = Date.parse(session.last_activity_at || session.started_at || "");
  if (!Number.isFinite(sessionTime)) return null;
  const title = summarizeText(session.title, 96);
  let best = null;
  let bestDistance = Infinity;

  for (const event of events) {
    const eventTime = Date.parse(event.timestamp || "");
    if (!Number.isFinite(eventTime)) continue;
    const distance = Math.abs(eventTime - sessionTime);
    if (distance > 10 * 60 * 1000) continue;

    const eventTitle = summarizeText(event.title, 96);
    const titleMatches =
      title &&
      eventTitle &&
      (title === eventTitle || title.startsWith(eventTitle) || eventTitle.startsWith(title));
    if (!titleMatches && distance > 90 * 1000) continue;

    if (distance < bestDistance) {
      best = event;
      bestDistance = distance;
    }
  }

  return best;
}

function currentBridgeDefaultModel(config) {
  return SUPPORTED_MODELS.has(config?.model)
    ? config.model
    : DEFAULT_OPENCODE_MODEL;
}

function effectiveSessionModel(provider, model, bridgeEvent) {
  if (provider === "opencode-go-bridge" && bridgeEvent?.forwarded_model) {
    return bridgeEvent.forwarded_model;
  }
  return model || null;
}

async function readRecentSessions() {
  const files = await collectSessionFiles(CODEX_SESSIONS);
  const bridgeEvents = await readBridgeEvents();
  const sessions = [];

  for (const file of files) {
    const text = await readFile(file.path, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    let meta = null;
    let context = null;
    let lastTimestamp = null;
    let title = null;

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.timestamp) lastTimestamp = event.timestamp;
        if (event.type === "session_meta") meta = event.payload;
        if (!title && event.type === "event_msg" && event.payload?.type === "user_message") {
          const candidate = event.payload.message;
          if (isUsefulTitle(candidate)) {
            title = candidate;
          }
        }
        if (!title && event.type === "response_item" && event.payload?.role === "user") {
          const candidate = extractInputText(event.payload.content);
          if (isUsefulTitle(candidate)) {
            title = candidate;
          }
        }
        if (event.type === "turn_context") {
          context = event.payload;
        }
      } catch {
        // Ignore partial or non-JSON log lines.
      }
    }

    if (!meta && !context) continue;
    const provider = meta?.model_provider || null;
    const model = context?.model || null;
    const session = {
      id: meta?.id || null,
      title: summarizeText(title),
      started_at: meta?.timestamp || null,
      last_activity_at: lastTimestamp,
      cwd: meta?.cwd || context?.cwd || null,
      originator: meta?.originator || null,
      provider,
      model,
      effective_model: null,
      bridge_forwarded_model: null,
      bridge_requested_model: null,
      file: file.path,
    };
    const bridgeEvent =
      provider === "opencode-go-bridge"
        ? findBridgeEventForSession(session, bridgeEvents)
        : null;
    session.bridge_forwarded_model = bridgeEvent?.forwarded_model || null;
    session.bridge_requested_model = bridgeEvent?.requested_model || null;
    session.effective_model = effectiveSessionModel(provider, model, bridgeEvent);
    sessions.push(session);
  }

  return sessions
    .sort(
      (a, b) =>
        new Date(b.last_activity_at || b.started_at || 0) -
        new Date(a.last_activity_at || a.started_at || 0),
    )
    .slice(0, 10);
}

async function findSessionFile(sessionId) {
  if (!sessionId) throw new Error("Missing session id.");
  const files = await collectSessionFiles(CODEX_SESSIONS, 500);
  for (const file of files) {
    const text = await readFile(file.path, "utf8");
    const firstLine = text.split(/\r?\n/, 1)[0];
    try {
      const event = JSON.parse(firstLine);
      if (event.type === "session_meta" && event.payload?.id === sessionId) {
        return file.path;
      }
    } catch {
      // Keep scanning.
    }
  }
  throw new Error(`Session not found: ${sessionId}`);
}

async function archiveSession(sessionId) {
  const source = await findSessionFile(sessionId);
  const date = new Date().toISOString().slice(0, 10);
  const targetDir = join(CODEX_SESSIONS_ARCHIVE, date);
  await mkdir(targetDir, { recursive: true });
  const target = join(targetDir, basename(source));
  await rename(source, target);
  return { id: sessionId, archived_to: target };
}

async function deleteSession(sessionId) {
  const source = await findSessionFile(sessionId);
  await unlink(source);
  return { id: sessionId, deleted: true };
}

async function readDashboardState() {
  const config = await readCodexConfig();
  const defaultModel = currentBridgeDefaultModel(config);
  const bridgeEvents = await readBridgeEvents(1);
  const latestBridgeEvent = lastBridgeEvent || bridgeEvents.at(-1) || null;
  const sessions = await readRecentSessions();
  return {
    ok: true,
    bridge: {
      port: PORT,
      default_model: defaultModel,
      supported_models: [...SUPPORTED_MODELS],
      last_forwarded_model: lastForwardedModel || latestBridgeEvent?.forwarded_model || null,
      last_event: latestBridgeEvent,
    },
    codex: config,
    selectable_models: SELECTABLE_MODELS,
    recent_sessions: sessions,
    note: "Model changes affect new Codex chats only.",
  };
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex Model Control</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f4ef;
      --panel: #ffffff;
      --ink: #1c1d1f;
      --muted: #666f7a;
      --line: #d9d5ca;
      --accent: #0f766e;
      --accent-ink: #ffffff;
      --warn: #a16207;
      --ok: #15803d;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg: #17191c;
      --panel: #22252a;
      --ink: #f4f0e8;
      --muted: #adb5bd;
      --line: #3a3f45;
      --accent: #2dd4bf;
      --accent-ink: #06211d;
      --warn: #fbbf24;
      --ok: #4ade80;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
    }
    main {
      width: min(1080px, calc(100vw - 32px));
      margin: 32px auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 24px;
      margin-bottom: 24px;
    }
    .header-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 32px;
      line-height: 1.1;
      letter-spacing: 0;
    }
    p { color: var(--muted); margin: 0; }
    button {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      border-radius: 8px;
      min-height: 40px;
      padding: 0 14px;
      font-size: 14px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-ink);
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
    }
    h2 {
      font-size: 16px;
      margin: 0 0 14px;
      letter-spacing: 0;
    }
    .current {
      font-size: 28px;
      line-height: 1.15;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .muted { color: var(--muted); }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--ok);
      font-weight: 650;
    }
    .dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--ok);
    }
    .buttons {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .model-button.active {
      border-color: var(--accent);
      box-shadow: inset 0 0 0 1px var(--accent);
      font-weight: 700;
    }
    .danger {
      border-color: #b91c1c;
      color: #b91c1c;
    }
    :root[data-theme="dark"] .danger {
      border-color: #f87171;
      color: #fca5a5;
    }
    .session-title {
      min-width: 220px;
      max-width: 380px;
      font-weight: 650;
    }
    .row-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .row-actions button {
      min-height: 32px;
      padding: 0 10px;
    }
    .session-details td {
      background: color-mix(in srgb, var(--panel) 92%, var(--bg));
      color: var(--muted);
      font-size: 13px;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 18px;
    }
    .detail-grid span {
      display: block;
      color: var(--ink);
      margin-top: 2px;
      word-break: break-all;
    }
    .notice {
      color: var(--warn);
      margin-top: 12px;
      font-size: 14px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      padding: 10px 8px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 650;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
    }
    .full { grid-column: 1 / -1; }
    @media (max-width: 760px) {
      header, .grid { display: block; }
      header button { margin-top: 16px; }
      .header-actions { justify-content: flex-start; }
      section { margin-bottom: 16px; }
      .buttons { grid-template-columns: 1fr; }
      .current { font-size: 22px; }
      main { margin: 18px auto; width: min(100vw - 20px, 1080px); }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Codex Model Control</h1>
        <p>本机模型切换面板，只影响新开的 Codex 聊天。</p>
      </div>
      <div class="header-actions">
        <button id="theme-toggle">深色模式</button>
        <button id="refresh">刷新</button>
      </div>
    </header>

    <div class="grid">
      <section>
        <h2>桥接服务</h2>
        <div class="status"><span class="dot"></span><span id="bridge-status">检查中</span></div>
        <p class="muted" id="bridge-detail"></p>
      </section>

      <section>
        <h2>新聊天默认模型</h2>
        <div class="current" id="current-model">读取中</div>
        <p class="muted" id="current-provider"></p>
      </section>

      <section class="full">
        <h2>切换默认模型</h2>
        <div class="buttons" id="model-buttons"></div>
        <div class="notice">切换后请新开 Codex 聊天；已经打开的聊天不会中途变模型。</div>
      </section>

      <section class="full">
        <h2>最近会话</h2>
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>最近活动</th>
              <th>摘要</th>
              <th>实际模型</th>
              <th>Provider</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="sessions"></tbody>
        </table>
      </section>
    </div>
  </main>

  <script>
    let state = null;
    const root = document.documentElement;
    const savedTheme = localStorage.getItem("codex-model-control-theme") || "light";
    root.dataset.theme = savedTheme;

    async function api(path, options) {
      const response = await fetch(path, {
        headers: { "content-type": "application/json" },
        ...options,
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }

    function formatTime(value) {
      if (!value) return "-";
      return new Date(value).toLocaleString();
    }

    function appendDetailLine(container, label, value) {
      const item = document.createElement("div");
      item.textContent = label;
      const text = document.createElement("span");
      text.textContent = value || "-";
      item.appendChild(text);
      container.appendChild(item);
    }

    function render(data) {
      state = data;
      document.getElementById("bridge-status").textContent = "运行中";
      document.getElementById("bridge-detail").textContent =
        "支持 " + data.bridge.supported_models.join(", ") +
        (data.bridge.last_forwarded_model ? " | 最近实际转发 " + data.bridge.last_forwarded_model : "");
      document.getElementById("current-model").textContent =
        data.codex.model || "未设置";
      document.getElementById("current-provider").textContent =
        data.codex.provider ? "provider: " + data.codex.provider : "provider: openai";

      const buttons = document.getElementById("model-buttons");
      buttons.innerHTML = "";
      for (const model of data.selectable_models) {
        const button = document.createElement("button");
        button.className = "model-button" + (model.id === data.codex.model ? " active" : "");
        button.textContent = model.label;
        button.onclick = () => switchModel(model.id);
        buttons.appendChild(button);
      }

      const sessions = document.getElementById("sessions");
      sessions.innerHTML = "";
      for (const session of data.recent_sessions) {
        const row = document.createElement("tr");
        const titleCell = document.createElement("td");
        titleCell.className = "session-title";
        titleCell.textContent = session.title || "无标题会话";

        row.innerHTML =
          "<td>" + formatTime(session.started_at) + "</td>" +
          "<td>" + formatTime(session.last_activity_at) + "</td>";
        row.appendChild(titleCell);
        row.insertAdjacentHTML(
          "beforeend",
          "<td><code>" + (session.effective_model || session.model || "-") + "</code></td>" +
          "<td><code>" + (session.provider || "-") + "</code></td>",
        );

        const actions = document.createElement("td");
        const actionWrap = document.createElement("div");
        actionWrap.className = "row-actions";

        const detailRow = document.createElement("tr");
        detailRow.className = "session-details";
        detailRow.hidden = true;
        const detailCell = document.createElement("td");
        detailCell.colSpan = 6;
        const detailGrid = document.createElement("div");
        detailGrid.className = "detail-grid";
        appendDetailLine(detailGrid, "实际模型", session.effective_model || session.model);
        appendDetailLine(detailGrid, "Codex 原始记录", session.model);
        appendDetailLine(detailGrid, "Codex 请求模型", session.bridge_requested_model);
        appendDetailLine(detailGrid, "桥接实际转发", session.bridge_forwarded_model);
        appendDetailLine(detailGrid, "Provider", session.provider);
        appendDetailLine(detailGrid, "文件", session.file);
        detailCell.appendChild(detailGrid);
        detailRow.appendChild(detailCell);

        const details = document.createElement("button");
        details.textContent = "详情";
        details.onclick = () => {
          detailRow.hidden = !detailRow.hidden;
          details.textContent = detailRow.hidden ? "详情" : "收起";
        };
        actionWrap.appendChild(details);

        const archive = document.createElement("button");
        archive.textContent = "归档";
        archive.onclick = () => archiveSession(session);
        actionWrap.appendChild(archive);

        const remove = document.createElement("button");
        remove.textContent = "删除";
        remove.className = "danger";
        remove.onclick = () => deleteSession(session);
        actionWrap.appendChild(remove);

        actions.appendChild(actionWrap);
        row.appendChild(actions);
        sessions.appendChild(row);
        sessions.appendChild(detailRow);
      }
    }

    function renderThemeButton() {
      const isDark = root.dataset.theme === "dark";
      document.getElementById("theme-toggle").textContent = isDark ? "白天模式" : "深色模式";
    }

    async function load() {
      try {
        render(await api("/api/state"));
      } catch (error) {
        document.getElementById("bridge-status").textContent = "异常";
        document.getElementById("bridge-detail").textContent = String(error);
      }
    }

    async function switchModel(model) {
      await api("/api/default-model", {
        method: "POST",
        body: JSON.stringify({ model }),
      });
      await load();
    }

    async function archiveSession(session) {
      const ok = confirm("归档这个会话？\\n\\n" + (session.title || session.id) + "\\n\\n文件会移动到 ~/.codex/sessions-archive/，可以找回。");
      if (!ok) return;
      await api("/api/session/archive", {
        method: "POST",
        body: JSON.stringify({ id: session.id }),
      });
      await load();
    }

    async function deleteSession(session) {
      const ok = confirm("永久删除这个本地会话记录？\\n\\n" + (session.title || session.id) + "\\n\\n这个操作不会删除项目代码，但会删除对应 .jsonl 记录。");
      if (!ok) return;
      await api("/api/session/delete", {
        method: "POST",
        body: JSON.stringify({ id: session.id }),
      });
      await load();
    }

    document.getElementById("refresh").onclick = load;
    document.getElementById("theme-toggle").onclick = () => {
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
      localStorage.setItem("codex-model-control-theme", root.dataset.theme);
      renderThemeButton();
    };
    renderThemeButton();
    load();
  </script>
</body>
</html>`;
}

function chatChoiceToResponsesOutput(choice, responseId, model) {
  const message = choice?.message || {};
  const output = [];

  if (message.content) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: message.content,
          annotations: [],
        },
      ],
    });
  }

  for (const toolCall of message.tool_calls || []) {
    output.push({
      id: toolCall.id || `fc_${randomUUID()}`,
      type: "function_call",
      status: "completed",
      call_id: toolCall.id || `call_${randomUUID()}`,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments || "{}",
    });
  }

  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: {},
  };
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function pipeStreamingChatToResponses(chatResponse, res, responseId) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  writeSse(res, "response.created", {
    type: "response.created",
    response: { id: responseId, type: "response", status: "in_progress" },
  });

  const decoder = new TextDecoder();
  let buffer = "";
  let outputIndex = 0;
  let textStarted = false;
  let text = "";
  const toolCalls = new Map();

  const ensureTextStarted = () => {
    if (textStarted) return;
    textStarted = true;
    writeSse(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        id: `msg_${randomUUID()}`,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    });
    writeSse(res, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: `msg_${randomUUID()}`,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  };

  for await (const chunk of chatResponse.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      const data = JSON.parse(payload);
      const delta = data.choices?.[0]?.delta || {};

      if (delta.content) {
        ensureTextStarted();
        text += delta.content;
        writeSse(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          output_index: outputIndex,
          content_index: 0,
          delta: delta.content,
        });
      }

      for (const toolCall of delta.tool_calls || []) {
        const index = toolCall.index ?? 0;
        const existing =
          toolCalls.get(index) ||
          {
            id: toolCall.id || `call_${randomUUID()}`,
            name: "",
            arguments: "",
          };
        if (toolCall.id) existing.id = toolCall.id;
        if (toolCall.function?.name) existing.name += toolCall.function.name;
        if (toolCall.function?.arguments) {
          existing.arguments += toolCall.function.arguments;
        }
        toolCalls.set(index, existing);
      }
    }
  }

  if (textStarted) {
    writeSse(res, "response.output_text.done", {
      type: "response.output_text.done",
      output_index: outputIndex,
      content_index: 0,
      text,
    });
    writeSse(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        id: `msg_${randomUUID()}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    });
    outputIndex += 1;
  }

  for (const toolCall of toolCalls.values()) {
    writeSse(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        id: toolCall.id,
        type: "function_call",
        status: "in_progress",
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: "",
      },
    });
    writeSse(res, "response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      output_index: outputIndex,
      item_id: toolCall.id,
      delta: toolCall.arguments,
    });
    writeSse(res, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      output_index: outputIndex,
      item_id: toolCall.id,
      arguments: toolCall.arguments,
    });
    writeSse(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        id: toolCall.id,
        type: "function_call",
        status: "completed",
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    });
    outputIndex += 1;
  }

  writeSse(res, "response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      type: "response",
      status: "completed",
      output: [],
    },
  });
  res.end("data: [DONE]\n\n");
}

async function handleResponses(req, res) {
  const apiKey = process.env.OPENCODE_GO_API_KEY;
  if (!apiKey) {
    sendJson(res, 500, {
      error: {
        message: "Set OPENCODE_GO_API_KEY before starting the bridge.",
      },
    });
    return;
  }

  const body = await readJson(req);
  const responseId = `resp_${randomUUID()}`;
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
  const chatBody = {
    model,
    messages: responsesInputToMessages(body.input),
    stream: Boolean(body.stream),
    thinking: { type: "disabled" },
  };

  const tools = responsesToolsToChatTools(body.tools);
  if (tools) {
    chatBody.tools = tools;
    chatBody.tool_choice = body.tool_choice || "auto";
    chatBody.parallel_tool_calls = body.parallel_tool_calls ?? true;
  }
  if (body.temperature !== undefined) chatBody.temperature = body.temperature;
  if (body.top_p !== undefined) chatBody.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) {
    chatBody.max_tokens = body.max_output_tokens;
  }

  const chatResponse = await fetch(`${OPENCODE_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(chatBody),
  });

  if (!chatResponse.ok) {
    const text = await chatResponse.text();
    sendJson(res, chatResponse.status, {
      error: {
        message: text,
      },
    });
    return;
  }

  if (body.stream) {
    await pipeStreamingChatToResponses(chatResponse, res, responseId);
    return;
  }

  const chatJson = await chatResponse.json();
  sendJson(
    res,
    200,
    chatChoiceToResponsesOutput(chatJson.choices?.[0], responseId, model),
  );
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      sendHtml(res, dashboardHtml());
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      const config = await readCodexConfig();
      sendJson(res, 200, {
        ok: true,
        default_model: currentBridgeDefaultModel(config),
        supported_models: [...SUPPORTED_MODELS],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      sendJson(res, 200, await readDashboardState());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/default-model") {
      const body = await readJson(req);
      const config = await setDefaultModel(body.model);
      sendJson(res, 200, { ok: true, codex: config });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session/archive") {
      const body = await readJson(req);
      sendJson(res, 200, { ok: true, session: await archiveSession(body.id) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session/delete") {
      const body = await readJson(req);
      sendJson(res, 200, { ok: true, session: await deleteSession(body.id) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/responses") {
      await handleResponses(req, res);
      return;
    }
    sendJson(res, 404, { error: { message: "Not found" } });
  } catch (error) {
    sendJson(res, 500, { error: { message: error?.stack || String(error) } });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(
    `OpenCode Go bridge listening on http://127.0.0.1:${PORT}/v1/responses`,
  );
});
