import { describe, test, expect, beforeEach } from "bun:test";
import { LocalDb, DEFAULT_AGENTS_CONTRACT } from "../public/local_db.js";

interface Preset {
  id: string;
  name: string;
  isDefault?: boolean;
  content?: string;
  updatedAt?: number;
  [k: string]: unknown;
}

// In-memory localStorage stub; no IndexedDB anywhere in this suite.
const store = new Map<string, string>(); // dynamic membership, cleared per test
// @ts-ignore - test stub
globalThis.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => store.set(k, String(v)),
  removeItem: (k: string) => store.delete(k),
};

beforeEach(() => store.clear());

describe("Generic presets store", () => {
  test("defaults seeded on first read (personas)", async () => {
    const list = (await LocalDb.getAllPersonas()) as Preset[];
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("persona_default");
    expect(list[0].isDefault).toBe(true);
    // seed persisted
    expect(JSON.parse(store.get("vibe_rp_personas")!)).toHaveLength(1);
  });

  test("defaults seeded on first read (directives)", async () => {
    const list = (await LocalDb.getAllDirectives()) as Preset[];
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("directive_default");
    expect(list[0].content).toBe(DEFAULT_AGENTS_CONTRACT);
  });

  test("save/get roundtrip assigns id and persists", async () => {
    const saved = (await LocalDb.savePersona({ name: "Valen Vance" })) as Preset;
    expect(saved.id).toMatch(/^persona_/);
    expect(saved.updatedAt).toBeNumber();
    const got = (await LocalDb.getPersona(saved.id)) as Preset;
    expect(got?.name).toBe("Valen Vance");

    const dir = (await LocalDb.saveDirective({ name: "Grimdark", content: "blood" })) as Preset;
    expect(dir.id).toMatch(/^directive_/);
    expect(((await LocalDb.getDirective(dir.id)) as Preset)?.content).toBe("blood");
  });

  test("delete removes the preset", async () => {
    const p = (await LocalDb.savePersona({ name: "Temp" })) as Preset;
    await LocalDb.deletePersona(p.id);
    expect(await LocalDb.getPersona(p.id)).toBeNull();
    const d = (await LocalDb.saveDirective({ name: "Temp D" })) as Preset;
    await LocalDb.deleteDirective(d.id);
    expect(await LocalDb.getDirective(d.id)).toBeNull();
  });

  test("delete default falls back to remaining list item", async () => {
    const p = (await LocalDb.savePersona({ name: "Second" })) as Preset;
    await LocalDb.deletePersona("persona_default");
    expect(((await LocalDb.getDefaultPersona()) as Preset)?.id).toBe(p.id);
  });

  test("setDefault flips isDefault flags exactly once", async () => {
    const a = (await LocalDb.savePersona({ id: "persona_a", name: "A" })) as Preset;
    const b = (await LocalDb.savePersona({ id: "persona_b", name: "B" })) as Preset;
    await LocalDb.setDefaultPersona(b.id);
    const list = (await LocalDb.getAllPersonas()) as Preset[];
    expect(list.filter((p) => p.isDefault).map((p) => p.id)).toEqual([b.id]);
    expect(list.find((p) => p.id === a.id)?.isDefault).toBe(false);

    const da = (await LocalDb.saveDirective({ id: "directive_a", name: "D1" })) as Preset;
    const db2 = (await LocalDb.saveDirective({ id: "directive_b", name: "D2" })) as Preset;
    await LocalDb.setDefaultDirective(db2.id);
    const dlist = (await LocalDb.getAllDirectives()) as Preset[];
    expect(dlist.filter((d) => d.isDefault).map((d) => d.id)).toEqual([db2.id]);
    expect(dlist.find((d) => d.id === da.id)?.isDefault).toBe(false);
  });

  test("resolveForCard prefers card root override, then card.data, then default (personas)", async () => {
    const custom = (await LocalDb.savePersona({ name: "Root" })) as Preset;
    const nested = (await LocalDb.savePersona({ name: "Nested" })) as Preset;

    const viaRoot = (await LocalDb.resolvePersonaForCard({ userPersonaId: custom.id })) as Preset;
    expect(viaRoot.id).toBe(custom.id);

    const viaData = (await LocalDb.resolvePersonaForCard({ data: { userPersonaId: nested.id } })) as Preset;
    expect(viaData.id).toBe(nested.id);

    // root wins over data
    const both = (await LocalDb.resolvePersonaForCard({
      userPersonaId: custom.id,
      data: { userPersonaId: nested.id },
    })) as Preset;
    expect(both.id).toBe(custom.id);

    // missing id in store falls back to default
    const missing = (await LocalDb.resolvePersonaForCard({ userPersonaId: "persona_ghost" })) as Preset;
    expect(missing.id).toBe("persona_default");

    const none = (await LocalDb.resolvePersonaForCard({})) as Preset;
    expect(none.id).toBe("persona_default");
  });

  test("resolveForCard prefers card root override, then card.data, then default (directives)", async () => {
    const custom = (await LocalDb.saveDirective({ name: "Root D", content: "root" })) as Preset;
    const nested = (await LocalDb.saveDirective({ name: "Nested D", content: "nested" })) as Preset;

    expect(((await LocalDb.resolveDirectiveForCard({ directivePresetId: custom.id })) as Preset).id).toBe(custom.id);
    expect(
      ((await LocalDb.resolveDirectiveForCard({ data: { directivePresetId: nested.id } })) as Preset).id
    ).toBe(nested.id);

    const both = (await LocalDb.resolveDirectiveForCard({
      directivePresetId: custom.id,
      data: { directivePresetId: nested.id },
    })) as Preset;
    expect(both.id).toBe(custom.id);
  });

  test("unresolved directive resolution returns DEFAULT_AGENTS_CONTRACT content", async () => {
    const resolved = (await LocalDb.resolveDirectiveForCard({ id: "card_x" })) as Preset;
    expect(resolved.content).toBe(DEFAULT_AGENTS_CONTRACT);
  });
});
