import { describe, test, expect } from "bun:test";
import { formatProse, formatMessages } from "../public/message_format.js";
import { substitutePlaceholders } from "../public/text.js";
import { stripThoughtBlocks as stripThoughts } from "../public/text.js";
import { escapeHtml } from "../public/safe_html.js";

describe("formatProse", () => {
  test("returns empty string for empty input", () => {
    expect(formatProse("")).toBe("");
    expect(formatProse(null)).toBe("");
    expect(formatProse(undefined)).toBe("");
  });

  test("wraps plain paragraphs", () => {
    expect(formatProse("Hello there.")).toBe("<p>Hello there.</p>");
  });

  test("converts HTML-ish input instead of showing literal tags, and never injects markup", () => {
    // Deliberate behavior change: an HTML-ish input now goes through the shared
    // converter before the escape-then-format passes, so source-site/model HTML
    // renders as prose instead of literal tags. The safety property is kept:
    // no raw tag may ever be emitted as markup.
    // script/style content is dropped outright, never injected as markup.
    const out = formatProse('<script>alert("x")</script>');
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("alert");

    const para = formatProse('<p style="text-align:center"><strong>Bold</strong> &amp; <em>italic</em></p>');
    expect(para).toBe("<p><strong>Bold</strong> &amp; <em>italic</em></p>");
    expect(para).not.toContain("<p style");
    expect(para).not.toMatch(/<[a-z][^>]*\s(?:style|class|align)=/i);

    // A stray angle bracket in ordinary prose is not treated as HTML.
    expect(formatProse("5 < 6 > 4")).toBe("<p>5 &lt; 6 &gt; 4</p>");
  });

  test("protects code blocks from escaping and formatting", () => {
    const code = '```js\nconst a = "<b>&</b>";\n```';
    const out = formatProse(code);
    expect(out).toBe('<pre class="prose-code-block"><code class="language-js">const a = &quot;&lt;b&gt;&amp;&lt;/b&gt;&quot;;</code></pre>');
  });

  test("code block content is escaped once, not formatted", () => {
    const out = formatProse("```\n**bold** <div>\n```");
    expect(out).toBe('<pre class="prose-code-block"><code class="">**bold** &lt;div&gt;</code></pre>');
  });

  test("protects inline code", () => {
    const out = formatProse("Use `npm run x` here.");
    expect(out).toBe('<p>Use <code class="prose-inline-code">npm run x</code> here.</p>');
  });

  test("renders blockquotes and merges consecutive ones", () => {
    const out = formatProse("> line one\n> line two");
    expect(out).toContain('<blockquote class="prose-quote">');
    expect(out).not.toContain("</blockquote><blockquote");
  });

  test("renders headers", () => {
    expect(formatProse("# Title")).toContain('<h1 class="prose-h1">Title</h1>');
    expect(formatProse("## Sub")).toContain('<h2 class="prose-h2">Sub</h2>');
    expect(formatProse("### Deep")).toContain('<h3 class="prose-h3">Deep</h3>');
  });

  test("renders bold and italic", () => {
    expect(formatProse("**bold** and *italic*")).toBe("<p><strong>bold</strong> and <em>italic</em></p>");
    expect(formatProse("__bold__")).toContain("<strong>bold</strong>");
    expect(formatProse("_italic_")).toContain("<em>italic</em>");
    expect(formatProse("***both***")).toContain("<strong><em>both</em></strong>");
  });

  test("renders strikethrough", () => {
    expect(formatProse("~~gone~~")).toContain("<del>gone</del>");
  });

  test("replaces em-dashes per anti-slop rules", () => {
    expect(formatProse("wait — what")).toBe("<p>wait ,  what</p>");
    expect(formatProse("wait -- what")).toBe("<p>wait ,  what</p>");
  });

  test("renders horizontal rule scene breaks", () => {
    expect(formatProse("---")).toContain('<hr class="prose-hr">');
  });
});

