import { describe, test, expect } from "bun:test";
import {
  validateChoiceJson,
  checkRepetition,
  checkLanguage,
  checkLedgerCompliance,
} from "../eval/metrics.js";
import {
  planChoiceRequest,
  stripThoughtBlocks,
} from "../public/browser_engine.js";

describe("Prompt Evaluation Harness - Metrics & Assertions", () => {
  test("validateChoiceJson accepts well-formed 4-choice JSON payloads", () => {
    const validJson = JSON.stringify({
      choices: [
        { label: "Maju perlahan", text: "Melangkah maju perlahan sambil mengawasi setiap pergerakannya di balik meja." },
        { label: "Tanyakan alasan", text: "'Kenapa kamu baru memberitahuku sekarang setelah semua ini terjadi?'" },
        { label: "Tarik napas", text: "Menarik napas dalam-dalam, menahan emosi yang mulai memuncak." },
        { label: "Balikkan badan", text: "Membalikkan badan dan bersiap meninggalkan ruangan tanpa berkata apa-apa." },
      ],
    });

    const result = validateChoiceJson(validJson);
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.choices.length).toBe(4);
  });

  test("validateChoiceJson rejects payloads with fewer than 3 choices", () => {
    const insufficientJson = JSON.stringify({
      choices: [
        { label: "Action 1", text: "Take the keys." },
        { label: "Action 2", text: "Walk away." },
      ],
    });

    const result = validateChoiceJson(insufficientJson);
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reason).toContain("Expected 3 to 5 choices");
  });

  test("validateChoiceJson flags choices exceeding character limits", () => {
    const oversizedJson = JSON.stringify({
      choices: [
        { label: "Action 1", text: "a".repeat(170) },
        { label: "Action 2", text: "Valid short action." },
        { label: "Action 3", text: "Another valid short action." },
      ],
    });

    const result = validateChoiceJson(oversizedJson);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("exceeds 160 chars");
  });

  test("checkRepetition detects and penalizes echoing the previous character turn", () => {
    const previousTurn = "Detective Vance slammed both palms onto the scarred metal table, leaning forward into the shadows.";
    
    // Echoing response: repeats many words directly from the previous turn
    const echoingChoices = JSON.stringify({
      choices: [
        { label: "Slam palms", text: "Slam palms onto the scarred metal table leaning forward into the shadows." },
        { label: "Detective Vance", text: "Ask Detective Vance about the scarred metal table in the shadows." },
        { label: "The shadows", text: "Watch Detective Vance leaning forward onto the metal table." },
      ],
    });

    const echoResult = checkRepetition(echoingChoices, previousTurn);
    expect(echoResult.pass).toBe(false);
    expect(echoResult.named_scores.overlapRatio).toBeGreaterThan(0.35);

    // Fresh, non-repetitive response with asymmetric beats
    const dynamicChoices = JSON.stringify({
      choices: [
        { label: "Maintain eye contact", text: "Remain motionless in the wooden chair, keeping chin elevated." },
        { label: "Demand representation", text: "'I want my legal counsel in this interrogation room immediately.'" },
        { label: "Point to timestamp", text: "Slide the printed transit receipt across the cold surface." },
      ],
    });

    const dynamicResult = checkRepetition(dynamicChoices, previousTurn);
    expect(dynamicResult.pass).toBe(true);
    expect(dynamicResult.named_scores.overlapRatio).toBeLessThan(0.35);
  });

  test("checkLanguage validates Indonesian choices without English leakage", () => {
    const validIndonesian = JSON.stringify({
      choices: [
        { label: "Tatap tajam", text: "Menatap matanya dengan dingin tanpa memberikan jawaban langsung." },
        { label: "Buka dokumen", text: "Membuka map berkas itu perlahan di atas meja kaca." },
        { label: "Tolak tuduhan", text: "'Bukan aku yang mencuri kunci enkripsi itu kemarin malam.'" },
        { label: "Tanyakan bukti", text: "'Di mana bukti rekaman kamera keamanan yang kamu sebutkan?'" },
      ],
    });

    const idResult = checkLanguage(validIndonesian, "Indonesian");
    expect(idResult.pass).toBe(true);
    expect(idResult.score).toBe(1.0);

    // English leakage in an Indonesian prompt
    const englishLeakage = JSON.stringify({
      choices: [
        { label: "Step back", text: "Step back from the console and draw your weapon." },
        { label: "Say nothing", text: "Remain quiet and observe her reaction." },
        { label: "Deny charges", text: "'I will never give you that access code.'" },
      ],
    });

    const leakResult = checkLanguage(englishLeakage, "Indonesian");
    expect(leakResult.pass).toBe(false);
  });

  test("checkLedgerCompliance validates word count and required fact retention", () => {
    const compliantSummary = `
# CONTINUITY LEDGER
## Cast
- Rowan: Augmented scout, owed credits by Marcus.
- Elena: New Geneva archivist holding the Citadel cipher key.
- Marcus: Rogue syndicate broker currently in hiding.
## Timeline
- Day 1-2: Met Elena at Kepler Station hydroponics deck; escaped syndicate drone ambush via shaft 4.
## World
- Kepler Station: Failing orbit around Saturn with compromised atmospheric scrubbers.
## Threads
- Elena requires fuel cells from Bay 9 to unlock cipher.
`.trim();

    const entities = ["Rowan", "Elena", "Marcus", "Kepler", "cipher"];
    const result = checkLedgerCompliance(compliantSummary, entities);
    expect(result.pass).toBe(true);
    expect(result.named_scores.wordCount).toBeLessThan(700);
    expect(result.named_scores.entityRetention).toBe(1.0);

    // Missing key entity test
    const incompleteSummary = "Rowan escaped the station. The cipher is safe.";
    const incompleteResult = checkLedgerCompliance(incompleteSummary, entities);
    expect(incompleteResult.pass).toBe(false);
    expect(incompleteResult.reason).toContain("Missing entities");
  });

  test("planChoiceRequest end-to-end creates an evaluation-compliant prompt for Indonesian roleplay", () => {
    const session = {
      messages: [
        { id: "u1", role: "user", content: "Kamu tidak boleh menyentuh konsol navigasi itu!" },
        { id: "a1", role: "assistant", content: "Siti tersenyum tipis sambil menekan tuas darurat. 'Terlambat, Kapten.'" },
      ],
      ledger: "",
      consumed: 1,
    };
    const card = { data: { name: "Siti", scenario: "Di ruang kemudi kapal antariksa Garuda-9." } };
    const req = planChoiceRequest({
      card,
      session,
      settings: {
        maxContextTokens: 4096,
        maxTokens: 1000,
        agentsContract: "Directives: Penulisan novel interaktif berbahasa Indonesia.",
      },
      persona: {
        name: "Kapten Budi",
        description: "Komandan armada yang tegas dan selalu memprioritaskan keselamatan kru.",
      },
      count: 4,
    });

    // Check system prompt has craft beat guidelines and persona adaptation
    expect(req.payload[0].content).toContain("Scene Beats & Physical Grounding");
    expect(req.payload[0].content).toContain("Anti-Echo Rule");
    expect(req.payload[0].content).toContain("User Persona (Kapten Budi): Komandan armada yang tegas");
    expect(req.payload[0].content).toContain("System & Craft Directives:\nDirectives: Penulisan novel interaktif berbahasa Indonesia.");

    // Check user instruction has adaptive guidance
    const taskMsg = req.payload[req.payload.length - 1];
    expect(taskMsg.content).toContain("Embody Kapten Budi's persona, speech habits, and narrative perspective.");
    expect(taskMsg.content).toContain("Seamlessly match the active language, dialect, and tone established in the scene and directives.");
  });
});
