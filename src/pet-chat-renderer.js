"use strict";

// ── Pet chat renderer ──
//
// Pure view over the snapshot main pushes. No conversation state is kept here
// beyond what the last snapshot said, so a main-side reload (theme/lang change,
// process restart) can never desync from what the user sees.
//
// Height reporting: main positions this window by asking the renderer how tall
// the content wants to be. We measure the outer .chat element after every
// layout-affecting change and only report on change, so a quiet transcript does
// not generate IPC traffic.

const chatEl = document.getElementById("chat");
const logEl = document.getElementById("chatLog");
const errorEl = document.getElementById("chatError");
const inputEl = document.getElementById("chatInput");
const sendBtn = document.getElementById("btnSend");
const stopBtn = document.getElementById("btnStop");
const clearBtn = document.getElementById("btnClear");
const closeBtn = document.getElementById("btnClose");
const titleEl = document.getElementById("chatTitle");
const subEl = document.getElementById("chatSub");

const STRINGS = {
  en: {
    title: "Chat",
    placeholder: "Say something…",
    emptyTitle: "No messages yet",
    empty: "Click the pet any time to chat.\nEnter to send · Shift+Enter for a new line.",
    clear: "Clear",
    close: "Close",
    stop: "Stop",
    send: "Send",
    interrupted: "replied incompletely",
    statusReady: "online",
    statusThinking: "typing…",
    statusOffline: "not connected",
    statusChecking: "connecting…",
  },
  zh: {
    title: "聊天",
    placeholder: "说点什么…",
    emptyTitle: "还没有消息",
    empty: "点一下桌宠就能聊天。\n回车发送 · Shift+回车换行。",
    clear: "清空",
    close: "关闭",
    stop: "停止",
    send: "发送",
    interrupted: "回复中断",
    statusReady: "在线",
    statusThinking: "正在输入…",
    statusOffline: "未连接",
    statusChecking: "连接中…",
  },
};

let lang = "en";
let lastSnapshot = null;
let lastReportedHeight = 0;
let stickToBottom = true;

function t(key) {
  const dict = STRINGS[lang] || STRINGS.en;
  return dict[key] || STRINGS.en[key] || key;
}

function applyStrings() {
  document.documentElement.lang = lang;
  titleEl.textContent = t("title");
  inputEl.placeholder = t("placeholder");
  clearBtn.title = t("clear");
  clearBtn.setAttribute("aria-label", t("clear"));
  closeBtn.title = t("close");
  closeBtn.setAttribute("aria-label", t("close"));
  stopBtn.title = t("stop");
  stopBtn.setAttribute("aria-label", t("stop"));
  sendBtn.title = t("send");
  sendBtn.setAttribute("aria-label", t("send"));
}

// ── Height reporting ──

function reportHeight() {
  // The window is transparent with 6px body padding, so the visible card height
  // is what main should size to. scrollHeight is used rather than a hardcoded
  // row count so long transcripts and wrapped lines both measure correctly.
  const rect = chatEl.getBoundingClientRect();
  const measured = Math.ceil(rect.height + 12);
  if (!Number.isFinite(measured) || measured <= 0) return;
  if (Math.abs(measured - lastReportedHeight) < 2) return;
  lastReportedHeight = measured;
  window.petChatAPI.reportHeight(measured);
}

function scheduleHeightReport() {
  requestAnimationFrame(reportHeight);
}

// ── Transcript rendering ──

function atBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

function scrollToBottom() {
  logEl.scrollTop = logEl.scrollHeight;
}

