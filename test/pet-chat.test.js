"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_PERSONA,
  normalizePetChat,
  validatePetChat,
  normalizeBaseUrl,
  readiness,
} = require("../src/pet-chat-config");
const { createPetChatStore, sanitizeMessage } = require("../src/pet-chat-store");
const {
  buildEndpoint,
  buildMessages,
  createPetChatClient,
  parseSseData,
} = require("../src/pet-chat-client");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pet-chat-test-"));
}

// Minimal SSE body whose reader yields the given chunks verbatim.
function sseResponse(chunks) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => "text/event-stream" },
    body: {
      getReader() {
        return {
          read: async () => (index < chunks.length
            ? { value: new TextEncoder().encode(chunks[index++]), done: false }
            : { value: undefined, done: true }),
          cancel: async () => {},
          releaseLock: () => {},
        };
      },
    },
  };
}

describe("pet chat config", () => {
  it("normalizes junk into a usable object", () => {
    const cfg = normalizePetChat({
      enabled: "yes",
      baseUrl: 42,
      model: null,
      persona: "   ",
      maxHistoryMessages: 9999,
      temperature: 9,
    });
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.baseUrl, "");
    assert.strictEqual(cfg.model, "");
    assert.strictEqual(cfg.persona, DEFAULT_PERSONA);
    assert.strictEqual(cfg.maxHistoryMessages, 200);
    assert.strictEqual(cfg.temperature, 2);
  });

  it("defaults to disabled with no endpoint so no install gains a network feature", () => {
    const cfg = normalizePetChat(undefined);
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.baseUrl, "");
    assert.strictEqual(cfg.model, "");
  });

  it("rejects malformed fields instead of silently repairing them", () => {
    assert.strictEqual(validatePetChat({ enabled: "true" }).status, "error");
    assert.strictEqual(validatePetChat({ baseUrl: "ftp://x" }).status, "error");
    assert.strictEqual(validatePetChat({ baseUrl: "https://u:p@h/v1" }).status, "error");
    assert.strictEqual(validatePetChat({ maxHistoryMessages: 1 }).status, "error");
    assert.strictEqual(validatePetChat({ temperature: 3 }).status, "error");
    assert.strictEqual(validatePetChat({ nope: 1 }).status, "error");
    assert.strictEqual(validatePetChat({ enabled: true, baseUrl: "https://h/v1", model: "m" }).status, "ok");
  });

  it("normalizes base URLs and strips trailing slashes", () => {
    assert.deepStrictEqual(normalizeBaseUrl("https://api.x.com/v1/"), {
      ok: true,
      url: "https://api.x.com/v1",
    });
    assert.strictEqual(normalizeBaseUrl("nope").ok, false);
    assert.strictEqual(normalizeBaseUrl("").ok, false);
  });

  it("reports the exact missing piece for readiness", () => {
    assert.strictEqual(readiness({}, false).reason, "disabled");
    assert.strictEqual(readiness({ enabled: true }, false).reason, "no-base-url");
    assert.strictEqual(
      readiness({ enabled: true, baseUrl: "https://h/v1" }, false).reason,
      "no-model"
    );
    assert.strictEqual(
      readiness({ enabled: true, baseUrl: "https://h/v1", model: "m" }, false).reason,
      "no-api-key"
    );
    const ready = readiness({ enabled: true, baseUrl: "https://h/v1", model: "m" }, true);
    assert.strictEqual(ready.ready, true);
    assert.strictEqual(ready.endpoint, "https://h/v1");
  });
});

describe("pet chat store", () => {
  it("round-trips a turn and trims to the requested window", () => {
    const dir = tempDir();
    const store = createPetChatStore({ dir });
    store.appendTurn([{ role: "user", content: "a1" }, { role: "assistant", content: "b1" }], 2);
    store.appendTurn([{ role: "user", content: "a2" }, { role: "assistant", content: "b2" }], 2);
    const history = store.loadHistory();
    assert.deepStrictEqual(history.map((m) => m.content), ["a2", "b2"]);
  });

  it("never trusts the file: bad records are dropped, not thrown", () => {
    const dir = tempDir();
    const store = createPetChatStore({ dir });
    fs.writeFileSync(store.historyPath, JSON.stringify({
      version: 1,
      messages: [
        { role: "user", content: "ok" },
        { role: "system", content: "not a chat role" },
        { role: "assistant", content: "" },
        { role: "assistant", content: "  " },
        "junk",
        null,
      ],
    }));
    assert.deepStrictEqual(store.loadHistory().map((m) => m.content), ["ok"]);
  });

  it("survives a corrupt file instead of crashing", () => {
    const dir = tempDir();
    const store = createPetChatStore({ dir });
    fs.writeFileSync(store.historyPath, "{not json");
    assert.deepStrictEqual(store.loadHistory(), []);
  });

  it("appends memory as lines and keeps it bounded", () => {
    const dir = tempDir();
    const store = createPetChatStore({ dir });
    store.appendMemory("likes green tea");
    const mem = store.appendMemory("prefers tabs");
    assert.strictEqual(mem.text, "- likes green tea\n- prefers tabs");
  });

  it("trimHistory shrinks what is already on disk", () => {
    const dir = tempDir();
    const store = createPetChatStore({ dir });
    store.replaceHistory([
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
    ]);
    assert.deepStrictEqual(store.trimHistory(2).map((m) => m.content), ["3", "4"]);
    assert.deepStrictEqual(store.loadHistory().map((m) => m.content), ["3", "4"]);
  });

  it("rejects empty messages rather than persisting whitespace", () => {
    assert.strictEqual(sanitizeMessage({ role: "user", content: "   " }), null);
  });

  it("writes private files", () => {
    const dir = tempDir();
    const store = createPetChatStore({ dir });
    store.appendTurn({ role: "user", content: "hi" });
    const mode = fs.statSync(store.historyPath).mode & 0o777;
    assert.strictEqual(mode, 0o600);
  });
});

