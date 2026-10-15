// Regression tests for the grill pass: one home per rule, verified fixes.
//
//   - Avatar allowlist lives in character_card.js (isSafeAvatarUrl); every UI
//     call site renders through it instead of its own startsWith check.
//   - clipLedgerToTokens shrinks geometrically (no quadratic tail loop).
//   - estimateTokens stays correct under cache pressure (entry + byte bound).
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isSafeAvatarUrl, cardAvatarUrl, avatarInnerHtml } from "../public/ui/character_card.js";
import { clipLedgerToTokens, estimateTokens } from "../public/context_plan.js";

const PUBLIC = path.join(import.meta.dir, "..", "public");

describe("avatar allowlist has one home", () => {
  test("isSafeAvatarUrl accepts image portraits, rejects everything else", () => {
    expect(isSafeAvatarUrl("data:image/png;base64,AAA")).toBe(true);
    expect(isSafeAvatarUrl("DATA:IMAGE/JPEG;BASE64,AAA")).toBe(true);
    expect(isSafeAvatarUrl("https://example.com/a.png")).toBe(true);
    expect(isSafeAvatarUrl("http://example.com/a.png")).toBe(true);
    expect(isSafeAvatarUrl("  https://example.com/a.png  ")).toBe(true);
    expect(isSafeAvatarUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeAvatarUrl("data:application/javascript,alert(1)")).toBe(false);
    expect(isSafeAvatarUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeAvatarUrl("blob:https://example.com/x")).toBe(false);
    expect(isSafeAvatarUrl("/relative/path.png")).toBe(false);
    expect(isSafeAvatarUrl("httpfoo://example.com")).toBe(false);
    expect(isSafeAvatarUrl("")).toBe(false);
    expect(isSafeAvatarUrl(null)).toBe(false);
  });

  test("cardAvatarUrl and avatarInnerHtml enforce the same allowlist", () => {
    const evil = { data: { avatar: "data:text/html,<script>alert(1)</script>" } };
    expect(cardAvatarUrl(evil)).toBe("");
    expect(avatarInnerHtml("data:text/html,x", "E")).toBe("E");
    expect(avatarInnerHtml("javascript:alert(1)", "E")).toBe("E");
    expect(avatarInnerHtml("https://example.com/a.png", "E")).toContain("<img");
  });

  test("no UI module keeps its own startsWith avatar gate", () => {
    // The drift this fixes: five call sites each re-implemented the check
    // with a broader predicate (any data: scheme, any http prefix).
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".js")) continue;
        const text = fs.readFileSync(full, "utf8");
        if (/startsWith\("data:"\)/.test(text) && !/stream|sse|event/i.test(text)) {
          // browser_engine.js matches on SSE "data:" framing, not avatars.
          if (!full.endsWith("browser_engine.js")) offenders.push(path.relative(PUBLIC, full));
        }
      }
    };
    walk(path.join(PUBLIC, "ui"));
    expect(offenders).toEqual([]);
  });
});

describe("clipLedgerToTokens geometric shrink", () => {
  test("a huge ledger against a tiny limit finishes fast and stays bounded", () => {
    const big = "X".repeat(200000);
    const started = Date.now();
    const out = clipLedgerToTokens(big, 128);
    expect(estimateTokens(out)).toBeLessThanOrEqual(128);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("estimateTokens under cache pressure", () => {
  test("stays correct past the entry ceiling", () => {
    const first = "alpha ".repeat(100);
    const firstTokens = estimateTokens(first);
    for (let i = 0; i < 6000; i += 1) estimateTokens(`unique-string-${i} ` + "x".repeat(50));
    // Evicted entries recompute to the same value; nothing throws.
    expect(estimateTokens(first)).toBe(firstTokens);
    expect(estimateTokens("")).toBe(0);
  });
});
