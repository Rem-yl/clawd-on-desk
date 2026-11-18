"use strict";

// API key storage for pet chat. Reuses the shared safeStorage-backed credential
// vault so the key is encrypted with the OS vault (Keychain / DPAPI / libsecret)
// and never lands in clawd-prefs.json. A separate record kind and path keep it
// isolated from the DeepSeek balance key.

const os = require("os");
const path = require("path");
const { createQuotaCredentialStore } = require("./quota-credential-store");

const DEFAULT_CREDENTIAL_PATH = path.join(os.homedir(), ".clawd", "pet-chat-credential.json");
const STORAGE_UNAVAILABLE = "PET_CHAT_STORAGE_UNAVAILABLE";
const CREDENTIAL_INVALID = "PET_CHAT_CREDENTIAL_INVALID";
const MAX_API_KEY_LENGTH = 4096;

function createPetChatCredentialStore(options = {}) {
  return createQuotaCredentialStore({
    CREDENTIAL_VERSION: 1,
    CREDENTIAL_KIND: "pet-chat-api-key",
    DEFAULT_CREDENTIAL_PATH,
    MAX_API_KEY_LENGTH,
    STORAGE_UNAVAILABLE,
    CREDENTIAL_INVALID,
    keyName: "Pet chat API Key",
    recordName: "Pet chat credential record",
  }, options);
}

module.exports = {
  CREDENTIAL_INVALID,
  DEFAULT_CREDENTIAL_PATH,
  MAX_API_KEY_LENGTH,
  STORAGE_UNAVAILABLE,
  createPetChatCredentialStore,
};