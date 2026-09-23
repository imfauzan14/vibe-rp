import { describe, test, expect } from "bun:test";
import { BrowserChatEngine } from "../public/browser_engine.js";

describe("BrowserChatEngine public interface", () => {
  // The narrowed contract: orchestration entry + externally-consumed planners.
  const PUBLIC_STATICS = [
    "streamTurn",
    "formatSystemPrompt",
    "planContext",
    "planRequest",
    "describeRequest",
    "planChoiceRequest",
    "generateChoices",
    "assembleMessages",
    "resolveBudgets",
    "buildRequestBody",
    "fetchAvailableModels",
  ];

  test("public statics are exactly the keep-list", () => {
    const publics = Object.getOwnPropertyNames(BrowserChatEngine).filter(
      (name) => name !== "prototype" && name !== "length" && name !== "name"
    );
    expect(publics.sort()).toEqual([...PUBLIC_STATICS].sort());
  });

  test("formatSystemPrompt includes contract and character name", () => {
    const prompt = BrowserChatEngine.formatSystemPrompt(
      { data: { name: "Aria" } },
      { name: "Rowan" },
      { agentsContract: "SENSORY GROUNDING: anchor every scene." }
    );
    expect(prompt).toContain("SENSORY GROUNDING: anchor every scene.");
    expect(prompt).toContain("CHARACTER IN SCENE: Aria");
  });

  test("planContext returns a plan with history and consumed fields", () => {
    const plan = BrowserChatEngine.planContext({
      systemPrompt: "Base prompt.",
      messages: [
        { role: "assistant", content: "Opening line." },
        { role: "user", content: "Hello." },
      ],
      ledger: "",
      consumed: 1,
      settings: { maxContextTokens: 2048, maxTokens: 512 },
    });
    expect(Array.isArray(plan.history)).toBe(true);
    expect(typeof plan.consumedAfter).toBe("number");
  });

  test("assembleMessages keeps the system prompt as payload head", () => {
    const payload = BrowserChatEngine.assembleMessages("System head.", [{ role: "user", content: "hi" }], "", "");
    expect(payload[0].role).toBe("system");
    expect(payload[0].content).toBe("System head.");
  });

  test("resolveBudgets clamps configured budgets", () => {
    const budgets = BrowserChatEngine.resolveBudgets({ maxContextTokens: 2048, maxTokens: 512 });
    expect(typeof budgets.promptBudget).toBe("number");
    expect(budgets.promptBudget).toBeGreaterThan(0);
  });

  test("buildRequestBody requests streaming with usage accounting", () => {
    const body = BrowserChatEngine.buildRequestBody({ model: "m" }, [{ role: "user", content: "hi" }]);
    expect(body.stream).toBe(true);
    expect(body.stream_options.include_usage).toBe(true);
  });

  test("streamTurn and fetchAvailableModels exist as functions", () => {
    expect(typeof BrowserChatEngine.streamTurn).toBe("function");
    expect(typeof BrowserChatEngine.fetchAvailableModels).toBe("function");
  });

  test("library_page imports BrowserChatEngine for model fetching", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const code = fs.readFileSync(path.join(import.meta.dir, "..", "public", "ui", "library_page.js"), "utf8");
    expect(code).toMatch(/import\s+\{[^}]*BrowserChatEngine[^}]*\}\s+from\s+["']\.\.\/browser_engine\.js["']/);
  });
});
