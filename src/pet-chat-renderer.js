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
const jumpBtn = document.getElementById("btnJumpLatest");
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
    jumpLatest: "Latest",
    jumpNew: "New",
    copy: "Copy",
    copied: "Copied",
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
    jumpLatest: "最新",
    jumpNew: "新消息",
    copy: "复制",
    copied: "已复制",
  },
};

let lang = "en";
let lastSnapshot = null;
let lastReportedHeight = 0;
let stickToBottom = true;
// Counts messages that arrived while the user was scrolled up. Reset on jump.
let unseenCount = 0;
let lastSeenMessageCount = 0;

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
// Last known configuration status. Snapshots that carry only a transcript
// (every streaming update) must not erase it — doing so left the header stuck
// on "connecting…" forever after the first exchange.
let knownStatus = null;

function renderStatus(status, streaming) {
  if (!subEl) return;
  if (status && typeof status === "object") knownStatus = status;
  const effective = knownStatus;

  let text;
  let tone;
  if (streaming) {
    text = t("statusThinking");
    tone = "pending";
  } else if (!effective) {
    // Nothing has been reported yet; this is the only honest "unknown" case.
    text = t("statusChecking");
    tone = "pending";
  } else if (effective.enabled && effective.ready) {
    text = t("statusReady");
    tone = "ready";
  } else {
    text = t("statusOffline");
    tone = "error";
  }
  if (subEl.textContent !== text) subEl.textContent = text;
  subEl.dataset.tone = tone;
}

// ── Per-message copy ──
//
// Each bubble gets a button that copies the ORIGINAL text, not the rendered
// markup: `body.dataset.raw` holds what the model (or the user) actually said,
// so pasting never yields HTML entities or stripped formatting.

function buildCopyIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.9");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  r.setAttribute("x", "9"); r.setAttribute("y", "9");
  r.setAttribute("width", "11"); r.setAttribute("height", "11");
  r.setAttribute("rx", "2");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M5 15V5a2 2 0 0 1 2-2h10");
  svg.appendChild(r);
  svg.appendChild(p);
  return svg;
}

function attachCopyButton(bubble) {
  if (bubble.querySelector(".bubble-copy")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "bubble-copy";
  btn.title = t("copy");
  btn.setAttribute("aria-label", t("copy"));
  btn.appendChild(buildCopyIcon());
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    const body = bubble.querySelector(".bubble-text");
    const raw = body && body.dataset.raw ? body.dataset.raw : "";
    if (!raw) return;
    try {
      const result = await window.petChatAPI.copyText(raw);
      if (!result || result.status !== "ok") throw new Error("copy failed");
      // Brief confirmation in place of the icon; the button stays visible.
      btn.dataset.copied = "true";
      btn.title = t("copied");
      btn.textContent = "";
      const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      check.setAttribute("viewBox", "0 0 24 24");
      check.setAttribute("fill", "none");
      check.setAttribute("stroke", "currentColor");
      check.setAttribute("stroke-width", "2.4");
      check.setAttribute("stroke-linecap", "round");
      check.setAttribute("stroke-linejoin", "round");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M20 6 9 17l-5-5");
      check.appendChild(path);
      btn.appendChild(check);
      clearTimeout(btn.__resetTimer);
      btn.__resetTimer = setTimeout(() => {
        btn.dataset.copied = "false";
        btn.title = t("copy");
        btn.textContent = "";
        btn.appendChild(buildCopyIcon());
      }, 1400);
    } catch {
      // Copy failing is not worth an error banner; leave the button as-is.
    }
  });
  bubble.appendChild(btn);
}

// ── Jump-to-latest ──
//
// While the user reads history, streamed content keeps growing below. Rather
// than yanking the scroll position (which would fight the reader), surface a
// button that says how much arrived.

