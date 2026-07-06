// src/core/filetype.js
// Pure, environment-agnostic magic-byte file type sniffing.
// No Node APIs — receives bytes, returns { ext, mime }. Runs in the browser too.

/**
 * Detect a file's type from its leading bytes.
 * @param {Uint8Array} bytes - the first chunk of the file (a few KB is plenty)
 * @returns {{ ext: string, mime: string }}
 */
export function sniffBytes(bytes) {
  if (!bytes || bytes.length === 0) {
    return { ext: 'bin', mime: 'application/octet-stream' };
  }
  const b = bytes;

  // --- Binary magic numbers -------------------------------------------------

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ext: 'png', mime: 'image/png' };
  }

  // JPEG: FF D8 FF
  if (startsWith(b, [0xff, 0xd8, 0xff])) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }

  // GIF: "GIF87a" / "GIF89a"
  if (asciiAt(b, 0, 'GIF87a') || asciiAt(b, 0, 'GIF89a')) {
    return { ext: 'gif', mime: 'image/gif' };
  }

  // RIFF container: "RIFF" .... then format tag at offset 8
  if (asciiAt(b, 0, 'RIFF') && b.length >= 12) {
    if (asciiAt(b, 8, 'WEBP')) return { ext: 'webp', mime: 'image/webp' };
    if (asciiAt(b, 8, 'WAVE')) return { ext: 'wav', mime: 'audio/wav' };
  }

  // PDF: "%PDF"
  if (asciiAt(b, 0, '%PDF')) {
    return { ext: 'pdf', mime: 'application/pdf' };
  }

  // ZIP: "PK" + 03 04 (or empty/spanned archive variants). Deliberately NOT
  // inspecting deeper (docx/xlsx/pptx are zips) — plain 'zip' here; the CLI
  // layer may refine via the original filename.
  if (
    b[0] === 0x50 && b[1] === 0x4b &&
    ((b[2] === 0x03 && b[3] === 0x04) ||
     (b[2] === 0x05 && b[3] === 0x06) ||
     (b[2] === 0x07 && b[3] === 0x08))
  ) {
    return { ext: 'zip', mime: 'application/zip' };
  }

  // MP4 / M4A: "ftyp" at offset 4
  if (b.length >= 12 && asciiAt(b, 4, 'ftyp')) {
    const brand = ascii(b, 8, 4);
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) {
      return { ext: 'm4a', mime: 'audio/mp4' };
    }
    return { ext: 'mp4', mime: 'video/mp4' };
  }

  // EBML (webm / mkv): 1A 45 DF A3. Look for the "webm" docType string in the
  // header; otherwise call it mkv.
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) {
    if (indexOfAscii(b, 'webm', 64) !== -1) {
      return { ext: 'webm', mime: 'video/webm' };
    }
    return { ext: 'mkv', mime: 'video/x-matroska' };
  }

  // MP3: "ID3" tag, or an MPEG audio frame sync (FF Ex / FF Fx)
  if (asciiAt(b, 0, 'ID3')) {
    return { ext: 'mp3', mime: 'audio/mpeg' };
  }
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    return { ext: 'mp3', mime: 'audio/mpeg' };
  }

  // --- Text-ish heuristics --------------------------------------------------

  let i = 0;
  // Skip UTF-8 BOM
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  // Skip leading ASCII whitespace
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;

  if (i < b.length) {
    const first = b[i];

    // Leading '<' → svg or generic xml
    if (first === 0x3c /* '<' */) {
      const head = ascii(b, i, Math.min(1024, b.length - i)).toLowerCase();
      if (head.includes('<svg')) return { ext: 'svg', mime: 'image/svg+xml' };
      return { ext: 'xml', mime: 'application/xml' };
    }

    // RTF starts with "{\rtf" — check before the generic '{' → json branch
    if (asciiAt(b, i, '{\\rtf')) {
      return { ext: 'rtf', mime: 'application/rtf' };
    }

    // Leading '{' or '[' → json
    if (first === 0x7b /* '{' */ || first === 0x5b /* '[' */) {
      if (looksUtf8Text(b)) return { ext: 'json', mime: 'application/json' };
    }
  }

  // UTF-8-ish plain text
  if (looksUtf8Text(b)) {
    return { ext: 'txt', mime: 'text/plain' };
  }

  return { ext: 'bin', mime: 'application/octet-stream' };
}

// --- helpers ---------------------------------------------------------------

function startsWith(b, sig) {
  if (b.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[i] !== sig[i]) return false;
  return true;
}

function asciiAt(b, offset, str) {
  if (b.length < offset + str.length) return false;
  for (let i = 0; i < str.length; i++) {
    if (b[offset + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

function ascii(b, offset, len) {
  let s = '';
  const end = Math.min(offset + len, b.length);
  for (let i = offset; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

function indexOfAscii(b, str, limit) {
  const end = Math.min(limit, b.length) - str.length;
  for (let i = 0; i <= end; i++) {
    let ok = true;
    for (let j = 0; j < str.length; j++) {
      if (b[i + j] !== str.charCodeAt(j)) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * Heuristic: does this byte chunk look like UTF-8 (or ASCII) text?
 * - No NUL bytes.
 * - Valid UTF-8 multibyte sequences (a truncated sequence at the very end of
 *   the chunk is tolerated — we only see a prefix of the file).
 * - Very few ASCII control characters other than tab/newline/CR.
 */
function looksUtf8Text(b) {
  const n = b.length;
  let controls = 0;
  let i = 0;
  while (i < n) {
    const c = b[i];
    if (c === 0x00) return false;
    if (c < 0x80) {
      if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) controls++;
      i++;
      continue;
    }
    // Multibyte UTF-8 sequence
    let extra;
    if ((c & 0xe0) === 0xc0) extra = 1;
    else if ((c & 0xf0) === 0xe0) extra = 2;
    else if ((c & 0xf8) === 0xf0) extra = 3;
    else return false; // invalid lead byte
    if (i + extra >= n) break; // truncated at chunk boundary — tolerate
    for (let j = 1; j <= extra; j++) {
      if ((b[i + j] & 0xc0) !== 0x80) return false;
    }
    i += extra + 1;
  }
  return controls <= Math.max(1, n * 0.003);
}
