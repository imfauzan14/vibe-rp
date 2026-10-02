import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { structuralViolations } from "../tools/prompt_eval.mjs";

const EVAL = join(import.meta.dir, "..", "tools", "prompt_eval.mjs");
const clean = () => ({
  rows: [{ scenario: "fixture", singleDef: [], fits: true }],
  contractChecks: [],
  parityGaps: [],
  framingGaps: [],
});

function checkCli(report: object) {
  return Bun.spawnSync({
    cmd: [process.execPath, EVAL, "--check-report", "-"],
    stdin: Buffer.from(JSON.stringify(report)),
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("structural evaluator regression gate", () => {
  test("a clean report passes without treating diagnostics as violations", () => {
    expect(structuralViolations(clean())).toEqual([]);
    const run = checkCli(clean());
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("structural checks passed");
  });

  test("a malformed report never passes vacuously", () => {
    expect(() => structuralViolations({})).toThrow();
    expect(checkCli({}).exitCode).toBe(2);
  });

  const cases = [
    ["single-definition", (r: ReturnType<typeof clean>) => r.rows[0].singleDef.push({ id: "agency", count: 2, expect: 1 })],
    ["contract-layer", (r: ReturnType<typeof clean>) => r.contractChecks.push({ id: "authority", count: 0, expect: 1 })],
    ["bilingual-parity", (r: ReturnType<typeof clean>) => r.parityGaps.push({ rule: "voice", inEn: true, inId: false })],
    ["instruction-framing", (r: ReturnType<typeof clean>) => r.framingGaps.push({ id: "summary", negativeMarkers: 1, absolutistMarkers: 0 })],
  ] as const;

  for (const [name, inject] of cases) {
    test(`${name} fails both the pure check and CLI exit status`, () => {
      const report = clean();
      inject(report);
      expect(structuralViolations(report)).toHaveLength(1);
      const run = checkCli(report);
      expect(run.exitCode).toBe(1);
      expect(run.stderr.toString()).toContain(name);
    });
  }
});