// `messageCount` is only supplied from render(); scroll events call this with
// the default so they can show/hide the affordance without fabricating a count.
function updateJumpButton({ messageCount = null } = {}) {
  if (!jumpBtn) return;
  const scrolled = !atBottom(logEl);

  if (!scrolled) {
    unseenCount = 0;
    if (messageCount != null) lastSeenMessageCount = messageCount;
  } else if (messageCount != null && messageCount > lastSeenMessageCount) {
    unseenCount = Math.max(unseenCount, messageCount - lastSeenMessageCount);
  }

  // The button belongs on screen whenever the user is reading history — not
  // only when something new arrived. Someone who simply scrolled up still needs
  // an obvious way back to the newest message.
  const show = scrolled;
  jumpBtn.dataset.visible = show ? "true" : "false";
  jumpBtn.hidden = !show;
  if (!show) {
    const badge = jumpBtn.querySelector(".jump-count");
    if (badge) badge.remove();
    return;
  }

  const label = jumpBtn.querySelector(".jump-label");
  if (label) label.textContent = unseenCount > 1 ? t("jumpNew") : t("jumpLatest");

  let badge = jumpBtn.querySelector(".jump-count");
  if (unseenCount > 1) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "jump-count";
      jumpBtn.appendChild(badge);
    }
    if (badge.textContent !== String(unseenCount)) badge.textContent = String(unseenCount);
  } else if (badge) {
    badge.remove();
  }
}

function jumpToLatest() {
  stickToBottom = true;
  unseenCount = 0;
  logEl.scrollTo({ top: logEl.scrollHeight, behavior: "smooth" });
  // Fall back to an instant scroll when the environment ignores smooth.
  setTimeout(() => {
    if (!atBottom(logEl)) logEl.scrollTop = logEl.scrollHeight;
  }, 260);
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

// Tracks which markup string is currently in each bubble body, so an unchanged
// render can skip the parse+DOM swap entirely (this runs per streamed chunk).
const renderedHtml = new WeakMap();

// Applies pre-sanitized HTML from main.
//
// The markup is already restricted to an allowlist by pet-chat-markdown.js, but
// it is still parsed with DOMParser and imported node-by-node rather than
// assigned to innerHTML: the renderer then never interprets a string as markup,
// which is the invariant rest of the UI already follows. Parsing as XHTML makes
// the document strict — a malformed fragment fails to parse rather than being
// silently repaired into unexpected structure.
function applyRichText(body, html, rawText) {
  body.dataset.raw = rawText;
  if (renderedHtml.get(body) === html) return;
  renderedHtml.set(body, html);
  body.classList.add("rich");
  body.textContent = "";

  let doc = null;
  try {
    doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  } catch {
    doc = null;
  }
  if (!doc || !doc.body) {
    // Unparseable: show the source text rather than an empty bubble.
    body.classList.remove("rich");
    body.textContent = rawText;
    renderedHtml.delete(body);
    return;
  }
  for (const child of [...doc.body.childNodes]) {
    body.appendChild(document.importNode(child, true));
  }
}

function applyPlainText(body, text) {
  body.dataset.raw = text;
  renderedHtml.delete(body);
  body.classList.remove("rich");
  if (body.textContent !== text) body.textContent = text;
}

// Updates a bubble in place. Returns nothing; the caller owns positioning.
function paintBubble(bubble, text, { reasoning = "", at = null, interrupted = false, html = "" } = {}) {
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
  if (html) applyRichText(body, html, text);
  else applyPlainText(body, text);

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
      attachCopyButton(bubble);
      // A brand-new row may replace an existing node at this index.
      if (rows[i] && rows[i].parentNode === logEl) logEl.replaceChild(row, rows[i]);
      else logEl.insertBefore(row, logEl.children[i] || null);
      rows[i] = row;
    }
    paintBubble(row.firstChild, entry.content, {
      at: entry.at,
      interrupted,
      // Only assistant turns carry pre-sanitized markdown.
      html: typeof entry.html === "string" ? entry.html : "",
    });
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
      // The in-flight bubble gets its button only once it settles; copying a
      // half-finished reply is not useful.
      logEl.appendChild(streamingRow);
    }
    streamingRow.classList.toggle("group-start", lastRole !== "pet");

    const bubble = streamingRow.firstChild;
    if (streamed) {
      paintBubble(bubble, streamed, {
        reasoning,
        html: typeof snapshot.streaming_html === "string" ? snapshot.streaming_html : "",
      });
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
  // Run after the DOM has been laid out so atBottom() sees fresh geometry.
  requestAnimationFrame(() => updateJumpButton({ messageCount: messages.length }));
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
  updateJumpButton();
});

if (jumpBtn) jumpBtn.addEventListener("click", jumpToLatest);

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