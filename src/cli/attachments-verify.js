// src/cli/attachments-verify.js
// Standalone sanity check for the attachment index:
//   node src/cli/attachments-verify.js <export-dir>
// Prints totals, ext/mime distribution, name-mapping coverage, and samples.
// Read-only: never writes anything.

import { buildAttachmentIndex } from './attachments.js';

const exportDir = process.argv[2];
if (!exportDir) {
  console.error('Usage: node src/cli/attachments-verify.js <export-dir>');
  process.exit(1);
}

const { byFileId } = await buildAttachmentIndex(exportDir);

const entries = [...byFileId.entries()];
const total = entries.length;
let named = 0;
const dist = new Map(); // "ext|mime" -> { count, bytes }

for (const [, e] of entries) {
  if (e.originalName) named++;
  const key = `${e.ext}|${e.mime}`;
  const d = dist.get(key) ?? { count: 0, bytes: 0 };
  d.count++;
  d.bytes += e.sizeBytes;
  dist.set(key, d);
}

console.log(`Export dir : ${exportDir}`);
console.log(`Total .dat files indexed : ${total}`);
console.log(`With original names from conversation_asset_file_names.json : ${named} (${total ? ((named / total) * 100).toFixed(1) : 0}%)`);
console.log(`Without names : ${total - named}`);
console.log('');

const rows = [...dist.entries()]
  .map(([key, d]) => {
    const [ext, mime] = key.split('|');
    return { ext, mime, count: d.count, bytes: d.bytes };
  })
  .sort((a, b) => b.count - a.count);

const header = { ext: 'ext', mime: 'mime', count: 'count', size: 'total size' };
const w = {
  ext: Math.max(header.ext.length, ...rows.map((r) => r.ext.length)),
  mime: Math.max(header.mime.length, ...rows.map((r) => r.mime.length)),
  count: Math.max(header.count.length, ...rows.map((r) => String(r.count).length)),
  size: Math.max(header.size.length, ...rows.map((r) => fmtBytes(r.bytes).length)),
};

const line = (ext, mime, count, size) =>
  `${ext.padEnd(w.ext)}  ${mime.padEnd(w.mime)}  ${count.padStart(w.count)}  ${size.padStart(w.size)}`;

console.log(line(header.ext, header.mime, header.count, header.size));
console.log(line('-'.repeat(w.ext), '-'.repeat(w.mime), '-'.repeat(w.count), '-'.repeat(w.size)));
for (const r of rows) {
  console.log(line(r.ext, r.mime, String(r.count), fmtBytes(r.bytes)));
}

console.log('');
console.log('Sample entries:');
for (const [fileId, e] of entries.slice(0, 5)) {
  console.log(`  ${fileId}`);
  console.log(`    name: ${e.originalName ?? '(none)'}  ext: ${e.ext}  mime: ${e.mime}  size: ${fmtBytes(e.sizeBytes)}`);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
