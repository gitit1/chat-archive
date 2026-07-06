// src/cli/serve.js
// Node shell: read-only HTTP API over data/archive.db for the viewer (M2).
// Also serves attachment files and, in production, the built viewer (viewer/dist).
//
//   node src/cli/serve.js            # http://localhost:5173  (API + built viewer if present)
//   PORT=8080 node src/cli/serve.js
//
// This is a Node shell only — no core logic lives here. It never writes the DB.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'archive.db');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
const DIST_DIR = path.join(ROOT, 'viewer', 'dist');
const PORT = Number(process.env.PORT ?? 5173);
const PROVIDER = 'chatgpt';

if (!existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}. Run: node src/cli/ingest.js <export-dir>`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });

// ---- Prepared queries ----------------------------------------------------------
const q = {
  projects: db.prepare(`
    SELECT p.id, p.name, p.slug, COUNT(c.id) AS count
    FROM projects p
    LEFT JOIN project_aliases pa ON pa.project_id = p.id
    LEFT JOIN conversations c
      ON c.provider = pa.provider AND c.provider_project_id = pa.provider_project_id
    GROUP BY p.id, p.name, p.slug
    ORDER BY count DESC, p.name ASC
  `),
  noProjectCount: db.prepare(
    'SELECT COUNT(*) AS n FROM conversations WHERE provider_project_id IS NULL'
  ),
  totalCount: db.prepare('SELECT COUNT(*) AS n FROM conversations'),
  convsByProject: db.prepare(`
    SELECT c.id, c.title, c.created_at, c.updated_at, c.model, c.message_count,
           c.is_starred, c.is_archived
    FROM conversations c
    JOIN project_aliases pa
      ON pa.provider = c.provider AND pa.provider_project_id = c.provider_project_id
    WHERE pa.project_id = ?
    ORDER BY c.updated_at DESC, c.created_at DESC
  `),
  convsNoProject: db.prepare(`
    SELECT id, title, created_at, updated_at, model, message_count, is_starred, is_archived
    FROM conversations
    WHERE provider_project_id IS NULL
    ORDER BY updated_at DESC, created_at DESC
  `),
  convsAll: db.prepare(`
    SELECT id, title, created_at, updated_at, model, message_count, is_starred, is_archived
    FROM conversations
    ORDER BY updated_at DESC, created_at DESC
  `),
  convMeta: db.prepare(`
    SELECT c.id, c.title, c.created_at, c.updated_at, c.model, c.message_count,
           c.is_starred, c.is_archived, c.provider_project_id, p.name AS project_name, p.id AS project_id
    FROM conversations c
    LEFT JOIN project_aliases pa
      ON pa.provider = c.provider AND pa.provider_project_id = c.provider_project_id
    LEFT JOIN projects p ON p.id = pa.project_id
    WHERE c.id = ?
  `),
  messages: db.prepare(`
    SELECT id, provider_message_id, parent_provider_message_id, role, author_name,
           created_at, model, content_type, text, is_canonical, order_index, is_hidden
    FROM messages
    WHERE conversation_id = ? AND is_canonical = 1
    ORDER BY order_index ASC, id ASC
  `),
  attachmentsForConv: db.prepare(`
    SELECT message_id, provider_file_id, original_name, stored_path, mime, ext, status
    FROM attachments
    WHERE conversation_id = ?
  `),
  attachmentByFileId: db.prepare(`
    SELECT stored_path, mime, original_name FROM attachments
    WHERE provider = ? AND provider_file_id = ? AND stored_path IS NOT NULL
    LIMIT 1
  `),
  // Contentless FTS5 can't produce snippet()/highlight() — pull m.text and build the
  // excerpt in JS instead. rank orders by relevance (bm25).
  search: db.prepare(`
    SELECT m.conversation_id AS conversation_id, c.title AS title,
           c.updated_at AS updated_at, m.role AS role, m.text AS text
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN conversations c ON c.id = m.conversation_id
    WHERE messages_fts MATCH ?
    ORDER BY rank
    LIMIT 100
  `),
};

// ---- Handlers ------------------------------------------------------------------
function getProjects() {
  const projects = q.projects.all().map((r) => ({
    id: r.id, name: r.name, slug: r.slug, count: Number(r.count),
  }));
  return {
    projects,
    noProjectCount: Number(q.noProjectCount.get().n),
    total: Number(q.totalCount.get().n),
  };
}

function getConversations(projectParam) {
  let rows;
  if (projectParam === 'none') rows = q.convsNoProject.all();
  else if (projectParam === 'all' || projectParam == null) rows = q.convsAll.all();
  else rows = q.convsByProject.all(Number(projectParam));
  return rows.map((r) => ({
    id: r.id,
    title: r.title || '(ללא כותרת)',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    model: r.model,
    messageCount: Number(r.message_count ?? 0),
    isStarred: !!r.is_starred,
    isArchived: !!r.is_archived,
  }));
}

function getConversation(id, includeHidden) {
  const meta = q.convMeta.get(id);
  if (!meta) return null;

  const attByMsg = new Map();
  for (const a of q.attachmentsForConv.all(id)) {
    if (!attByMsg.has(a.message_id)) attByMsg.set(a.message_id, []);
    attByMsg.get(a.message_id).push({
      fileId: a.provider_file_id,
      name: a.original_name,
      mime: a.mime,
      ext: a.ext,
      status: a.status,
      url: a.stored_path ? `/api/attachments/${encodeURIComponent(a.provider_file_id)}` : null,
    });
  }

  const messages = q.messages.all(id)
    .filter((m) => includeHidden || !m.is_hidden)
    .map((m) => ({
      id: m.id,
      role: m.role,
      authorName: m.author_name,
      createdAt: m.created_at,
      model: m.model,
      contentType: m.content_type,
      text: m.text,
      isHidden: !!m.is_hidden,
      attachments: attByMsg.get(m.id) ?? [],
    }));

  return {
    id: meta.id,
    title: meta.title || '(ללא כותרת)',
    createdAt: meta.created_at,
    updatedAt: meta.updated_at,
    model: meta.model,
    messageCount: Number(meta.message_count ?? 0),
    isStarred: !!meta.is_starred,
    isArchived: !!meta.is_archived,
    projectId: meta.project_id ?? null,
    projectName: meta.project_name ?? null,
    messages,
  };
}

function ftsQuote(raw) {
  // Wrap each whitespace-separated term in double quotes so punctuation/Hebrew is
  // treated as a literal phrase token; join with AND (space) — user gets all-terms match.
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

/** First ~180-char window around the earliest matching term (case-insensitive). */
function excerpt(text, terms) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return flat.slice(0, 180) + (flat.length > 180 ? '…' : '');
  const start = Math.max(0, at - 60);
  const end = Math.min(flat.length, at + 120);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

function search(term) {
  if (!term || !term.trim()) return { results: [], query: '' };
  const terms = term.trim().split(/\s+/).filter(Boolean);
  const match = ftsQuote(term);
  try {
    const rows = q.search.all(match);
    // Collapse to one hit per conversation (best-ranked first).
    const seen = new Set();
    const results = [];
    for (const r of rows) {
      if (seen.has(r.conversation_id)) continue;
      seen.add(r.conversation_id);
      results.push({
        conversationId: r.conversation_id,
        title: r.title || '(ללא כותרת)',
        updatedAt: r.updated_at,
        role: r.role,
        snippet: excerpt(r.text, terms),
      });
    }
    return { query: term, results };
  } catch (err) {
    return { query: term, results: [], error: err.message };
  }
}

// ---- Static file serving (attachments + built viewer) --------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

async function serveFile(res, filePath, forcedMime) {
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return false;
    const mime = forcedMime || MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': s.size, 'Cache-Control': 'no-cache' });
    createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

// ---- Router --------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/api/projects') return sendJson(res, 200, getProjects());

    if (p === '/api/conversations') {
      return sendJson(res, 200, { conversations: getConversations(url.searchParams.get('project')) });
    }

    const convMatch = p.match(/^\/api\/conversations\/(\d+)$/);
    if (convMatch) {
      const includeHidden = url.searchParams.get('hidden') === '1';
      const conv = getConversation(Number(convMatch[1]), includeHidden);
      return conv ? sendJson(res, 200, conv) : sendJson(res, 404, { error: 'not found' });
    }

    if (p === '/api/search') return sendJson(res, 200, search(url.searchParams.get('q') ?? ''));

    const attMatch = p.match(/^\/api\/attachments\/(.+)$/);
    if (attMatch) {
      const fileId = decodeURIComponent(attMatch[1]);
      const row = q.attachmentByFileId.get(PROVIDER, fileId);
      if (!row?.stored_path) return sendJson(res, 404, { error: 'attachment not found' });
      const abs = path.join(DATA_DIR, row.stored_path);
      // Guard against path traversal — must stay under attachments dir.
      if (!abs.startsWith(ATTACH_DIR)) return sendJson(res, 403, { error: 'forbidden' });
      const ok = await serveFile(res, abs, row.mime || undefined);
      if (!ok) return sendJson(res, 404, { error: 'file missing on disk' });
      return;
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown endpoint' });

    // ---- Built viewer (production). In dev, Vite serves the UI and proxies /api here.
    if (existsSync(DIST_DIR)) {
      const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      const abs = path.join(DIST_DIR, rel);
      if (abs.startsWith(DIST_DIR) && (await serveFile(res, abs))) return;
      // SPA fallback.
      if (await serveFile(res, path.join(DIST_DIR, 'index.html'))) return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('chat-archive API is running. Build the viewer (cd viewer && npm run build) or run the Vite dev server.');
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`chat-archive server on http://localhost:${PORT}`);
  console.log(existsSync(DIST_DIR) ? 'Serving built viewer from viewer/dist' : 'Viewer not built — run the Vite dev server for the UI');
});
