"use strict";

// Static guard against a whole class of runtime breakage in main.js:
// an identifier that is *called* but never bound anywhere in the module.
//
// Why this exists: while cleaning up dead destructured bindings, a symbol
// (`detectRunningAgentProcesses`) was removed from a `const { … } = _state`
// line while a live call site remained — inside a `setTimeout(…, 5000)`. The
// module loaded fine, so `npm start` looked healthy, and the app crashed five
// seconds later with "ReferenceError: detectRunningAgentProcesses is not
// defined". `node --check` cannot see this: it is a scope error, not a syntax
// error.
//
// This is a heuristic scanner, not a JS parser. It is deliberately biased
// toward zero false positives: it strips comments/strings, collects bindings
// from declarations, destructuring patterns and parameters, then reports call
// sites whose identifier appears in none of them. Anything it flags is either a
// real bug or a pattern this file does not yet understand — both worth looking
// at.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const MAIN_PATH = path.join(__dirname, "..", "src", "main.js");

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "typeof", "new",
  "delete", "void", "in", "of", "instanceof", "do", "else", "try", "finally",
  "throw", "with", "yield", "await", "async", "case", "default", "break",
  "continue", "var", "let", "const", "class", "extends", "super", "this", "get", "set",
]);

const GLOBALS = new Set([
  "require", "module", "exports", "__dirname", "__filename", "process", "console",
  "global", "globalThis", "Buffer", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "setImmediate", "clearImmediate", "Promise", "Object", "Array",
  "String", "Number", "Boolean", "Symbol", "Map", "Set", "WeakMap", "WeakSet",
  "JSON", "Math", "Date", "RegExp", "Error", "TypeError", "RangeError",
  "SyntaxError", "ReferenceError", "Function", "Proxy", "Reflect", "Intl", "URL",
  "URLSearchParams", "TextEncoder", "TextDecoder", "AbortController", "fetch",
  "structuredClone", "queueMicrotask", "performance", "atob", "btoa",
  "encodeURIComponent", "decodeURIComponent", "parseInt", "parseFloat", "isNaN",
  "isFinite", "undefined", "NaN", "Infinity",
  // Browser globals, present in the renderer preload/window documents.
  "requestAnimationFrame", "cancelAnimationFrame", "DOMParser", "Node", "Element",
  "document", "window", "navigator", "location", "CustomEvent", "Event", "getComputedStyle",
]);

// Blank out comments and string/template bodies while preserving offsets, so
// prose words inside comments never look like call sites.
function stripNoise(text) {
  const out = text.split("");
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") { out[i] = " "; i += 1; }
      continue;
    }
    if (c === "/" && d === "*") {
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] !== "\n") out[i] = " ";
        i += 1;
      }
      out[i] = " "; out[i + 1] = " "; i += 2;
      continue;
    }
    // Regular-expression literals: a `/` right after an operator or opening
    // bracket starts a regex, and any quotes inside it must not be read as
    // string delimiters. Without this, `/href\s*=\s*"([^"]*)"/` swallowed the
    // rest of the file.
    if (c === "/" && (i === 0 || /[=(,:;[!&|?{}+\-*%<>~^]$/.test(text.slice(0, i).replace(/\s+$/, "").slice(-1)))) {
      out[i] = " "; i += 1;
      let inClass = false;
      while (i < n) {
        const rc = text[i];
        if (rc === "\\") { out[i] = " "; i += 1; if (i < n) { out[i] = " "; i += 1; } continue; }
        if (rc === "[") inClass = true;
        else if (rc === "]") inClass = false;
        else if (rc === "/" && !inClass) { out[i] = " "; i += 1; break; }
        else if (rc === "\n") break;
        out[i] = " "; i += 1;
      }
      // Consume trailing flags.
      while (i < n && /[a-z]/i.test(text[i])) { out[i] = " "; i += 1; }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out[i] = " "; i += 1;
      while (i < n && text[i] !== quote) {
        if (text[i] === "\\") { out[i] = " "; i += 1; }
        if (i < n) { if (text[i] !== "\n") out[i] = " "; i += 1; }
      }
      if (i < n) { out[i] = " "; i += 1; }
      continue;
    }
    i += 1;
  }
  return out.join("");
}

