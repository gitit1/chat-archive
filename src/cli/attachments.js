// src/cli/attachments.js
// Node shell: scans a raw export dir for file-*.dat attachments, sniffs their
// real types (src/core/filetype.js), and cross-references
// conversation_asset_file_names.json for original filenames.
// The raw export folder is READ-ONLY; materialized copies go under <dataDir>/attachments.

import { readdir, readFile, open } from 'node:fs/promises';
import { mkdirSync, statSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { sniffBytes } from '../core/filetype.js';

const SNIFF_BYTES = 4096;

// .dat files in the export are named "file-<id>.dat" (older uploads) or
// "file_<hex>.dat" (newer, e.g. generated images). Both are valid file ids.
const DAT_RE = /^file[-_][A-Za-z0-9]+\.dat$/;

// Known extensions → mime, used when the sniffer says 'bin' but the original
// filename carries a usable extension, and to refine zip → OOXML.
const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff',
  pdf: 'application/pdf', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
  json: 'application/json', xml: 'application/xml', csv: 'text/csv',
  txt: 'text/plain', md: 'text/markdown', mdx: 'text/markdown',
  html: 'text/html', htm: 'text/html', css: 'text/css',
  js: 'text/javascript', ts: 'text/plain', py: 'text/x-python',
};

/**
 * Normalize any provider file reference to a bare file id, e.g.:
 *   "file-service://file-ABC123"  → "file-ABC123"
 *   "sediment://file_0000abcd"    → "file_0000abcd"
 *   "file-ABC123.dat"             → "file-ABC123"
 *   "some/path/file-ABC123.dat"   → "file-ABC123"
 * @param {string} ref
 * @returns {string}
 */
export function normalizeFileId(ref) {
  if (!ref) return '';
  let id = String(ref);
  // Strip scheme prefixes like "file-service://" / "sediment://"
  const schemeIdx = id.indexOf('://');
  if (schemeIdx !== -1) id = id.slice(schemeIdx + 3);
  // Strip any path components
  id = id.split(/[\\/]/).pop();
  // Strip a trailing extension (".dat" etc.) — but only past the "file-"/"file_" prefix
  const m = id.match(/^(file[-_][A-Za-z0-9]+)/);
  if (m) return m[1];
  // Fallback: just drop a trailing .dat
  return id.replace(/\.dat$/i, '');
}

/**
 * Scan an export directory for file-*.dat attachments.
 * @param {string} exportDir
 * @returns {Promise<{ byFileId: Map<string, {datPath: string, originalName: string|null, ext: string, mime: string, sizeBytes: number}> }>}
 */
export async function buildAttachmentIndex(exportDir) {
  const entries = await readdir(exportDir, { withFileTypes: true });
  const datNames = entries
    .filter((e) => e.isFile() && DAT_RE.test(e.name))
    .map((e) => e.name)
    .sort();

  // conversation_asset_file_names.json is a flat object:
  //   { "<dat filename>": "<original filename>", ... }
  // e.g. { "file-17o1pa3ouSyK8msVCoPKRn.dat": "C95504E7-....jpeg" }
  const namesByDatFile = new Map();
  const namesPath = path.join(exportDir, 'conversation_asset_file_names.json');
  try {
    const raw = JSON.parse(await readFile(namesPath, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string' && value.length > 0) {
          namesByDatFile.set(key, value);
          // Also index by normalized id in case keys ever lose the ".dat"
          namesByDatFile.set(normalizeFileId(key), value);
        }
      }
    }
  } catch {
    // Mapping file absent or unreadable — proceed with sniffing only.
  }

  const byFileId = new Map();

  for (const datName of datNames) {
    const datPath = path.join(exportDir, datName);
    const fileId = normalizeFileId(datName);

    // Read only the first ~4KB for sniffing; stat (via the same handle) for size.
    let sizeBytes = 0;
    let chunk = new Uint8Array(0);
    const fh = await open(datPath, 'r');
    try {
      const st = await fh.stat();
      sizeBytes = st.size;
      const buf = Buffer.alloc(Math.min(SNIFF_BYTES, st.size));
      if (buf.length > 0) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        chunk = new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
      }
    } finally {
      await fh.close();
    }

    let { ext, mime } = sniffBytes(chunk);

    const originalName =
      namesByDatFile.get(datName) ?? namesByDatFile.get(fileId) ?? null;

    // The original filename can refine what magic bytes cannot:
    // - sniffer said 'bin' → trust a usable extension from the name
    // - sniffer said 'zip' → docx/xlsx/pptx are zips; use the name's OOXML ext
    const nameExt = usableExtension(originalName);
    if (nameExt) {
      if (ext === 'bin') {
        ext = nameExt;
        mime = EXT_MIME[nameExt] ?? 'application/octet-stream';
      } else if (ext === 'zip' && (nameExt === 'docx' || nameExt === 'xlsx' || nameExt === 'pptx')) {
        ext = nameExt;
        mime = EXT_MIME[nameExt];
      }
    }

    byFileId.set(fileId, { datPath, originalName, ext, mime, sizeBytes });
  }

  return { byFileId };
}

/**
 * Copy an indexed attachment into <dataDir>/attachments/<fileId>.<ext>.
 * Creates the directory if needed; skips the copy when the destination already
 * exists with the same size (idempotent re-ingest). Never touches the export.
 * @param {{datPath: string, ext: string, sizeBytes: number}} indexEntry
 * @param {string} fileId - normalized "file-XXXX" id
 * @param {string} dataDir - e.g. "data"
 * @returns {string} stored path relative to dataDir, e.g. "attachments/file-XXXX.png"
 */
export function materializeAttachment(indexEntry, fileId, dataDir) {
  const destDir = path.join(dataDir, 'attachments');
  mkdirSync(destDir, { recursive: true });

  const destName = `${fileId}.${indexEntry.ext}`;
  const destPath = path.join(destDir, destName);

  let needCopy = true;
  if (existsSync(destPath)) {
    try {
      if (statSync(destPath).size === indexEntry.sizeBytes) needCopy = false;
    } catch {
      // Unreadable destination — recopy.
    }
  }
  if (needCopy) copyFileSync(indexEntry.datPath, destPath);

  return `attachments/${destName}`;
}

/** Extract a usable lowercase extension from an original filename, or null. */
function usableExtension(name) {
  if (!name) return null;
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === 'dat') return null;
  return ext;
}
