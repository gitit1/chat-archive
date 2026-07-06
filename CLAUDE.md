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
- `data/archive.db`, `data/attachments/`, `data/reports/`
- `projects.yaml` — human-edited: names for provider project ids

## Current data
User's ChatGPT export (read-only):
`c:\Users\gitit\Git\Workplace\read-from-export\730ec111...f1a8\`
678 conversations, 19 projects (g-p-*), 900 .dat attachments, mostly Hebrew (viewer needs RTL).

## Roadmap
M1 ingest (done→verify) · M2 React viewer MVP · M3 search/filters · M4 tags+export+stats ·
M5 Claude/Gemini adapters + unified projects · M6 AI features (summaries, orphan classification).
