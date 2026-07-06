// src/cli/ingest.js
// Entry point: node src/cli/ingest.js <export-dir>
//
// Reads a raw ChatGPT export (READ-ONLY), parses each conversations-*.json
// sequentially (files run up to ~110MB — never hold all raw JSON at once), writes
// canonical rows into data/archive.db (one transaction per source file), resolves
// attachments, and writes the ingest report to data/reports/ingest-<date>.md.

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConversations } from '../core/providers/chatgpt.js';
import { openDb } from './db.js';

const PROVIDER = 'chatgpt';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = path.join(ROOT, 'data');

async function main() {
  const exportDir = process.argv[2];
  if (!exportDir) {
    console.error('Usage: node src/cli/ingest.js <export-dir>');
    process.exit(1);
  }

  const convFiles = readdirSync(exportDir)
    .filter((f) => /^conversations-\d+\.json$/.test(f))
    .sort();
  if (convFiles.length === 0) {
    console.error(`No conversations-*.json files found in ${exportDir}`);
    process.exit(1);
  }

  // Attachments module (built in parallel) — fall back to a no-op so ingest still
  // runs (attachments skipped + reported) if it is ever absent.
  let attachmentsMod = null;
  let attachmentsNote = null;
  try {
    attachmentsMod = await import('./attachments.js');
  } catch (err) {
    attachmentsNote = `attachments module unavailable (${err.message}) — attachment resolution SKIPPED`;
  }

  let attachmentIndex = new Map();
  if (attachmentsMod) {
    const t = Date.now();
    ({ byFileId: attachmentIndex } = await attachmentsMod.buildAttachmentIndex(exportDir));
    console.log(`Attachment index: ${attachmentIndex.size} .dat files (${Date.now() - t}ms)`);
  } else {
    console.warn(attachmentsNote);
  }

  const db = openDb(path.join(DATA_DIR, 'archive.db'));

  // ---- Accumulators for report + stdout ------------------------------------------
  const totals = {
    raw: 0, written: 0, replaced: 0, skipped: 0, unparseable: 0,
    messages: 0, canonical: 0, branch: 0, hidden: 0,
    attMatched: 0, attMissing: 0, attOrphan: 0,
  };
  const perFile = [];              // { file, rawCount, parsed, ms }
  const skipIssues = [];           // { file, conversationId, reason }
  const warnIssues = [];           // { file, conversationId, reason }
  const unknownContentTypes = Object.create(null);
  const contentTypeCounts = Object.create(null);
  const perProject = Object.create(null); // providerProjectId → conversation count
  const reconcileDeltas = [];      // { file, rawCount, accounted, ids }
  let minCreated = Infinity;
  let maxUpdated = -Infinity;
  const materialized = new Map();  // fileId → storedPath (copy each file once)
  const referencedThisRun = new Set();
  let messagesWritten = 0;

  const materialize = (fileId, entry) => {
    if (!materialized.has(fileId)) {
      materialized.set(fileId, attachmentsMod.materializeAttachment(entry, fileId, DATA_DIR));
    }
    return materialized.get(fileId);
  };

  // ---- Ingest each source file (one transaction per file) -------------------------
  for (const file of convFiles) {
    const t0 = Date.now();
    const jsonText = readFileSync(path.join(exportDir, file), 'utf8');
    const { conversations, issues, rawCount, unknownContentTypes: fileUnknown } =
      parseConversations(jsonText);

    totals.raw += rawCount;
    for (const [k, v] of Object.entries(fileUnknown)) {
      unknownContentTypes[k] = (unknownContentTypes[k] ?? 0) + v;
    }
    for (const issue of issues) {
      (issue.severity === 'skip' ? skipIssues : warnIssues)
        .push({ file, conversationId: issue.conversationId, reason: issue.reason });
    }
    const fileSkips = issues.filter((i) => i.severity === 'skip').length;
    totals.unparseable += fileSkips;

    db.begin();
    try {
      for (const conv of conversations) {
        if (typeof conv.createdAt === 'number') minCreated = Math.min(minCreated, conv.createdAt);
        if (typeof conv.updatedAt === 'number') maxUpdated = Math.max(maxUpdated, conv.updatedAt);
        if (conv.providerProjectId) {
          perProject[conv.providerProjectId] = (perProject[conv.providerProjectId] ?? 0) + 1;
        }
        for (const msg of conv.messages) {
          totals.messages += 1;
          if (msg.isCanonical) totals.canonical += 1; else totals.branch += 1;
          if (msg.isHidden) totals.hidden += 1;
          contentTypeCounts[msg.contentType] = (contentTypeCounts[msg.contentType] ?? 0) + 1;
          for (const ref of msg.attachmentRefs) referencedThisRun.add(ref.providerFileId);
        }

        const result = db.upsertConversation(PROVIDER, conv);
        totals[result.status === 'written' ? 'written' : result.status === 'replaced' ? 'replaced' : 'skipped'] += 1;

        if (result.status === 'skipped' || !attachmentsMod) continue;
        messagesWritten += conv.messages.length;

        // Attachment rows for every AttachmentRef on every written message.
        for (const msg of conv.messages) {
          if (msg.attachmentRefs.length === 0) continue;
          const messageId = result.messageIds.get(msg.providerMessageId) ?? null;
          for (const ref of msg.attachmentRefs) {
            const entry = attachmentIndex.get(ref.providerFileId);
            if (entry) {
              db.insertAttachment({
                provider: PROVIDER,
                providerFileId: ref.providerFileId,
                conversationId: result.conversationId,
                messageId,
                originalName: ref.name ?? entry.originalName ?? null,
                storedPath: materialize(ref.providerFileId, entry),
                mime: entry.mime ?? ref.mimeHint ?? null,
                ext: entry.ext ?? null,
                sizeBytes: entry.sizeBytes ?? null,
                status: 'matched',
              });
              totals.attMatched += 1;
            } else {
              db.insertAttachment({
                provider: PROVIDER,
                providerFileId: ref.providerFileId,
                conversationId: result.conversationId,
                messageId,
                originalName: ref.name ?? null,
                storedPath: null,
                mime: ref.mimeHint ?? null,
                ext: null,
                sizeBytes: null,
                status: 'missing_file',
              });
              totals.attMissing += 1;
            }
          }
        }
      }
      db.commit();
    } catch (err) {
      db.rollback();
      throw err;
    }

    const accounted = conversations.length + fileSkips;
    if (accounted !== rawCount) {
      reconcileDeltas.push({
        file, rawCount, accounted,
        ids: conversations.map((c) => c.providerConversationId),
      });
    }
    const ms = Date.now() - t0;
    perFile.push({ file, rawCount, parsed: conversations.length, ms });
    console.log(`${file}: ${conversations.length}/${rawCount} conversations parsed in ${ms}ms`);
  }

  // ---- Orphan files: indexed .dat files never referenced by any message ----------
  if (attachmentsMod) {
    db.begin();
    try {
      const referencedInDb = db.referencedFileIds(PROVIDER); // matched/missing across all runs
      const existingOrphans = db.orphanFileIds(PROVIDER);
      for (const [fileId, entry] of attachmentIndex) {
        if (referencedInDb.has(fileId) || referencedThisRun.has(fileId)) {
          if (existingOrphans.has(fileId)) db.deleteOrphanRow(PROVIDER, fileId); // no longer orphan
          continue;
        }
        if (existingOrphans.has(fileId)) continue; // already recorded
        db.insertAttachment({
          provider: PROVIDER,
          providerFileId: fileId,
          conversationId: null,
          messageId: null,
          originalName: entry.originalName ?? null,
          storedPath: null, // orphans are not materialized by default
          mime: entry.mime ?? null,
          ext: entry.ext ?? null,
          sizeBytes: entry.sizeBytes ?? null,
          status: 'orphan_file',
        });
        totals.attOrphan += 1;
      }
      db.commit();
    } catch (err) {
      db.rollback();
      throw err;
    }
  }

  // ---- Source row -----------------------------------------------------------------
  const dbAttachmentCounts = db.attachmentStatusCounts(PROVIDER);
  db.insertSource(
    PROVIDER,
    path.resolve(exportDir),
    new Date().toISOString(),
    totals.written + totals.replaced,
    messagesWritten
  );
  db.close();

  // ---- Report ---------------------------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(DATA_DIR, 'reports', `ingest-${today}.md`);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, buildReport({
    exportDir, today, totals, perFile, skipIssues, warnIssues, unknownContentTypes,
    contentTypeCounts, perProject, reconcileDeltas, minCreated, maxUpdated, attachmentsNote,
    attachmentIndexSize: attachmentIndex.size, dbAttachmentCounts,
  }), 'utf8');

  // ---- Stdout summary ---------------------------------------------------------------
  const accountedTotal = totals.written + totals.replaced + totals.skipped + totals.unparseable;
  console.log('');
  console.log(`Conversations: ${totals.raw} in export → ${totals.written} written, ` +
    `${totals.replaced} replaced, ${totals.skipped} skipped (already current), ` +
    `${totals.unparseable} unparseable`);
  console.log(`Messages: ${totals.messages} (${totals.canonical} canonical, ` +
    `${totals.branch} branch, ${totals.hidden} hidden)`);
  console.log(`Attachments: ${totals.attMatched} matched, ${totals.attMissing} missing_file, ` +
    `${totals.attOrphan} new orphan_file${attachmentsNote ? ' — ' + attachmentsNote : ''}`);
  console.log(`Reconciliation: ${totals.raw} raw = ${accountedTotal} accounted → ` +
    (totals.raw === accountedTotal && reconcileDeltas.length === 0 ? 'OK' : 'MISMATCH (see report)'));
  console.log(`Report: ${reportPath}`);
}

