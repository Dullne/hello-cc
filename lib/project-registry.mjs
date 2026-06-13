import fs from 'node:fs';
import path from 'node:path';
import { projectDbPath, projectRegistryPath } from './runtime-paths.mjs';

function registryTimestamp(nowFn = () => Math.floor(Date.now() / 1000)) {
  return nowFn();
}

export function projectRecord(ctx, nowFn) {
  return {
    root: ctx.root,
    db: ctx.dbPath,
    name: path.basename(ctx.root) || ctx.root,
    last_seen_at: registryTimestamp(nowFn)
  };
}

export function readProjectRegistry() {
  const file = projectRegistryPath();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(parsed?.projects) ? parsed.projects : [];
    return rows
      .filter((p) => p && typeof p.root === 'string')
      .map((p) => ({
        root: path.resolve(p.root),
        db: path.resolve(p.db || projectDbPath(p.root)),
        name: String(p.name || path.basename(p.root) || p.root),
        last_seen_at: Number.parseInt(p.last_seen_at || '0', 10) || 0
      }));
  } catch {
    return [];
  }
}

export function writeProjectRegistry(projects) {
  const file = projectRegistryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const unique = new Map();
  for (const project of projects) {
    if (!project?.root) continue;
    unique.set(path.resolve(project.root), {
      root: path.resolve(project.root),
      db: path.resolve(project.db || projectDbPath(project.root)),
      name: String(project.name || path.basename(project.root) || project.root),
      last_seen_at: Number.parseInt(project.last_seen_at || '0', 10) || 0
    });
  }
  const rows = [...unique.values()].sort((a, b) => (b.last_seen_at || 0) - (a.last_seen_at || 0));
  fs.writeFileSync(file, JSON.stringify({ projects: rows }, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return rows;
}

export function registerProject(ctx) {
  const rows = readProjectRegistry().filter((p) => path.resolve(p.root) !== ctx.root);
  rows.unshift(projectRecord(ctx));
  return writeProjectRegistry(rows);
}

export function registerProjectActivity(ctx) {
  try { registerProject(ctx); } catch {}
}