function collectBindings(src) {
  const declared = new Set();

  for (const re of [
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g,
  ]) {
    let m;
    while ((m = re.exec(src))) declared.add(m[1]);
  }

  // Destructuring: read the brace body with depth tracking so nested patterns
  // do not truncate the binding list.
  {
    const re = /\b(?:const|let|var)\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length - 1;
      let depth = 0;
      let body = "";
      for (; i < src.length; i += 1) {
        const c = src[i];
        if (c === "{") depth += 1;
        else if (c === "}") { depth -= 1; if (depth === 0) break; }
        if (depth >= 1) body += c;
      }
      const inner = body.slice(1);
      let d2 = 0;
      let part = "";
      const parts = [];
      for (const c of inner) {
        if ("{[(".includes(c)) d2 += 1;
        else if ("}])".includes(c)) d2 -= 1;
        if (c === "," && d2 === 0) { parts.push(part); part = ""; } else part += c;
      }
      if (part.trim()) parts.push(part);
      for (const raw of parts) {
        const t = raw.trim();
        if (!t) continue;
        const candidate = t.includes(":")
          ? t.slice(t.indexOf(":") + 1).trim().split("=")[0].trim()
          : t.split("=")[0].trim();
        const name = candidate.replace(/^\.\.\./, "");
        if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
      }
    }
  }

  // Parameters of functions and arrows.
  {
    const re = /\(([^()]*)\)\s*(?:=>|\{)/g;
    let m;
    while ((m = re.exec(src))) {
      for (const p of m[1].split(",")) {
        const t = p.trim();
        if (!t) continue;
        const raw = t.includes(":") ? t.slice(t.indexOf(":") + 1).trim() : t;
        const name = raw.split("=")[0].trim().replace(/^\.\.\./, "");
        if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
      }
    }
    const re2 = /\b([A-Za-z_$][\w$]*)\s*=>/g;
    while ((m = re2.exec(src))) declared.add(m[1]);
  }

  return declared;
}

function findUndeclaredCalls(source) {
  const src = stripNoise(source);
  const declared = collectBindings(src);
  const lines = src.split("\n");
  const findings = [];
  for (let ln = 0; ln < lines.length; ln += 1) {
    const line = lines[ln];
    const re = /(^|[^.\w$?"'])([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(line))) {
      const name = m[2];
      if (KEYWORDS.has(name) || GLOBALS.has(name) || declared.has(name)) continue;
      // Object-literal accessors and method shorthand.
      if (/^\s*(?:get|set)\s+[A-Za-z_$][\w$]*\s*\(/.test(line)) continue;
      if (/^\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/.test(line)) continue;
      findings.push({ name, line: ln + 1 });
    }
  }
  return findings;
}

describe("main.js scope integrity", () => {
  const source = fs.readFileSync(MAIN_PATH, "utf8");

  it("never calls an identifier that is not declared anywhere", () => {
    const findings = findUndeclaredCalls(source);
    const detail = findings.map((f) => `${f.name} (line ${f.line})`).join("\n");
    assert.deepStrictEqual(findings, [], `undeclared call targets:\n${detail}`);
  });

  // Proves the scanner is not vacuously passing: a binding removed from a
  // destructuring statement while its call site survives must be reported.
  it("detects a binding removed from destructuring while its call site remains", () => {
    const broken = [
      "function setup(state, done) {",
      "  const { startThing } = state;",
      "  setTimeout(() => {",
      "    stopThing(() => done());",
      "  }, 5000);",
      "}",
    ].join("\n");
    const findings = findUndeclaredCalls(broken);
    assert.ok(
      findings.some((f) => f.name === "stopThing"),
      "scanner must report stopThing as undeclared"
    );
    // `startThing` is bound but never called: it must NOT be reported.
    assert.ok(!findings.some((f) => f.name === "startThing"));
  });
});