// src/cli/serve.js
// Node shell: HTTP API over data/archive.db for the viewer (M2–M4).
// - Read-only for archive data (conversations, messages, attachments, search, stats).
// - Read/write for user-owned data ONLY: tags (tags, conversation_tags tables).
// Also serves attachment files and, in production, the built viewer (viewer/dist).
//
//   node src/cli/serve.js            # http://localhost:5173
//   PORT=8080 node src/cli/serve.js
//
// No core logic lives here — this is a Node shell. Archive rows are never mutated.

import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
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

// Read path (archive) is a separate read-only handle; write path (tags) is read/write.
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const wdb = new DatabaseSync(DB_PATH);
wdb.exec('PRAGMA journal_mode = WAL;');
wdb.exec(`
  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    color TEXT
  );
  CREATE TABLE IF NOT EXISTS conversation_tags (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, tag_id)
  );
`);

// A soft palette for auto-assigned tag colors (index by tag id).
const TAG_COLORS = ['#3f6ad8', '#2e9e83', '#c2410c', '#7c3aed', '#b91c1c', '#0e7490', '#a16207', '#be185d'];

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
  noProjectCount: db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE provider_project_id IS NULL'),
  totalCount: db.prepare('SELECT COUNT(*) AS n FROM conversations'),
  models: db.prepare(`
    SELECT model, COUNT(*) AS n FROM conversations
    WHERE model IS NOT NULL AND model != ''
    GROUP BY model ORDER BY n DESC
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
    FROM attachments WHERE conversation_id = ?
  `),
  attachmentByFileId: db.prepare(`
    SELECT stored_path, mime, original_name FROM attachments
    WHERE provider = ? AND provider_file_id = ? AND stored_path IS NOT NULL LIMIT 1
  `),
  search: db.prepare(`
    SELECT m.conversation_id AS conversation_id, c.title AS title,
           c.updated_at AS updated_at, m.role AS role, m.text AS text
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN conversations c ON c.id = m.conversation_id
    WHERE messages_fts MATCH ?
    ORDER BY rank LIMIT 100
  `),
  // Stats
  statMessages: db.prepare('SELECT COUNT(*) AS n FROM messages'),
  statVisibleMessages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE is_hidden = 0'),
  statByMonth: db.prepare(`
    SELECT strftime('%Y-%m', created_at, 'unixepoch') AS month, COUNT(*) AS n
    FROM conversations WHERE created_at IS NOT NULL
    GROUP BY month ORDER BY month ASC
  `),
  statByModel: db.prepare(`
    SELECT COALESCE(NULLIF(model, ''), '(לא ידוע)') AS model, COUNT(*) AS n
    FROM conversations GROUP BY model ORDER BY n DESC LIMIT 12
  `),
  statAttachments: db.prepare('SELECT status, COUNT(*) AS n FROM attachments GROUP BY status'),
  statStarred: db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE is_starred = 1'),
  // Tags
  allTags: db.prepare(`
    SELECT t.id, t.name, t.color, COUNT(ct.conversation_id) AS count
    FROM tags t JOIN conversation_tags ct ON ct.tag_id = t.id
    GROUP BY t.id, t.name, t.color ORDER BY count DESC, t.name ASC
  `),
  tagsForConv: db.prepare(`
    SELECT t.id, t.name, t.color FROM conversation_tags ct
    JOIN tags t ON t.id = ct.tag_id WHERE ct.conversation_id = ? ORDER BY t.name
  `),
};

// Tag write statements (on wdb).
const w = {
  findTag: wdb.prepare('SELECT id, name, color FROM tags WHERE name = ?'),
  insertTag: wdb.prepare('INSERT INTO tags (name, color) VALUES (?, ?)'),
  linkTag: wdb.prepare('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id) VALUES (?, ?)'),
  unlinkTag: wdb.prepare('DELETE FROM conversation_tags WHERE conversation_id = ? AND tag_id = ?'),
  convExists: wdb.prepare('SELECT 1 FROM conversations WHERE id = ?'),
};

// ---- Conversation list (filters + sort) ----------------------------------------
function buildConversationQuery({ project, tag, model, starred, sort }) {
  const where = [];
  const params = [];
  let join = '';

  if (project === 'none') where.push('c.provider_project_id IS NULL');
  else if (project && project !== 'all') {
    join += ` JOIN project_aliases pa ON pa.provider = c.provider AND pa.provider_project_id = c.provider_project_id AND pa.project_id = ?`;
    params.push(Number(project));
  }
  if (tag) {
    join += ' JOIN conversation_tags ct ON ct.conversation_id = c.id AND ct.tag_id = ?';
    params.push(Number(tag));
  }
  if (model) { where.push('c.model = ?'); params.push(model); }
  if (starred === '1') where.push('c.is_starred = 1');

  const order = {
    recent: 'c.updated_at DESC, c.created_at DESC',
    oldest: 'c.created_at ASC',
    messages: 'c.message_count DESC',
    title: 'c.title ASC',
  }[sort] || 'c.updated_at DESC, c.created_at DESC';

  const sql = `
    SELECT c.id, c.title, c.created_at, c.updated_at, c.model, c.message_count,
           c.is_starred, c.is_archived
    FROM conversations c${join}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${order}`;
  return { sql, params };
}