describe("pet chat client", () => {
  it("builds the completions endpoint from either URL shape", () => {
    assert.strictEqual(buildEndpoint("https://h/v1"), "https://h/v1/chat/completions");
    assert.strictEqual(buildEndpoint("https://h/v1/"), "https://h/v1/chat/completions");
    assert.strictEqual(
      buildEndpoint("https://h/v1/chat/completions"),
      "https://h/v1/chat/completions"
    );
    assert.throws(() => buildEndpoint(""), /base URL/);
  });

  it("parses SSE deltas, reasoning and [DONE]", () => {
    assert.deepStrictEqual(parseSseData("[DONE]"), { done: true, delta: "", reasoning: "" });
    const delta = parseSseData(JSON.stringify({
      choices: [{ delta: { content: "hi" }, finish_reason: null }],
    }));
    assert.strictEqual(delta.delta, "hi");
    const reason = parseSseData(JSON.stringify({
      choices: [{ delta: { reasoning_content: "hmm" } }],
    }));
    assert.strictEqual(reason.reasoning, "hmm");
    const bad = parseSseData("{oops");
    assert.strictEqual(bad.malformed, true);
  });

  it("streams text incrementally and returns the full reply", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const seen = [];
    const client = createPetChatClient({
      fetch: async () => sseResponse(chunks),
    });
    const result = await client.complete({
      baseUrl: "https://h/v1",
      apiKey: "k",
      model: "m",
      messages: [],
      onDelta: (d) => seen.push(d.delta),
    });
    assert.strictEqual(result.text, "Hello");
    assert.deepStrictEqual(seen.filter(Boolean), ["Hel", "lo"]);
  });

  it("falls back to plain JSON when the provider ignores stream:true", async () => {
    const client = createPetChatClient({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({
          choices: [{ message: { content: "plain" }, finish_reason: "stop" }],
        }),
      }),
    });
    const result = await client.complete({
      baseUrl: "https://h/v1", apiKey: "k", model: "m", messages: [],
    });
    assert.strictEqual(result.text, "plain");
  });

  it("maps auth failures to a stable code", async () => {
    const client = createPetChatClient({
      fetch: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: "bad key" } }),
      }),
    });
    await assert.rejects(
      () => client.complete({ baseUrl: "https://h/v1", apiKey: "k", model: "m", messages: [] }),
      (err) => err.code === "AUTH_FAILED" && /bad key/.test(err.message)
    );
  });

  it("refuses to send without a key or model", async () => {
    const client = createPetChatClient({ fetch: async () => { throw new Error("no"); } });
    await assert.rejects(
      () => client.complete({ baseUrl: "https://h/v1", apiKey: "", model: "m", messages: [] }),
      (err) => err.code === "NO_API_KEY"
    );
    await assert.rejects(
      () => client.complete({ baseUrl: "https://h/v1", apiKey: "k", model: "", messages: [] }),
      (err) => err.code === "NO_MODEL"
    );
  });

  it("rejects an empty reply rather than storing a blank assistant turn", async () => {
    const client = createPetChatClient({ fetch: async () => sseResponse(["data: [DONE]\n\n"]) });
    await assert.rejects(
      () => client.complete({ baseUrl: "https://h/v1", apiKey: "k", model: "m", messages: [] }),
      (err) => err.code === "EMPTY_RESPONSE"
    );
  });

  it("does not duplicate the final user turn already present in history", () => {
    const messages = buildMessages({
      persona: "P",
      memory: "M",
      history: [{ role: "user", content: "hi" }],
      userText: "hi",
      maxHistoryMessages: 10,
    });
    assert.strictEqual(messages[0].role, "system");
    assert.match(messages[0].content, /P/);
    assert.match(messages[0].content, /M/);
    assert.strictEqual(messages.filter((m) => m.content === "hi").length, 1);
  });

  it("adds the user turn when history does not already contain it", () => {
    const messages = buildMessages({
      persona: "P",
      memory: "",
      history: [],
      userText: "fresh",
      maxHistoryMessages: 10,
    });
    assert.strictEqual(messages[messages.length - 1].content, "fresh");
  });
});
describe("pet chat session runtime", () => {
  const { createPetChatSessionRuntime } = require("../src/pet-chat-runtime");

  function makeRuntime({ reply = "hello", failWith = null, chunks = null, persona = "P" } = {}) {
    const dir = tempDir();
    const store = createPetChatStore({ dir });
    const pushed = [];
    const moods = [];
    const client = {
      async complete(req) {
        if (chunks) {
          for (const chunk of chunks) {
            req.onDelta({ delta: chunk, reasoning: "" });
          }
        }
        if (failWith) throw failWith;
        return { ok: true, text: reply, reasoning: "", finishReason: "stop" };
      },
    };
    const runtime = createPetChatSessionRuntime({
      getConfig: () => ({
        enabled: true,
        baseUrl: "https://h/v1",
        model: "m",
        persona,
        memoryEnabled: true,
        maxHistoryMessages: 20,
        temperature: 0.7,
      }),
      getApiKey: () => "key",
      client,
      store,
      sendToWindow: (payload) => pushed.push(payload),
      onMood: (mood) => moods.push(mood),
      logWarn: () => {},
    });
    return { runtime, store, pushed, moods };
  }

  it("stores the turn and reports thinking -> done", async () => {
    const { runtime, store, moods } = makeRuntime();
    const result = await runtime.submit("hi");
    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(store.loadHistory().map((m) => `${m.role}:${m.content}`), [
      "user:hi",
      "assistant:hello",
    ]);
    assert.deepStrictEqual(moods, ["thinking", "idle"]);
  });

  it("surfaces a readiness failure without calling the model", async () => {
    const dir = tempDir();
    const store = createPetChatStore({ dir });
    const runtime = createPetChatSessionRuntime({
      getConfig: () => ({ enabled: true, baseUrl: "", model: "", persona: "P", maxHistoryMessages: 20 }),
      getApiKey: () => null,
      client: { complete: async () => { throw new Error("should not run"); } },
      store,
      sendToWindow: () => {},
      onMood: () => {},
      logWarn: () => {},
    });
    const result = await runtime.submit("hi");
    assert.strictEqual(result.status, "error");
    assert.deepStrictEqual(store.loadHistory(), []);
  });

  it("keeps the partial reply and an error when the stream breaks", async () => {
    const err = Object.assign(new Error("boom"), { code: "STREAM_BROKEN" });
    const { runtime, store, moods } = makeRuntime({ failWith: err, chunks: ["part"] });
    const result = await runtime.submit("hi");
    assert.strictEqual(result.status, "error");
    const history = store.loadHistory();
    assert.strictEqual(history[0].content, "hi");
    assert.match(history[1].content, /part/);
    assert.match(history[1].content, /中断/);
    assert.deepStrictEqual(moods, ["thinking", "error"]);
  });

  it("rejects an empty message", async () => {
    const { runtime } = makeRuntime();
    const result = await runtime.submit("   ");
    assert.strictEqual(result.status, "error");
  });

  it("clear wipes the transcript", async () => {
    const { runtime, store } = makeRuntime();
    await runtime.submit("hi");
    runtime.clear();
    assert.deepStrictEqual(store.loadHistory(), []);
  });

  it("syncHistoryLimit trims what is on disk", async () => {
    const { runtime, store } = makeRuntime();
    await runtime.submit("one");
    await runtime.submit("two");
    runtime.syncHistoryLimit(2);
    assert.strictEqual(store.loadHistory().length, 2);
  });
});

