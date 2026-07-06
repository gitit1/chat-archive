// src/cli/db.js
// Node shell: opens/creates data/archive.db (node:sqlite) with the exact schema from
// docs/SCHEMA.md and provides idempotent upsert helpers.
//
// Idempotency (SCHEMA.md rule 4): dedupe on (provider, provider_conversation_id).
// On conflict, replace the conversation + its messages only when the incoming
// updated_at is newer; FTS rows of replaced messages are removed first (contentless
// FTS5 requires the special 'delete' command with the original column values).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA_SQL = `
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
  text, title, content='',
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

/**
 * Open (creating if needed) the archive database and prepare all statements.
 * @param {string} dbPath e.g. "data/archive.db"
 */
export function openDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);

  const stmt = {
    findConv: db.prepare(
      'SELECT id, updated_at, title FROM conversations WHERE provider = ? AND provider_conversation_id = ?'
    ),
    insertConv: db.prepare(
      `INSERT INTO conversations
         (provider, provider_conversation_id, title, created_at, updated_at, model,
          provider_project_id, gizmo_id, is_starred, is_archived, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    updateConv: db.prepare(
      `UPDATE conversations SET title = ?, created_at = ?, updated_at = ?, model = ?,
         provider_project_id = ?, gizmo_id = ?, is_starred = ?, is_archived = ?, message_count = ?
       WHERE id = ?`
    ),
    insertMsg: db.prepare(
      `INSERT INTO messages
         (conversation_id, provider_message_id, parent_provider_message_id, role, author_name,
          created_at, model, content_type, text, is_canonical, order_index, is_hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    selectMsgsForFts: db.prepare(
      'SELECT id, text FROM messages WHERE conversation_id = ? AND is_canonical = 1 AND is_hidden = 0'
    ),
    deleteMsgs: db.prepare('DELETE FROM messages WHERE conversation_id = ?'),
    deleteAttachmentsForConv: db.prepare('DELETE FROM attachments WHERE conversation_id = ?'),
    ftsInsert: db.prepare('INSERT INTO messages_fts (rowid, text, title) VALUES (?, ?, ?)'),
    ftsDelete: db.prepare(
      "INSERT INTO messages_fts (messages_fts, rowid, text, title) VALUES ('delete', ?, ?, ?)"
    ),
    insertAttachment: db.prepare(
      `INSERT OR IGNORE INTO attachments
         (provider, provider_file_id, conversation_id, message_id, original_name,
          stored_path, mime, ext, size_bytes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    selectNonOrphanFileIds: db.prepare(
      "SELECT DISTINCT provider_file_id FROM attachments WHERE provider = ? AND status != 'orphan_file'"
    ),
    selectOrphanFileIds: db.prepare(
      "SELECT DISTINCT provider_file_id FROM attachments WHERE provider = ? AND status = 'orphan_file'"
    ),
    deleteOrphanRow: db.prepare(
      "DELETE FROM attachments WHERE provider = ? AND provider_file_id = ? AND status = 'orphan_file'"
    ),
    insertSource: db.prepare(
      `INSERT INTO sources (provider, export_path, imported_at, conversations_count, messages_count)
       VALUES (?, ?, ?, ?, ?)`
    ),
  };

  const bool = (v) => (v ? 1 : 0);

  /** Insert all messages of a conversation; index canonical+visible ones in FTS. */
  function insertMessages(conversationId, conv) {
    const messageIds = new Map(); // providerMessageId → messages.id
    for (const msg of conv.messages) {
      const { lastInsertRowid } = stmt.insertMsg.run(
        conversationId,
        msg.providerMessageId ?? null,
        msg.parentProviderMessageId ?? null,
        msg.role ?? 'unknown',
        msg.authorName ?? null,
        msg.createdAt ?? null,
        msg.model ?? null,
        msg.contentType ?? null,
        msg.text ?? '',
        bool(msg.isCanonical),
        msg.orderIndex ?? -1,
        bool(msg.isHidden)
      );
      const rowid = Number(lastInsertRowid);
      messageIds.set(msg.providerMessageId, rowid);
      if (msg.isCanonical && !msg.isHidden) {
        stmt.ftsInsert.run(rowid, msg.text ?? '', conv.title ?? '');
      }
    }
    return messageIds;
  }

  return {
    raw: db,
    begin: () => db.exec('BEGIN'),
    commit: () => db.exec('COMMIT'),
    rollback: () => db.exec('ROLLBACK'),
    close: () => db.close(),

    /**
     * Idempotent conversation upsert.
     * @param {string} provider
     * @param {object} conv canonical Conversation
     * @returns {{ status: 'written'|'replaced'|'skipped', conversationId: number|null,
     *             messageIds: Map<string, number>|null }}
     */
    upsertConversation(provider, conv) {
      const existing = stmt.findConv.get(provider, conv.providerConversationId);

      if (!existing) {
        const { lastInsertRowid } = stmt.insertConv.run(
          provider,
          conv.providerConversationId,
          conv.title ?? '',
          conv.createdAt ?? null,
          conv.updatedAt ?? null,
          conv.model ?? null,
          conv.providerProjectId ?? null,
          conv.gizmoId ?? null,
          bool(conv.isStarred),
          bool(conv.isArchived),
          conv.messages.length
        );
        const conversationId = Number(lastInsertRowid);
        const messageIds = insertMessages(conversationId, conv);
        return { status: 'written', conversationId, messageIds };
      }

      const conversationId = Number(existing.id);
      const incoming = conv.updatedAt ?? conv.createdAt ?? 0;
      const current = existing.updated_at ?? 0;
      if (!(incoming > current)) {
        return { status: 'skipped', conversationId, messageIds: null };
      }

      // Replace: purge old FTS rows (contentless table → 'delete' command needs the
      // original values), old attachment rows, then old messages.
      for (const row of stmt.selectMsgsForFts.all(conversationId)) {
        stmt.ftsDelete.run(Number(row.id), row.text ?? '', existing.title ?? '');
      }
      stmt.deleteAttachmentsForConv.run(conversationId);
      stmt.deleteMsgs.run(conversationId);
      stmt.updateConv.run(
        conv.title ?? '',
        conv.createdAt ?? null,
        conv.updatedAt ?? null,
        conv.model ?? null,
        conv.providerProjectId ?? null,
        conv.gizmoId ?? null,
        bool(conv.isStarred),
        bool(conv.isArchived),
        conv.messages.length,
        conversationId
      );
      const messageIds = insertMessages(conversationId, conv);
      return { status: 'replaced', conversationId, messageIds };
    },

    /**
     * Insert an attachment row (INSERT OR IGNORE on (provider, file id, message_id)).
     * @param {{provider: string, providerFileId: string, conversationId: number|null,
     *          messageId: number|null, originalName: string|null, storedPath: string|null,
     *          mime: string|null, ext: string|null, sizeBytes: number|null, status: string}} row
     */
    insertAttachment(row) {
      stmt.insertAttachment.run(
        row.provider,
        row.providerFileId,
        row.conversationId ?? null,
        row.messageId ?? null,
        row.originalName ?? null,
        row.storedPath ?? null,
        row.mime ?? null,
        row.ext ?? null,
        row.sizeBytes ?? null,
        row.status
      );
    },

    /** File ids that appear in any non-orphan attachment row for this provider. */
    referencedFileIds(provider) {
      return new Set(stmt.selectNonOrphanFileIds.all(provider).map((r) => r.provider_file_id));
    },

    /** File ids currently recorded as orphan_file rows for this provider. */
    orphanFileIds(provider) {
      return new Set(stmt.selectOrphanFileIds.all(provider).map((r) => r.provider_file_id));
    },

    /** Remove an orphan_file row (the file became referenced by a message). */
    deleteOrphanRow(provider, providerFileId) {
      stmt.deleteOrphanRow.run(provider, providerFileId);
    },

    /** DB-wide attachment counts by status for this provider. */
    attachmentStatusCounts(provider) {
      const rows = db
        .prepare('SELECT status, COUNT(*) AS n FROM attachments WHERE provider = ? GROUP BY status')
        .all(provider);
      return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    },

    insertSource(provider, exportPath, importedAt, conversationsCount, messagesCount) {
      const { lastInsertRowid } = stmt.insertSource.run(
        provider, exportPath, importedAt, conversationsCount, messagesCount
      );
      return Number(lastInsertRowid);
    },
  };
}
