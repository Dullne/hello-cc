import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

export function writeJsonSafe(filePath, data, opts = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(16).toString('hex')}`;
  const contents = JSON.stringify(data, null, 2) + '\n';
  let fd = null;
  let opened = null;
  let renamed = false;
  try {
    fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 ||
        (typeof process.geteuid === 'function' && opened.uid !== process.geteuid())) {
      throw new Error(`unsafe JSON temporary file: ${tmpPath}`);
    }
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    const privateStat = fs.fstatSync(fd);
    if (!privateStat.isFile() || privateStat.nlink !== 1 ||
        privateStat.dev !== opened.dev || privateStat.ino !== opened.ino ||
        (typeof process.geteuid === 'function' && privateStat.uid !== process.geteuid()) ||
        (process.platform !== 'win32' && (privateStat.mode & 0o777) !== 0o600)) {
      throw new Error(`unsafe JSON temporary file: ${tmpPath}`);
    }
    fs.writeFileSync(fd, contents, 'utf8');
    if (opts.mode !== undefined && opts.mode !== 0o600 && process.platform !== 'win32') {
      fs.fchmodSync(fd, opts.mode);
    }
    const ready = fs.fstatSync(fd);
    if (!ready.isFile() || ready.nlink !== 1 ||
        ready.dev !== opened.dev || ready.ino !== opened.ino ||
        (typeof process.geteuid === 'function' && ready.uid !== process.geteuid()) ||
        (process.platform !== 'win32' && (ready.mode & 0o777) !== (opts.mode ?? 0o600))) {
      throw new Error(`unsafe JSON temporary file: ${tmpPath}`);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    const current = fs.lstatSync(tmpPath);
    if (!current.isFile() || current.nlink !== 1 ||
        current.dev !== opened.dev || current.ino !== opened.ino ||
        (typeof process.geteuid === 'function' && current.uid !== process.geteuid()) ||
        (process.platform !== 'win32' && (current.mode & 0o777) !== (opts.mode ?? 0o600))) {
      throw new Error(`JSON temporary file changed before rename: ${tmpPath}`);
    }
    fs.renameSync(tmpPath, filePath);
    renamed = true;
  } finally {
    if (fd !== null) fs.closeSync(fd);
    if (!renamed && opened) {
      try {
        const current = fs.lstatSync(tmpPath);
        if (current.dev === opened.dev && current.ino === opened.ino) fs.unlinkSync(tmpPath);
      } catch {
        // Preserve the write failure. Any remaining temp file is private.
      }
    }
  }
}
