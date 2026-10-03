import fs from 'node:fs';
import process from 'node:process';
import { CliError } from '../shared/errors.mjs';
import { unsafeDirectoryAcl } from './project-trust.mjs';

function forbidden(file) {
  return new CliError('PROJECT_PATH_FORBIDDEN', `Managed file must be an owned private regular file: ${file}`);
}

export function openPrivateAppendFile(file) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
    (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(file, flags, 0o600);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 ||
        (typeof process.getuid === 'function' && opened.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600) ||
        unsafeDirectoryAcl(file, opened)) {
      throw forbidden(file);
    }
    const current = fs.lstatSync(file);
    const secured = fs.fstatSync(fd);
    if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 ||
        current.dev !== secured.dev || current.ino !== secured.ino ||
        (typeof process.getuid === 'function' && current.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (secured.mode & 0o777) !== 0o600)) {
      throw forbidden(file);
    }
    return fd;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error instanceof CliError) throw error;
    throw forbidden(file);
  }
}

export function readPrivateTextFile(file, { maxBytes = 65536 } = {}) {
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw forbidden(file);
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 ||
      (typeof process.getuid === 'function' && before.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (before.mode & 0o777) !== 0o600) ||
      before.size > maxBytes || unsafeDirectoryAcl(file, before)) {
    throw forbidden(file);
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev ||
        opened.ino !== before.ino || opened.size > maxBytes ||
        (typeof process.getuid === 'function' && opened.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600)) {
      throw forbidden(file);
    }
    const content = fs.readFileSync(fd, 'utf8');
    const after = fs.lstatSync(file);
    const current = fs.fstatSync(fd);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino ||
        current.size !== opened.size || current.mtimeMs !== opened.mtimeMs) {
      throw forbidden(file);
    }
    return content;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw forbidden(file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
