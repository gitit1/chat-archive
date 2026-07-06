// src/core/providers/chatgpt.js
// ChatGPT export adapter: conversations-*.json content → canonical objects (docs/SCHEMA.md).
// PURE environment-agnostic JS: no node:fs / node:path / Node globals. Receives file
// CONTENTS (a string), never paths — must be able to run in the browser later.

/**
 * Content types we flatten with a dedicated rule. Anything else is best-effort
 * flattened and counted in `unknownContentTypes`.
 */
const KNOWN_CONTENT_TYPES = new Set([
  'text',
  'code',
  'multimodal_text',
  'thoughts',
  'reasoning_recap',
  'execution_output',
  'tether_quote',
  'tether_browsing_display',
  'user_editable_context',
  'model_editable_context',
]);

/**
 * Normalize any provider file reference to a bare file id:
 *   "file-service://file-ABC123" → "file-ABC123"
 *   "sediment://file_0000abcd"   → "file_0000abcd"   (newer ids use an underscore)
 *   "file-ABC123"                → "file-ABC123"
 * Must stay in sync with normalizeFileId in src/cli/attachments.js.
 * @param {unknown} ref
 * @returns {string|null}
 */
export function normalizeFileId(ref) {
  if (ref == null) return null;
  let id = String(ref);
  const schemeIdx = id.indexOf('://');
  if (schemeIdx !== -1) id = id.slice(schemeIdx + 3);
  id = id.split(/[\\/]/).pop() ?? id;
  const m = id.match(/^(file[-_][A-Za-z0-9]+)/);
  if (m) return m[1];
  return id || null;
}

/**
 * Parse the raw text of one conversations-*.json file.
 *
 * Never throws on a weird conversation: unparseable/degenerate conversations are
 * skipped and recorded as issues with severity 'skip'; recoverable oddities inside a
 * kept conversation are recorded with severity 'warn'.
 *
 * @param {string} jsonText raw content of one conversations-*.json file
 * @returns {{
 *   conversations: Array<object>,          // Conversation objects per SCHEMA.md
 *   issues: Array<{conversationId: string|null, reason: string, severity: 'skip'|'warn'}>,
 *   rawCount: number,                      // length of the raw JSON array (for reconciliation)
 *   unknownContentTypes: Record<string, number>,
 * }}
 */
export function parseConversations(jsonText) {
  const issues = [];
  const conversations = [];
  const unknownContentTypes = Object.create(null);

  let raw;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    issues.push({ conversationId: null, reason: `file is not valid JSON: ${err.message}`, severity: 'skip' });
    return { conversations, issues, rawCount: 0, unknownContentTypes };
  }
  if (!Array.isArray(raw)) {
    issues.push({ conversationId: null, reason: 'top-level JSON is not an array', severity: 'skip' });
    return { conversations, issues, rawCount: 0, unknownContentTypes };
  }

  raw.forEach((rawConv, index) => {
    try {
      const result = parseOneConversation(rawConv, index, unknownContentTypes);
      for (const issue of result.issues) issues.push(issue);
      if (result.conversation) conversations.push(result.conversation);
    } catch (err) {
      issues.push({
        conversationId: idOf(rawConv) ?? `#${index}`,
        reason: `parser error: ${err.message}`,
        severity: 'skip',
      });
    }
  });

  return { conversations, issues, rawCount: raw.length, unknownContentTypes };
}

function idOf(rawConv) {
  if (!rawConv || typeof rawConv !== 'object') return null;
  return rawConv.conversation_id ?? rawConv.id ?? null;
}

/**
 * @returns {{ conversation: object|null, issues: Array<object> }}
 */