function fmtDate(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return 'n/a';
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function buildReport(r) {
  const {
    exportDir, today, totals, perFile, skipIssues, warnIssues, unknownContentTypes,
    contentTypeCounts, perProject, reconcileDeltas, minCreated, maxUpdated, attachmentsNote,
    attachmentIndexSize, dbAttachmentCounts,
  } = r;
  const accountedTotal = totals.written + totals.replaced + totals.skipped + totals.unparseable;
  const lines = [];
  lines.push(`# Ingest report — ${today}`);
  lines.push('');
  lines.push(`Export: \`${exportDir}\``);
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(`- Conversations in export (raw JSON array lengths): **${totals.raw}**`);
  lines.push(`- Written (new): **${totals.written}** · Replaced (newer update_time): **${totals.replaced}** · ` +
    `Skipped (already current): **${totals.skipped}** · Unparseable: **${totals.unparseable}**`);
  lines.push(`- Messages emitted: **${totals.messages}** — canonical ${totals.canonical}, ` +
    `branch ${totals.branch}, hidden ${totals.hidden}`);
  lines.push(`- Attachments (this run): matched ${totals.attMatched}, missing_file ${totals.attMissing}, ` +
    `new orphan_file ${totals.attOrphan} (index: ${attachmentIndexSize} .dat files)` +
    (attachmentsNote ? ` — **${attachmentsNote}**` : ''));
  lines.push(`- Attachments in DB by status: ` +
    (Object.keys(dbAttachmentCounts).length === 0
      ? 'none'
      : Object.entries(dbAttachmentCounts).map(([s, n]) => `${s} ${n}`).join(', ')));
  lines.push(`- Date range: ${fmtDate(minCreated)} → ${fmtDate(maxUpdated)}`);
  lines.push('');
  lines.push('## Reconciliation');
  lines.push('');
  const ok = totals.raw === accountedTotal && reconcileDeltas.length === 0;
  lines.push(`Raw conversations (${totals.raw}) = written (${totals.written}) + replaced (${totals.replaced}) ` +
    `+ skipped (${totals.skipped}) + unparseable (${totals.unparseable}) = ${accountedTotal} → ` +
    (ok ? '**OK**' : '**MISMATCH**'));
  if (!ok) {
    for (const d of reconcileDeltas) {
      lines.push(`- ${d.file}: raw ${d.rawCount} vs accounted ${d.accounted}; parsed ids: ${d.ids.join(', ')}`);
    }
  }
  lines.push('');
  lines.push('## Per-file parse timing');
  lines.push('');
  lines.push('| file | raw | parsed | ms |');
  lines.push('|------|-----|--------|----|');
  for (const f of perFile) lines.push(`| ${f.file} | ${f.rawCount} | ${f.parsed} | ${f.ms} |`);
  lines.push('');
  lines.push('## Content types');
  lines.push('');
  for (const [ct, n] of Object.entries(contentTypeCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${ct}: ${n}`);
  }
  lines.push('');
  lines.push('## Unknown content types');
  lines.push('');
  const unknown = Object.entries(unknownContentTypes).sort((a, b) => b[1] - a[1]);
  if (unknown.length === 0) lines.push('None.');
  for (const [ct, n] of unknown) lines.push(`- ${ct}: ${n}`);
  lines.push('');
  lines.push('## Per-project conversation counts');
  lines.push('');
  const projects = Object.entries(perProject).sort((a, b) => b[1] - a[1]);
  if (projects.length === 0) lines.push('None.');
  for (const [pid, n] of projects) lines.push(`- ${pid}: ${n}`);
  lines.push('');
  lines.push('## Skipped / errored conversations');
  lines.push('');
  if (skipIssues.length === 0) lines.push('None.');
  for (const i of skipIssues) lines.push(`- ${i.file} · ${i.conversationId}: ${i.reason}`);
  lines.push('');
  lines.push('## Warnings (conversation kept)');
  lines.push('');
  if (warnIssues.length === 0) lines.push('None.');
  for (const i of warnIssues) lines.push(`- ${i.file} · ${i.conversationId}: ${i.reason}`);
  lines.push('');
  return lines.join('\n');
}

main().catch((err) => {
  console.error('Ingest failed:', err);
  process.exit(1);
});
