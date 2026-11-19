"use strict";

// ── Pet chat IPC ──
//
// Wires the chat window, the session runtime and the credential store into
// ipcMain channels. Kept out of main.js for the same reason every other feature
// gets its own module: main.js is the composition root, not the owner of feature
// wiring.
//
// Trust boundary: the chat window is a sandboxed renderer with a narrow preload,
// but the channels still validate every payload — a compromised renderer must
// not be able to write an arbitrary API key, path, or transcript.

const { createPetChatCredentialStore } = require("./pet-chat-credential-store");
const { createPetChatSessionRuntime } = require("./pet-chat-runtime");
const { createPetChatWindowRuntime } = require("./pet-chat-window");
const { createPetChatClient } = require("./pet-chat-client");
const { createPetChatStore } = require("./pet-chat-store");
const { normalizePetChat, readiness } = require("./pet-chat-config");

const MAX_SUBMIT_CHARS = 4000;
const MAX_COPY_CHARS = 200000;

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerPetChatIpc requires ${name}`);
  return value;
}

function isTrustedSender(event, getWindow) {
  const win = getWindow();
  if (!event || !win || win.isDestroyed()) return false;
  const sender = event.sender;
  if (!sender || sender !== win.webContents) return false;
  try {
    return !!event.senderFrame && event.senderFrame === win.webContents.mainFrame;
  } catch {
    return false;
  }
}

function registerPetChatIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const safeStorage = requiredDependency(options.safeStorage, "safeStorage");
  const settingsController = requiredDependency(options.settingsController, "settingsController");
  const userDataDir = requiredDependency(options.userDataDir, "userDataDir");
  const getLang = options.getLang || (() => "en");
  const onMood = options.onMood || (() => {});
  const logWarn = options.logWarn || ((msg, err) => console.warn(msg, err && err.message));

  const credentialStore = createPetChatCredentialStore({ safeStorage });
  const store = createPetChatStore({ dir: options.chatDataDir || require("path").join(userDataDir, "pet-chat") });
  const client = options.client || createPetChatClient();

  let windowRuntime = null;
  let sessionRuntime = null;

  function getConfig() {
    return settingsController.get("petChat");
  }

  function readApiKey() {
    try {
      const record = credentialStore.load();
      return record ? record.apiKey : null;
    } catch (error) {
      // An unreadable vault must never look like "no key configured" silently;
      // surface it and let the request fail with a clear reason.
      logWarn("Clawd pet chat: could not read the API key:", error);
      return null;
    }
  }

  // Single exit point for every snapshot the window sees. `status` is attached
  // here rather than at each call site: the session runtime broadcasts on its
  // own (thinking / streaming / done) with a transcript-only payload, and a
  // missing `status` made the header fall back to "connecting…" permanently
  // after the first exchange. Callers that already computed a status keep
  // theirs; everyone else gets the current one.
  function pushState(payload) {
    if (!windowRuntime) return;
    const withStatus = payload && payload.status !== undefined
      ? payload
      : { ...payload, status: currentStatus() };
    windowRuntime.refreshTranscript(withStatus);
  }

  function currentStatus() {
    const cfg = normalizePetChat(getConfig());
    const ready = readiness(cfg, hasApiKey());
    return {
      enabled: cfg.enabled,
      ready: ready.ready,
      reason: ready.reason,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      openOnClick: cfg.openOnClick,
      petReactions: cfg.petReactions,
      memoryEnabled: cfg.memoryEnabled,
      persona: cfg.persona,
      hasApiKey: hasApiKey(),
      maxHistoryMessages: cfg.maxHistoryMessages,
      temperature: cfg.temperature,
    };
  }

  let apiKeyCache = null;
  let apiKeyCacheValid = false;

  function hasApiKey() {
    if (!apiKeyCacheValid) {
      apiKeyCache = readApiKey();
      apiKeyCacheValid = true;
    }
    return !!apiKeyCache;
  }

  function invalidateKeyCache() {
    apiKeyCacheValid = false;
    apiKeyCache = null;
  }

  function sendI18n() {
    if (!windowRuntime) return;
    const win = windowRuntime.getWindow();
    if (!win || win.isDestroyed()) return;
    const payload = { lang: getLang() };
    try { win.webContents.send("pet-chat:i18n", payload); } catch {}
  }

  function createRuntimes() {
    sessionRuntime = createPetChatSessionRuntime({
      getConfig: () => getConfig(),
      getApiKey: () => {
        if (!apiKeyCacheValid) {
          apiKeyCache = readApiKey();
          apiKeyCacheValid = true;
        }
        return apiKeyCache;
      },
      client,
      store,
      sendToWindow: (payload) => pushState(payload),
      onMood,
      logWarn,
    });

    windowRuntime = createPetChatWindowRuntime({
      getPetWindowBounds: options.getPetWindowBounds,
      getNearestWorkArea: options.getNearestWorkArea,
      getBubbleWorkArea: options.getBubbleWorkArea,
      getTextScale: options.getTextScale,
      getPermissionBubbleBounds: options.getPermissionBubbleBounds,
      getSessionHudBounds: options.getSessionHudBounds,
      repositionQuotaRing: options.repositionQuotaRing,
      guardAlwaysOnTop: options.guardAlwaysOnTop,
      reapplyMacVisibility: options.reapplyMacVisibility,
      getPetWindow: options.getPetWindow,
      onWindowClosed: () => {
        if (typeof options.onVisibilityChange === "function") {
          try { options.onVisibilityChange(false); } catch {}
        }
      },
      logWarn,
    });
  }

  function ensureRuntimes() {
    if (!sessionRuntime || !windowRuntime) createRuntimes();
  }

  function open() {
    ensureRuntimes();
    const cfg = normalizePetChat(getConfig());
    if (!cfg.enabled) {
      return { status: "error", reason: "disabled", message: "宠物聊天还没有开启。" };
    }
    const snapshot = sessionRuntime.snapshot();
    const opened = windowRuntime.show({
      ...snapshot,
      status: currentStatus(),
    });
    if (opened) {
      sendI18n();
      if (typeof options.onVisibilityChange === "function") {
        try { options.onVisibilityChange(true); } catch {}
      }
    }
    return { status: "ok", opened };
  }

  function close() {
    if (!windowRuntime) return { status: "ok" };
    sessionRuntime.stop();
    windowRuntime.hide();
    if (typeof options.onVisibilityChange === "function") {
      try { options.onVisibilityChange(false); } catch {}
    }
    return { status: "ok" };
  }

  function toggle() {
    if (isVisible()) return close();
    return open();
  }

  function isVisible() {
    return !!windowRuntime && windowRuntime.isVisible();
  }

  // ── Channels ──

  ipcMain.handle("pet-chat:get-state", (event) => {
    if (!isTrustedSender(event, () => windowRuntime && windowRuntime.getWindow())) {
      return { messages: [], streaming: false, error: null };
    }
    ensureRuntimes();
    return {
      ...sessionRuntime.snapshot(),
      status: currentStatus(),
    };
  });

  ipcMain.handle("pet-chat:submit", async (event, text) => {
    if (!isTrustedSender(event, () => windowRuntime && windowRuntime.getWindow())) {
      return { status: "error", message: "untrusted sender" };
    }
    if (typeof text !== "string" || !text.trim()) {
      return { status: "error", message: "empty message" };
    }
    if (text.length > MAX_SUBMIT_CHARS) {
      return { status: "error", message: "message is too long" };
    }
    ensureRuntimes();
    // Re-read the key every request so a key added in Settings applies without
    // needing to reopen the window.
    invalidateKeyCache();
    return sessionRuntime.submit(text);
  });

  ipcMain.on("pet-chat:stop", (event) => {
    if (!isTrustedSender(event, () => windowRuntime && windowRuntime.getWindow())) return;
    if (sessionRuntime) sessionRuntime.stop();
  });

  ipcMain.handle("pet-chat:clear", (event) => {
    if (!isTrustedSender(event, () => windowRuntime && windowRuntime.getWindow())) {
      return { status: "error", message: "untrusted sender" };
    }
    if (!sessionRuntime) return { status: "ok" };
    return { status: "ok", snapshot: sessionRuntime.clear() };
  });

  ipcMain.on("pet-chat:close", (event) => {
    if (!isTrustedSender(event, () => windowRuntime && windowRuntime.getWindow())) return;
    close();
  });

  ipcMain.on("pet-chat:set-collapsed", (event, value) => {
    if (!isTrustedSender(event, () => windowRuntime && windowRuntime.getWindow())) return;
    if (windowRuntime) windowRuntime.setCollapsed(!!value);
  });

  // Copy goes through main so the sandboxed renderer needs no clipboard access.
  // Bound to a size cap: a runaway model reply must not be able to push an
  // unbounded string through IPC.
  ipcMain.handle("pet-chat:copy", (event, text) => {
    if (!isTrustedSender(event, () => windowRuntime && windowRuntime.getWindow())) {
      return { status: "error", reason: "untrusted-sender" };
    }
    if (typeof text !== "string" || !text) {
      return { status: "error", reason: "invalid-input" };
    }
    const capped = text.slice(0, MAX_COPY_CHARS);
    try {
      options.clipboard.writeText(capped);
      return { status: "ok" };
    } catch {
      return { status: "error", reason: "copy-failed" };
    }
  });

  ipcMain.on("pet-chat:height", (event, height) => {
    if (!isTrustedSender(event, () => windowRuntime && windowRuntime.getWindow())) return;
    if (windowRuntime) windowRuntime.handleMeasuredHeight(Number(height));
  });

  // Credential + config writes stay on dedicated channels so the generic
  // settings:update path can never mint a spendable secret.
  ipcMain.handle("pet-chat:set-api-key", (event, apiKey) => {
    if (!isTrustedSender(event, () => windowRuntime && windowRuntime.getWindow())) {
      return { status: "error", reason: "untrusted-sender" };
    }
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      return { status: "error", reason: "invalid-credential-input" };
    }
    try {
      credentialStore.save(apiKey.trim());
      invalidateKeyCache();
      pushState({ ...sessionRuntime.snapshot(), status: currentStatus() });
      return { status: "ok" };
    } catch (error) {
      return { status: "error", reason: error && error.code ? error.code : "save-failed" };
    }
  });

  // Runtime-facing API used by main.js (click handler, settings changes).
  return {
    open,
    close,
    toggle,
    isVisible,
    getStatus: currentStatus,
    invalidateKeyCache,
    refreshStatus: () => {
      ensureRuntimes();
      if (isVisible()) pushState({ ...sessionRuntime.snapshot(), status: currentStatus() });
    },
    onSettingsChanged: () => {
      if (!sessionRuntime) return;
      const cfg = normalizePetChat(getConfig());
      sessionRuntime.syncHistoryLimit(cfg.maxHistoryMessages);
      invalidateKeyCache();
      if (isVisible()) {
        sendI18n();
        pushState({ ...sessionRuntime.snapshot(), status: currentStatus() });
      }
    },
    onLangChanged: () => {
      if (isVisible()) sendI18n();
    },
    syncWithPetVisibility: (hidden) => {
      if (windowRuntime) windowRuntime.syncWithPetVisibility(hidden);
    },
    reposition: () => {
      if (windowRuntime) windowRuntime.reposition();
    },
    // Settings tab uses these through the trusted settings IPC layer.
    credentialStore,
    store,
    dispose: () => {
      if (sessionRuntime) sessionRuntime.dispose();
      if (windowRuntime) windowRuntime.destroy();
    },
    __test: { isTrustedSender },
  };
}

module.exports = { registerPetChatIpc };