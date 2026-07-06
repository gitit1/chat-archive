// Thin fetch layer over the archive API (src/cli/serve.js).

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function qs(params) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '' && v !== 'all') s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : '';
}

export const api = {
  projects: () => getJson('/api/projects'),
  models: () => getJson('/api/models'),
  tags: () => getJson('/api/tags'),
  stats: () => getJson('/api/stats'),
  conversations: (filters = {}) => getJson(`/api/conversations${qs(filters)}`),
  conversation: (id, includeHidden = false) =>
    getJson(`/api/conversations/${id}${includeHidden ? '?hidden=1' : ''}`),
  search: (q) => getJson(`/api/search?q=${encodeURIComponent(q)}`),
  addTag: (convId, name) =>
    getJson(`/api/conversations/${convId}/tags`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    }),
  removeTag: (convId, tagId) =>
    getJson(`/api/conversations/${convId}/tags/${tagId}`, { method: 'DELETE' }),
  exportUrl: (id, format) => `/api/export/conversation/${id}.${format}`,
};

const fmt = new Intl.DateTimeFormat('he-IL', {
  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const fmtShort = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });

export function formatDate(unixSeconds) {
  if (!unixSeconds) return '';
  return fmt.format(new Date(unixSeconds * 1000));
}
export function formatDateShort(unixSeconds) {
  if (!unixSeconds) return '';
  return fmtShort.format(new Date(unixSeconds * 1000));
}