function parseOneConversation(c, index, unknownContentTypes) {
  const issues = [];

  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    issues.push({
      conversationId: `#${index}`,
      reason: `conversation entry is not an object (${c === null ? 'null' : typeof c})`,
      severity: 'skip',
    });
    return { conversation: null, issues };
  }
  if (Object.keys(c).length === 0) {
    issues.push({ conversationId: `#${index}`, reason: 'conversation entry is an empty object {}', severity: 'skip' });
    return { conversation: null, issues };
  }

  const convId = idOf(c);
  if (!convId) {
    issues.push({ conversationId: `#${index}`, reason: 'conversation has no conversation_id / id', severity: 'skip' });
    return { conversation: null, issues };
  }
  const mapping = c.mapping;
  if (!mapping || typeof mapping !== 'object') {
    issues.push({ conversationId: convId, reason: 'conversation has no mapping tree', severity: 'skip' });
    return { conversation: null, issues };
  }

  // --- Canonical path: current_node → root via parent, reversed. -------------------
  // canonicalNodeIds = node ids on the path (including structural message:null nodes).
  const canonicalNodeIds = new Set();
  const canonicalChain = []; // node ids root..leaf
  const currentNode = c.current_node;
  if (currentNode == null || !mapping[currentNode]) {
    issues.push({
      conversationId: convId,
      reason: `current_node ${JSON.stringify(currentNode)} not found in mapping; no canonical path`,
      severity: 'warn',
    });
  } else {
    let cursor = currentNode;
    const seen = new Set();
    while (cursor != null) {
      if (seen.has(cursor)) {
        issues.push({ conversationId: convId, reason: `parent cycle in mapping at node ${cursor}`, severity: 'warn' });
        break;
      }
      seen.add(cursor);
      const node = mapping[cursor];
      if (!node) {
        issues.push({
          conversationId: convId,
          reason: `broken parent chain: node ${cursor} missing from mapping`,
          severity: 'warn',
        });
        break;
      }
      canonicalChain.push(cursor);
      cursor = node.parent ?? null;
    }
    canonicalChain.reverse();
    for (const id of canonicalChain) canonicalNodeIds.add(id);
  }

  // --- Emit ALL message-bearing nodes in tree order (DFS from roots). --------------
  // NOTE: current ChatGPT exports ship mapping nodes with only `parent` links and NO
  // `children` arrays, so children are DERIVED from parent pointers (declared
  // children, when present, take precedence for ordering). Structural nodes
  // (message: null) are skipped but bridge parentage.
  const nodeIds = Object.keys(mapping);
  const rootIds = nodeIds.filter((id) => {
    const p = mapping[id]?.parent;
    return p == null || !mapping[p];
  });

  const derivedChildren = new Map(); // parent node id → child node ids
  for (const id of nodeIds) {
    const p = mapping[id]?.parent;
    if (p != null && mapping[p]) {
      if (!derivedChildren.has(p)) derivedChildren.set(p, []);
      derivedChildren.get(p).push(id);
    }
  }
  const timeOf = (id) => {
    const t = mapping[id]?.message?.create_time;
    return typeof t === 'number' ? t : Infinity; // undated last; stable sort keeps ties in file order
  };
  for (const kids of derivedChildren.values()) kids.sort((a, b) => timeOf(a) - timeOf(b));

  const childrenOf = (id) => {
    const declared = Array.isArray(mapping[id]?.children)
      ? mapping[id].children.filter((child) => mapping[child])
      : [];
    const derived = derivedChildren.get(id) ?? [];
    return declared.length === 0 ? derived : [...new Set([...declared, ...derived])];
  };

  const treeOrder = [];
  const visited = new Set();
  const stack = [];
  const dfs = (startId) => {
    stack.push(startId);
    while (stack.length > 0) {
      const id = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      treeOrder.push(id);
      const kids = childrenOf(id);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]); // preserve child order
    }
  };
  for (const rootId of rootIds) dfs(rootId);
  // Nodes unreachable from any root (e.g. parent cycles) still get emitted.
  let unreachable = 0;
  for (const id of nodeIds) {
    if (!visited.has(id)) {
      unreachable++;
      dfs(id);
    }
  }
  if (unreachable > 0) {
    issues.push({
      conversationId: convId,
      reason: `${unreachable} mapping nodes unreachable from tree roots (emitted after the tree)`,
      severity: 'warn',
    });
  }

  // Nearest ancestor node that actually carries a message (bridges structural nodes).
  const nearestMessageAncestor = (nodeId) => {
    let cursor = mapping[nodeId]?.parent ?? null;
    const seen = new Set([nodeId]);
    while (cursor != null && !seen.has(cursor)) {
      seen.add(cursor);
      const node = mapping[cursor];
      if (!node) return null;
      if (node.message && node.message.id != null) return node.message.id;
      if (node.message) return cursor; // message without id: fall back to node id
      cursor = node.parent ?? null;
    }
    return null;
  };

  // orderIndex along the canonical path counts only message-bearing nodes.
  const orderIndexByNodeId = new Map();
  let nextOrder = 0;
  for (const id of canonicalChain) {
    if (mapping[id]?.message) orderIndexByNodeId.set(id, nextOrder++);
  }

  const messages = [];
  for (const nodeId of treeOrder) {
    const node = mapping[nodeId];
    const m = node?.message;
    if (!m) continue; // structural node

    const isCanonical = canonicalNodeIds.has(nodeId);
    const flat = flattenContent(m, convId, issues, unknownContentTypes);
    const role = m.author?.role ?? 'unknown';

    let isHidden = Boolean(
      m.metadata?.is_visually_hidden_from_conversation ||
      flat.hidden ||
      (role === 'system' && flat.text.trim() === '')
    );

    messages.push({
      providerMessageId: m.id ?? nodeId,
      parentProviderMessageId: nearestMessageAncestor(nodeId),
      role,
      authorName: m.author?.name ?? null,
      createdAt: typeof m.create_time === 'number' ? m.create_time : null,
      model: m.metadata?.model_slug ?? null,
      contentType: m.content?.content_type ?? 'unknown',
      text: flat.text,
      isCanonical,
      orderIndex: isCanonical ? (orderIndexByNodeId.get(nodeId) ?? -1) : -1,
      isHidden,
      attachmentRefs: flat.refs,
    });
  }

  const templateId = typeof c.conversation_template_id === 'string' ? c.conversation_template_id : null;
  const conversation = {
    providerConversationId: convId,
    title: typeof c.title === 'string' ? c.title : '',
    createdAt: typeof c.create_time === 'number' ? c.create_time : null,
    updatedAt: typeof c.update_time === 'number' ? c.update_time : null,
    model: c.default_model_slug ?? null,
    providerProjectId: templateId && templateId.startsWith('g-p-') ? templateId : null,
    gizmoId:
      c.gizmo_id ??
      (templateId && templateId.startsWith('g-') && !templateId.startsWith('g-p-') ? templateId : null),
    isStarred: Boolean(c.is_starred),
    isArchived: Boolean(c.is_archived),
    messages,
  };
  return { conversation, issues };
}

