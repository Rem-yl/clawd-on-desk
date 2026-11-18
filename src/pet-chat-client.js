"use strict";

// ── OpenAI-compatible chat client (main process) ──
//
// Only what a desktop pet needs: `POST {baseUrl}/chat/completions` with
// `stream: true`, incremental text via callback, and a cancel hook. No SDK, no
// retries beyond one explicit caller-driven retry, no tool calling.
//
// Deliberate limits:
//   - The API key never leaves this module; callers pass it in per request.
//   - The response body is read with a bounded buffer: SSE lines are parsed
//     incrementally, and a single line over MAX_LINE_BYTES aborts instead of
//     growing memory.
//   - Errors are normalized to { code, message } so the renderer never has to
//     pattern-match on vendor error shapes.

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

function makeError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function buildEndpoint(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw makeError("NO_BASE_URL", "base URL is not configured");
  // Users paste either ".../v1" or the full ".../v1/chat/completions".
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

// Maps an upstream body to a short, user-facing reason without echoing the
// key or the whole payload. Providers vary wildly here, so this is best-effort.
function describeHttpError(status, bodyText) {
  let detail = "";
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      const candidate = parsed && (
        (parsed.error && (parsed.error.message || parsed.error.type))
        || parsed.message
        || parsed.detail
      );
      if (typeof candidate === "string") detail = candidate.slice(0, 400);
    } catch {
      detail = String(bodyText).slice(0, 200);
    }
  }
  const suffix = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403) return makeError("AUTH_FAILED", `authentication failed (HTTP ${status})${suffix}`);
  if (status === 404) return makeError("NOT_FOUND", `endpoint or model not found (HTTP 404)${suffix}`);
  if (status === 429) return makeError("RATE_LIMITED", `rate limited (HTTP 429)${suffix}`);
  if (status >= 500) return makeError("UPSTREAM_ERROR", `provider error (HTTP ${status})${suffix}`);
  return makeError("HTTP_ERROR", `request failed (HTTP ${status})${suffix}`);
}

// One SSE line -> delta text (or ""), reasoning text (or ""), and a finish
// marker. Kept pure so it is unit-testable without a socket.
function parseSseData(data) {
  const text = String(data || "").trim();
  if (!text || text === "[DONE]") {
    return { done: text === "[DONE]", delta: "", reasoning: "" };
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { done: false, delta: "", reasoning: "", malformed: true };
  }
  if (payload && payload.error) {
    const message = typeof payload.error.message === "string"
      ? payload.error.message.slice(0, 400)
      : "stream error";
    return { done: false, delta: "", reasoning: "", error: makeError("STREAM_ERROR", message) };
  }
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (!choice) return { done: false, delta: "", reasoning: "" };
  const delta = choice.delta || choice.message || {};
  const content = typeof delta.content === "string" ? delta.content : "";
  // DeepSeek/Qwen-style reasoning models put chain-of-thought here. The pet
  // window shows it as a dim "thinking" line, never as the reply.
  const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
  return {
    done: !!choice.finish_reason,
    delta: content,
    reasoning,
    finishReason: choice.finish_reason || null,
  };
}

