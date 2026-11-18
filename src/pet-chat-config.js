"use strict";

// ── Pet chat config (pure data layer) ──
//
// Non-secret chat settings live in clawd-prefs.json under `petChat`. The API key
// is NOT here — it is encrypted with the OS vault by pet-chat-credential-store.js
// so a prefs backup or a synced folder never carries a spendable secret.
//
// `normalize` is total: any junk in, a valid object out. `validate` is what the
// Settings command path uses, and it rejects shapes normalize would silently
// repair so the user gets a real error instead of a quiet fallback.

const DEFAULT_PERSONA =
  "你是一只住在用户桌面上的小宠物。说话简短、口语化，中文为主，偶尔卖萌但不要过度。"
  + "用户问技术问题时正常给答案，不要为了卖萌牺牲准确性。";

const MAX_PERSONA_LENGTH = 4000;
const MAX_MEMORY_LENGTH = 20000;
const MIN_HISTORY_MESSAGES = 2;
const MAX_HISTORY_MESSAGES = 200;
const MAX_BASE_URL_LENGTH = 512;
const MAX_MODEL_LENGTH = 200;

const DEFAULT_PET_CHAT = Object.freeze({
  enabled: false,
  baseUrl: "",
  model: "",
  persona: DEFAULT_PERSONA,
  memoryEnabled: true,
  maxHistoryMessages: 40,
  temperature: 0.8,
  openOnClick: true,
  petReactions: true,
});

function cloneDefaultPetChat() {
  return { ...DEFAULT_PET_CHAT };
}

function trimString(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function normalizePetChat(value) {
  const base = cloneDefaultPetChat();
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  base.enabled = value.enabled === true;
  base.baseUrl = trimString(value.baseUrl, MAX_BASE_URL_LENGTH).trim();
  base.model = trimString(value.model, MAX_MODEL_LENGTH).trim();
  const persona = trimString(value.persona, MAX_PERSONA_LENGTH);
  base.persona = persona.trim() ? persona : DEFAULT_PERSONA;
  base.memoryEnabled = value.memoryEnabled !== false;
  if (Number.isInteger(value.maxHistoryMessages)) {
    base.maxHistoryMessages = Math.min(
      MAX_HISTORY_MESSAGES,
      Math.max(MIN_HISTORY_MESSAGES, value.maxHistoryMessages)
    );
  }
  if (Number.isFinite(value.temperature)) {
    base.temperature = Math.min(2, Math.max(0, value.temperature));
  }
  base.openOnClick = value.openOnClick !== false;
  base.petReactions = value.petReactions !== false;
  return base;
}

function validatePetChat(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "error", message: "petChat must be an object" };
  }
  const allowed = new Set(Object.keys(DEFAULT_PET_CHAT));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return { status: "error", message: `petChat.${key} is not supported` };
  }
  if ("enabled" in value && typeof value.enabled !== "boolean") {
    return { status: "error", message: "petChat.enabled must be a boolean" };
  }
  if ("memoryEnabled" in value && typeof value.memoryEnabled !== "boolean") {
    return { status: "error", message: "petChat.memoryEnabled must be a boolean" };
  }
  if ("openOnClick" in value && typeof value.openOnClick !== "boolean") {
    return { status: "error", message: "petChat.openOnClick must be a boolean" };
  }
  if ("petReactions" in value && typeof value.petReactions !== "boolean") {
    return { status: "error", message: "petChat.petReactions must be a boolean" };
  }
  if ("baseUrl" in value) {
    const url = value.baseUrl;
    if (typeof url !== "string" || url.length > MAX_BASE_URL_LENGTH) {
      return { status: "error", message: "petChat.baseUrl must be a string" };
    }
    if (url.trim()) {
      const check = normalizeBaseUrl(url);
      if (!check.ok) return { status: "error", message: `petChat.baseUrl ${check.reason}` };
    }
  }
  if ("model" in value) {
    if (typeof value.model !== "string" || value.model.length > MAX_MODEL_LENGTH) {
      return { status: "error", message: "petChat.model must be a string" };
    }
  }
  if ("persona" in value) {
    if (typeof value.persona !== "string" || value.persona.length > MAX_PERSONA_LENGTH) {
      return { status: "error", message: `petChat.persona must be at most ${MAX_PERSONA_LENGTH} characters` };
    }
  }
  if ("maxHistoryMessages" in value) {
    const n = value.maxHistoryMessages;
    if (!Number.isInteger(n) || n < MIN_HISTORY_MESSAGES || n > MAX_HISTORY_MESSAGES) {
      return {
        status: "error",
        message: `petChat.maxHistoryMessages must be an integer ${MIN_HISTORY_MESSAGES}–${MAX_HISTORY_MESSAGES}`,
      };
    }
  }
  if ("temperature" in value) {
    const n = value.temperature;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 2) {
      return { status: "error", message: "petChat.temperature must be between 0 and 2" };
    }
  }
  return { status: "ok" };
}

// Only http(s) with a host. Trailing slashes are stripped by the client, so a
// pasted "https://host/v1/" and "https://host/v1" behave identically.
function normalizeBaseUrl(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, reason: "must not be empty" };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, reason: "must be an absolute http(s) URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "must use http or https" };
  }
  if (!parsed.hostname) return { ok: false, reason: "must include a host" };
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "must not embed credentials" };
  }
  return { ok: true, url: text.replace(/\/+$/, "") };
}

// Everything needed to actually send a request. Missing pieces are reported by
// name so Settings can point at the exact row that still needs filling in.
function readiness(config, hasApiKey) {
  const cfg = normalizePetChat(config);
  if (!cfg.enabled) return { ready: false, reason: "disabled", config: cfg };
  if (!cfg.baseUrl) return { ready: false, reason: "no-base-url", config: cfg };
  const url = normalizeBaseUrl(cfg.baseUrl);
  if (!url.ok) return { ready: false, reason: "invalid-base-url", config: cfg };
  if (!cfg.model) return { ready: false, reason: "no-model", config: cfg };
  if (!hasApiKey) return { ready: false, reason: "no-api-key", config: cfg };
  return { ready: true, reason: null, config: cfg, endpoint: url.url };
}

module.exports = {
  DEFAULT_PERSONA,
  DEFAULT_PET_CHAT,
  MAX_PERSONA_LENGTH,
  MAX_MEMORY_LENGTH,
  MIN_HISTORY_MESSAGES,
  MAX_HISTORY_MESSAGES,
  cloneDefaultPetChat,
  normalizePetChat,
  validatePetChat,
  normalizeBaseUrl,
  readiness,
};