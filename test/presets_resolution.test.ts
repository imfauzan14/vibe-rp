import { describe, test, expect } from "bun:test";
import { BrowserChatEngine } from "../public/browser_engine.js";
import { DEFAULT_SETTINGS } from "../public/local_db.js";

describe("User Personas & Directives Presets Resolution", () => {
  const defaultContract = "# AGENTS.md — Author's Craft Directive\nSensory grounding.";
  const grimdarkContract = "# AGENTS.md — Grimdark Action\nVisceral blood, mud, and steel.";

  const globalDefaultPersona = {
    id: "persona_default",
    name: "Author",
    description: "The primary observer and author.",
    isDefault: true,
  };

  const customPersona = {
    id: "persona_vance",
    name: "Valen Vance",
    description: "A disgraced royal archivist broker.",
    isDefault: false,
  };

  const mockCardNoOverrides = {
    id: "card_1",
    name: "Aria",
    description: "A stoic wandering swordswoman.",
  };

  const mockCardWithOverrides = {
    id: "card_2",
    name: "Kestrel",
    description: "A desert drifter.",
    userPersonaId: "persona_vance",
    directivePresetId: "directive_grimdark",
  };

  test("1. Block 0 formats system prompt with global default persona and contract fallback", () => {
    const prompt = BrowserChatEngine.formatSystemPrompt(
      mockCardNoOverrides,
      globalDefaultPersona,
      { agentsContract: defaultContract }
    );

    expect(prompt).toContain(defaultContract);
    expect(prompt).toContain("CHARACTER IN SCENE: Aria");
    expect(prompt).toContain("[User Persona: Author]");
    expect(prompt).toContain("The primary observer and author.");
  });

  test("2. Block 0 formats system prompt with overridden persona and custom directive contract", () => {
    const prompt = BrowserChatEngine.formatSystemPrompt(
      mockCardWithOverrides,
      customPersona,
      { agentsContract: grimdarkContract }
    );

    expect(prompt).toContain("Visceral blood, mud, and steel.");
    expect(prompt).not.toContain("Sensory grounding.");
    expect(prompt).toContain("CHARACTER IN SCENE: Kestrel");
    expect(prompt).toContain("[User Persona: Valen Vance]");
    expect(prompt).toContain("A disgraced royal archivist broker.");
  });

  test("3. assembleMessages keeps custom directive and persona in Block 0 prefix", () => {
    const prompt = BrowserChatEngine.formatSystemPrompt(
      mockCardWithOverrides,
      customPersona,
      { agentsContract: grimdarkContract }
    );

    const messages = [
      { role: "assistant", content: "The dust storm approaches." },
      { role: "user", content: "Hold the line." }
    ];

    const payload = BrowserChatEngine.assembleMessages(prompt, messages, "Strike now!", "");

    expect(payload[0].role).toBe("system");
    expect(payload[0].content).toContain("Visceral blood, mud, and steel.");
    expect(payload[0].content).toContain("[User Persona: Valen Vance]");
    expect(payload[payload.length - 1].content).toBe("Strike now!");
  });
});

describe("Default Generation Parameters", () => {
  test("DEFAULT_SETTINGS matches the optimized modern-chat-model defaults", () => {
    expect(DEFAULT_SETTINGS.temperature).toBe(0.95);
    expect(DEFAULT_SETTINGS.topP).toBe(1); // >=1 so buildRequestBody omits top_p
    expect(DEFAULT_SETTINGS.minP).toBe(0); // <=0 so buildRequestBody omits min_p
    expect(DEFAULT_SETTINGS.frequencyPenalty).toBe(0); // not sent
    expect(DEFAULT_SETTINGS.presencePenalty).toBe(0); // not sent
    expect(DEFAULT_SETTINGS.maxTokens).toBe(1200);
    expect(DEFAULT_SETTINGS.maxContextTokens).toBe(65536);
    expect(DEFAULT_SETTINGS.choiceMode).toBe("normal");
    expect(DEFAULT_SETTINGS.choiceModel).toBe("");
    expect(DEFAULT_SETTINGS).not.toHaveProperty("cacheKey");
  });

  test("default buildRequestBody omits neutral samplers and sends only temperature + max_tokens", () => {
    const body = BrowserChatEngine.buildRequestBody(DEFAULT_SETTINGS, [
      { role: "user", content: "hi" },
    ]);
    expect(body.temperature).toBe(0.95);
    expect(body.max_tokens).toBe(1200);
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("min_p");
    expect(body).not.toHaveProperty("frequency_penalty");
    expect(body).not.toHaveProperty("presence_penalty");
  });

  test("resolveBudgets with new defaults keeps prompt budget above 50% of the window", () => {
    const b = BrowserChatEngine.resolveBudgets(DEFAULT_SETTINGS);
    expect(b.reservedOutput).toBe(1200);
    // 65536 - 1200 - floor(8% of 64336) = 59190
    expect(b.promptBudget).toBeGreaterThan(b.contextWindow * 0.5);
  });

  test("resolveBudgets at 32k window: maxTokens 1200 does not starve the prompt", () => {
    const b = BrowserChatEngine.resolveBudgets({ ...DEFAULT_SETTINGS, maxContextTokens: 32768 });
    expect(b.reservedOutput).toBe(1200); // the user's ceiling, not a half-window cap
    // 32768 - 1200 - floor(2% of 32768) = 30913; the adaptive margin is now
    // sub-linear (bounded at 4096) instead of 8% of the window.
    expect(b.promptBudget).toBe(30913);
    expect(b.promptBudget).toBeGreaterThan(32768 * 0.5);
  });
});