describe("pet chat prefs", () => {
  const prefs = require("../src/prefs");

  it("defaults to disabled and survives a round trip", () => {
    const snapshot = prefs.getDefaults();
    assert.strictEqual(snapshot.petChat.enabled, false);
    assert.strictEqual(snapshot.petChat.baseUrl, "");
    const validated = prefs.validate({ ...snapshot });
    assert.strictEqual(validated.petChat.enabled, false);
    assert.strictEqual(validated.petChat.openOnClick, true);
  });

  it("migrates an old prefs file to the current version with pet chat present", () => {
    const upgraded = prefs.migrate({ version: 21, lang: "zh" });
    assert.strictEqual(upgraded.version, prefs.CURRENT_VERSION);
    const validated = prefs.validate(upgraded);
    assert.strictEqual(validated.petChat.enabled, false);
  });

  it("coerces bad pet chat values instead of throwing", () => {
    const validated = prefs.validate({ ...prefs.getDefaults(), petChat: "nope" });
    assert.strictEqual(validated.petChat.enabled, false);
  });
});

// Regression guard: every symbol pet-chat destructures out of another module
// must actually exist there. A destructure of a missing export yields
// `undefined` at load time and only explodes on the user's first click (that is
// exactly how computeUpdateBubbleBounds broke: it lived only on `__test`).
describe("pet chat module wiring", () => {
  const MODULE_DIR = path.join(__dirname, "..", "src");
  const PET_CHAT_FILES = fs.readdirSync(MODULE_DIR)
    .filter((name) => name.startsWith("pet-chat-") && name.endsWith(".js"))
    .concat(["preload-pet-chat.js"]);

  it("destructures only symbols that the source module really exports", () => {
    const broken = [];
    for (const file of PET_CHAT_FILES) {
      const source = fs.readFileSync(path.join(MODULE_DIR, file), "utf8");
      const requireRe = /const\s*\{([^}]+)\}\s*=\s*require\(\s*["'](\.[^"']+)["']\s*\)/g;
      let match;
      while ((match = requireRe.exec(source)) !== null) {
        const [, names, spec] = match;
        // Electron builtins are not ours to check.
        let mod;
        try {
          mod = require(path.resolve(MODULE_DIR, spec));
        } catch {
          continue;
        }
        if (!mod || typeof mod !== "object" && typeof mod !== "function") continue;
        for (const raw of names.split(",")) {
          const name = raw.split(":").pop().trim();
          if (!name) continue;
          if (mod[name] === undefined) broken.push(`${file}: ${name} from ${spec}`);
        }
      }
    }
    assert.deepStrictEqual(broken, [], `missing exports:\n${broken.join("\n")}`);
  });

  it("exposes computeUpdateBubbleBounds as a real export, not only on __test", () => {
    const updateBubble = require("../src/update-bubble");
    assert.strictEqual(typeof updateBubble.computeUpdateBubbleBounds, "function");
  });

  it("can compute chat window bounds without throwing", () => {
    const { createPetChatWindowRuntime } = require("../src/pet-chat-window");
    const runtime = createPetChatWindowRuntime({
      getPetWindowBounds: () => ({ x: 300, y: 60, width: 120, height: 120 }),
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      getTextScale: () => 1,
      getPermissionBubbleBounds: () => [],
      getSessionHudBounds: () => [],
      logWarn: () => {},
    });
    const bounds = runtime.computeBounds();
    assert.ok(bounds, "bounds must be computed");
    assert.ok(Number.isFinite(bounds.x) && Number.isFinite(bounds.y));
    assert.ok(bounds.width > 0 && bounds.height > 0);
  });
});