describe("formatMessages", () => {
  const base = {
    card: { name: "Mira", data: { name: "Mira" } },
    persona: { name: "Alex", avatar: "data:image/png;base64,xxx" },
    charName: "Mira",
    initialLetter: "M",
  };

  test("builds view models for user and assistant messages", () => {
    const msgs = [
      { id: "m1", role: "user", content: "Hi!", timestamp: 1700000000000 },
      { id: "m2", role: "assistant", content: "Hello.", timestamp: 1700000001000 },
    ];
    const vms = formatMessages({ ...base, messages: msgs });
    expect(vms).toHaveLength(2);

    expect(vms[0].id).toBe("m1");
    expect(vms[0].role).toBe("user");
    expect(vms[0].isUser).toBe(true);
    expect(vms[0].speakerName).toBe("Alex");
    expect(vms[0].roleTag).toBe("USER");
    expect(vms[0].avatarHtml).toContain("data:image/png;base64,xxx");
    expect(vms[0].showReroll).toBe(false);
    expect(vms[0].showDelete).toBe(true);

    expect(vms[1].isUser).toBe(false);
    expect(vms[1].speakerName).toBe("Mira");
    expect(vms[1].roleTag).toBe("ASSISTANT");
    expect(vms[1].proseHtml).toBe("<p>Hello.</p>");
    expect(vms[1].showReroll).toBe(true);
  });

  test("falls back to letter avatar without a usable avatar", () => {
    const vms = formatMessages({
      ...base,
      persona: { name: "Alex" },
      messages: [{ id: "m1", role: "user", content: "Hey" }],
    });
    expect(vms[0].avatarHtml).toBe("A");
  });

  test("uses initialLetter fallback for assistant without card avatar", () => {
    const vms = formatMessages({
      ...base,
      card: {},
      messages: [{ id: "m2", role: "assistant", content: "..." }],
    });
    expect(vms[0].avatarHtml).toBe("M");
  });

  test("defaults user speaker to You without a persona", () => {
    const vms = formatMessages({
      card: {},
      charName: "Mira",
      initialLetter: "M",
      messages: [{ id: "m1", role: "user", content: "Hey" }],
    });
    expect(vms[0].speakerName).toBe("You");
    expect(vms[0].avatarHtml).toBe("U");
  });

  test("strips thought blocks from proseHtml", () => {
    const vms = formatMessages({
      ...base,
      messages: [{ id: "m2", role: "assistant", content: '<thought character="Mira">secret plan</thought>Visible reply.' }],
    });
    const vm = vms[0];
    expect(vm.proseHtml).toBe("<p>Visible reply.</p>");
    expect(vm.proseHtml).not.toContain("secret plan");
  });

  test("strips thought blocks without character attribute from proseHtml", () => {
    const vms = formatMessages({
      ...base,
      messages: [{ id: "m2", role: "assistant", content: "<thought>hmm</thought>Out loud." }],
    });
    expect(vms[0].proseHtml).toBe("<p>Out loud.</p>");
  });

  test("strips thoughts with single-quoted or extra attributes, space before >, and think tags", () => {
    const vms1 = formatMessages({
      ...base,
      messages: [{ id: "m1", role: "assistant", content: "<thought character='Elena' mood='nervous'>Quiet doubt</thought>Hello." }],
    });
    expect(vms1[0].proseHtml).toBe("<p>Hello.</p>");

    const vms2 = formatMessages({
      ...base,
      messages: [{ id: "m2", role: "assistant", content: '<think class="reasoning">Deeper thinking</think>Spoken word.' }],
    });
    expect(vms2[0].proseHtml).toBe("<p>Spoken word.</p>");

    const vms3 = formatMessages({
      ...base,
      messages: [{ id: "m3", role: "assistant", content: "<thought >Spaced thought</thought>Visible." }],
    });
    expect(vms3[0].proseHtml).toBe("<p>Visible.</p>");
  });

  test("copy source retains raw content including thoughts", () => {
    const raw = "<thought>x</thought>Reply.";
    const vms = formatMessages({
      ...base,
      messages: [{ id: "m2", role: "assistant", content: raw }],
    });
    expect(vms[0].rawContent).toBe(raw);
  });

  test("single-message feed hides delete button", () => {
    const vms = formatMessages({
      ...base,
      messages: [{ id: "m1", role: "user", content: "only" }],
    });
    expect(vms[0].showDelete).toBe(false);
  });

  test("handles null messages and messages without timestamps", () => {
    expect(formatMessages({ ...base, messages: null })).toEqual([]);
    const vms = formatMessages({ ...base, messages: [{ id: "m1", role: "user", content: "hi" }] });
    expect(vms[0].timestamp).toBeUndefined();
  });
});

