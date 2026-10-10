// Drift guard for the CSP script policy.
//
// History: chat.html used to carry its entire bootstrap as an inline
// <script type="module"> block, pinned by a SHA-256 hash in script-src. The
// hash silently drifted from the served bytes (whitespace and line-ending
// churn) and the browser blocked the block, killing the whole chat app with
// no visible error. The block now lives in ui/chat/chat_boot.js and is loaded
// with <script src>, so script-src is 'self' only and there is no hash to
// drift.
//
// These tests make that failure mode impossible to reintroduce:
//   1. No public HTML file may contain an inline <script> (no `src`).
//   2. Neither CSP may carry a sha256- source, and the two CSP strings must
//      be byte-identical so serve.js and vercel.json cannot drift apart.
//   3. No runtime source emits a `<script` tag literal, so no code path can
//      assemble a document carrying an inline script — whether through
//      document.write, srcdoc, innerHTML/insertAdjacentHTML, a template
//      string, or a text/html Blob, each of which would need that literal.
//      A console report once showed an inline script blocked inside a
//      UUID-named document; a static HTML scan cannot see a document that is
//      only assembled at runtime, so this guard scans the code that would
//      build one.
//   4. No runtime source builds a document script-src cannot govern (a
//      text/html Blob, an iframe srcdoc, document.write, createHTMLDocument).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PUBLIC = join(ROOT, "public");

function htmlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(full));
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

// Runtime sources that could synthesise a document: the Bun server and every
// client-side module. The entry HTML is covered by the test above.
function jsSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsSources(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const SOURCES = [join(ROOT, "serve.js"), ...jsSources(PUBLIC)];

// Comment lines are prose, not emissions: serve.js documents the `<script>`
// rule in a comment, so the scan below must ignore comment lines.
//
// Line-numbered matches, so a failure names the exact site.
function findInSources(pattern: RegExp): string[] {
  const out: string[] = [];
  for (const file of SOURCES) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      if (!/^\s*(\/\/|\/\*|\*)/.test(line) && pattern.test(line)) {
        out.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  return out;
}

// serve.js builds its CSP by joining an array of directive strings.
const serveCspArray = readFileSync(join(ROOT, "serve.js"), "utf8").match(
  /["']Content-Security-Policy["']\s*:\s*\[([\s\S]*?)\]\.join\(/,
);
const cspFromServe = [...(serveCspArray?.[1] ?? "").matchAll(/"([^"]*)"/g)]
  .map((m) => m[1])
  .join("; ");

// vercel.json mirrors it as one flat header string.
const vercelHeaders = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")).headers;
const cspFromVercel =
  vercelHeaders
    .flatMap((h: { headers: { key: string; value: string }[] }) => h.headers)
    .find((h: { key: string }) => h.key === "Content-Security-Policy")?.value ?? "";

describe("CSP script policy", () => {
  test("no public HTML file contains an inline <script>", () => {
    const files = htmlFiles(PUBLIC);
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const html = readFileSync(file, "utf8");
      for (const [, attrs] of html.matchAll(/<script\b([^>]*)>/gi)) {
        if (!/\bsrc\s*=/i.test(attrs)) offenders.push(`${file.slice(ROOT.length + 1)}: <script${attrs}>`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no sha256- source remains in either CSP", () => {
    expect(cspFromServe).not.toContain("sha256-");
    expect(cspFromVercel).not.toContain("sha256-");
  });

  test("serve.js and vercel.json CSP strings are byte-identical", () => {
    expect(cspFromServe).toBe(cspFromVercel);
  });

  test("script-src is 'self' only", () => {
    expect(cspFromServe).toContain("script-src 'self'");
  });

  test("no runtime source emits an inline <script> tag string", () => {
    expect(SOURCES.length).toBeGreaterThan(10);
    // A runtime document can only carry an inline script if some source
    // assembles it from this literal. There is no legitimate use in the app.
    expect(findInSources(/<script/i)).toEqual([]);
  });

  test("no runtime source builds a document script-src cannot govern", () => {
    const sinks: [string, RegExp][] = [
      ["document.write", /document\s*\.\s*write(?:ln)?\s*\(/],
      ["iframe srcdoc", /\.\s*srcdoc\s*=/],
      ["createHTMLDocument", /createHTMLDocument\s*\(/],
      ["text/html Blob", /type\s*:\s*["']text\/html["']/],
    ];
    const offenders = sinks.flatMap(([name, re]) =>
      findInSources(re).map((hit) => `${name} -> ${hit}`),
    );
    expect(offenders).toEqual([]);
  });
});
