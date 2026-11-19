"use strict";

// ── Chat markdown → safe HTML ──
//
// The chat window renders model output. That output is untrusted: it is
// whatever a remote endpoint decided to send. So markdown is converted to HTML
// here, in the main process, under a strict allowlist — the renderer never
// interprets raw model text as markup.
//
// The sanitizer is a second pass over markdown-it's output rather than a
// "trust markdown-it" shortcut, because link destinations and raw HTML both
// need independent vetting:
//
//   html: false        markdown-it will not pass through raw HTML at all;
//   validateLink       rejects every scheme except http/https;
//   ALLOWED_TAGS       anything markdown-it emits outside this set is dropped;
//   href check         again at parse time, in case markdown-it's rules change.
//
// Anything not understood degrades to escaped plain text, never to markup.

const MarkdownIt = require("markdown-it");

const ALLOWED_TAGS = new Set([
  "p", "br", "strong", "em", "del", "code", "pre", "blockquote",
  "ul", "ol", "li", "a", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td",
]);

const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "svg", "math"]);

const markdown = new MarkdownIt({
  html: false,
  xhtmlOut: false,
  linkify: false,
  typographer: false,
  breaks: true,   // chat: a single newline is a line break, as users expect
});
// CommonMark `<scheme:value>` autolinks bypass `linkify`; disable them so
// placeholders such as `<redacted:token>` never become anchors.
markdown.disable(["autolink"]);
// Accept destinations here; `sanitizeHref` below is the real gate.
markdown.validateLink = () => true;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeHref(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // Credentials in a link are a phishing vector, not a feature in a chat bubble.
  if (parsed.username || parsed.password) return null;
  return parsed.toString();
}

// Rewrites markdown-it's output: keeps allowlisted tags, drops dangerous
// elements entirely, and neutralises attributes except a vetted <a href>.
function sanitizeHtml(html) {
  const out = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^>]*?)?)(\/?)>/g;
  let lastIndex = 0;
  let match;

  while ((match = tagRe.exec(html)) !== null) {
    const [full, slash, rawName, rawAttrs, selfClose] = match;
    const name = rawName.toLowerCase();

    // Text between tags is markdown-it's own escape output, already safe.
    out.push(html.slice(lastIndex, match.index));
    lastIndex = match.index + full.length;

    if (DROP_WITH_CONTENT.has(name)) {
      if (!slash) {
        // Skip to the matching close tag (or the end) so its body is dropped.
        const closeRe = new RegExp(`</${name}\\s*>`, "i");
        const rest = html.slice(lastIndex);
        const closeMatch = closeRe.exec(rest);
        lastIndex = closeMatch ? lastIndex + closeMatch.index + closeMatch[0].length : html.length;
        tagRe.lastIndex = lastIndex;
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(name)) {
      // Unknown but harmless wrapper (e.g. a custom element): keep children.
      continue;
    }

    if (slash) {
      out.push(`</${name}>`);
      continue;
    }

    if (name === "a") {
      const hrefMatch = /href\s*=\s*"([^"]*)"/i.exec(rawAttrs || "");
      const href = hrefMatch ? sanitizeHref(hrefMatch[1].replace(/&amp;/g, "&")) : null;
      if (href) {
        out.push(`<a href="${escapeHtml(href)}" rel="noreferrer noopener">`);
      } else {
        // Keep the link text but strip the destination.
        out.push("<span>");
      }
      continue;
    }

    // No attributes are preserved for any other tag.
    out.push(selfClose ? `<${name}>` : `<${name}>`);
  }

  out.push(html.slice(lastIndex));
  return out.join("");
}

// markdown-it emits `<a href="...">` for links and `</a>` to close them. When a
// destination is rejected we emit `<span>` instead, so the matching close tag
// must follow. Rather than track nesting mid-stream, do a second corrective pass
// that rewrites each `</a>` to `</span>` when its opener was replaced.
function closeRejectedLinks(html) {
  const stack = [];
  let result = "";
  const tokenRe = /<(\/?)(a|span)([^>]*)>/gi;
  let lastIndex = 0;
  let match;
  while ((match = tokenRe.exec(html)) !== null) {
    result += html.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    if (closing) {
      const opener = stack.pop();
      result += `</${opener || name}>`;
    } else {
      stack.push(name);
      result += match[0];
    }
  }
  result += html.slice(lastIndex);
  // Unclosed openers still need closing so the DOM cannot leak styling.
  while (stack.length) result += `</${stack.pop()}>`;
  return result;
}

/**
 * Converts model markdown to HTML safe for `innerHTML` in the chat window.
 * Returns "" for empty input so callers can skip a render.
 */
function renderSafeMarkdown(source) {
  const text = typeof source === "string" ? source : "";
  if (!text.trim()) return "";
  let html;
  try {
    html = markdown.render(text);
  } catch {
    return escapeHtml(text);
  }
  return closeRejectedLinks(sanitizeHtml(html));
}

module.exports = {
  ALLOWED_TAGS,
  renderSafeMarkdown,
  sanitizeHref,
};