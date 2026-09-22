// Conversation export and restore. No dependencies.
//
// Export writes a self-describing JSON document (the transcript, the card
// identity, the persona, and the ledger) so a session can be archived and read
// outside the app. Restore validates the shape and returns the messages for the
// caller to append, so the append-only transcript rule stays with the caller.

const FORMAT = "vibe-rp-conversation";
const VERSION = 1;

/** Filesystem-safe slug from a title. */
function slug(text) {
  const base = String(text || "conversation")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "conversation";
}

/**
 * @param {object} args
 * @param {object} args.session   the active session (messages, title, ledger)
 * @param {object} [args.card]    the active card, for identity only
 * @param {object} [args.persona] the active persona, for identity only
 */
export function buildExport({ session, card = null, persona = null }) {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    title: session?.title || "Untitled chat",
    character: card ? { name: card.data?.name || card.name || "Character" } : null,
    persona: persona ? { name: persona.name || "You" } : null,
    ledger: session?.ledger || "",
    consumed: Number(session?.consumed) || 0,
    messages: (session?.messages || []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      forks: m.forks || undefined,
    })),
  };
}

/** Serialises and downloads. Returns the file name used. */
export function downloadExport({ session, card, persona, filename = null }) {
  const doc = buildExport({ session, card, persona });
  const name = filename || `${slug(doc.title)}.vibe-rp.json`;
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next frame so the click has committed the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return name;
}

/** Plain-text transcript, for pasting into anything. */
export function buildPlainText({ session, card = null }) {
  const lines = [];
  const title = session?.title || "Untitled chat";
  lines.push(title);
  if (card) lines.push(card.data?.name || card.name || "");
  lines.push("");
  for (const m of session?.messages || []) {
    const who = m.role === "user" ? "You" : card ? card.data?.name || card.name || "Character" : "Character";
    lines.push(`${who}:`);
    lines.push(String(m.content || "").trim());
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Validates a parsed export document and returns its messages.
 * Throws a descriptive Error when the document is not a conversation.
 */
export function parseImport(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (_) {
    throw new Error("That file is not valid JSON.");
  }
  if (!doc || typeof doc !== "object") throw new Error("That file is empty.");
  if (doc.format !== FORMAT) throw new Error("That file is not a vibe-rp conversation export.");
  if (!Array.isArray(doc.messages) || doc.messages.length === 0) {
    throw new Error("That export has no messages in it.");
  }
  const messages = doc.messages
    .filter((m) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
    .map((m, i) => ({
      id: typeof m.id === "string" && m.id ? m.id : `msg_import_${Date.now()}_${i}`,
      role: m.role,
      content: m.content,
      timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now() + i,
      ...(Array.isArray(m.forks) && m.forks.length ? { forks: m.forks } : {}),
    }));
  if (!messages.length) throw new Error("That export has no readable messages.");
  return { title: doc.title || "Restored chat", ledger: doc.ledger || "", messages };
}

/** Reads a File or Blob and returns the parsed conversation. */
export async function readImportFile(file) {
  const text = await file.text();
  return parseImport(text);
}
