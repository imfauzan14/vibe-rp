import { describe, test, expect } from "bun:test";
import { BrowserChatEngine } from "../public/browser_engine.js";

describe("TDD - Seam Tests for Robust Cost-Saving & Engine Stability", () => {
  test("Seam 1: planContext warns or handles oversized system prompt gracefully", () => {
    // Huge system prompt that exceeds the calculated prompt budget
    const hugeSystemPrompt = "System directive. ".repeat(600); // ~1800-2400 tokens
    const messages = [
      { role: "assistant", content: "Opening line." },
      { role: "user", content: "Hello." },
      { role: "assistant", content: "Response." },
    ];
    const settings = { maxContextTokens: 2048, maxTokens: 512 };
    const plan = BrowserChatEngine.planContext({
      systemPrompt: hugeSystemPrompt,
      messages,
      ledger: "",
      consumed: 1,
      settings,
    });

    expect(plan).toBeDefined();
    expect(plan.overflow).toBe(true);
    expect(typeof plan.overflowWarning).toBe("string");
  });

  test("Seam 2: streamDirect includes stream_options with include_usage for cache accounting", () => {
    const settings = {
      apiEndpoint: "https://api.example.com/v1",
      model: "test-model",
    };
    const body = BrowserChatEngine.buildRequestBody(settings, [{ role: "user", content: "hi" }]);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toBeDefined();
    expect(body.stream_options.include_usage).toBe(true);
  });

  test("Seam 3: planContext caps fallback ledger so it cannot cause endless prompt overflow", () => {
    const hugeLedger = "Extracted facts. ".repeat(500); // ~1500 tokens
    const messages = [
      { role: "assistant", content: "Initial greeting." },
      { role: "user", content: "Turn 1" },
      { role: "assistant", content: "Turn 2" },
      { role: "user", content: "Turn 3" },
    ];
    const settings = { maxContextTokens: 4096, maxTokens: 1000 };
    const plan = BrowserChatEngine.planContext({
      systemPrompt: "Base prompt.",
      messages,
      ledger: hugeLedger,
      consumed: 1,
      settings,
    });

    expect(plan.budget).toBeGreaterThanOrEqual(256);
  });
});