// ---------------------------------------------------------------------------------
// Content flattening (SCHEMA.md "ChatGPT content types → text flattening")
// ---------------------------------------------------------------------------------

/**
 * @returns {{ text: string, hidden: boolean, refs: Array<object> }}
 */
function flattenContent(m, convId, issues, unknownContentTypes) {
  const content = m.content ?? {};
  const contentType = content.content_type ?? 'unknown';
  const refs = new Map(); // fileId → AttachmentRef (merged across sources)

  const addRef = (rawId, extra = {}) => {
    const fileId = normalizeFileId(rawId);
    if (!fileId) return null;
    const prev = refs.get(fileId) ?? { providerFileId: fileId, name: null, mimeHint: null, width: null, height: null };
    for (const key of ['name', 'mimeHint', 'width', 'height']) {
      if (extra[key] != null && prev[key] == null) prev[key] = extra[key];
    }
    refs.set(fileId, prev);
    return fileId;
  };

  let text = '';
  let hidden = false;

  switch (contentType) {
    case 'text': {
      text = joinParts(content.parts);
      break;
    }
    case 'code': {
      const lang = content.language ?? m.metadata?.language ?? '';
      const code = typeof content.text === 'string' ? content.text : joinParts(content.parts);
      text = '```' + (lang === 'unknown' ? '' : lang) + '\n' + code + '\n```';
      break;
    }
    case 'multimodal_text': {
      const lines = [];
      for (const part of content.parts ?? []) {
        if (typeof part === 'string') {
          if (part !== '') lines.push(part);
          continue;
        }
        if (!part || typeof part !== 'object') continue;
        const partType = part.content_type;
        switch (partType) {
          case 'image_asset_pointer': {
            const fileId = addRef(part.asset_pointer, { width: part.width ?? null, height: part.height ?? null });
            lines.push(`[image: ${fileId ?? 'unknown'}]`);
            break;
          }
          case 'audio_asset_pointer': {
            const fileId = addRef(part.asset_pointer, {
              mimeHint: part.format ? `audio/${part.format}` : null,
            });
            lines.push(`[audio: ${fileId ?? 'unknown'}]`);
            break;
          }
          case 'video_container_asset_pointer': {
            const fileId = addRef(part.asset_pointer ?? part.video_asset_pointer?.asset_pointer);
            lines.push(`[video: ${fileId ?? 'unknown'}]`);
            break;
          }
          case 'real_time_user_audio_video_asset_pointer': {
            const audio = part.audio_asset_pointer;
            if (audio?.asset_pointer) {
              const fileId = addRef(audio.asset_pointer, {
                mimeHint: audio.format ? `audio/${audio.format}` : null,
              });
              lines.push(`[audio: ${fileId ?? 'unknown'}]`);
            } else {
              lines.push('[realtime audio/video]');
            }
            if (part.video_container_asset_pointer?.asset_pointer) {
              const fileId = addRef(part.video_container_asset_pointer.asset_pointer);
              lines.push(`[video: ${fileId}]`);
            }
            break;
          }
          case 'audio_transcription': {
            if (typeof part.text === 'string' && part.text !== '') lines.push(part.text);
            break;
          }
          default: {
            const key = `multimodal_text/part:${partType ?? 'untyped'}`;
            unknownContentTypes[key] = (unknownContentTypes[key] ?? 0) + 1;
            const best = bestEffortText(part);
            lines.push(best !== '' ? best : `[${partType ?? 'unknown part'}]`);
          }
        }
      }
      text = lines.join('\n');
      break;
    }
    case 'thoughts': {
      // Reasoning traces: keep the text, hide from the transcript (SCHEMA.md).
      const chunks = [];
      for (const t of content.thoughts ?? []) {
        if (!t || typeof t !== 'object') continue;
        const summary = typeof t.summary === 'string' && t.summary !== '' ? t.summary : null;
        const body = typeof t.content === 'string' ? t.content : '';
        chunks.push(summary ? `**${summary}**\n${body}` : body);
      }
      text = chunks.join('\n\n');
      hidden = true;
      break;
    }
    case 'reasoning_recap': {
      text = typeof content.content === 'string' ? content.content : bestEffortText(content);
      break; // recap stays visible (SCHEMA.md)
    }
    case 'execution_output': {
      text = typeof content.text === 'string' ? content.text : bestEffortText(content);
      break;
    }
    case 'tether_quote': {
      const title = typeof content.title === 'string' ? content.title : '';
      const url = typeof content.url === 'string' ? content.url : '';
      const body = typeof content.text === 'string' ? content.text : '';
      text = [title && `> ${title}`, url && `> ${url}`, body].filter(Boolean).join('\n');
      break;
    }
    case 'tether_browsing_display': {
      text = typeof content.result === 'string' ? content.result
        : typeof content.summary === 'string' ? content.summary
        : bestEffortText(content);
      break;
    }
    case 'user_editable_context': {
      // Injected custom-instructions context — the ChatGPT UI never shows it.
      const profile = typeof content.user_profile === 'string' ? content.user_profile : '';
      const instructions = typeof content.user_instructions === 'string' ? content.user_instructions : '';
      text = [profile, instructions].filter(Boolean).join('\n\n') || bestEffortText(content);
      hidden = true;
      break;
    }
    case 'model_editable_context': {
      // Injected model memory context — hidden in the ChatGPT UI.
      text = typeof content.model_set_context === 'string' ? content.model_set_context : bestEffortText(content);
      hidden = true;
      break;
    }
    default: {
      unknownContentTypes[contentType] = (unknownContentTypes[contentType] ?? 0) + 1;
      text = bestEffortText(content);
      break;
    }
  }

  // Always also scan message.metadata.attachments (SCHEMA.md).
  const metaAttachments = m.metadata?.attachments;
  if (Array.isArray(metaAttachments)) {
    for (const a of metaAttachments) {
      if (!a || typeof a !== 'object' || a.id == null) continue;
      addRef(a.id, {
        name: typeof a.name === 'string' ? a.name : null,
        mimeHint: typeof a.mime_type === 'string' ? a.mime_type : null,
        width: typeof a.width === 'number' ? a.width : null,
        height: typeof a.height === 'number' ? a.height : null,
      });
    }
  }

  return { text: typeof text === 'string' ? text : '', hidden, refs: [...refs.values()] };
}

/** Join a `parts` array into text, coercing non-strings best-effort. */
function joinParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (typeof p === 'string' ? p : p == null ? '' : bestEffortText(p)))
    .join('\n');
}

/**
 * Best-effort human-readable text for content shapes we do not know:
 * prefer obvious text fields, else compact JSON (never throws).
 */
function bestEffortText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  for (const key of ['text', 'content', 'result', 'summary', 'title']) {
    if (typeof value[key] === 'string' && value[key] !== '') return value[key];
  }
  if (Array.isArray(value.parts)) {
    const joined = joinParts(value.parts);
    if (joined.trim() !== '') return joined;
  }
  try {
    const json = JSON.stringify(value);
    return json.length > 4000 ? json.slice(0, 4000) + '…' : json;
  } catch {
    return '';
  }
}
