import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

export function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

export function hasHccRootSync(cwd) {
  if (!cwd) return null;
  const dir = path.resolve(cwd);
  const hccDir = path.join(dir, '.hello-cc');
  return fs.existsSync(path.join(hccDir, 'mesh.db')) ||
    fs.existsSync(path.join(hccDir, 'config.json'));
}

export function detectRoot(cwd, explicitRoot) {
  if (explicitRoot) return path.resolve(explicitRoot);
  if (process.env.HCC_ROOT) return path.resolve(process.env.HCC_ROOT);
  return path.resolve(cwd);
}

export function detectBranch(cwd) {
  return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) || '';
}
