# chat-archive viewer (M2)

Vite + React + MUI reader for the archive DB. RTL/Hebrew-first. Reads everything from
the `/api` endpoints served by `src/cli/serve.js` — it holds no data itself.

## Run

From the repo root:

```bash
npm run load-projects     # once, after editing ../projects.yaml
npm run viewer:install    # once

# Development (hot reload) — two terminals:
PORT=5199 npm run serve   # API on :5199
npm run viewer:dev        # UI on :5173, proxies /api → :5199

# Production preview:
npm run viewer:build      # → viewer/dist
npm run serve             # serves API + viewer/dist on :5173
```

Set `API_PORT` for the dev proxy if the server runs on a non-default port.

## What it does

- Right sidebar: projects (named via `projects.yaml`), "כל השיחות", "ללא פרויקט", tags, and a search box.
- Middle: conversation list with sort + model + starred filters, or search results.
- Main pane: the conversation, rendered as Markdown, with inline images and file links.
  Toggle "הצג הודעות מוסתרות" to reveal the model's hidden `thoughts`.
  Add/remove tags inline; export the conversation as Markdown or JSON.
- Top bar: "סטטיסטיקות" opens a dashboard (totals, monthly timeline, per-project + per-model bars).
- Conversations deep-link: `?c=<conversation-id>`.

## Notes / future (M5+)

- Search is all-terms FTS5 with a JS-built excerpt (contentless FTS can't `snippet()`).
- Tags are stored in the archive DB (`tags`, `conversation_tags`) via serve.js's write handle;
  archive rows themselves are never mutated.
- Not yet: unified cross-provider projects (needs Claude/Gemini exports), AI summaries, dark mode.
