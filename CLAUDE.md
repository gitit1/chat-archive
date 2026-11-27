# chat-archive

Local-first, private archive viewer for AI chat exports (ChatGPT now; Claude + Gemini later).
Standalone project — NOT part of Homebase.

## The contract
Read `docs/SCHEMA.md` before touching anything. Key rules:
- `src/core/` = pure environment-agnostic JS (no fs/path/Node globals) — it must run in the
  browser later (users will process their own export zips fully client-side).
- `src/cli/` = Node shell (file IO, SQLite via `node:sqlite`).
- Raw export folders are read-only. Derived data goes to `data/` (gitignored).
- Ingest is idempotent; nothing is dropped silently — everything unparseable is reported.

## Layout
- `src/core/providers/chatgpt.js` — export parser → canonical objects
- `src/core/filetype.js` — magic-byte file type sniffing
- `src/cli/ingest.js` — entry: `node src/cli/ingest.js <export-dir>`
- `src/cli/db.js`, `src/cli/attachments.js`
- `src/cli/load-projects.js` — loads projects.yaml → projects/project_aliases tables (idempotent)
- `src/cli/serve.js` — read-only HTTP API over archive.db + serves attachments and the built viewer
- `viewer/` — Vite + React + MUI viewer (RTL/Hebrew). Talks to /api; dev server proxies to serve.js
- `data/archive.db`, `data/attachments/`, `data/reports/`
- `projects.yaml` — human-edited: names for provider project ids

## Running the viewer (M2–M4)
Ports come from the global dev-ports registry (`~/.claude/skills/dev-ports`):
API = **5200**, viewer dev = **5201**. Never use 5173/5174 (banned, Vite defaults).
1. `npm run load-projects`            # once, after editing projects.yaml names
2. `npm run viewer:install`           # once
3. Dev: `npm run serve` + `npm run viewer:dev` → http://localhost:5201
   Prod: `npm run viewer:build` then `npm run serve` → http://localhost:5200 (serves viewer/dist)
   (Port override, PowerShell: `$env:PORT=…; npm run serve`; Vite proxy target: `$env:API_PORT=…`)
- API (read-only archive): /api/projects, /api/models, /api/stats,
  /api/conversations?project=<id|none|all>&tag=&model=&starred=1&sort=<recent|oldest|messages|title>,
  /api/conversations/:id[?hidden=1], /api/search?q=, /api/attachments/:fileId,
  /api/export/conversation/:id.(md|json). Conversations deep-link via ?c=<id>.
- API (read/write, user data ONLY): POST /api/conversations/:id/tags {name},
  DELETE /api/conversations/:id/tags/:tagId. Tags live in tags + conversation_tags tables
  (created by serve.js on a second read/write handle; archive rows are never mutated).

## Current data
User's ChatGPT export (read-only):
`c:\Users\gitit\Git\Workplace\read-from-export\730ec111...f1a8\`
678 conversations, 18 projects (g-p-*), 900 .dat attachments, mostly Hebrew (viewer needs RTL).

## Roadmap
M1 ingest (done) · M2 viewer MVP (done: sidebar/list/chat/markdown/attachments/search) ·
M3 search/filters (done: sort, model+starred filters, tag filter, FTS search) ·
M4 tags+export+stats (done: tag editor, MD/JSON export, stats dashboard) ·
M5 Claude/Gemini adapters + unified projects (BLOCKED: need real Claude/Gemini exports to build against) ·
M6 AI features (summaries, orphan classification — needs Claude API access/opt-in; 175 project-less chats).

Note: viewer is a Node-shell server for now (src/cli/serve.js). The future browser-only goal
(client-side zip processing) is unchanged — src/core/ stays pure; only the shell would be swapped.
