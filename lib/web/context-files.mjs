import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError } from '../shared/errors.mjs';

const ignored = new Set(['.git', 'node_modules', '.hcc', '.hello-cc', '.codex', '.claude', '.dsh', '.ssh', '.aws', 'dist', 'build', 'coverage', '.next']);

function assertBoundRoot(rootIdentity, stat = null) {
  if (!rootIdentity) return;
  rootIdentity.assertUnchanged();
  if (stat && (rootIdentity.identity.dev !== stat.dev.toString() ||
      rootIdentity.identity.ino !== stat.ino.toString() ||
      rootIdentity.identity.birthtimeNs !== (stat.birthtimeNs?.toString() || null))) {
    throw new CliError('PROJECT_PATH_CHANGED', 'Selected project directory changed; select its current location again');
  }
}

/** List bounded project-relative filenames only. Never open or upload their contents. */
export async function listContextFiles(root, query = '', { limit = 80, maxEntries = 10000, timeBudgetMs = 150, now = Date.now, rootIdentity = null } = {}) {
  if (typeof query !== 'string' || query.length > 256 || /[\0\r\n]/.test(query) || path.isAbsolute(query) || query.includes('\\') || query.split('/').includes('..')) {
    throw new CliError('INVALID_CONTEXT_QUERY', 'Use a project-relative filename query');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(timeBudgetMs) || timeBudgetMs < 0 || typeof now !== 'function') {
    throw new TypeError('Invalid context file listing budget');
  }
  assertBoundRoot(rootIdentity);
  const base = await fs.realpath(root), pending = [''], paths = [], needle = query.toLocaleLowerCase();
  if (rootIdentity) assertBoundRoot(rootIdentity, await fs.lstat(base, { bigint: true }));
  let seen = 0, truncated = false;
  const deadline = now() + timeBudgetMs;
  outer: while (pending.length) {
    if (now() >= deadline || seen >= maxEntries) { truncated = true; break; }
    assertBoundRoot(rootIdentity);
    const relative = pending.shift(), directory = path.join(base, relative);
    try {
      if ((await fs.lstat(directory)).isSymbolicLink()) continue;
      const resolved = await fs.realpath(directory), fromRoot = path.relative(base, resolved);
      if (fromRoot === '..' || fromRoot.startsWith('..' + path.sep) || path.isAbsolute(fromRoot)) continue;
      const handle = await fs.opendir(directory);
      for await (const item of handle) {
        seen++;
        if (seen > maxEntries || now() >= deadline) { truncated = true; break outer; }
        if (item.isSymbolicLink() || ignored.has(item.name) || item.name === '.env' || item.name.startsWith('.env.')) continue;
        const name = relative ? relative + '/' + item.name : item.name;
        if (item.isDirectory()) pending.push(name);
        else if (item.isFile() && name.toLocaleLowerCase().includes(needle)) {
          paths.push(name);
          if (paths.length >= limit) { truncated = true; break outer; }
        }
      }
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
  assertBoundRoot(rootIdentity);
  return { paths: paths.sort(), truncated };
}
