import { describe, test, expect } from "bun:test";
import { htmlToAppMarkup, decodeHtmlEntities, normalizeCard, stripJsonComments, decodeBase64Utf8 } from "../public/card_parse.js";

// A tag-shaped sequence that the converter is required never to emit.
const TAG_RE = /<[a-zA-Z][^<>]*>/;

describe("decodeHtmlEntities", () => {
  test("decodes the common named entities", () => {
    expect(decodeHtmlEntities("&amp; &lt; &gt; &quot; &#39; &nbsp; &mdash; &ndash; &hellip;"))
      .toBe("& < > \" ' \u00a0 \u2014 \u2013 \u2026");
  });

  test("decodes decimal and hex numeric entities", () => {
    expect(decodeHtmlEntities("&#8212; &#x2014; &#65; &#x41;")).toBe("\u2014 \u2014 A A");
  });

  test("leaves unknown entities and out-of-range code points literal", () => {
    expect(decodeHtmlEntities("&bogus; &#x110000; &notreal;")).toBe("&bogus; &#x110000; &notreal;");
  });

  test("handles empty and nullish input", () => {
    expect(decodeHtmlEntities("")).toBe("");
    expect(decodeHtmlEntities(null)).toBe("");
  });
});

describe("htmlToAppMarkup", () => {
  test("converts the reported source-site definition verbatim-free", () => {
    const src = '<p style="text-align: center;"><em>"Your leadership has failed us."</em></p>' +
      '<p style="text-align: center;"><strong>Adventurer User x S-Rank Party</strong></p>' +
      '<hr><p style="text-align: center;"><strong>Premise</strong></p>';
    const out = htmlToAppMarkup(src);
    expect(out).toBe('*"Your leadership has failed us."*\n\n**Adventurer User x S-Rank Party**\n\n---\n\n**Premise**');
    expect(out).not.toMatch(TAG_RE);
  });

  test("maps block structure: p, br, br/, hr, hr/", () => {
    expect(htmlToAppMarkup("a<br>b<br/>c")).toBe("a\nb\nc");
    expect(htmlToAppMarkup("a<hr/>b")).toBe("a\n\n---\n\nb");
  });

  test("maps headings to # / ## / ### (h4-h6 clamp to ###)", () => {
    expect(htmlToAppMarkup("<h1>T</h1><h2>S</h2><h3>D</h3><h6>X</h6>"))
      .toBe("# T\n\n## S\n\n### D\n\n### X");
  });

  test("maps strong/b to ** and em/i to *", () => {
    expect(htmlToAppMarkup("<strong>a</strong><b>b</b><em>c</em><i>d</i>")).toBe("**a****b***c**d*");
  });

  test("maps blockquote to > line prefixes", () => {
    expect(htmlToAppMarkup("<blockquote>one<br>two</blockquote>")).toBe("> one\n> two");
  });

  test("maps ul/ol/li to - lines", () => {
    expect(htmlToAppMarkup("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n\n- two");
    expect(htmlToAppMarkup("<ol><li>a</li></ol>")).toBe("- a");
  });

  test("maps anchors to 'text (href)', and to bare text when they match", () => {
    expect(htmlToAppMarkup('<a href="https://y.com">Y</a>')).toBe("Y (https://y.com)");
    expect(htmlToAppMarkup('<a href="https://x.com">https://x.com</a>')).toBe("https://x.com");
  });

  test("strips every attribute and unknown/void tag", () => {
    const out = htmlToAppMarkup('<div class="x" data-y="z"><span style="color:red" align="center">t</span><img src="a.png"></div>');
    expect(out).toBe("t");
    expect(out).not.toMatch(TAG_RE);
  });

  test("handles nested markup without throwing and stays tag-free", () => {
    const out = htmlToAppMarkup("<div><p>one <strong>two <em>three</em></strong></p><p>four</p></div>");
    expect(out).toBe("one **two *three***\n\nfour");
    expect(out).not.toMatch(TAG_RE);
  });

  test("handles malformed markup (unclosed tags, stray brackets)", () => {
    expect(htmlToAppMarkup("<p>unclosed <em>emphasis")).toBe("unclosed *emphasis");
    expect(htmlToAppMarkup("5 < 6 > 4")).toBe("5 < 6 > 4");
  });

  test("drops comments and script/style content", () => {
    expect(htmlToAppMarkup("a<!-- x -->b")).toBe("ab");
    expect(htmlToAppMarkup("<script>alert(1)</script>ok")).toBe("ok");
    expect(htmlToAppMarkup("<style>.x{color:red}</style>ok")).toBe("ok");
  });

  test("preserves app card markers like <START>", () => {
    expect(htmlToAppMarkup("<START> {{user}}: hi")).toBe("<START> {{user}}: hi");
  });

  test("collapses runs of 3+ newlines to 2", () => {
    expect(htmlToAppMarkup("a<p></p><p></p><p></p>b")).toBe("a\n\nb");
  });

  test("is idempotent and returns clean text byte-identical", () => {
    const clean = "Already **clean** *text* with --- and # heading";
    expect(htmlToAppMarkup(clean)).toBe(clean);
    for (const s of [
      "<p><em>a</em></p>",
      "<ul><li>x</li></ul>",
      "<blockquote>q</blockquote>",
      "plain",
      "",
    ]) {
      const once = htmlToAppMarkup(s);
      expect(htmlToAppMarkup(once)).toBe(once);
    }
  });

  test("never emits a tag, even from entity-encoded tags", () => {
    const out = htmlToAppMarkup("literal &lt;em&gt;text&lt;/em&gt;");
    expect(out).not.toMatch(TAG_RE);
    expect(out).not.toContain("<em>");
  });
});

describe("normalizeCard HTML cleaning", () => {
  test("cleans every card text field on the v2 path", () => {
    const card = normalizeCard({
      spec: "chara_card_v2",
      data: {
        name: "T",
        description: "<p><strong>D</strong></p>",
        personality: "<em>P</em>",
        scenario: "<p>S</p>",
        first_mes: "<p>F</p>",
        alternate_greetings: ["<p>G1</p>", "<em>G2</em>"],
        mes_example: "<p>M</p>",
        system_prompt: "<p>SP</p>",
        post_history_instructions: "<p>PH</p>",
        creator_notes: "<p>CN</p>",
        example_dialogs: "<p>ED</p>",
      },
    });
    expect(card.data.description).toBe("**D**");
    expect(card.data.personality).toBe("*P*");
    expect(card.data.scenario).toBe("S");
    expect(card.data.first_mes).toBe("F");
    expect(card.data.alternate_greetings).toEqual(["G1", "*G2*"]);
    expect(card.data.mes_example).toBe("M");
    expect(card.data.system_prompt).toBe("SP");
    expect(card.data.post_history_instructions).toBe("PH");
    expect(card.data.creator_notes).toBe("CN");
    expect(card.data.example_dialogs).toBe("ED");
  });

  test("cleans fields on the v1 flat path", () => {
    const card = normalizeCard({ name: "V1", description: "<p>flat</p>" });
    expect(card.spec).toBe("chara_card_v1");
    expect(card.data.description).toBe("flat");
  });

  test("does not mutate the caller's input object", () => {
    const input = { spec: "chara_card_v2", data: { name: "T", description: "<p>x</p>" } };
    normalizeCard(input);
    expect(input.data.description).toBe("<p>x</p>");
  });

  test("leaves already-clean fields untouched", () => {
    const card = normalizeCard({ name: "T", data: { description: "plain text" } });
    expect(card.data.description).toBe("plain text");
  });
});

describe("stripJsonComments", () => {
  test("preserves commas inside string literals while stripping trailing commas and comments", () => {
    const input = `// Card definition
    {
      "name": "Elena",
      /* greeting comment */
      "greeting": "Wait, } what did you say?",
      "items": ["apple", "orange", ],
    }`;
    const stripped = stripJsonComments(input);
    const parsed = JSON.parse(stripped);
    expect(parsed.name).toBe("Elena");
    expect(parsed.greeting).toBe("Wait, } what did you say?");
    expect(parsed.items).toEqual(["apple", "orange"]);
  });
});

describe("decodeBase64Utf8", () => {
  test("properly decodes UTF-8 multi-byte characters from base64", () => {
    const text = "Aria (アリア) — Елена 🗡️";
    const bytes = new TextEncoder().encode(text);
    const binStr = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    const b64 = btoa(binStr);
    const decoded = decodeBase64Utf8(b64);
    expect(decoded).toBe(text);
  });
});
