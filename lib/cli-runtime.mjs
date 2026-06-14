import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { projectDbPath } from './runtime/paths.mjs';

export function createContext(global = {}, deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const detectRoot = deps.detectRoot;
  if (typeof detectRoot !== 'function') throw new TypeError('createContext requires deps.detectRoot');
  const root = detectRoot(cwd, global.root);
  const envDb = global.root ? null : process.env.HCC_DB;
  const dbPath = path.resolve(global.db || envDb || projectDbPath(root));
  return { cwd, root, dbPath, json: global.json, explicitRoot: Boolean(global.root || process.env.HCC_ROOT) };
}

export function shellCommand(args, quoteArg) {
  if (typeof quoteArg !== 'function') throw new TypeError('shellCommand requires quoteArg');
  return args.map(quoteArg).join(' ');
}

export function tailFile(file, maxBytes = 12000) {
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, Math.max(0, stat.size - size));
      return buf.toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export function commandPath(argv = process.argv) {
  try { return fs.realpathSync(argv[1]); }
  catch { return path.resolve(argv[1]); }
}

export function packageRoot(argv = process.argv) {
  return path.resolve(path.dirname(commandPath(argv)), '..');
}