describe("Empty & Simple System Prompts, Personas, and Cards Contract", () => {
  test("formatSystemPrompt with empty contract and empty persona outputs only character section", () => {
    const card = { data: { name: "Aria", description: "A wandering knight." } };
    const prompt = BrowserChatEngine.formatSystemPrompt(card, null, { agentsContract: "" });
    expect(prompt).toContain("### CHARACTER IN SCENE: Aria");
    expect(prompt).toContain("[Description: A wandering knight.]");
    expect(prompt).not.toContain("[User Persona");
    expect(prompt).not.toContain("Operational Precedence:");
    expect(prompt).not.toContain("Epistemic Boundary");
  });

  test("formatSystemPrompt with simple name-only persona has no trailing dangling newline", () => {
    const card = { data: { name: "Aria" } };
    const prompt = BrowserChatEngine.formatSystemPrompt(card, { name: "Rowan" }, { agentsContract: "" });
    expect(prompt).toContain("[User Persona: Rowan]");
    expect(prompt).not.toMatch(/\[User Persona: Rowan\]\n(?!\n)/); // No single trailing newline before next block
    expect(prompt).toContain("Operational Precedence:");
    expect(prompt).toContain("Epistemic Boundary");
  });

  test("formatSystemPrompt with description-only persona defaults name to User and preserves description", () => {
    const card = { data: { name: "Aria" } };
    const prompt = BrowserChatEngine.formatSystemPrompt(card, { description: "A tired cartographer." }, { agentsContract: "" });
    expect(prompt).toContain("[User Persona: User]\nA tired cartographer.");
    expect(prompt).toContain("Operational Precedence:");
  });

  test("formatSystemPrompt with whitespace persona omits persona section completely", () => {
    const card = { data: { name: "Aria" } };
    const prompt = BrowserChatEngine.formatSystemPrompt(card, { name: "   ", description: "" }, { agentsContract: "" });
    expect(prompt).not.toContain("[User Persona");
    expect(prompt).not.toContain("Operational Precedence");
  });

  test("formatSystemPrompt with minimal contract and null persona includes contract and operational boundaries", () => {
    const card = { data: { name: "Aria" } };
    const prompt = BrowserChatEngine.formatSystemPrompt(card, null, { agentsContract: "Speak in short sentences." });
    expect(prompt).toContain("Speak in short sentences.");
    expect(prompt).toContain("### CHARACTER IN SCENE: Aria");
    expect(prompt).not.toContain("[User Persona");
    expect(prompt).toContain("Operational Precedence:");
  });

  test("formatSystemPrompt with null card and null persona falls back to default character", () => {
    const prompt = BrowserChatEngine.formatSystemPrompt(null, null, { agentsContract: "" });
    expect(prompt).toBe("### CHARACTER IN SCENE: Character");
  });

  test("assembleMessages omits empty system message when system prompt is empty or whitespace", () => {
    const messages = [{ role: "user", content: "Hello!" }];
    const payloadEmpty = BrowserChatEngine.assembleMessages("", messages, "", "");
    expect(payloadEmpty).toHaveLength(1);
    expect(payloadEmpty[0].role).toBe("user");
    expect(payloadEmpty[0].content).toBe("Hello!");

    const payloadWhitespace = BrowserChatEngine.assembleMessages("   \n  ", messages, "", "");
    expect(payloadWhitespace).toHaveLength(1);
    expect(payloadWhitespace[0].role).toBe("user");
  });

  test("assembleMessages keeps non-empty system prompt as head", () => {
    const messages = [{ role: "user", content: "Hello!" }];
    const payload = BrowserChatEngine.assembleMessages("Direct system prompt.", messages, "", "");
    expect(payload).toHaveLength(2);
    expect(payload[0].role).toBe("system");
    expect(payload[0].content).toBe("Direct system prompt.");
  });

  test("planRequest with null persona and empty contract does not synthesize [User Persona: You]", () => {
    const plan = BrowserChatEngine.planRequest({
      card: { data: { name: "Elena" } },
      session: { messages: [{ role: "user", content: "Hi" }] },
      settings: { maxContextTokens: 8192, maxTokens: 500 },
      persona: null,
      agentsContract: "",
    });
    expect(plan.systemPrompt).not.toContain("[User Persona");
    expect(plan.systemPrompt).not.toContain("Operational Precedence");
    expect(plan.breakdown.persona).toBe(0);
    expect(plan.payload[0].role).toBe("system");
    expect(plan.payload[0].content).toBe("### CHARACTER IN SCENE: Elena");
    expect(plan.impossible).toBe(false);
  });

  test("planChoiceRequest with null persona and empty contract provides clean defaults", () => {
    const req = BrowserChatEngine.planChoiceRequest({
      card: { data: { name: "Elena" } },
      session: { messages: [{ role: "user", content: "Hi" }] },
      settings: { maxContextTokens: 8192, maxTokens: 500, agentsContract: "" },
      persona: null,
      count: 3,
    });
    const system = req.payload[0].content;
    expect(system).toContain("Scene Context: Elena opposite the protagonist.");
    expect(system).not.toContain("\nUser Persona (");
    expect(system).not.toContain("System & Craft Directives");
    expect(req.payload.at(-1)?.content).toContain("[the protagonist]");
  });

  test("planChoiceRequest with nameless persona description includes description under the protagonist", () => {
    const req = BrowserChatEngine.planChoiceRequest({
      card: { data: { name: "Elena" } },
      session: { messages: [{ role: "user", content: "Hi" }] },
      settings: { maxContextTokens: 8192, maxTokens: 500 },
      persona: { description: "An apprentice healer." },
      count: 3,
    });
    const system = req.payload[0].content;
    expect(system).toContain("Scene Context: Elena opposite the protagonist.");
    expect(system).toContain("User Persona (the protagonist): An apprentice healer.");
  });
});