function getConversations(opts) {
  const { sql, params } = buildConversationQuery(opts);
  const rows = db.prepare(sql).all(...params);
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

function convMessages(id, includeHidden) {
  const attByMsg = new Map();
  for (const a of q.attachmentsForConv.all(id)) {
    if (!attByMsg.has(a.message_id)) attByMsg.set(a.message_id, []);
    attByMsg.get(a.message_id).push({
      fileId: a.provider_file_id, name: a.original_name, mime: a.mime, ext: a.ext, status: a.status,
      url: a.stored_path ? `/api/attachments/${encodeURIComponent(a.provider_file_id)}` : null,
    });
  }
  return q.messages.all(id)
    .filter((m) => includeHidden || !m.is_hidden)
    .map((m) => ({
      id: m.id, role: m.role, authorName: m.author_name, createdAt: m.created_at,
      model: m.model, contentType: m.content_type, text: m.text, isHidden: !!m.is_hidden,
      attachments: attByMsg.get(m.id) ?? [],
    }));
}

function getConversation(id, includeHidden) {
  const meta = q.convMeta.get(id);
  if (!meta) return null;
  return {
    id: meta.id, title: meta.title || '(ללא כותרת)', createdAt: meta.created_at,
    updatedAt: meta.updated_at, model: meta.model, messageCount: Number(meta.message_count ?? 0),
    isStarred: !!meta.is_starred, isArchived: !!meta.is_archived,
    projectId: meta.project_id ?? null, projectName: meta.project_name ?? null,
    tags: q.tagsForConv.all(id),
    messages: convMessages(id, includeHidden),
  };
}

// ---- Search --------------------------------------------------------------------
function ftsQuote(raw) {
  return raw.trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}
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
  const start = Math.max(0, at - 60), end = Math.min(flat.length, at + 120);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}
function search(term) {
  if (!term || !term.trim()) return { results: [], query: '' };
  const terms = term.trim().split(/\s+/).filter(Boolean);
  try {
    const rows = q.search.all(ftsQuote(term));
    const seen = new Set(), results = [];
    for (const r of rows) {
      if (seen.has(r.conversation_id)) continue;
      seen.add(r.conversation_id);
      results.push({
        conversationId: r.conversation_id, title: r.title || '(ללא כותרת)',
        updatedAt: r.updated_at, role: r.role, snippet: excerpt(r.text, terms),
      });
    }
    return { query: term, results };
  } catch (err) {
    return { query: term, results: [], error: err.message };
  }
}

// ---- Stats ---------------------------------------------------------------------
function getStats() {
  const attachments = {};
  for (const r of q.statAttachments.all()) attachments[r.status] = Number(r.n);
  return {
    totalConversations: Number(q.totalCount.get().n),
    totalMessages: Number(q.statMessages.get().n),
    visibleMessages: Number(q.statVisibleMessages.get().n),
    starred: Number(q.statStarred.get().n),
    projects: q.projects.all().map((r) => ({ name: r.name, count: Number(r.count) })),
    noProject: Number(q.noProjectCount.get().n),
    byMonth: q.statByMonth.all().map((r) => ({ month: r.month, count: Number(r.n) })),
    byModel: q.statByModel.all().map((r) => ({ model: r.model, count: Number(r.n) })),
    attachments,
  };
}

// ---- Tags (write) --------------------------------------------------------------
function addTag(conversationId, name) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('tag name required');
  if (!w.convExists.get(conversationId)) return null;
  let tag = w.findTag.get(clean);
  if (!tag) {
    const id = Number(w.insertTag.run(clean, null).lastInsertRowid);
    tag = { id, name: clean, color: TAG_COLORS[id % TAG_COLORS.length] };
    // Persist the auto color so it's stable.
    wdb.prepare('UPDATE tags SET color = ? WHERE id = ?').run(tag.color, id);
  }
  w.linkTag.run(conversationId, tag.id);
  return tag;
}
function removeTag(conversationId, tagId) {
  w.unlinkTag.run(conversationId, Number(tagId));
}