describe("stripThoughts", () => {
  test("returns empty or unchanged for plain prose", () => {
    expect(stripThoughts("Hello world.")).toBe("Hello world.");
    expect(stripThoughts("")).toBe("");
    expect(stripThoughts(null as unknown as string)).toBe("");
  });

  test("strips standard thought tags and think tags from prose", () => {
    expect(stripThoughts('<thought character="Elena">Her private motive.</thought>She nods slowly.'))
      .toBe("She nods slowly.");
    expect(stripThoughts("<thought character='Mira' mood='tense'>Cautious.</thought>Greetings."))
      .toBe("Greetings.");
    expect(stripThoughts('<think class="reasoning">Deeper calculation.</think>I agree.'))
      .toBe("I agree.");
    expect(stripThoughts("<thought >Spaced tag.</thought>Done."))
      .toBe("Done.");
  });
});

describe("substitutePlaceholders", () => {
  test("resolves {{user}} and {{char}} case-insensitively", () => {
    expect(substitutePlaceholders("Hi {{user}}, I am {{char}}.", { user: "Alex", char: "Mira" }))
      .toBe("Hi Alex, I am Mira.");
    expect(substitutePlaceholders("{{USER}} meets {{CHAR}}", { user: "Alex", char: "Mira" }))
      .toBe("Alex meets Mira");
  });

  test("supports common name aliases", () => {
    expect(substitutePlaceholders("{{UserName}} and {{user_name}}", { user: "Alex" }))
      .toBe("Alex and Alex");
    expect(substitutePlaceholders("{{CharName}} / {{char_name}}", { char: "Mira" }))
      .toBe("Mira / Mira");
  });

  test("supports universal single-brace, angle brackets, and bot aliases", () => {
    expect(substitutePlaceholders("Hello {User} and <user>, meet {char} and {{bot}} and <bot>.", { user: "Iqbal", char: "Elena" }))
      .toBe("Hello Iqbal and Iqbal, meet Elena and Elena and Elena.");
    expect(substitutePlaceholders("{user_name} / <USER>", { user: "Iqbal" }))
      .toBe("Iqbal / Iqbal");
  });

  test("leaves unknown placeholders and unavailable names as literal text", () => {
    expect(substitutePlaceholders("{{random}} stays, as does {{time}}", { user: "Alex", char: "Mira" }))
      .toBe("{{random}} stays, as does {{time}}");
    expect(substitutePlaceholders("Hi {{user}}", {})).toBe("Hi {{user}}");
    expect(substitutePlaceholders("Hi {{char}}", {})).toBe("Hi {{char}}");
  });

  test("is safe against dollar-pattern names", () => {
    expect(substitutePlaceholders("{{user}}", { user: "$& $1", char: "Mira" })).toBe("$& $1");
  });

  test("formatMessages resolves placeholders in rendered prose", () => {
    const vms = formatMessages({
      card: { name: "Mira", data: { name: "Mira" } },
      persona: { name: "Alex" },
      charName: "Mira",
      initialLetter: "M",
      messages: [{ id: "m1", role: "assistant", content: "Hello {{user}}, I am {{char}}." }],
    });
    expect(vms[0].proseHtml).toBe("<p>Hello Alex, I am Mira.</p>");
    expect(vms[0].proseHtml).not.toContain("{{");
  });

  test("formatMessages converts old stored HTML and resolves placeholders together", () => {
    const vms = formatMessages({
      card: { name: "Mira", data: { name: "Mira" } },
      persona: { name: "Alex" },
      charName: "Mira",
      initialLetter: "M",
      messages: [{ id: "m1", role: "assistant", content: "<p><em>Hi</em> {{user}}</p>" }],
    });
    expect(vms[0].proseHtml).toBe("<p><em>Hi</em> Alex</p>");
    expect(vms[0].proseHtml).not.toContain("<p ");
  });
});

describe("escapeHtml", () => {
  test("escapes all dangerous characters", () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });

  test("handles falsy input", () => {
    expect(escapeHtml("")).toBe("");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});
