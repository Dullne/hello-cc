import fs from 'node:fs';
import path from 'node:path';

export function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

export function writeJsonSafe(filePath, data, opts = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp.' + process.pid;
  const writeOpts = opts.mode !== undefined ? { mode: opts.mode } : undefined;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', writeOpts);
  fs.renameSync(tmpPath, filePath);
  if (opts.mode !== undefined) {
    try { fs.chmodSync(filePath, opts.mode); } catch {}
  }
}