// The window gets a full snapshot per streamed chunk. Rebuilding the transcript
// on each one made the log flicker and replayed the entry animation dozens of
// times a second (the "thinking text keeps flashing" bug). This guards the
// structural invariants that keep updates incremental — it inspects the source
// because the renderer runs only inside Electron.
describe("pet chat renderer stays incremental", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "pet-chat-renderer.js"), "utf8");

  it("never clears the whole transcript on update", () => {
    // `logEl.textContent = ""` / `logEl.innerHTML = ...` would detach every row.
    assert.ok(
      !/logEl\.textContent\s*=\s*""/.test(source),
      "renderer must not wipe logEl; that rebuilds every bubble per chunk"
    );
    assert.ok(
      !/logEl\.innerHTML\s*=/.test(source),
      "renderer must not assign logEl.innerHTML"
    );
  });

  it("reuses mounted rows through a row cache", () => {
    assert.match(source, /let rows = \[\];/);
    assert.match(source, /let streamingRow = null;/);
  });

  it("repaints the streaming bubble in place instead of recreating it", () => {
    // The in-flight row is created only when missing, never appended per update.
    const streamingBlock = source.slice(
      source.indexOf("// ── In-flight bubble"),
      source.indexOf("renderedShape = shape;\n  finishRender(snapshot, messages, shouldStick);")
    );
    assert.ok(streamingBlock.length > 0, "expected an in-flight section");
    assert.match(
      streamingBlock,
      /if \(!streamingRow \|\| streamingRow\.dataset\.kind !== "pet"\)/,
      "in-flight row must be reused when it already exists"
    );
  });

  it("does not reassign text when the string is unchanged", () => {
    assert.match(source, /if \(body\.textContent !== text\) body\.textContent = text;/);
    assert.match(source, /if \(think\.textContent !== reasoning\) think\.textContent = reasoning;/);
  });

  it("drops mounted rows when history is cleared", () => {
    assert.match(source, /rows = \[\];/);
  });
});
