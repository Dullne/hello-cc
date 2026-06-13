import os from 'node:os';
import path from 'node:path';

export function projectStateDir(root) {
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
  return path.join(os.homedir(), '.hello-cc');
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
