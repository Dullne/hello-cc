import fs from 'node:fs';
import path from 'node:path';
import { privateProjectStateDir, privateProjectAuthorityPath, validatedGlobalStateDir } from './private-state.mjs';
import { stableProjectStateRoot } from './project-trust.mjs';

export function projectStateDir(root) {
  const privateDir = privateProjectStateDir(root);
  // An established private binding is authoritative even if permissions on
  // the project path later change. A damaged or unreadable private store must
  // fail validation, never silently reactivate an old project-local database.
  try { fs.lstatSync(privateDir); return privateDir; }
  catch (error) { if (error?.code !== 'ENOENT') return privateDir; }
  try { fs.lstatSync(privateProjectAuthorityPath(root)); return privateDir; }
  catch (error) { if (error?.code !== 'ENOENT') return privateDir; }
  const stableRoot = stableProjectStateRoot(root);
  return stableRoot ? path.join(stableRoot, '.hello-cc') : privateDir;
}

export function legacyProjectStateDir(root) {
  return path.join(root, '.hello-cc');
}

export function projectDbPath(root) {
  return path.join(projectStateDir(root), 'mesh.db');
}

export function runtimePath(ctx) {
  return path.join(projectStateDir(ctx.root), 'runtime.json');
}

export function webLogPath(ctx) {
  return path.join(projectStateDir(ctx.root), 'web.log');
}

export function globalStateDir() {
  return validatedGlobalStateDir();
}

export function globalRuntimePath() {
  return path.join(globalStateDir(), 'runtime.json');
}

export function globalWebTokenPath() {
  return path.join(globalStateDir(), 'web-token');
}

export function projectRegistryPath() {
  return path.join(globalStateDir(), 'projects.json');
}

export function contextForProject(root, dbPath = null, base = {}) {
  const resolvedRoot = path.resolve(root);
  return {
    cwd: base.cwd || resolvedRoot,
    root: resolvedRoot,
    dbPath: path.resolve(dbPath || projectDbPath(resolvedRoot)),
    json: Boolean(base.json),
    explicitRoot: true
  };
}
