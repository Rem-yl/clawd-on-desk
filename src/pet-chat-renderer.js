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

const STRINGS = {
  en: {
    title: "Chat",
    placeholder: "Say something…",
    empty: "Click the pet any time to chat.\nEnter to send · Shift+Enter for a new line.",
    clear: "Clear",
    close: "Close",
    stop: "Stop",
    send: "Send",
    interrupted: "（回复中断）",
  },
  zh: {
    title: "聊天",
    placeholder: "说点什么…",
    empty: "点一下桌宠就能聊天。\n回车发送 · Shift+回车换行。",
    clear: "清空",
    close: "关闭",
    stop: "停止",
    send: "发送",
    interrupted: "（回复中断）",
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

function buildBubble(rowKind, text, { interrupted = false, reasoning = "" } = {}) {
  const row = document.createElement("div");
  row.className = `row ${rowKind}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble" + (interrupted ? " interrupted" : "");
  if (reasoning) {
    const think = document.createElement("div");
    think.className = "reasoning";
    think.textContent = reasoning;
    bubble.appendChild(think);
  }
  // textContent, never innerHTML — model output is untrusted.
  bubble.appendChild(document.createTextNode(text));
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
    think.className = "reasoning";
    think.textContent = reasoning;
    bubble.appendChild(think);
  }
  const typing = document.createElement("span");
  typing.className = "typing";
  for (let i = 0; i < 3; i += 1) typing.appendChild(document.createElement("i"));
  bubble.appendChild(typing);
  row.appendChild(bubble);
  return row;
}

function render(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  lastSnapshot = snapshot;

  const wasAtBottom = atBottom(logEl);
  const shouldStick = wasAtBottom || stickToBottom;
  logEl.textContent = "";

  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  if (!messages.length && !snapshot.streaming) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = t("empty");
    logEl.appendChild(hint);
  } else {
    for (const entry of messages) {
      if (!entry || typeof entry.content !== "string") continue;
      const kind = entry.role === "user" ? "user" : "pet";
      const interrupted = entry.content.includes(t("interrupted"));
      logEl.appendChild(buildBubble(kind, entry.content, { interrupted }));
    }
    if (snapshot.streaming) {
      const streamed = typeof snapshot.streaming_text === "string" ? snapshot.streaming_text : "";
      const reasoning = typeof snapshot.streaming_reasoning === "string"
        ? snapshot.streaming_reasoning
        : "";
      if (streamed) {
        logEl.appendChild(buildBubble("pet", streamed, { reasoning }));
      } else {
        logEl.appendChild(buildTypingBubble(reasoning));
      }
    }
  }

  errorEl.hidden = !snapshot.error;
  if (snapshot.error) errorEl.textContent = snapshot.error.message || String(snapshot.error);

  stopBtn.hidden = !snapshot.streaming;
  sendBtn.hidden = !!snapshot.streaming;
  clearBtn.disabled = !messages.length && !snapshot.streaming;

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