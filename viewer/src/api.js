// Thin fetch layer over the read-only archive API (src/cli/serve.js).

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  projects: () => getJson('/api/projects'),
  conversations: (project) =>
    getJson(`/api/conversations?project=${encodeURIComponent(project ?? 'all')}`),
  conversation: (id, includeHidden = false) =>
    getJson(`/api/conversations/${id}${includeHidden ? '?hidden=1' : ''}`),
  search: (q) => getJson(`/api/search?q=${encodeURIComponent(q)}`),
};

// Unix seconds → "6 ביולי 2026, 14:32" (Hebrew locale).
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
