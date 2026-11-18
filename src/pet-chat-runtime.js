"use strict";

// ── Pet chat session runtime (main process) ──
//
// Owns the conversation: the transcript shown in the window, the request to the
// model, the streamed reply, and the long-term memory file. The window runtime
// (pet-chat-window.js) only renders; this module only decides.
//
// Concurrency rule: at most ONE in-flight request. A new submit while streaming
// aborts the previous one (that's what "stop and say something else" means to a
// user typing into a chat box). Aborted partial replies are kept in the
// transcript, flagged, so the record matches what was on screen.

const {
  buildMessages,
  createPetChatClient,
} = require("./pet-chat-client");
const { readiness } = require("./pet-chat-config");
const { createPetChatStore } = require("./pet-chat-store");

// Pet emotional beats. These are *hints* for whichever theme is active — an
// unknown state name simply does nothing, so no theme capability is invented.
const MOOD = Object.freeze({
  thinking: "thinking",
  talking: "working",
  done: "idle",
  error: "error",
});

function makeCancelToken() {
  const controller = new AbortController();
  return { controller, signal: controller.signal };
}

function createPetChatSessionRuntime(options = {}) {
  const getConfig = options.getConfig || (() => null);
  const getApiKey = options.getApiKey || (() => null);
  const client = options.client || createPetChatClient({ fetch: options.fetch });
  const store = options.store;
  const sendToWindow = options.sendToWindow || (() => {});
  const onMood = options.onMood || (() => {});
  const logWarn = options.logWarn || ((msg, err) => console.warn(msg, err && err.message));

  if (!store) throw new Error("createPetChatSessionRuntime requires store");

  let messages = store.loadHistory();
  let streaming = false;
  let activeRequest = null;
  let lastError = null;

  function snapshot() {
    return {
      messages: messages.map(({ role, content, at }) => ({ role, content, at })),
      streaming,
      error: lastError,
      collapsed: false,
    };
  }

  function broadcast() {
    sendToWindow(snapshot());
  }

  function setError(error) {
    lastError = error
      ? { code: error.code || "ERROR", message: error.message || String(error) }
      : null;
  }

  function configNow() {
    const cfg = getConfig();
    const key = getApiKey();
    return readiness(cfg, !!key);
  }

  function stop() {
    if (activeRequest && typeof activeRequest.controller.abort === "function") {
      try { activeRequest.controller.abort(); } catch {}
    }
    activeRequest = null;
    streaming = false;
    return true;
  }

  // Appends a user turn and starts the reply. Returns immediately; progress
  // arrives through broadcast().
  async function submit(text) {
    const content = typeof text === "string" ? text.trim() : "";
    if (!content) return { status: "error", message: "empty message" };

    const ready = configNow();
    if (!ready.ready) {
      const reason = describeNotReady(ready.reason);
      setError({ code: ready.reason.toUpperCase(), message: reason });
      broadcast();
      return { status: "error", message: reason };
    }

    // A second submit preempts the first: keep whatever was streamed so far.
    if (streaming) stop();

    const cfg = ready.config;
    const apiKey = getApiKey();
    const memory = cfg.memoryEnabled ? store.loadMemory().text : "";

    messages = store.appendTurn({ role: "user", content }, cfg.maxHistoryMessages);
    lastError = null;
    streaming = true;
    broadcast();
    onMood(MOOD.thinking);

    const request = makeCancelToken();
    activeRequest = request;

    const payloadMessages = buildMessages({
      persona: cfg.persona,
      memory,
      history: messages.slice(0, -1),
      userText: content,
      maxHistoryMessages: cfg.maxHistoryMessages,
    });

    // Streaming placeholder: the window renders this as the "typing" bubble.
    let streamed = "";
    let streamedReasoning = "";
    const emitDelta = ({ delta, reasoning }) => {
      if (activeRequest !== request) return;
      if (delta) streamed += delta;
      if (reasoning) streamedReasoning += reasoning;
      sendToWindow({
        ...snapshot(),
        streaming: true,
        streaming_text: streamed,
        streaming_reasoning: streamedReasoning,
      });
    };

    try {
      const result = await client.complete({
        baseUrl: ready.endpoint,
        apiKey,
        model: cfg.model,
        messages: payloadMessages,
        temperature: cfg.temperature,
        signal: request.signal,
        onDelta: emitDelta,
      });
      if (activeRequest !== request) return { status: "ok", aborted: true };

      const reply = (result.text || "").trim();
      if (!reply) throw Object.assign(new Error("empty reply"), { code: "EMPTY_RESPONSE" });
      messages = store.appendTurn({ role: "assistant", content: reply }, cfg.maxHistoryMessages);
      streaming = false;
      activeRequest = null;
      setError(null);
      broadcast();
      onMood(MOOD.done);
      return { status: "ok" };
    } catch (error) {
      const aborted = error && (error.code === "ABORTED" || error.name === "AbortError");
      if (activeRequest !== request) return { status: "ok", aborted: true };
      streaming = false;
      activeRequest = null;

      // Preserve the partial reply: the user saw it, so the record keeps it.
      const partial = streamed.trim();
      if (partial) {
        messages = store.appendTurn(
          { role: "assistant", content: `${partial}\n\n（回复中断）` },
          cfg.maxHistoryMessages
        );
      }
      if (aborted) {
        setError(null);
        broadcast();
        onMood(MOOD.done);
        return { status: "ok", aborted: true };
      }
      logWarn("Clawd pet chat request failed:", error);
      setError(error);
      broadcast();
      onMood(MOOD.error);
      return { status: "error", message: error && error.message };
    }
  }

  function describeNotReady(reason) {
    switch (reason) {
      case "disabled": return "宠物聊天还没有开启，请到设置里打开。";
      case "no-base-url": return "还没有填写接口地址（Base URL）。";
      case "invalid-base-url": return "接口地址不是合法的 http(s) URL。";
      case "no-model": return "还没有填写模型名。";
      case "no-api-key": return "还没有填写 API Key。";
      default: return "宠物聊天还缺少配置。";
    }
  }

  function clear() {
    stop();
    messages = store.clearHistory();
    setError(null);
    broadcast();
    return snapshot();
  }

  function reload() {
    messages = store.loadHistory();
    broadcast();
    return snapshot();
  }

  // Applies a changed maxHistoryMessages to what is already on disk.
  function syncHistoryLimit(maxMessages) {
    const before = messages.length;
    messages = store.trimHistory(maxMessages);
    if (messages.length !== before) broadcast();
    return messages.length;
  }

  function remember(line) {
    const result = store.appendMemory(line);
    sendToWindow({ ...snapshot(), memory_updated_at: result.updatedAt });
    return result;
  }

  function getMemory() {
    return store.loadMemory();
  }

  function saveMemory(text) {
    return store.saveMemory(text);
  }

  function dispose() {
    stop();
  }

  // Re-send current transcript with fresh config (language/persona changes).
  function refresh() {
    broadcast();
  }

  return {
    dispose,
    submit,
    stop,
    clear,
    reload,
    refresh,
    remember,
    getMemory,
    saveMemory,
    snapshot,
    syncHistoryLimit,
    isStreaming: () => streaming,
  };
}

module.exports = {
  MOOD,
  createPetChatSessionRuntime,
  createPetChatStore,
};