// Pure message formatting for the chat feed. No DOM/window/document
// references: same inputs always yield the same HTML strings.

import { estimateTokens } from "./browser_engine.js";
import { htmlToAppMarkup } from "./card_parse.js";
import { escapeHtml } from "./safe_html.js";
import { avatarInnerHtml } from "./ui/character_card.js";
import { substitutePlaceholders, stripThoughtBlocks } from "./text.js";

export function formatProse(text) {
  if (!text) return "";

  let s = String(text);

  // 1. Extract and protect code blocks (before em-dash/HR passes so code
  // content is never reformatted; the original stripped em-dashes inside
  // code blocks).
  const codeBlocks = [];
  s = s.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    // ponytail: original used %%CODE_BLOCK_N%% / %%INLINE_CODE_N%%, which the
    // _italic_ rule shredded into %%CODE<em>BLOCK</em>N%% so code blocks and
    // inline code never rendered. Placeholder changed to avoid underscores.
    const placeholder = `{{CODEBLOCK${codeBlocks.length}||`;
    codeBlocks.push(`<pre class="prose-code-block"><code class="${lang ? 'language-' + escapeHtml(lang) : ''}">${escapeHtml(code.trim())}</code></pre>`);
    return `\n\n${placeholder}\n\n`;
  });

  // 2. Extract and protect inline code
  const inlineCodes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    const placeholder = `{{INLINECODE${inlineCodes.length}||`;
    inlineCodes.push(`<code class="prose-inline-code">${escapeHtml(code)}</code>`);
    return placeholder;
  });

  // 2b. Convert an HTML-ish input (old stored cards, model output) through the
  // shared converter, now that code spans are protected. The result is
  // tag-free, so the escape-then-format passes below still guarantee no raw
  // HTML is ever injected as markup.
  if (/<[a-zA-Z][^>]*>|<\/[a-zA-Z]/.test(s)) s = htmlToAppMarkup(s);

  // 3. Horizontal rules / scene breaks, before em-dash stripping eats `---`.
  // Emitted as a placeholder token and restored after escaping (an injected
  // `<hr>` would be escaped by step 5).
  s = s.replace(/^(?:---|\*\*\*|___)\s*$/gm, "\n\n{{HR||\n\n");

  // 4. Strip em-dashes per anti-slop rules
  s = s
    .replace(/(?<!-)--/g, ", ")
    .replace(/—/g, ", ");

  // 5. Escape raw HTML for all non-code content (before blockquote's &gt; match),
  // then restore the hr placeholder.
  s = escapeHtml(s).replaceAll("{{HR||", '<hr class="prose-hr">');

  // 6. Blockquotes (handling &gt; since escapeHtml escaped >)
  s = s.replace(/^(?:&gt;|>)[ \t]?(.*)$/gm, '<blockquote class="prose-quote">$1</blockquote>');

  // 7. Headers (at start of line)
  s = s.replace(/^### (.*$)/gim, '<h3 class="prose-h3">$1</h3>');
  s = s.replace(/^## (.*$)/gim, '<h2 class="prose-h2">$1</h2>');
  s = s.replace(/^# (.*$)/gim, '<h1 class="prose-h1">$1</h1>');

  // 7. Bold + Italic: ***text*** or ___text___
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');

  // Bold: **text** or __text__
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');

  // Strikethrough: ~~text~~
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Note: We deliberately do NOT wrap dialogue in <q> tags.
  // In browsers, <q> automatically inserts quotes, causing duplicate quotes (""...""").
  // Plain text quotes render naturally, cleanly, and consistently across all platforms.

  // 8. Split into paragraphs on double-newlines
  const chunks = s.split(/\n{2,}/);
  const formatted = chunks.map(chunk => {
    const trimmed = chunk.trim();
    if (!trimmed) return "";
    // If it starts with a block tag or code placeholder, don't wrap in <p>
    if (/^<(h1|h2|h3|blockquote|pre|hr)/i.test(trimmed) || trimmed.startsWith("{{CODEBLOCK")) {
      return trimmed;
    }
    return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
  }).filter(Boolean);

  let result = formatted.join("");

  // Merge consecutive blockquotes into one cohesive block
  result = result.replace(/<\/blockquote>\s*<blockquote class="prose-quote">/g, '<br>');

  // 9. Restore inline code
  inlineCodes.forEach((codeHtml, i) => {
    result = result.replaceAll(`{{INLINECODE${i}||`, codeHtml);
  });

  // 10. Restore code blocks
  codeBlocks.forEach((blockHtml, i) => {
    result = result.replaceAll(`{{CODEBLOCK${i}||`, blockHtml);
  });

  return result;
}

/**
 * Builds one plain view-model object per message, carrying everything the
 * feed loop needs to render a card without touching controller state.
 */
export function formatMessages({ messages, card, persona, charName, initialLetter }) {
  const msgs = messages || [];
  const userSpeaker = persona?.name || "You";
  const cardAvatar = card?.avatar || card?.data?.avatar;

  return msgs.map((msg, idx) => {
    const isUser = msg.role === "user";
    const isLastAssistant = !isUser && idx === msgs.length - 1;
    const speaker = isUser ? userSpeaker : charName;

    let avatarHtml = "";
    if (isUser) {
      const uAvatar = persona?.avatar;
      avatarHtml = avatarInnerHtml(uAvatar, persona?.name ? persona.name.charAt(0) : "U");
    } else {
      avatarHtml = avatarInnerHtml(cardAvatar, initialLetter);
    }

    const msgTokens = estimateTokens(msg.content);
    const tokenTagHtml = `<span class="msg-token-tag">~${msgTokens.toLocaleString()} tokens</span>`;

    // Resolve card placeholders before formatting: the greeting, alternate
    // greetings and any echoed assistant output must never show `{{user}}` /
    // `{{char}}` on screen.
    let content = substitutePlaceholders(msg.content, { user: userSpeaker, char: charName });
    content = stripThoughtBlocks(content);

    return {
      id: msg.id,
      role: msg.role,
      isUser,
      speakerName: speaker,
      roleTag: isUser ? "USER" : "ASSISTANT",
      avatarHtml,
      tokenTagHtml,
      proseHtml: formatProse(content),
      timestamp: msg.timestamp,
      rawContent: msg.content,
      showDelete: msgs.length > 1,
      showReroll: isLastAssistant,
    };
  });
}