// Formats an epoch-ms stamp as a compact local clock time. Telegram shows just
// the time on each bubble; the date lives in the header, so this stays tiny.
function formatClock(at) {
  const ms = Number.isFinite(at) ? at : Date.now();
  try {
    return new Date(ms).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
}

function sameSender(a, b) {
  if (!a || !b) return false;
  const ra = a.role === "user" ? "user" : "pet";
  const rb = b.role === "user" ? "user" : "pet";
  return ra === rb;
}

// Builds the visual bubble for one message. Structure mirrors Telegram: the
// text and the timestamp share one grid row so the clock tucks into the bubble
// corner without ever overlapping the last line of text.
function buildBubble(rowKind, text, { interrupted = false, reasoning = "", at = null } = {}) {
  const row = document.createElement("div");
  row.className = `row ${rowKind}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble" + (interrupted ? " interrupted" : "");

  if (reasoning) {
    const think = document.createElement("div");
    think.className = "bubble-think";
    think.textContent = reasoning;
    bubble.appendChild(think);
  }

  // textContent, never innerHTML — model output is untrusted.
  const body = document.createElement("div");
  body.className = "bubble-text";
  body.textContent = text;
  bubble.appendChild(body);

  if (at != null) {
    const time = document.createElement("div");
    time.className = "bubble-time";
    time.textContent = formatClock(at);
    bubble.appendChild(time);
  }

  if (interrupted) {
    const tag = document.createElement("div");
    tag.className = "interrupt-tag";
    tag.textContent = t("interrupted");
    bubble.appendChild(tag);
  }

  row.appendChild(bubble);
  return row;
}

function buildTypingBubble(reasoning) {
  const row = document.createElement("div");
  row.className = "row pet";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (reasoning) {
    const think = document.createElement("div");
    think.className = "bubble-think";
    think.textContent = reasoning;
    bubble.appendChild(think);
  }
  const typing = document.createElement("span");
  typing.className = "typing";
  typing.setAttribute("aria-label", t("statusThinking"));
  for (let i = 0; i < 3; i += 1) typing.appendChild(document.createElement("i"));
  const body = document.createElement("div");
  body.className = "bubble-text";
  body.appendChild(typing);
  bubble.appendChild(body);
  row.appendChild(bubble);
  return row;
}

function buildEmptyState() {
  const hint = document.createElement("div");
  hint.className = "empty-hint";

  // Built via DOMParser-free DOM APIs to stay consistent with the no-markup rule.
  const icon = document.createElement("div");
  icon.className = "empty-icon";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"
  );
  svg.appendChild(path);
  icon.appendChild(svg);

  const title = document.createElement("div");
  title.className = "empty-title";
  title.textContent = t("emptyTitle");

  const body = document.createElement("div");
  body.textContent = t("empty");

  hint.appendChild(icon);
  hint.appendChild(title);
  hint.appendChild(body);
  return hint;
}

// Header presence line. Keeps the small status dot honest: it only claims
// "online" when main actually reports a usable configuration.
function renderStatus(status, streaming) {
  if (!subEl) return;
  let text = t("statusChecking");
  let tone = "pending";
  if (streaming) {
    text = t("statusThinking");
    tone = "pending";
  } else if (status && status.enabled && status.ready) {
    text = t("statusReady");
    tone = "ready";
  } else if (status && !status.enabled) {
    text = t("statusOffline");
    tone = "error";
  } else if (status) {
    text = t("statusOffline");
    tone = "error";
  }
  subEl.textContent = text;
  subEl.dataset.tone = tone;
}

// ── Incremental transcript ──
//
// The window receives a fresh full snapshot for every streamed chunk. Rebuilding
// the whole transcript on each one made the log flicker and restarted the entry
// animation dozens of times per second. Instead this keeps the mounted rows and
// only touches what actually changed:
//
//   - settled messages are addressed by index and reused untouched;
//   - the in-flight bubble is a single mutable row whose text nodes are
//     overwritten in place (no re-parenting, no animation restart);
//   - the footer (empty state / typing placeholder) is added or dropped only
//     when the transcript shape changes.
//
// `rows` mirrors logEl's children so an index lookup is a plain array read.

let rows = [];
let streamingRow = null;
let footerRow = null;
let renderedShape = null;

function makeRow(kind) {
  const row = document.createElement("div");
  row.className = `row ${kind}`;
  return row;
}

function ensureBubbleBody(bubble) {
  let body = bubble.querySelector(".bubble-text");
  if (!body) {
    body = document.createElement("div");
    body.className = "bubble-text";
    bubble.appendChild(body);
  }
  return body;
}

// Updates a bubble in place. Returns nothing; the caller owns positioning.
function paintBubble(bubble, text, { reasoning = "", at = null, interrupted = false } = {}) {
  let think = bubble.querySelector(".bubble-think");
  if (reasoning) {
    if (!think) {
      think = document.createElement("div");
      think.className = "bubble-think";
      bubble.insertBefore(think, bubble.firstChild);
    }
    // Only assign when the string differs: writing textContent unconditionally
    // forces a layout pass even when the value is identical.
    if (think.textContent !== reasoning) think.textContent = reasoning;
    // Keep the newest reasoning line visible while it streams.
    think.scrollTop = think.scrollHeight;
  } else if (think) {
    think.remove();
  }

  const body = ensureBubbleBody(bubble);
  if (body.textContent !== text) body.textContent = text;

  let time = bubble.querySelector(".bubble-time");
  if (at != null) {
    const stamp = formatClock(at);
    if (!time) {
      time = document.createElement("div");
      time.className = "bubble-time";
      bubble.appendChild(time);
    }
    if (time.textContent !== stamp) time.textContent = stamp;
  } else if (time) {
    time.remove();
  }

  let tag = bubble.querySelector(".interrupt-tag");
  if (interrupted) {
    if (!tag) {
      tag = document.createElement("div");
      tag.className = "interrupt-tag";
      tag.textContent = t("interrupted");
      bubble.appendChild(tag);
    }
  } else if (tag) {
    tag.remove();
  }

  bubble.classList.toggle("interrupted", interrupted);
}

function shapeKey(messages, streaming, hasStreamText) {
  return [
    messages.length,
    streaming ? 1 : 0,
    hasStreamText ? 1 : 0,
    messages.length ? messages[messages.length - 1].role : "-",
  ].join("|");
}

function render(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  lastSnapshot = snapshot;

  const wasAtBottom = atBottom(logEl);
  const shouldStick = wasAtBottom || stickToBottom;

  const messages = (Array.isArray(snapshot.messages) ? snapshot.messages : [])
    .filter((entry) => entry && typeof entry.content === "string");
  const streamed = snapshot.streaming && typeof snapshot.streaming_text === "string"
    ? snapshot.streaming_text
    : "";
  const reasoning = snapshot.streaming && typeof snapshot.streaming_reasoning === "string"
    ? snapshot.streaming_reasoning
    : "";
  const shape = shapeKey(messages, !!snapshot.streaming, !!streamed);
  const shapeChanged = shape !== renderedShape;

  // ── Empty placeholder ──
  if (!messages.length && !snapshot.streaming) {
    // Clearing history leaves the mounted rows behind; drop them so the next
    // message starts from a clean transcript instead of reusing detached nodes.
    for (const extra of rows) {
      if (extra && extra.parentNode) extra.parentNode.removeChild(extra);
    }
    rows = [];
    if (streamingRow) { streamingRow.remove(); streamingRow = null; }
    if (shapeChanged || !footerRow) {
      if (footerRow) footerRow.remove();
      footerRow = buildEmptyState();
      logEl.appendChild(footerRow);
    }
    renderedShape = shape;
    finishRender(snapshot, messages, shouldStick);
    return;
  }

  // Drop the empty placeholder once real content exists.
  if (footerRow) {
    footerRow.remove();
    footerRow = null;
  }

  // A finished reply arrives as a settled message; drop the in-flight row first
  // so it cannot linger after the committed bubble.
  if (!snapshot.streaming && streamingRow) {
    streamingRow.remove();
    streamingRow = null;
  }

  // ── Settled messages: reuse by index, repaint only what changed ──
  for (let i = 0; i < messages.length; i += 1) {
    const entry = messages[i];
    const kind = entry.role === "user" ? "user" : "pet";
    const interrupted = entry.content.includes(t("interrupted"));
    let row = rows[i];
    if (!row || row.dataset.kind !== kind) {
      row = makeRow(kind);
      row.dataset.kind = kind;
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      row.appendChild(bubble);
      // A brand-new row may replace an existing node at this index.
      if (rows[i] && rows[i].parentNode === logEl) logEl.replaceChild(row, rows[i]);
      else logEl.insertBefore(row, logEl.children[i] || null);
      rows[i] = row;
    }
    paintBubble(row.firstChild, entry.content, { at: entry.at, interrupted });
  }

  // Trim rows beyond the current transcript.
  while (rows.length > messages.length) {
    const extra = rows.pop();
    if (extra && extra.parentNode) extra.parentNode.removeChild(extra);
  }

  // ── Grouping: recomputed cheaply, class toggles are no-ops when unchanged ──
  for (let i = 0; i < messages.length; i += 1) {
    const row = rows[i];
    const startsGroup = i === 0 || !sameSender(messages[i - 1], messages[i]);
    const endsGroup = !messages[i + 1] || !sameSender(messages[i], messages[i + 1]);
    row.classList.toggle("group-start", startsGroup);
    row.classList.toggle("group-end", endsGroup);
  }

  // ── In-flight bubble: one long-lived row, mutated in place ──
  if (snapshot.streaming) {
    const lastRole = messages.length ? messages[messages.length - 1].role : null;
    if (!streamingRow || streamingRow.dataset.kind !== "pet") {
      if (streamingRow && streamingRow.parentNode) streamingRow.parentNode.removeChild(streamingRow);
      streamingRow = makeRow("pet");
      streamingRow.dataset.kind = "pet";
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      streamingRow.appendChild(bubble);
      logEl.appendChild(streamingRow);
    }
    streamingRow.classList.toggle("group-start", lastRole !== "pet");

    const bubble = streamingRow.firstChild;
    if (streamed) {
      paintBubble(bubble, streamed, { reasoning });
      bubble.querySelectorAll(".typing").forEach((el) => el.remove());
    } else {
      // Typing placeholder: reuse if present so the dots keep their phase.
      let typing = bubble.querySelector(".typing");
      if (!typing) {
        const body = ensureBubbleBody(bubble);
        body.textContent = "";
        typing = document.createElement("span");
        typing.className = "typing";
        typing.setAttribute("aria-label", t("statusThinking"));
        for (let i = 0; i < 3; i += 1) typing.appendChild(document.createElement("i"));
        body.appendChild(typing);
      }
      paintBubbleKeepBody(bubble, reasoning);
    }
  } else if (streamingRow) {
    streamingRow.remove();
    streamingRow = null;
  }

  renderedShape = shape;
  finishRender(snapshot, messages, shouldStick);
}

// Repaints only the reasoning block for the typing placeholder, leaving the
// animated dots node untouched so their keyframe phase never restarts.
function paintBubbleKeepBody(bubble, reasoning) {
  let think = bubble.querySelector(".bubble-think");
  if (reasoning) {
    if (!think) {
      think = document.createElement("div");
      think.className = "bubble-think";
      bubble.insertBefore(think, bubble.firstChild);
    }
    if (think.textContent !== reasoning) think.textContent = reasoning;
    think.scrollTop = think.scrollHeight;
  } else if (think) {
    think.remove();
  }
}

function finishRender(snapshot, messages, shouldStick) {
  errorEl.hidden = !snapshot.error;
  const errorText = snapshot.error ? (snapshot.error.message || String(snapshot.error)) : "";
  if (errorEl.textContent !== errorText) errorEl.textContent = errorText;

  stopBtn.hidden = !snapshot.streaming;
  sendBtn.hidden = !!snapshot.streaming;
  clearBtn.disabled = !messages.length && !snapshot.streaming;

  renderStatus(snapshot.status, !!snapshot.streaming);

  if (shouldStick) scrollToBottom();
  stickToBottom = atBottom(logEl);
  scheduleHeightReport();
}

// ── Composer ──

function autoGrow() {
  inputEl.style.height = "auto";
  const next = Math.min(132, Math.max(34, inputEl.scrollHeight));
  inputEl.style.height = `${next}px`;
  scheduleHeightReport();
}

function currentText() {
  return inputEl.value.trim();
}

function setComposerEnabled(enabled) {
  inputEl.disabled = !enabled;
  sendBtn.disabled = !enabled || !currentText();
}

async function submitCurrent() {
  const text = currentText();
  if (!text) return;
  inputEl.value = "";
  autoGrow();
  sendBtn.disabled = true;
  logEl.scrollTop = logEl.scrollHeight;
  stickToBottom = true;
  try {
    const result = await window.petChatAPI.submit(text);
    if (result && result.status === "error" && result.message) {
      // Keep the text so the user does not retype it after a config error.
      if (!inputEl.value) inputEl.value = text;
      autoGrow();
      sendBtn.disabled = false;
    }
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = (err && err.message) || "send failed";
  }
  inputEl.focus();
}

document.getElementById("chatCompose").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitCurrent();
});

inputEl.addEventListener("input", () => {
  autoGrow();
  sendBtn.disabled = !currentText() || !!inputEl.disabled;
});

inputEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  // Shift+Enter inserts a newline; IME composition must never submit.
  if (event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  void submitCurrent();
});

stopBtn.addEventListener("click", () => window.petChatAPI.stop());

clearBtn.addEventListener("click", async () => {
  clearBtn.disabled = true;
  try { await window.petChatAPI.clear(); } catch {}
  clearBtn.disabled = false;
  inputEl.focus();
});

closeBtn.addEventListener("click", () => window.petChatAPI.close());

// The transcript only auto-scrolls while the user is parked at the bottom;
// scrolling up to read history must not be yanked back by incoming deltas.
logEl.addEventListener("scroll", () => {
  stickToBottom = atBottom(logEl);
});

window.addEventListener("resize", scheduleHeightReport);

// ── Boot ──

window.petChatAPI.onState((snapshot) => render(snapshot));
window.petChatAPI.onI18n((payload) => {
  if (payload && typeof payload.lang === "string") {
    lang = payload.lang;
    applyStrings();
    if (lastSnapshot) render(lastSnapshot);
  }
});

applyStrings();
setComposerEnabled(true);
autoGrow();
window.petChatAPI.getState()
  .then((snapshot) => {
    render(snapshot);
    inputEl.focus();
  })
  .catch(() => {});