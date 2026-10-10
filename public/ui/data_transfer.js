// Browser data transfer: cookie serialization, backup download and file reading.
//
// Zero-backend client helpers for packaging and restoring the browser state.

/**
 * Reads all readable cookies from `document.cookie`.
 * Returns an array of `{ name, value }` objects.
 */
export function readBrowserCookies() {
  if (typeof document === "undefined" || !document.cookie) return [];
  const result = [];
  const pairs = document.cookie.split(";");
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      result.push({ name: trimmed, value: "" });
    } else {
      const name = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (name) result.push({ name, value });
    }
  }
  return result;
}

/**
 * Restores an array of `{ name, value }` objects to `document.cookie`.
 */
export function restoreBrowserCookies(cookies = []) {
  if (typeof document === "undefined" || !Array.isArray(cookies)) return;
  for (const c of cookies) {
    if (!c || !c.name) continue;
    const name = String(c.name).trim();
    const val = String(c.value ?? "").trim();
    document.cookie = `${name}=${val}; path=/; max-age=31536000; SameSite=Lax`;
  }
}

/**
 * Clears all readable cookies by setting their expiration in the past.
 */
export function clearBrowserCookies() {
  if (typeof document === "undefined" || !document.cookie) return;
  const pairs = document.cookie.split(";");
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    const name = eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx).trim();
    if (name) {
      document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0; SameSite=Lax`;
    }
  }
}

/**
 * Formats a timestamp into a filesystem-safe date string: YYYY-MM-DD-HHmm.
 */
function fileTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${y}-${m}-${d}-${h}${min}`;
}

/**
 * Triggers a client-side download of the full backup document.
 * Returns the downloaded filename.
 */
export function downloadBackupFile(backupData, filename = null) {
  const name = filename || `vibe-rp-backup-${fileTimestamp()}.json`;
  const jsonText = JSON.stringify(backupData, null, 2);
  const blob = new Blob([jsonText], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 100);
  return name;
}

/**
 * Reads a File or Blob and returns the parsed JSON document.
 * Throws a descriptive error if the file is not valid JSON.
 */
export async function readBackupFile(file) {
  if (!file) throw new Error("No file selected.");
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error("The selected file is not valid JSON.");
  }
}
