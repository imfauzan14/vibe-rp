// Bun static file server with SPA-style routing for Vibe RP
// Maps /chat -> chat.html and / -> index.html; settings routes open the library modal.
import { resolve, sep } from "path";

const PUBLIC = resolve(import.meta.dir, "public");

// Security headers applied to every response (HTML, static assets, 404, and
// redirects). Kept as one constant so serve.js and vercel.json cannot drift.
//
// CSP decisions:
//   - script-src is 'self' only: there are NO inline <script> blocks in the
//     app, so there is nothing to hash. index.html's pre-paint theme boot is
//     theme-boot.js and chat.html's bootstrap is ui/chat/chat_boot.js, both
//     loaded with <script src>, which 'self' already covers. A SHA-256 hash
//     used to pin chat.html's inline module, but it silently drifted from the
//     served bytes (whitespace and line-ending edits) and killed the whole
//     chat app; extracting the block removes that failure mode. Keeping
//     'unsafe-inline' out of script-src still means an injected inline script
//     cannot execute.
//   - style-src needs 'unsafe-inline': chat.html carries inline style
//     attributes (several computed at runtime) and 404.html carries an inline
//     <style> block. A hash cannot cover a runtime-computed style attribute,
//     so 'unsafe-inline' is the only option short of refactoring those styles
//     into classes. Style injection is a far weaker primitive than script
//     injection, which is why script-src stays free of 'unsafe-inline'.
//   - connect-src * is required by design: this client talks directly to the
//     arbitrary OpenAI-compatible endpoint the user configures, whose origin
//     is unknown at build time. Nothing is proxied, so the browser must be
//     allowed to open that connection.
//   - img-src allows data: (locally compressed avatars) and https: (remote
//     card art). Plain http: images are deliberately excluded.
//   - HSTS is NOT set here: this is a plain-HTTP dev server and an HSTS header
//     on localhost would poison the browser. It is set at deploy time in
//     vercel.json, which is HTTPS-only.
const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: https:",
    "connect-src *",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "X-Frame-Options": "DENY",
};

function safePublicPath(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPath.includes("\0")) return null;

  const filePath = resolve(PUBLIC, `.${decodedPath}`);
  if (filePath !== PUBLIC && !filePath.startsWith(`${PUBLIC}${sep}`)) return null;
  return filePath;
}
function notFound() {
  return new Response(Bun.file(safePublicPath("/404.html")), {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
const PORT = 3000;

const ROUTES = {
  "/": "index.html",
  "/chat": "chat.html",
};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const response = await handleRequest(req);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      response.headers.set(name, value);
    }
    return response;
  },
});

async function handleRequest(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Redirect redundant standalone settings/directives/personas pages to unified modal in library
    if (pathname === "/settings" || pathname === "/directives" || pathname === "/personas") {
      let target = "/?openSettings=1";
      if (pathname === "/directives") target += "&tab=settings-system-prompts-tab";
      else if (pathname === "/personas") target += "&tab=settings-personas-tab";
      return new Response(null, {
        status: 302,
        headers: { Location: target },
      });
    }

    // Route → HTML mapping
    const htmlFile = ROUTES[pathname] ?? ROUTES[pathname.replace(/\/$/, "")] ?? null;
    if (htmlFile) {
      const file = Bun.file(safePublicPath(`/${htmlFile}`));
      return new Response(file, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // Static assets (js, css, fonts, etc.)
    const filePath = safePublicPath(pathname);
    if (!filePath) return notFound();

    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    return notFound();
}

console.log(`Vibe RP dev server running at http://localhost:${PORT}`);
