import { utf8Decoder } from "./text.js";

// Character-card import parsing (JSON/JSONC + chub V2 PNG + legacy V1 WebP).
// No DOM/window/document references: pure byte/JSON parsing helpers.

export function stripJsonComments(src) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      out += " ";
      continue;
    }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

// HTML in definition fields (source sites, exported cards) is inert junk here:
// the feed escapes it (literal tags on screen) and the model gets it verbatim.
// Converter below maps the common subset onto the app's lightweight markup.
const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»", copy: "©", reg: "®" };
export function decodeHtmlEntities(str) {
  if (!str) return "";
  return String(str).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const hit = HTML_ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}
function htmlHref(attrs) {
  const m = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs || "");
  return m ? decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? "") : "";
}
function tagToMarkup(close, name) {
  switch (name) {
    case "p": return "\n\n";
    case "br": return "\n";
    case "hr": return "\n\n---\n\n";
    case "strong": case "b": return "**";
    case "em": case "i": return "*";
    case "h1": return close ? "\n\n" : "\n\n# ";
    case "h2": return close ? "\n\n" : "\n\n## ";
    case "h3": case "h4": case "h5": case "h6": return close ? "\n\n" : "\n\n### ";
    case "blockquote": return close ? "\n\u0000QE\u0000\n\n" : "\n\n\u0000QS\u0000\n";
    case "ul": case "ol": return "\n\n";
    case "li": return close ? "\n" : "\n- ";
    default: return "";
  }
}
// Card-format markers the app itself understands (index.html renders <START> as
// a sample divider). They are not HTML, so they are preserved verbatim instead
// of being stripped as an unknown tag.
const CARD_MARKER = /^(?:start|bot|end)$/;
export function htmlToAppMarkup(input) {
  if (input == null) return "";
  let s = String(input);
  if (!s) return "";
  // Fast path: already-clean text is returned byte-identical (idempotence).
  if (!/[<&\r]/.test(s) && !/\n{3}/.test(s)) return s;
  // Comments, and script/style elements with their content, are dropped outright:
  // neither is prose, and neither should ever reach the model or the feed.
  s = s.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<a\b((?:"[^"]*"|'[^']*'|[^"'>])*)>([\s\S]*?)<\/a\s*>/gi, (_w, at, inner) => {
    const href = htmlHref(at);
    const tx = decodeHtmlEntities(inner.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (!tx) return href;
    if (!href || tx === href) return tx;
    return tx + " (" + href + ")";
  });
  const markers = [];
  let out = "", last = 0, m;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
  while ((m = re.exec(s)) !== null) {
    out += decodeHtmlEntities(s.slice(last, m.index));
    const name = m[2].toLowerCase();
    if (CARD_MARKER.test(name) && !m[3]) out += "\u0000MK" + (markers.push(m[0]) - 1) + "\u0000";
    else out += tagToMarkup(m[1] === "/", name);
    last = re.lastIndex;
  }
  out += decodeHtmlEntities(s.slice(last));
  out = out.replace(/\u0000QS\u0000\n([\s\S]*?)\n\u0000QE\u0000/g, (_w, inner) => {
    const q = inner.split("\n").map((l) => (l.trim() ? "> " + l.trim() : ">")).join("\n");
    return "\n\n" + q + "\n\n";
  });
  out = out.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // Final safety net: any tag-shaped sequence that survived (e.g. from a decoded
  // `&lt;em&gt;`) is neutralised, so the output can never be parsed as markup.
  out = out.replace(/<\/?[a-zA-Z][^<>]*>/g, (t) => "&lt;" + t.slice(1, -1) + "&gt;");
  out = out.replace(/\u0000MK(\d+)\u0000/g, (_w, i) => markers[+i]);
  return out;
}
export const CARD_HTML_FIELDS = ["description", "personality", "scenario", "first_mes", "mes_example", "system_prompt", "post_history_instructions", "creator_notes", "example_dialogs"];
function cleanCardData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const out = { ...data };
  for (const f of CARD_HTML_FIELDS) {
    if (typeof out[f] === "string" && out[f]) out[f] = htmlToAppMarkup(out[f]);
  }
  if (Array.isArray(out.alternate_greetings)) {
    out.alternate_greetings = out.alternate_greetings.map((g) => (typeof g === "string" && g ? htmlToAppMarkup(g) : g));
  }
  return out;
}
export function normalizeCard(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("card JSON is not an object");
  if (json.data && typeof json.data === "object" && !Array.isArray(json.data)) {
    return { spec: json.spec || "chara_card_v2", spec_version: json.spec_version || "2.0", data: cleanCardData(json.data) };
  }
  return { spec: "chara_card_v1", spec_version: "1.0", data: cleanCardData(json) };
}

export function parseJsonLoose(text) {
  try { return JSON.parse(String(text).trim()); } catch { return null; }
}

const latin1Decoder = new TextDecoder("latin1");

export async function inflateDecompress(u8) {
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  const out = await new Response(stream).arrayBuffer();
  return utf8Decoder.decode(out);
}

