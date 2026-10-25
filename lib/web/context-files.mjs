import path from 'node:path';
import { CliError } from '../shared/errors.mjs';
import { captureSelectedCwdIdentity } from '../process/selected-cwd-identity.mjs';
import { privateComponent, PROJECT_PRIVATE_COMPONENT_WORKER_SOURCE,
  runPinnedDirectoryWorker, assertProjectFileReadsAvailable } from './project-files.mjs';

const contextIgnored = new Set(['.git', 'node_modules', '.hcc', '.hello-cc', '.codex', '.claude', '.dsh', '.ssh', '.aws', 'dist', 'build', 'coverage', '.next']);

function changed() {
  return new CliError('PROJECT_PATH_CHANGED', 'Selected project directory changed while listing files');
}

function assertBoundRoot(rootIdentity) {
  if (!rootIdentity) return;
  rootIdentity.assertUnchanged();
}

function contextListWorker() {
  const fs = require('node:fs');
  const { query, limit, maxEntries, timeBudgetMs } = JSON.parse(process.argv[1]);
  const deadline = Date.now() + timeBudgetMs;
  const root = fs.statSync('.', { bigint: true });
  const same = (left, right) => left.isDirectory() && right.isDirectory() &&
    left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
  const skippable = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP']);
  const changed = () => { const error = new Error('Directory identity changed'); error.code = 'PROJECT_PATH_CHANGED'; return error; };

  function leave(held) {
    for (let index = held.length - 1; index >= 0; index--) {
      process.chdir('..');
      const current = fs.statSync('.', { bigint: true });
      const expected = index ? held[index - 1].stat : root;
      fs.closeSync(held[index].fd);
      if (!same(current, expected)) throw changed();
    }
  }

  function enter(relative) {
    const held = [];
    for (const part of relative ? relative.split('/') : []) {
      let fd;
      try { fd = fs.openSync(part, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }
      catch (error) {
        leave(held);
        if (skippable.has(error.code)) return null;
        throw error;
      }
      let stat;
      try { stat = fs.fstatSync(fd, { bigint: true }); }
      catch (error) { fs.closeSync(fd); leave(held); throw error; }
      if (!stat.isDirectory()) { fs.closeSync(fd); leave(held); return null; }
      try { process.chdir(part); }
      catch (error) {
        fs.closeSync(fd); leave(held);
        if (skippable.has(error.code)) return null;
        throw error;
      }
      // A rename between no-follow open and chdir must not let us inspect B.
      if (!same(stat, fs.statSync('.', { bigint: true }))) throw changed();
      held.push({ fd, stat });
    }
    return held;
  }

  function exactPath() {
    const parts = query.split('/');
    if (!query || parts.some(part => !part || part === '.' || contextIgnored.has(part) || privateComponent(part))) return null;
    const held = enter(parts.slice(0, -1).join('/'));
    if (held === null) return null;
    try {
      const entry = fs.lstatSync(parts.at(-1));
      return entry.isFile() && !entry.isSymbolicLink() ? query : null;
    } catch (error) { if (skippable.has(error.code)) return null; throw error; }
    finally { leave(held); }
  }

  const pending = [''], paths = [], needle = query.toLocaleLowerCase();
  const exact = exactPath();
  if (exact) paths.push(exact);
  let seen = 0, truncated = false, stop = false;
  try {
    while (pending.length && !stop) {
      if (Date.now() >= deadline || seen >= maxEntries || paths.length >= limit) { truncated = true; break; }
      const relative = pending.shift(), held = enter(relative);
      if (held === null) continue;
      let directory;
      try {
        directory = fs.opendirSync('.');
        for (let item; (item = directory.readSync()) !== null;) {
          seen++;
          if (seen > maxEntries || Date.now() >= deadline) { truncated = true; stop = true; break; }
          if (item.isSymbolicLink() || contextIgnored.has(item.name) || privateComponent(item.name) ||
              /[\\:\x00-\x1f\x7f]/.test(item.name)) continue;
          const name = relative ? relative + '/' + item.name : item.name;
          if (item.isDirectory()) pending.push(name);
          else if (item.isFile() && name !== exact && name.toLocaleLowerCase().includes(needle)) {
            paths.push(name);
            if (paths.length >= limit) { truncated = true; stop = true; break; }
          }
        }
      } catch (error) { if (!skippable.has(error.code)) throw error; }
      finally { directory?.closeSync(); leave(held); }
    }
    process.stdout.write(JSON.stringify({ paths, truncated, exact }));
  } catch (error) {
    process.stderr.write('HCC_DIRECTORY_WORKER_FAILED:' + (error.code || 'PROJECT_PATH_CHANGED') + '\n');
    process.exitCode = 1;
  }
}

const CONTEXT_LIST_WORKER_SOURCE = PROJECT_PRIVATE_COMPONENT_WORKER_SOURCE +
  `const contextIgnored = new Set(${JSON.stringify([...contextIgnored])});\n` +
  `(${contextListWorker.toString()})()`;

/** List bounded project-relative filenames only. Never open or upload their contents. */
export async function listContextFiles(root, query = '', { limit = 80, maxEntries = 10000, timeBudgetMs = 150, now = Date.now, rootIdentity = null } = {}) {
  if (typeof query !== 'string' || query.length > 256 || /[\0\r\n]/.test(query) || path.isAbsolute(query) || query.includes('\\') || query.split('/').includes('..')) {
    throw new CliError('INVALID_CONTEXT_QUERY', 'Use a project-relative filename query');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(timeBudgetMs) || timeBudgetMs < 0 || typeof now !== 'function') {
    throw new TypeError('Invalid context file listing budget');
  }
  assertProjectFileReadsAvailable();
  const ownedIdentity = rootIdentity ? null : captureSelectedCwdIdentity(root);
  const identity = rootIdentity || ownedIdentity;
  try {
    assertBoundRoot(identity);
    let result;
    try {
      result = await runPinnedDirectoryWorker(identity.canonical, identity,
        CONTEXT_LIST_WORKER_SOURCE, { query, limit, maxEntries, timeBudgetMs });
    } catch (error) {
      if (['PROJECT_FILE_CHANGED', 'PROJECT_PATH_CHANGED'].includes(error.code)) throw changed();
      throw error;
    }
    assertBoundRoot(identity);
    const paths = [];
    // Apply the listing budget inside the pinned worker; bootstrap latency
    // must not discard names that the bounded scan already found.
    const deadline = now() + timeBudgetMs;
    let truncated = result.truncated;
    for (const file of result.paths) {
      if (file !== result.exact && now() >= deadline) { truncated = true; break; }
      paths.push(file);
    }
    return { paths: paths.sort(), truncated };
  } finally { ownedIdentity?.release(); }
}
