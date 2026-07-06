// src/cli/load-projects.js
// Node shell: loads projects.yaml (human-edited names for provider project ids)
// into the `projects` + `project_aliases` tables. Idempotent — safe to re-run
// after editing names; it upserts by slug and rebuilds the alias map.
//
//   node src/cli/load-projects.js
//
// projects.yaml shape:
//   projects:
//     - name: "..."          # display name (may be Hebrew, RTL)
//       aliases: ["chatgpt:g-p-...."]   # "<provider>:<provider_project_id>"

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PATH = path.join(ROOT, 'data', 'archive.db');
const YAML_PATH = path.join(ROOT, 'projects.yaml');

/** Deterministic slug from a project name (Hebrew-safe: falls back to an index). */
function slugify(name, index) {
  const base = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return base || `project-${index + 1}`;
}

export function loadProjects({ dbPath = DB_PATH, yamlPath = YAML_PATH } = {}) {
  const doc = parseYaml(readFileSync(yamlPath, 'utf8'));
  const projects = Array.isArray(doc?.projects) ? doc.projects : [];

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');

  const findBySlug = db.prepare('SELECT id FROM projects WHERE slug = ?');
  const insertProject = db.prepare('INSERT INTO projects (name, slug, notes) VALUES (?, ?, ?)');
  const updateProject = db.prepare('UPDATE projects SET name = ?, notes = ? WHERE id = ?');
  const clearAliases = db.prepare('DELETE FROM project_aliases');
  const insertAlias = db.prepare(
    `INSERT OR REPLACE INTO project_aliases (provider, provider_project_id, project_id)
     VALUES (?, ?, ?)`
  );

  const seenSlugs = new Set();
  let projectCount = 0;
  let aliasCount = 0;
  const unmatched = []; // aliases whose provider_project_id has no conversations

  const knownPid = new Set(
    db.prepare('SELECT DISTINCT provider, provider_project_id FROM conversations WHERE provider_project_id IS NOT NULL')
      .all()
      .map((r) => `${r.provider}:${r.provider_project_id}`)
  );

  db.exec('BEGIN');
  try {
    clearAliases.run();

    projects.forEach((p, i) => {
      const name = String(p?.name ?? '').trim();
      if (!name) return;
      let slug = slugify(name, i);
      // Keep slugs unique even if two names collapse to the same slug.
      let n = 2;
      while (seenSlugs.has(slug)) slug = `${slugify(name, i)}-${n++}`;
      seenSlugs.add(slug);

      const existing = findBySlug.get(slug);
      let projectId;
      if (existing) {
        projectId = Number(existing.id);
        updateProject.run(name, p?.notes ?? null, projectId);
      } else {
        projectId = Number(insertProject.run(name, slug, p?.notes ?? null).lastInsertRowid);
      }
      projectCount += 1;

      const aliases = Array.isArray(p?.aliases) ? p.aliases : [];
      for (const raw of aliases) {
        const alias = String(raw).trim();
        const sep = alias.indexOf(':');
        if (sep === -1) continue;
        const provider = alias.slice(0, sep);
        const providerProjectId = alias.slice(sep + 1);
        insertAlias.run(provider, providerProjectId, projectId);
        aliasCount += 1;
        if (!knownPid.has(`${provider}:${providerProjectId}`)) unmatched.push(alias);
      }
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }

  // Report project ids present in conversations but named by no project in the yaml.
  const named = new Set();
  for (const r of db.prepare('SELECT provider, provider_project_id FROM project_aliases').all()) {
    named.add(`${r.provider}:${r.provider_project_id}`);
  }
  const unnamed = [...knownPid].filter((k) => !named.has(k));

  db.close();
  return { projectCount, aliasCount, unmatched, unnamed };
}

// Run directly.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('load-projects.js')) {
  const res = loadProjects();
  console.log(`Loaded ${res.projectCount} projects, ${res.aliasCount} aliases.`);
  if (res.unmatched.length) {
    console.warn(`\nAliases with no matching conversations (${res.unmatched.length}):`);
    for (const a of res.unmatched) console.warn(`  - ${a}`);
  }
  if (res.unnamed.length) {
    console.warn(`\nProject ids in conversations but not named in projects.yaml (${res.unnamed.length}):`);
    for (const a of res.unnamed) console.warn(`  - ${a}`);
  }
}