// ---- Export --------------------------------------------------------------------
const ROLE_LABEL = { user: 'You', assistant: 'ChatGPT', tool: 'Tool', system: 'System' };
function exportMarkdown(id) {
  const conv = getConversation(id, false);
  if (!conv) return null;
  const lines = [`# ${conv.title}`, ''];
  if (conv.projectName) lines.push(`**Project:** ${conv.projectName}  `);
  if (conv.model) lines.push(`**Model:** ${conv.model}  `);
  lines.push(`**Created:** ${conv.createdAt ? new Date(conv.createdAt * 1000).toISOString() : 'n/a'}`, '', '---', '');
  for (const m of conv.messages) {
    lines.push(`### ${ROLE_LABEL[m.role] ?? m.role}`, '');
    if (m.text) lines.push(m.text, '');
    for (const a of m.attachments) {
      if (a.url) lines.push(`![${a.name || a.fileId}](${a.url})`, '');
      else lines.push(`_(missing attachment: ${a.name || a.fileId})_`, '');
    }
    lines.push('---', '');
  }
  return lines.join('\n');
}

// ---- Static file serving -------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
};
async function serveFile(res, filePath, forcedMime) {
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return false;
    const mime = forcedMime || MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': s.size, 'Cache-Control': 'no-cache' });
    createReadStream(filePath).pipe(res);
    return true;
  } catch { return false; }
}
function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ---- Router --------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const sp = url.searchParams;

  try {
    if (p === '/api/projects' && req.method === 'GET') return sendJson(res, 200, {
      projects: q.projects.all().map((r) => ({ id: r.id, name: r.name, slug: r.slug, count: Number(r.count) })),
      noProjectCount: Number(q.noProjectCount.get().n),
      total: Number(q.totalCount.get().n),
    });

    if (p === '/api/models' && req.method === 'GET')
      return sendJson(res, 200, { models: q.models.all().map((r) => ({ model: r.model, count: Number(r.n) })) });

    if (p === '/api/tags' && req.method === 'GET')
      return sendJson(res, 200, { tags: q.allTags.all().map((t) => ({ ...t, count: Number(t.count) })) });

    if (p === '/api/stats' && req.method === 'GET') return sendJson(res, 200, getStats());

    if (p === '/api/conversations' && req.method === 'GET') {
      return sendJson(res, 200, {
        conversations: getConversations({
          project: sp.get('project'), tag: sp.get('tag'), model: sp.get('model'),
          starred: sp.get('starred'), sort: sp.get('sort'),
        }),
      });
    }

    // /api/conversations/:id  and  /api/conversations/:id/tags[/:tagId]
    const convTagMatch = p.match(/^\/api\/conversations\/(\d+)\/tags(?:\/(\d+))?$/);
    if (convTagMatch) {
      const convId = Number(convTagMatch[1]);
      if (req.method === 'POST') {
        const body = await readBody(req);
        const tag = addTag(convId, body.name);
        return tag ? sendJson(res, 200, { tag }) : sendJson(res, 404, { error: 'conversation not found' });
      }
      if (req.method === 'DELETE' && convTagMatch[2]) {
        removeTag(convId, convTagMatch[2]);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    const convMatch = p.match(/^\/api\/conversations\/(\d+)$/);
    if (convMatch && req.method === 'GET') {
      const conv = getConversation(Number(convMatch[1]), sp.get('hidden') === '1');
      return conv ? sendJson(res, 200, conv) : sendJson(res, 404, { error: 'not found' });
    }

    if (p === '/api/search' && req.method === 'GET') return sendJson(res, 200, search(sp.get('q') ?? ''));

    const exportMatch = p.match(/^\/api\/export\/conversation\/(\d+)\.(md|json)$/);
    if (exportMatch && req.method === 'GET') {
      const id = Number(exportMatch[1]);
      if (exportMatch[2] === 'json') {
        const conv = getConversation(id, sp.get('hidden') === '1');
        if (!conv) return sendJson(res, 404, { error: 'not found' });
        const buf = Buffer.from(JSON.stringify(conv, null, 2));
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length,
          'Content-Disposition': `attachment; filename="conversation-${id}.json"`,
        });
        return res.end(buf);
      }
      const md = exportMarkdown(id);
      if (md == null) return sendJson(res, 404, { error: 'not found' });
      const buf = Buffer.from(md);
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': buf.length,
        'Content-Disposition': `attachment; filename="conversation-${id}.md"`,
      });
      return res.end(buf);
    }

    const attMatch = p.match(/^\/api\/attachments\/(.+)$/);
    if (attMatch && req.method === 'GET') {
      const fileId = decodeURIComponent(attMatch[1]);
      const row = q.attachmentByFileId.get(PROVIDER, fileId);
      if (!row?.stored_path) return sendJson(res, 404, { error: 'attachment not found' });
      const abs = path.join(DATA_DIR, row.stored_path);
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
      if (await serveFile(res, path.join(DIST_DIR, 'index.html'))) return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('chat-archive API is running. Build the viewer (npm run viewer:build) or run the Vite dev server.');
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`chat-archive server on http://localhost:${PORT}`);
  console.log(existsSync(DIST_DIR) ? 'Serving built viewer from viewer/dist' : 'Viewer not built — run the Vite dev server for the UI');
});