function createPetChatClient(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("createPetChatClient requires a fetch implementation");
  }
  const defaultTimeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  // Returns { ok, text, reasoning, finishReason, usage } or throws a coded error.
  // `onDelta({ delta, reasoning })` fires per chunk so the window can type live.
  async function complete(request = {}) {
    const {
      baseUrl,
      apiKey,
      model,
      messages,
      temperature,
      signal,
      onDelta,
      timeoutMs,
    } = request;
    if (!apiKey) throw makeError("NO_API_KEY", "API key is not configured");
    if (!model) throw makeError("NO_MODEL", "model is not configured");

    const endpoint = buildEndpoint(baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(makeError("TIMEOUT", "request timed out"));
    }, Number.isFinite(timeoutMs) ? timeoutMs : defaultTimeoutMs);
    if (timeout && typeof timeout.unref === "function") timeout.unref();
    const onOuterAbort = () => controller.abort(makeError("ABORTED", "request cancelled"));
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeout);
        throw makeError("ABORTED", "request cancelled");
      }
      signal.addEventListener("abort", onOuterAbort, { once: true });
    }

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          ...(Number.isFinite(temperature) ? { temperature } : {}),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
      if (error && error.code) throw error;
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason && reason.code
          ? reason
          : makeError("ABORTED", "request cancelled");
      }
      throw makeError("NETWORK_ERROR", `could not reach ${endpoint}`, error);
    }

    if (!response.ok) {
      let bodyText = "";
      try { bodyText = await response.text(); } catch {}
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
      throw describeHttpError(response.status, bodyText);
    }

    // No stream body (some proxies ignore stream:true): fall back to plain JSON.
    const contentType = String((response.headers && response.headers.get("content-type")) || "");
    if (!contentType.includes("text/event-stream") || !response.body) {
      try {
        const text = await response.text();
        const parsed = JSON.parse(text);
        const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
        const content = choice && choice.message && typeof choice.message.content === "string"
          ? choice.message.content
          : "";
        if (!content) throw makeError("EMPTY_RESPONSE", "provider returned no message");
        if (typeof onDelta === "function") onDelta({ delta: content, reasoning: "" });
        return {
          ok: true,
          text: content,
          reasoning: "",
          finishReason: choice.finish_reason || null,
          usage: parsed.usage || null,
        };
      } catch (error) {
        if (error && error.code) throw error;
        throw makeError("MALFORMED_RESPONSE", "provider returned an unreadable response", error);
      } finally {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", onOuterAbort);
      }
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let text = "";
    let reasoning = "";
    let finishReason = null;
    let totalBytes = 0;
    const pendingEvents = [];

    const flushEvent = (rawEvent) => {
      const lines = rawEvent.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const parsed = parseSseData(line.slice(5));
        if (parsed.error) throw parsed.error;
        if (parsed.reasoning) {
          reasoning += parsed.reasoning;
          if (typeof onDelta === "function") onDelta({ delta: "", reasoning: parsed.reasoning });
        }
        if (parsed.delta) {
          text += parsed.delta;
          if (typeof onDelta === "function") onDelta({ delta: parsed.delta, reasoning: "" });
        }
        if (parsed.done) {
          if (parsed.finishReason) finishReason = parsed.finishReason;
          pendingEvents.push("[DONE]");
        }
      }
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw makeError("RESPONSE_TOO_LARGE", "stream exceeded the size limit");
        }
        buffer += decoder.decode(value, { stream: true });
        let separatorIndex;
        while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          flushEvent(rawEvent);
          if (pendingEvents.includes("[DONE]")) {
            try { await reader.cancel(); } catch {}
            break;
          }
        }
        if (buffer.length > MAX_LINE_BYTES) {
          throw makeError("RESPONSE_TOO_LARGE", "stream line exceeded the size limit");
        }
      }
      // A final event without the trailing blank line.
      if (buffer.trim()) flushEvent(buffer);
    } catch (error) {
      if (error && error.code) throw error;
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason && reason.code ? reason : makeError("ABORTED", "request cancelled");
      }
      throw makeError("STREAM_BROKEN", "the response stream ended unexpectedly", error);
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
      try { reader.releaseLock(); } catch {}
    }

    if (!text.trim()) {
      throw makeError("EMPTY_RESPONSE", "provider returned no message");
    }
    return { ok: true, text, reasoning, finishReason, usage: null };
  }

  return { complete };
}

// Assembles the provider payload from persona + memory + history. Kept separate
// from the client so the exact prompt shape is testable and stable.
function buildMessages({ persona, memory, history, userText, maxHistoryMessages }) {
  const messages = [];
  const system = [];

  // Memory is the cheapest injection point available and the only one that
  // survives restarts — it must come before history so it frames the turn.
  const memoryText = typeof memory === "string" ? memory.trim() : "";
  if (memoryText) {
    system.push(`# 你记得的事\n${memoryText}`);
  }

  const historyLimit = Number.isInteger(maxHistoryMessages) ? maxHistoryMessages : 40;
  const recent = Array.isArray(history) ? history.slice(-historyLimit) : [];
  for (const entry of recent) {
    if (!entry || (entry.role !== "user" && entry.role !== "assistant")) continue;
    if (typeof entry.content !== "string" || !entry.content.trim()) continue;
    messages.push({ role: entry.role, content: entry.content });
  }
  if (messages.length && messages[messages.length - 1].role === "user"
    && userText && messages[messages.length - 1].content === userText) {
    // The caller already appended this turn to history; don't duplicate it.
    return withSystem(messages, system, persona);
  }
  if (typeof userText === "string" && userText.trim()) {
    messages.push({ role: "user", content: userText });
  }
  return withSystem(messages, system, persona);
}

function withSystem(messages, systemParts, persona) {
  const system = typeof persona === "string" ? persona.trim() : "";
  if (system) systemParts.unshift(system);
  if (!systemParts.length) return messages;
  return [{ role: "system", content: systemParts.join("\n\n") }, ...messages];
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  buildEndpoint,
  buildMessages,
  createPetChatClient,
  describeHttpError,
  parseSseData,
};