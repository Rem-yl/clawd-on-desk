"use strict";

// ── Pet chat persistence (main process) ──
//
// Two small files under `<userData>/pet-chat/`:
//
//   history.json  { version, messages: [{ role, content, at }] }
//   memory.json   { version, text, updatedAt }
//
// Both are written atomically (tmp + rename) and 0600. Nothing here touches the
// network, and nothing here is trusted: load() re-validates every record so a
// hand-edited or half-written file degrades to empty/a bounded state instead of
// throwing into the chat runtime.
//
// History is a rolling window. `appendTurn` enforces the caller's current
// `maxHistoryMessages` on every write, so lowering the setting in Settings also
// trims what's already on disk instead of only future writes.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { MAX_MEMORY_LENGTH } = require("./pet-chat-config");

const HISTORY_VERSION = 1;
const MEMORY_VERSION = 1;
const HARD_MAX_MESSAGES = 400;
const MAX_MESSAGE_CHARS = 20000;
const ROLES = new Set(["user", "assistant"]);

function atomicWriteJson(filePath, value, options = {}) {
  const fsImpl = options.fs || fs;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let renamed = false;
  try {
    fsImpl.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    try { fsImpl.chmodSync(temporaryPath, 0o600); } catch {}
    fsImpl.renameSync(temporaryPath, filePath);
    renamed = true;
    try { fsImpl.chmodSync(filePath, 0o600); } catch {}
  } finally {
    if (!renamed) {
      try { fsImpl.unlinkSync(temporaryPath); } catch {}
    }
  }
}

function readJson(filePath, fsImpl) {
  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function sanitizeMessage(entry) {
  if (!entry || typeof entry !== "object") return null;
  const role = entry.role;
  if (!ROLES.has(role)) return null;
  if (typeof entry.content !== "string") return null;
  const content = entry.content.slice(0, MAX_MESSAGE_CHARS);
  if (!content.trim()) return null;
  const at = Number.isFinite(entry.at) ? entry.at : Date.now();
  return { role, content, at };
}

function createPetChatStore(options = {}) {
  const fsImpl = options.fs || fs;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  if (!options.dir) throw new Error("createPetChatStore requires dir");
  // `dir` is always an app-owned location (app.getPath("userData")/pet-chat, or a
  // test temp dir) — never user input. Pinning it to an absolute path keeps that
  // invariant explicit: a relative value could otherwise resolve against the
  // process cwd and scatter history elsewhere.
  const dir = path.resolve(options.dir);
  if (!path.isAbsolute(dir)) {
    throw new Error("createPetChatStore requires an absolute dir");
  }
  const historyPath = path.join(dir, "history.json");
  const memoryPath = path.join(dir, "memory.json");

  function loadHistory() {
    const parsed = readJson(historyPath, fsImpl);
    if (!parsed || typeof parsed !== "object" || parsed.version !== HISTORY_VERSION) return [];
    const raw = Array.isArray(parsed.messages) ? parsed.messages : [];
    const out = [];
    for (const entry of raw.slice(-HARD_MAX_MESSAGES)) {
      const message = sanitizeMessage(entry);
      if (message) out.push(message);
    }
    return out;
  }

  function writeHistory(messages) {
    atomicWriteJson(historyPath, { version: HISTORY_VERSION, messages }, { fs: fsImpl, randomBytes });
  }

  // Appends one turn, then trims to `maxMessages` from the tail. A turn whose
  // reply failed still keeps the user message, so the transcript the user sees
  // matches what was actually said.
  function appendTurn(messages, maxMessages = HARD_MAX_MESSAGES) {
    const cap = Math.min(
      HARD_MAX_MESSAGES,
      Math.max(2, Number.isInteger(maxMessages) ? maxMessages : HARD_MAX_MESSAGES)
    );
    const existing = loadHistory();
    const appended = [];
    for (const entry of Array.isArray(messages) ? messages : [messages]) {
      const message = sanitizeMessage({ ...entry, at: entry && entry.at != null ? entry.at : now() });
      if (message) appended.push(message);
    }
    if (!appended.length) return existing;
    const next = [...existing, ...appended].slice(-cap);
    writeHistory(next);
    return next;
  }

  function replaceHistory(messages, maxMessages = HARD_MAX_MESSAGES) {
    const cap = Math.min(HARD_MAX_MESSAGES, Math.max(0, Number.isInteger(maxMessages) ? maxMessages : HARD_MAX_MESSAGES));
    const out = [];
    for (const entry of Array.isArray(messages) ? messages : []) {
      const message = sanitizeMessage(entry);
      if (message) out.push(message);
    }
    const next = cap === 0 ? [] : out.slice(-cap);
    writeHistory(next);
    return next;
  }

  function clearHistory() {
    try { fsImpl.unlinkSync(historyPath); } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    return [];
  }

  function trimHistory(maxMessages) {
    const existing = loadHistory();
    const cap = Math.min(HARD_MAX_MESSAGES, Math.max(0, Number.isInteger(maxMessages) ? maxMessages : HARD_MAX_MESSAGES));
    if (existing.length <= cap) return existing;
    const next = existing.slice(-cap);
    writeHistory(next);
    return next;
  }

  function loadMemory() {
    const parsed = readJson(memoryPath, fsImpl);
    if (!parsed || typeof parsed !== "object" || parsed.version !== MEMORY_VERSION) {
      return { text: "", updatedAt: null };
    }
    const text = typeof parsed.text === "string" ? parsed.text.slice(0, MAX_MEMORY_LENGTH) : "";
    return {
      text,
      updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : null,
    };
  }

  function saveMemory(text) {
    const safe = typeof text === "string" ? text.slice(0, MAX_MEMORY_LENGTH) : "";
    atomicWriteJson(memoryPath, { version: MEMORY_VERSION, text: safe, updatedAt: now() }, {
      fs: fsImpl,
      randomBytes,
    });
    return { text: safe, updatedAt: now() };
  }

  // Appends one line to long-term memory. Used by the runtime when the model
  // (or the user) asks to remember something. Kept line-oriented so it stays
  // human-readable in the Settings textarea.
  function appendMemory(line) {
    const addition = typeof line === "string" ? line.trim() : "";
    if (!addition) return loadMemory();
    const current = loadMemory().text;
    const next = current ? `${current}\n- ${addition}` : `- ${addition}`;
    return saveMemory(next.slice(-MAX_MEMORY_LENGTH));
  }

  return {
    dir,
    historyPath,
    memoryPath,
    loadHistory,
    replaceHistory,
    appendTurn,
    clearHistory,
    trimHistory,
    loadMemory,
    saveMemory,
    appendMemory,
  };
}

module.exports = {
  HARD_MAX_MESSAGES,
  HISTORY_VERSION,
  MEMORY_VERSION,
  atomicWriteJson,
  createPetChatStore,
  sanitizeMessage,
};