export function parsePngChara(buf) {
  const view = new DataView(buf);
  if (view.byteLength < 8 || view.getUint32(0) !== 0x89504e47) return null;
  const bytes = new Uint8Array(buf);
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off);
    const type = latin1Decoder.decode(bytes.subarray(off + 4, off + 8));
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > bytes.length) break;
    if (type === "IEND") break;
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const data = bytes.subarray(dataStart, dataEnd);
      let k = 0;
      while (k < data.length && data[k] !== 0) k++;
      const keyword = latin1Decoder.decode(data.subarray(0, k)).toLowerCase();
      if (keyword === "chara") {
        const rest = data.subarray(k + 1);
        if (type === "tEXt") {
          const raw = latin1Decoder.decode(rest).trim();
          // chub.ai encodes as base64; fall back to direct parse for plain-JSON embeds
          try { return parseJsonLoose(atob(raw)); } catch { return parseJsonLoose(raw); }
        }
        if (type === "zTXt") {
          return inflateDecompress(rest.subarray(1)).then((raw) => {
            const clean = String(raw || "").trim();
            try { return parseJsonLoose(atob(clean)); } catch { return parseJsonLoose(clean); }
          }).catch(() => null);
        }
        // iTXt: compressionFlag(1) compressionMethod(1) lang\0 translated\0 [compressed] text
        const cflag = rest[0];
        let p = 2;
        while (p < rest.length && rest[p] !== 0) p++; p++;
        while (p < rest.length && rest[p] !== 0) p++; p++;
        const payload = rest.subarray(p);
        if (cflag) {
          return inflateDecompress(payload).then((raw) => {
            const clean = String(raw || "").trim();
            try { return parseJsonLoose(atob(clean)); } catch { return parseJsonLoose(clean); }
          }).catch(() => null);
        }
        const text = utf8Decoder.decode(payload).trim();
        try { return parseJsonLoose(atob(text)); } catch { return parseJsonLoose(text); }
      }
    }
    off = dataEnd + 4; // skip CRC
  }
  return null;
}

export function tryExtractBase64Json(str) {
  const clean = String(str).replace(/\0/g, "").trim().replace(/^exif:\s*/i, "");
  if (!clean) return null;
  // Strategy 1: whole chunk is base64-encoded JSON
  try {
    const json = JSON.parse(atob(clean));
    if (json && typeof json === "object") return normalizeCard(json);
  } catch { /* fall through */ }
  // Strategy 2: substring base64 scan (some encoders wrap with header bytes)
  const b64Match = clean.match(/[A-Za-z0-9+/]{40,}={0,2}/g);
  if (b64Match) {
    for (const seg of b64Match) {
      try {
        const json = JSON.parse(atob(seg));
        if (json && typeof json === "object" && json.name) return normalizeCard(json);
      } catch { /* continue */ }
    }
  }
  // Strategy 3: chunk is raw JSON
  try {
    const json = parseJsonLoose(clean);
    if (json && typeof json === "object") return normalizeCard(json);
  } catch { /* fall through */ }
  return null;
}

export function scanExifIfdForChara(bytes, view, ifdStart, littleEndian) {
  // Minimal EXIF IFD entry scanner: look for UserComment tag 0x9286
  try {
    const entryCount = view.getUint16(ifdStart, littleEndian);
    for (let i = 0; i < entryCount; i++) {
      const entryOff = ifdStart + 2 + i * 12;
      if (entryOff + 12 > bytes.length) break;
      const tag = view.getUint16(entryOff, littleEndian);
      if (tag !== 0x9286) continue; // UserComment
      const dataType = view.getUint16(entryOff + 2, littleEndian);
      const count = view.getUint32(entryOff + 4, littleEndian);
      let dataOff;
      if (count > 4) {
        dataOff = view.getUint32(entryOff + 8, littleEndian);
      } else {
        dataOff = entryOff + 8;
      }
      if (dataOff + count > bytes.length) break;
      // UserComment starts with 8-byte charset code (ASCII\0\0\0 or UNICODE\0 etc)
      const payload = bytes.subarray(dataOff + 8, dataOff + count);
      const text = utf8Decoder.decode(payload).replace(/\0/g, "").trim();
      if (text) {
        const result = tryExtractBase64Json(text);
        if (result) return result;
      }
      break;
    }
  } catch { /* ignore */ }
  return null;
}

export function parseWebpChara(buf) {
  const view = new DataView(buf);
  if (view.byteLength < 12 || view.getUint32(0) !== 0x52494646) return null;
  const bytes = new Uint8Array(buf);
  let off = 12;
  while (off + 8 <= bytes.length) {
    const type = latin1Decoder.decode(bytes.subarray(off, off + 4));
    const size = view.getUint32(off + 4, true);
    const dataStart = off + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) break;
    if (type === "EXIF" || type === "XMP ") {
      // Strategy A: treat chunk as text and try base64/JSON extraction
      const chunk = latin1Decoder.decode(bytes.subarray(dataStart, dataEnd));
      const found = tryExtractBase64Json(chunk);
      if (found) return found;

      // Strategy B: parse as binary EXIF to find UserComment IFD entry
      if (type === "EXIF") {
        try {
          // EXIF header: 6 bytes "Exif\0\0" then TIFF header
          const exifStart = dataStart + 6;
          if (exifStart + 8 < dataEnd) {
            const byteOrder = view.getUint16(exifStart, true);
            const le = byteOrder === 0x4949; // "II" = little-endian
            const ifd0Offset = view.getUint32(exifStart + 4, le);
            const ifd0Start = exifStart + ifd0Offset;
            if (ifd0Start < dataEnd) {
              const result = scanExifIfdForChara(bytes, new DataView(buf, exifStart), ifd0Offset, le);
              if (result) return result;
            }
          }
        } catch { /* ignore */ }
      }
    }
    off = (dataEnd + 1) & ~1;
  }
  return null;
}
