# Vibe RP

Vibe RP is a browser-first roleplay client for importing character cards, managing personas and directives, and continuing local chat sessions through any OpenAI-compatible streaming API.

Cards, sessions, personas, directives, and settings stay in the browser. The server only serves the static client and maps the `/chat` route.

## Quickstart

Prerequisites: [Bun](https://bun.sh/).

```bash
bun install
bun run start
```

Open `http://localhost:3000`.

Run the tests with:

```bash
bun test test/
```

## Configuration

Open Settings in the app and enter an OpenAI-compatible API base URL and model. Use **Fetch Models** when the provider exposes `GET /models`. The client sends streaming `POST /chat/completions` requests directly from the browser.

API keys and all application data are stored locally in the browser. No server-side API proxy or database is included.

`.env.example` documents optional local environment values. The current static server listens on port `3000`.

## Routes

- `/` — character library and settings modal
- `/chat` — roleplay conversation view
- `/settings` — redirects to the library settings modal
- `/directives` — redirects to the system prompts tab
- `/personas` — redirects to the personas tab

## Project layout

```text
public/
  index.html          Character library and settings modal
  chat.html           Roleplay conversation view
  browser_engine.js   Prompt assembly and browser streaming
  local_db.js         IndexedDB and localStorage persistence
  editorial.css       Shared styles
serve.js               Bun static server
package.json           Scripts and metadata
test/                  Bun tests for shipped client behavior
```

## Character cards

The library accepts Character Card v1, v2, and v3 JSON/JSONC files, plus PNG and WebP files containing embedded card metadata. Imported cards, conversations, and profile images remain local to the browser.

## License

MIT — Free for personal and commercial use.
