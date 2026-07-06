# Chat Archive — Canonical Schema Contract (v1)

This is the binding contract for all code in this repo. Provider adapters (ChatGPT, Claude,
Gemini) normalize INTO this schema; the viewer reads FROM it. Nothing else touches raw exports.

## Hard rules

1. **Raw exports are read-only.** Never write inside an export folder.
2. **`src/core/` is environment-agnostic.** Pure JS (ESM), no `node:fs`, no `node:path`, no
   Node globals. Core receives file *contents* (strings/Uint8Array) or async reader callbacks,
   never file paths. This is non-negotiable: core must run in the browser later (users will
   process their own zips client-side).
3. **`src/cli/` is the Node shell.** It reads files, feeds core, writes the DB. Node-only code
   lives here.
4. **Idempotent ingest.** Re-running on the same or a newer export must not duplicate rows.
   Dedupe key: `(provider, provider_conversation_id)`. On conflict, replace the conversation
   and its messages if the incoming `updated_at` is newer.
5. **Nothing dropped silently.** Anything the parser cannot handle is counted and listed in the
   ingest report with conversation id + reason.

## Canonical objects (what adapters emit)

```
Conversation {
  providerConversationId: string   // ChatGPT: conversation_id
  title: string
  createdAt: number                // unix seconds (float ok)
  updatedAt: number | null
  model: string | null             // default_model_slug
  providerProjectId: string | null // ChatGPT: conversation_template_id when it starts with "g-p-"
  gizmoId: string | null           // custom GPT id (g-XXXX, not a project)
  isStarred: boolean
  isArchived: boolean
  messages: Message[]              // ALL nodes incl. branches, in tree order
}

Message {
  providerMessageId: string
  parentProviderMessageId: string | null
  role: 'user' | 'assistant' | 'system' | 'tool'
  authorName: string | null        // tool/plugin name when role=tool
  createdAt: number | null
  model: string | null             // metadata.model_slug
  contentType: string              // original provider content_type (text, code, multimodal_text, thoughts, ...)
  text: string                     // flattened human-readable text ('' allowed)
  isCanonical: boolean             // on the path from root to current_node
  orderIndex: number               // position within the canonical path; branches get -1
  isHidden: boolean                // metadata.is_visually_hidden_from_conversation, empty system roots, etc.
  attachmentRefs: AttachmentRef[]  // provider file ids referenced by this message
}

AttachmentRef {
  providerFileId: string           // "file-XXXX" (strip any "file-service://" / "sediment://" prefix)
  name: string | null              // original filename if the message metadata has it
  mimeHint: string | null
  width/height: number | null      // for images if present
}
```

### ChatGPT tree → canonical path
Walk `mapping` from `current_node` up via `parent` to the root: that chain (reversed) is the
canonical path (`isCanonical=true`, `orderIndex` = 0..n along it). All other nodes are branch
messages (`isCanonical=false`, `orderIndex=-1`) and must still be emitted with their parent ids.
Nodes with `message: null` are structural — skip them but bridge parentage.

### ChatGPT content types → text flattening
- `text` → join `parts` with `\n`
- `code` → fenced code block with `metadata.language` if any
- `multimodal_text` → parts: strings pass through; `image_asset_pointer` parts become an
  AttachmentRef + placeholder line `[image: <file-id>]`
- `thoughts` / `reasoning_recap` → keep, `isHidden=true` unless recap
- `execution_output`, `tether_quote`, `tether_browsing_display`, `user_editable_context`,
  `model_editable_context`, anything else → best-effort text, never throw; count unknown
  content types in the report.
- Also scan `message.metadata.attachments` (id, name, mime_type, size) → AttachmentRefs.

## SQLite schema (built by src/cli/db.js)

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,              -- 'chatgpt' | 'claude' | 'gemini'
  export_path TEXT NOT NULL,
  imported_at TEXT NOT NULL,           -- ISO
  conversations_count INTEGER,
  messages_count INTEGER
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS project_aliases (
  provider TEXT NOT NULL,
  provider_project_id TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  PRIMARY KEY (provider, provider_project_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_conversation_id TEXT NOT NULL,
  title TEXT,
  created_at REAL,
  updated_at REAL,
  model TEXT,
  provider_project_id TEXT,            -- raw g-p-... ; joined to projects via project_aliases
  gizmo_id TEXT,
  is_starred INTEGER DEFAULT 0,
  is_archived INTEGER DEFAULT 0,
  message_count INTEGER,
  UNIQUE (provider, provider_conversation_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  provider_message_id TEXT,
  parent_provider_message_id TEXT,
  role TEXT NOT NULL,
  author_name TEXT,
  created_at REAL,
  model TEXT,
  content_type TEXT,
  text TEXT NOT NULL DEFAULT '',
  is_canonical INTEGER NOT NULL DEFAULT 1,
  order_index INTEGER NOT NULL DEFAULT -1,
  is_hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, order_index);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_file_id TEXT NOT NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  original_name TEXT,
  stored_path TEXT,                    -- relative to data/, e.g. attachments/file-XXX.png
  mime TEXT,
  ext TEXT,
  size_bytes INTEGER,
  status TEXT NOT NULL                 -- 'matched' | 'orphan_file' | 'missing_file'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attach_file
  ON attachments(provider, provider_file_id, message_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, title, content='',            -- contentless; we insert explicitly
  tokenize = 'unicode61 remove_diacritics 2'
);
-- fts rowid == messages.id ; only canonical, non-hidden messages are indexed.
```

## Attachment resolution (src/core/filetype.js + src/cli/attachments.js)

- Export contains `file-*.dat` files (extensions stripped) and `conversation_asset_file_names.json`
  (inspect its actual structure before coding against it).
- Detect real type by magic bytes: png, jpg, gif, webp, pdf, zip/docx/xlsx/pptx, mp3, mp4, wav,
  webm, svg/xml, json, plain text (utf8 heuristic), else 'bin'.
- CLI copies each matched file to `data/attachments/<file-id>.<ext>` (raw export untouched).
- Statuses: file referenced by a message and present → `matched`; present on disk but never
  referenced → `orphan_file`; referenced but no .dat on disk → `missing_file`.

## Ingest report (data/reports/ingest-<date>.md)

Totals (conversations, messages canonical/branch/hidden, attachments by status), per-project
conversation counts, unknown content types with counts, skipped/errored conversations with ids,
date range, per-file parse timing. Reconciliation line: parsed conversation count MUST equal
raw JSON array lengths summed; if not, list the delta ids.
