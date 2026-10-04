import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CliError } from '../shared/errors.mjs';
import { withFileLock } from '../shared/file-lock.mjs';
import { preparePinnedCwdLaunch } from '../process/pinned-cwd.mjs';
import { PROJECT_FILE_LIMITS, projectFilePathParts, projectTextContent, isProjectTextPath,
  projectContentRevision, prepareProjectFileParent, verifyProjectFileParent } from './project-files.mjs';

// Serialized into a built-ins-only Node child. The trusted bootstrap pins cwd
// to the validated parent inode; every mutation below uses a single basename.
// HCC writers share a cross-process lock. Other editors do not share that lock,
// so the final revision check is optimistic, not an OS-level compare-and-swap.
function fileWriteWorker(revisionOf) {
  const fs = require('node:fs');
  const { createHash, randomBytes } = require('node:crypto');
  const { TextDecoder } = require('node:util');
  const textOf = bytes => {
    try {
      const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(value)) return null;
      return value;
    } catch { return null; }
  };
  let temporary = null, tempFd, oldFd, tempIdentity, published = false, attempted = false;
  const fail = code => { const error = new Error(code); error.code = code; throw error; };
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  const ordinary = stat => stat.isFile() && stat.nlink === 1n;
  const readBounded = (fd, stat, maxBytes, code) => {
    if (stat.size > BigInt(maxBytes)) fail(code);
    const result = Buffer.alloc(Number(stat.size));
    let position = 0;
    while (position < result.length) {
      const count = fs.readSync(fd, result, position, result.length - position, position);
      if (!count) fail(code);
      position += count;
    }
    if (!same(stat, fs.fstatSync(fd, { bigint: true }))) fail(code);
    return result;
  };
  let receipt, failure;
  try {
    const request = JSON.parse(fs.readFileSync(0, 'utf8'));
    const name = request.name, bytes = Buffer.from(request.content, 'base64');
    if (!name || /[\\/\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..') fail('PROJECT_FILE_BAD_PATH');
    let before;
    if (request.operation === 'save') {
      oldFd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      before = fs.fstatSync(oldFd, { bigint: true });
      if (!ordinary(before)) fail('PROJECT_FILE_FORBIDDEN');
      if (before.size > 1048576n) fail('PROJECT_FILE_TOO_LARGE');
      const oldBytes = readBounded(oldFd, before, 1048576, 'PROJECT_FILE_CONFLICT');
      if (!same(before, fs.fstatSync(oldFd, { bigint: true })) ||
          revisionOf(before, oldBytes) !== request.revision) fail('PROJECT_FILE_CONFLICT');
      if (textOf(oldBytes, false) === null) fail('PROJECT_FILE_FORBIDDEN');
    } else if (request.operation === 'upload') {
      try { fs.lstatSync(name); fail('PROJECT_FILE_EXISTS'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else fail('PROJECT_FILE_BAD_PATH');
    temporary = '.hcc-file-write-' + randomBytes(18).toString('hex');
    tempFd = fs.openSync(temporary, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    tempIdentity = fs.fstatSync(tempFd, { bigint: true });
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(tempFd, bytes, offset, bytes.length - offset, offset);
      if (!written) fail('PROJECT_FILE_WRITE_UNAVAILABLE');
      offset += written;
    }
    fs.fchmodSync(tempFd, request.operation === 'save' ? Number(before.mode & 0o777n) : 0o644);
    fs.fsyncSync(tempFd);
    /* PINNED_FILE_TEST_BEFORE_PUBLISH */
    const prepared = fs.fstatSync(tempFd, { bigint: true });
    if (!ordinary(prepared) || !same(prepared, fs.lstatSync(temporary, { bigint: true })) ||
        !readBounded(tempFd, prepared, bytes.length, 'PROJECT_FILE_CHANGED').equals(bytes)) fail('PROJECT_FILE_CHANGED');
    if (request.operation === 'save') {
      const current = fs.lstatSync(name, { bigint: true }), oldStat = fs.fstatSync(oldFd, { bigint: true });
      if (!ordinary(current) || !same(before, current) || !same(before, oldStat)) fail('PROJECT_FILE_CONFLICT');
      // Re-read immediately before publication to detect same-inode edits too.
      const currentBytes = readBounded(oldFd, oldStat, 1048576, 'PROJECT_FILE_CONFLICT');
      if (revisionOf(fs.fstatSync(oldFd, { bigint: true }), currentBytes) !== request.revision) fail('PROJECT_FILE_CONFLICT');
      attempted = true;
      fs.renameSync(temporary, name);
      published = true; temporary = null;
    } else {
      // link is an atomic, exclusive publication: a concurrent creator wins
      // with EEXIST and readers never observe a partly uploaded file.
      attempted = true;
      try { fs.linkSync(temporary, name); }
      catch (error) { if (error.code === 'EEXIST') { attempted = false; fail('PROJECT_FILE_EXISTS'); } throw error; }
      published = true;
      fs.unlinkSync(temporary); temporary = null;
    }
    /* PINNED_FILE_TEST_AFTER_PUBLISH */
    const final = fs.fstatSync(tempFd, { bigint: true }), visible = fs.lstatSync(name, { bigint: true });
    if (!ordinary(final) || !same(final, visible) || final.size !== BigInt(bytes.length)) fail('PROJECT_FILE_WRITE_UNCONFIRMED');
    const finalBytes = readBounded(tempFd, final, bytes.length, 'PROJECT_FILE_WRITE_UNCONFIRMED');
    if (!finalBytes.equals(bytes) || !same(final, fs.lstatSync(name, { bigint: true }))) fail('PROJECT_FILE_WRITE_UNCONFIRMED');
    const directoryFd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    receipt = { size: finalBytes.length, contentHash: createHash('sha256').update(finalBytes).digest('hex'),
      ...(request.operation === 'save' ? { saved: true, revision: revisionOf(final, finalBytes) } : { created: true }) };
  } catch (error) {
    failure = published || attempted ? 'PROJECT_FILE_WRITE_UNCONFIRMED' : error.code || 'PROJECT_FILE_WRITE_UNAVAILABLE';
  } finally {
    // Only our random temporary inode may be removed. Never unlink the public
    // name on errors: publication may already have succeeded.
    if (temporary && tempIdentity) {
      try {
        const current = fs.lstatSync(temporary, { bigint: true });
        if (current.isFile() && current.dev === tempIdentity.dev && current.ino === tempIdentity.ino) fs.unlinkSync(temporary);
      } catch {}
    }
    for (const fd of [oldFd, tempFd]) if (fd !== undefined) { try { fs.closeSync(fd); } catch { failure = 'PROJECT_FILE_WRITE_UNCONFIRMED'; } }
  }
  process.stdout.write(JSON.stringify(failure ? { error: { code: failure } } : { receipt }));
}

function workerSource() {
  return "const { createHash } = require('node:crypto'); (" + fileWriteWorker.toString() + ')(' + projectContentRevision.toString() + ');';
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validateSave(input) {
  if (!exactKeys(input, ['path', 'revision', 'content']) || typeof input.revision !== 'string' ||
      !/^v1-[a-f0-9]{64}$/.test(input.revision) || typeof input.content !== 'string') {
    throw new CliError('BAD_REQUEST', 'Text saves require only path, preview revision and content');
  }
  projectFilePathParts(input.path, false);
  if (!isProjectTextPath(input.path)) throw new CliError('PROJECT_FILE_FORBIDDEN', 'This file type is not editable text');
  if (!input.content.isWellFormed()) throw new CliError('BAD_REQUEST', 'Text must contain valid Unicode');
  const bytes = Buffer.from(input.content, 'utf8');
  if (bytes.length > PROJECT_FILE_LIMITS.textBytes) throw new CliError('PROJECT_FILE_TOO_LARGE', 'Text edits are limited to 1 MiB');
  if (projectTextContent(bytes, false) === null) throw new CliError('BAD_REQUEST', 'Text edits cannot contain binary control characters');
  return bytes;
}
function validateUpload(input) {
  if (!exactKeys(input, ['path', 'encoding', 'content']) || input.encoding !== 'base64' || typeof input.content !== 'string') {
    throw new CliError('BAD_REQUEST', 'Uploads require only path, encoding:base64 and content');
  }
  projectFilePathParts(input.path, false);
  if (input.content.length > Math.ceil(PROJECT_FILE_LIMITS.mediaBytes / 3) * 4) throw new CliError('PROJECT_FILE_TOO_LARGE', 'Uploads are limited to 10 MiB');
  if (input.content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) {
    throw new CliError('BAD_REQUEST', 'Upload content must be canonical base64');
  }
  const bytes = Buffer.from(input.content, 'base64');
  if (bytes.toString('base64') !== input.content) throw new CliError('BAD_REQUEST', 'Upload content must be canonical base64');
  if (bytes.length > PROJECT_FILE_LIMITS.mediaBytes) throw new CliError('PROJECT_FILE_TOO_LARGE', 'Uploads are limited to 10 MiB');
  return bytes;
}
function failure(code) {
  const messages = {
    PROJECT_FILE_CONFLICT: 'The file changed since this preview; reload before saving your draft',
    PROJECT_FILE_EXISTS: 'A file already exists at this path; uploads never overwrite it',
    PROJECT_FILE_WRITE_UNCONFIRMED: 'The write result is unknown; read the file back and compare its content before retrying',
    PROJECT_FILE_WRITE_UNAVAILABLE: 'The file could not be safely written',
    PROJECT_FILE_FORBIDDEN: 'Only ordinary project files with one link may be edited',
    PROJECT_FILE_TOO_LARGE: 'The file exceeds the allowed write size',
    PROJECT_FILE_NOT_FOUND: 'The target file or its parent directory no longer exists',
    PROJECT_FILE_CHANGED: 'The selected project directory changed before the write'
  };
  const normalized = code === 'ENOENT' || code === 'ENOTDIR' ? 'PROJECT_FILE_NOT_FOUND'
    : ['EACCES', 'EPERM', 'ELOOP'].includes(code) ? 'PROJECT_FILE_FORBIDDEN'
      : Object.hasOwn(messages, code) ? code : 'PROJECT_FILE_WRITE_UNAVAILABLE';
  return new CliError(normalized, messages[normalized]);
}

// Creating or replacing a child changes directory timestamps and link counts.
// After publication only directory identity is stable, but the requested path
// must still resolve through the same ancestors before reporting success.
async function verifyPublishedParent(snapshot, handle) {
  snapshot.rootIdentity?.assertUnchanged();
  if (await fs.promises.realpath(snapshot.root) !== snapshot.base ||
      await fs.promises.realpath(snapshot.absolute) !== snapshot.absolute) throw failure('PROJECT_FILE_WRITE_UNCONFIRMED');
  const identityMatches = (current, original) => current.isDirectory() &&
    current.dev === original.dev && current.ino === original.ino && current.birthtimeNs === original.birthtimeNs;
  for (const item of snapshot.chain) {
    const current = await fs.promises.lstat(item.absolute, { bigint: true });
    if (!identityMatches(current, item.stat)) throw failure('PROJECT_FILE_WRITE_UNCONFIRMED');
  }
  if (!identityMatches(await handle.stat({ bigint: true }), snapshot.stat)) throw failure('PROJECT_FILE_WRITE_UNCONFIRMED');
  snapshot.rootIdentity?.assertUnchanged();
}

async function writeProjectFile(root, input, operation, bytes, { rootIdentity, spawnProcess = spawnSync } = {}) {
  if (!['darwin', 'linux'].includes(process.platform) || !fs.constants.O_NOFOLLOW || !fs.constants.O_DIRECTORY) throw failure('PROJECT_FILE_WRITE_UNAVAILABLE');
  const parent = await prepareProjectFileParent(root, input.path, { rootIdentity });
  let receipt;
  try {
    await verifyProjectFileParent(parent.snapshot, parent.handle);
    rootIdentity?.assertUnchanged();
    const expectedIdentity = { canonical: parent.snapshot.absolute, identity: {
      dev: parent.snapshot.stat.dev.toString(), ino: parent.snapshot.stat.ino.toString(),
      birthtimeNs: parent.snapshot.stat.birthtimeNs?.toString() || null } };
    receipt = withFileLock(path.join(parent.snapshot.absolute, parent.name), () => {
      rootIdentity?.assertUnchanged();
      const binding = preparePinnedCwdLaunch(parent.snapshot.absolute, process.execPath, ['-e', workerSource()], {
        purpose: 'maintenance', expectedIdentity,
        env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '', NODE_NO_WARNINGS: '1' }
      });
      try {
        const result = spawnProcess(binding.command, binding.args, { cwd: binding.cwd, env: binding.env,
          input: JSON.stringify({ operation, name: parent.name, revision: input.revision, content: bytes.toString('base64') }),
          encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
        if (result.error || result.status !== 0) {
          if (/HCC_PINNED_CWD_CHANGED:/.test(result.stderr || '')) throw failure('PROJECT_FILE_CHANGED');
          // The worker may have published before a timeout or interrupted pipe.
          throw failure('PROJECT_FILE_WRITE_UNCONFIRMED');
        }
        let value;
        try { value = JSON.parse(result.stdout); } catch { throw failure('PROJECT_FILE_WRITE_UNCONFIRMED'); }
        if (value.error) throw failure(value.error.code);
        const valueReceipt = value.receipt;
        if (!valueReceipt || valueReceipt.size !== bytes.length ||
            valueReceipt.contentHash !== createHash('sha256').update(bytes).digest('hex') ||
            (operation === 'save' ? valueReceipt.saved !== true || !/^v1-[a-f0-9]{64}$/.test(valueReceipt.revision) : valueReceipt.created !== true)) {
          throw failure('PROJECT_FILE_WRITE_UNCONFIRMED');
        }
        // Record publication before the lock/bootstrap release paths run.
        receipt = valueReceipt;
        try { rootIdentity?.assertUnchanged(); } catch { throw failure('PROJECT_FILE_WRITE_UNCONFIRMED'); }
        return valueReceipt;
      } finally { binding.release(); }
    }, { createParent: false, timeoutMs: 5000 });
    await verifyPublishedParent(parent.snapshot, parent.handle);
    return { path: input.path, ...receipt };
  } catch (error) {
    if (receipt) throw failure('PROJECT_FILE_WRITE_UNCONFIRMED');
    if (error instanceof CliError) throw error;
    throw failure(error.code);
  } finally {
    try { await parent.handle.close(); }
    catch { if (receipt) throw failure('PROJECT_FILE_WRITE_UNCONFIRMED'); }
  }
}

export async function saveProjectFile(root, input, options) {
  const bytes = validateSave(input);
  return writeProjectFile(root, input, 'save', bytes, options);
}
export async function uploadProjectFile(root, input, options) {
  const bytes = validateUpload(input);
  return writeProjectFile(root, input, 'upload', bytes, options);
}
