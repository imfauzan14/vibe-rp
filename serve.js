// Bun static file server with SPA-style routing for Vibe RP
// Maps /chat -> chat.html and / -> index.html; settings routes open the library modal.
import { resolve, sep } from "path";

const PUBLIC = resolve(import.meta.dir, "public");

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
const PORT = 3000;

const ROUTES = {
  "/": "index.html",
  "/chat": "chat.html",
};

Bun.serve({
  port: PORT,
  async fetch(req) {
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
    if (!filePath) return new Response("Not found", { status: 404 });

    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Vibe RP dev server running at http://localhost:${PORT}`);
