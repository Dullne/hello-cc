import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify, TextDecoder } from 'node:util';
import { CliError } from '../shared/errors.mjs';
import { preparePinnedCwdLaunch } from '../process/pinned-cwd.mjs';
import { captureSelectedCwdIdentity } from '../process/selected-cwd-identity.mjs';

export const PROJECT_FILE_LIMITS = Object.freeze({ entries: 500, scannedEntries: 5000,
  textBytes: 1024 * 1024, mediaBytes: 10 * 1024 * 1024, sniffBytes: 4096 });

const ignored = new Set(['.git', '.hg', '.svn', '.hello-cc', '.hcc', '.codex', '.claude', '.dsh',
  '.ssh', '.aws', '.azure', '.gcloud', '.gnupg', '.config', '.local', '.docker', '.kube', '.terraform',
  'node_modules', '.cache', '.npm', '.pnpm-store', '.yarn', '.next', '.nuxt', '.turbo', '.parcel-cache',
  'coverage', '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox']);
const privateNames = new Set(['.envrc', '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.gitconfig',
  '.boto', '.bash_history', '.zsh_history', '.python_history', 'auth.json', 'accounts.json']);
const textExtensions = new Set(['.txt', '.log', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.conf', '.xml', '.csv', '.tsv', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.scss', '.sass',
  '.less', '.py', '.rb', '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.java', '.kt', '.swift', '.sh',
  '.bash', '.zsh', '.fish', '.ps1', '.sql', '.graphql', '.gql', '.vue', '.svelte', '.mdx', '.svg', '.tex',
  '.rst', '.diff', '.patch', '.lock', '.properties', '.gradle', '.cmake']);
const markdownExtensions = new Set(['.md', '.markdown', '.mdown']);
const htmlExtensions = new Set(['.html', '.htm']);
const media = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.pdf', 'application/pdf']]);
const errorStatus = new Map([['PROJECT_FILE_BAD_PATH', 400], ['PROJECT_FILE_FORBIDDEN', 403],
  ['PROJECT_FILE_NOT_FOUND', 404], ['PROJECT_FILE_CHANGED', 409], ['PROJECT_FILE_TOO_LARGE', 413],
  ['PROJECT_FILE_CONFLICT', 409], ['PROJECT_FILE_EXISTS', 409],
  ['PROJECT_FILE_WRITE_UNCONFIRMED', 503], ['PROJECT_FILE_WRITE_UNAVAILABLE', 503],
  ['PROJECT_FILE_NOT_DIRECTORY', 400], ['PROJECT_FILE_NOT_REGULAR', 400], ['PROJECT_FILE_UNAVAILABLE', 500]]);

export function projectFileErrorStatus(error) { return errorStatus.get(error?.code); }

export function privateComponent(name) {
  const lower = name.toLowerCase();
  return ignored.has(lower) || privateNames.has(lower) || /^\.hcc-file-write-/.test(lower) || /^(?:\.?env)(?:[._-]|$)/.test(lower) ||
    /\.env(?:[._-]|$)/.test(lower) ||
    /^(?:auth|accounts)(?:[._-](?:backup|bak|old|orig|copy))?\.(?:json|jsonl)(?:[._-](?:backup|bak|old|orig|copy))?$/.test(lower) ||
    /(?:^|[._-])(?:secrets?|credentials?|tokens?)(?:[._-]|$)/.test(lower) ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|terraform\.tfstate)(?:[.-]|$)/.test(lower) ||
    /^service[-_]account(?:[._-]|$)/.test(lower) || /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ovpn)(?:[.-]|$)/.test(lower);
}

function relativePath(value, allowRoot) {
  if (typeof value !== 'string' || value.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(value) ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new CliError('PROJECT_FILE_BAD_PATH', 'Use a project-relative path with forward slashes');
  }
  if (allowRoot && value === '') return [];
  const parts = value.split('/');
  if (parts.length > 128 || parts.some(part => !part || part === '.' || part === '..')) {
    throw new CliError('PROJECT_FILE_BAD_PATH', 'Use a project-relative path without traversal or empty components');
  }
  if (parts.some(privateComponent)) throw new CliError('PROJECT_FILE_FORBIDDEN', 'This private or cache path is excluded from project previews');
  return parts;
}

export function projectFilePathParts(value, allowRoot) { return relativePath(value, allowRoot); }

export function isProjectTextPath(name) {
  const extension = path.extname(name).toLowerCase();
  return !extension || textExtensions.has(extension) || markdownExtensions.has(extension) || htmlExtensions.has(extension);
}

export function projectContentRevision(stat, bytes) {
  const identity = [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs, stat.nlink]
    .map(value => value === null || value === undefined ? null : String(value));
  return 'v1-' + createHash('sha256').update(JSON.stringify(identity)).update('\0').update(bytes).digest('hex');
}

function contentHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}

function changed() { return new CliError('PROJECT_FILE_CHANGED', 'The project path changed while being read; refresh and try again'); }

function assertBoundRoot(rootIdentity, stat = null) {
  if (!rootIdentity) return;
  rootIdentity.assertUnchanged();
  if (stat && (rootIdentity.identity.dev !== stat.dev.toString() ||
      rootIdentity.identity.ino !== stat.ino.toString() ||
      rootIdentity.identity.birthtimeNs !== (stat.birthtimeNs?.toString() || null))) {
    throw new CliError('PROJECT_PATH_CHANGED', 'Selected project directory changed; select its current location again');
  }
}

function publicError(error) {
  if (error instanceof CliError) return error;
  if (['ENOENT', 'ENOTDIR'].includes(error.code)) return new CliError('PROJECT_FILE_NOT_FOUND', 'The requested project path was not found');
  if (['EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return new CliError('PROJECT_FILE_FORBIDDEN', 'The requested project path cannot be previewed');
  return new CliError('PROJECT_FILE_UNAVAILABLE', 'The requested project path could not be read');
}

const execFileAsync = promisify(execFile);

// The helper is launched with a checked directory identity and uses only
// relative names after entering that inode. It never opens a project path.
export async function runPinnedDirectoryWorker(directory, expectedIdentity, source, input) {
  const binding = preparePinnedCwdLaunch(directory, process.execPath,
    ['-e', source, JSON.stringify(input)], {
      purpose: 'maintenance', expectedIdentity,
      env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '', NODE_NO_WARNINGS: '1' }
    });
  try {
    const { stdout } = await execFileAsync(binding.command, binding.args, {
      cwd: binding.cwd, env: binding.env, timeout: 10000, maxBuffer: 4 * 1024 * 1024
    });
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = String(error.stderr || '');
    if (/HCC_PINNED_CWD_CHANGED:/.test(stderr)) throw changed();
    const workerError = /HCC_DIRECTORY_WORKER_FAILED:([A-Z_]+)/.exec(stderr);
    if (workerError?.[1] === 'PROJECT_FILE_CHANGED') throw changed();
    if (workerError) { const failure = new Error(workerError[1]); failure.code = workerError[1]; throw failure; }
    throw error;
  } finally { binding.release(); }
}

function projectListWorker() {
  const fs = require('node:fs');
  const { scannedEntries } = JSON.parse(process.argv[1]);
  const entries = [];
  let scanned = 0, truncated = false, directory;
  try {
    directory = fs.opendirSync('.');
    for (let item; (item = directory.readSync()) !== null;) {
      if (++scanned > scannedEntries) { truncated = true; break; }
      if (privateComponent(item.name) || /[\\:\x00-\x1f\x7f]/.test(item.name) || item.isSymbolicLink()) continue;
      if (!item.isDirectory() && !item.isFile()) continue;
      let stat;
      try { stat = fs.lstatSync(item.name, { bigint: true }); }
      catch (error) { if (error.code === 'ENOENT') error.code = 'PROJECT_FILE_CHANGED'; throw error; }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))) continue;
      entries.push({ name: item.name, type: stat.isDirectory() ? 'directory' : 'file',
        ...(stat.isFile() ? { size: Number(stat.size) } : {}) });
    }
    process.stdout.write(JSON.stringify({ entries, truncated }));
  } catch (error) {
    process.stderr.write('HCC_DIRECTORY_WORKER_FAILED:' + (error.code || 'PROJECT_FILE_UNAVAILABLE') + '\n');
    process.exitCode = 1;
  } finally { directory?.closeSync(); }
}

export const PROJECT_PRIVATE_COMPONENT_WORKER_SOURCE = `const ignored = new Set(${JSON.stringify([...ignored])});\n` +
  `const privateNames = new Set(${JSON.stringify([...privateNames])});\n` +
  `const privateComponent = ${privateComponent.toString()};\n`;
const PROJECT_LIST_WORKER_SOURCE = PROJECT_PRIVATE_COMPONENT_WORKER_SOURCE +
  `(${projectListWorker.toString()})()`;

// Windows has no trusted pinned-cwd launch. Keep its existing read-only
// listing behavior; transient ancestor replacement remains outside this POSIX fix.
async function listProjectFilesByPath(snapshot) {
  let directory;
  try {
    directory = await fs.opendir(snapshot.absolute);
    const entries = [];
    let scanned = 0, truncated = false;
    for await (const item of directory) {
      if (++scanned > PROJECT_FILE_LIMITS.scannedEntries) { truncated = true; break; }
      if (privateComponent(item.name) || /[\\:\x00-\x1f\x7f]/.test(item.name) || item.isSymbolicLink()) continue;
      if (!item.isDirectory() && !item.isFile()) continue;
      let stat;
      try { stat = await fs.lstat(path.join(snapshot.absolute, item.name), { bigint: true }); }
      catch (error) { if (error.code === 'ENOENT') throw changed(); throw error; }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))) continue;
      entries.push({ name: item.name, type: stat.isDirectory() ? 'directory' : 'file',
        ...(stat.isFile() ? { size: Number(stat.size) } : {}) });
    }
    directory = null;
    return { entries, truncated };
  } finally { await directory?.close().catch(() => {}); }
}

async function inspectPath(root, parts, directory, rootIdentity) {
  assertBoundRoot(rootIdentity);
  const base = await fs.realpath(root), chain = [];
  let absolute = base;
  for (let index = 0; index <= parts.length; index++) {
    if (index) absolute = path.join(absolute, parts[index - 1]);
    const stat = await fs.lstat(absolute, { bigint: true });
    if (!index) assertBoundRoot(rootIdentity, stat);
    if (stat.isSymbolicLink()) throw new CliError('PROJECT_FILE_FORBIDDEN', 'Symbolic links are excluded from project previews');
    const needsDirectory = index < parts.length || directory;
    if (needsDirectory && !stat.isDirectory()) throw new CliError('PROJECT_FILE_NOT_DIRECTORY', 'The requested project path is not a directory');
    if (!needsDirectory && (!stat.isFile() || stat.nlink !== 1n)) {
      throw new CliError('PROJECT_FILE_FORBIDDEN', 'Only ordinary files with one link can be previewed');
    }
    chain.push({ absolute, stat });
  }
  if (await fs.realpath(absolute) !== absolute) throw changed();
  return { root, base, absolute, chain, stat: chain.at(-1).stat, rootIdentity };
}

async function verifyPath(snapshot, handle) {
  assertBoundRoot(snapshot.rootIdentity, snapshot.chain[0].stat);
  if (await fs.realpath(snapshot.root) !== snapshot.base || await fs.realpath(snapshot.absolute) !== snapshot.absolute) throw changed();
  for (const item of snapshot.chain) {
    const current = await fs.lstat(item.absolute, { bigint: true });
    if (current.isSymbolicLink() || !sameIdentity(current, item.stat)) throw changed();
  }
  if (!sameIdentity(await handle.stat({ bigint: true }), snapshot.stat)) throw changed();
  assertBoundRoot(snapshot.rootIdentity, snapshot.chain[0].stat);
}

export async function verifyProjectFileParent(snapshot, handle) { await verifyPath(snapshot, handle); }

/** Caller owns the returned parent FD and must close it after its operation. */
export async function prepareProjectFileParent(root, relative, { rootIdentity } = {}) {
  try {
    const parts = relativePath(relative, false);
    const snapshot = await inspectPath(root, parts.slice(0, -1), true, rootIdentity);
    const handle = await openChecked(snapshot, true);
    return { snapshot, handle, name: parts.at(-1) };
  } catch (error) { throw publicError(error); }
}

async function openChecked(snapshot, directory) {
  const handle = await fs.open(snapshot.absolute, constants.O_RDONLY | constants.O_NOFOLLOW |
    constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0));
  try {
    const stat = await handle.stat({ bigint: true });
    if (!sameIdentity(stat, snapshot.stat) || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) throw changed();
    await verifyPath(snapshot, handle);
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

/** Single-level listing only. No project module or executable is loaded. */
export async function listProjectFiles(root, relative = '', { rootIdentity } = {}) {
  let handle, ownedIdentity;
  try {
    const parts = relativePath(relative, true);
    ownedIdentity = rootIdentity ? null : captureSelectedCwdIdentity(root);
    const identity = rootIdentity || ownedIdentity;
    const snapshot = await inspectPath(root, parts, true, identity);
    handle = await openChecked(snapshot, true);
    let listing;
    if (process.platform === 'win32') listing = await listProjectFilesByPath(snapshot);
    else {
      const expectedIdentity = { canonical: snapshot.absolute, identity: {
        dev: snapshot.stat.dev.toString(), ino: snapshot.stat.ino.toString(),
        birthtimeNs: snapshot.stat.birthtimeNs?.toString() || null } };
      listing = await runPinnedDirectoryWorker(snapshot.absolute, expectedIdentity,
        PROJECT_LIST_WORKER_SOURCE, { scannedEntries: PROJECT_FILE_LIMITS.scannedEntries });
    }
    const entries = listing.entries.map(item => ({ ...item,
      path: relative ? relative + '/' + item.name : item.name }));
    await verifyPath(snapshot, handle);
    assertBoundRoot(identity, snapshot.chain[0].stat);
    entries.sort((a, b) => a.type === b.type ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === 'directory' ? -1 : 1);
    return { path: relative, entries: entries.slice(0, PROJECT_FILE_LIMITS.entries),
      truncated: listing.truncated || entries.length > PROJECT_FILE_LIMITS.entries };
  } catch (error) { throw publicError(error); }
  finally { await handle?.close().catch(() => {}); ownedIdentity?.release(); }
}

async function readBytes(handle, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
    if (!bytesRead) throw changed();
    offset += bytesRead;
  }
  return buffer;
}

function textContent(bytes, truncated) {
  try {
    // Streaming decode deliberately withholds an incomplete final UTF-8 code
    // point when the file exceeds the byte budget.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated });
    if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) return null;
    return text;
  } catch { return null; }
}

export function projectTextContent(bytes, truncated) { return textContent(bytes, truncated); }

function newlineStyle(text) {
  if (!/[\r\n]/.test(text)) return 'none';
  const withoutCrlf = text.replace(/\r\n/g, '');
  const hasBareNewline = /[\r\n]/.test(withoutCrlf);
  if (text.includes('\r\n')) return hasBareNewline ? 'mixed' : 'crlf';
  return text.includes('\r') ? 'mixed' : 'lf';
}

function validMedia(bytes, mime) {
  if (mime === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  if (mime === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return mime === 'application/pdf' && /^%PDF-[12]\.\d/.test(bytes.subarray(0, 8).toString('ascii'));
}

/** Content is returned only as JSON data; callers must isolate HTML/media. */
export async function previewProjectFile(root, relative, { rootIdentity } = {}) {
  let handle;
  try {
    const parts = relativePath(relative, false), snapshot = await inspectPath(root, parts, false, rootIdentity);
    handle = await openChecked(snapshot, false);
    const name = parts.at(-1), size = Number(snapshot.stat.size), extension = path.extname(name).toLowerCase();
    const result = { path: relative, name, size, kind: 'unsupported', mime: 'application/octet-stream', encoding: 'base64', content: '', editable: false };
    const mime = media.get(extension);
    if (mime) {
      if (size > PROJECT_FILE_LIMITS.mediaBytes) throw new CliError('PROJECT_FILE_TOO_LARGE', 'Image and PDF previews are limited to 10 MiB');
      const bytes = await readBytes(handle, size);
      if (validMedia(bytes, mime)) Object.assign(result, { kind: mime === 'application/pdf' ? 'pdf' : 'image', mime, content: bytes.toString('base64') });
    } else if (isProjectTextPath(name)) {
      const prefix = await readBytes(handle, Math.min(size, PROJECT_FILE_LIMITS.sniffBytes));
      if (textContent(prefix, size > prefix.length) !== null) {
        const bytes = size <= prefix.length ? prefix : await readBytes(handle, Math.min(size, PROJECT_FILE_LIMITS.textBytes));
        const truncated = size > bytes.length, content = textContent(bytes, truncated);
        if (content !== null) {
          Object.assign(result, { kind: markdownExtensions.has(extension) ? 'markdown' : htmlExtensions.has(extension) ? 'html' : 'text',
            mime: markdownExtensions.has(extension) ? 'text/markdown' : htmlExtensions.has(extension) ? 'text/html' : 'text/plain',
            encoding: 'utf8', content, truncated });
          if (!truncated) Object.assign(result, { editable: true, revision: projectContentRevision(snapshot.stat, bytes),
            contentHash: contentHash(bytes), bom: content.startsWith('\ufeff'), newline: newlineStyle(content) });
        }
      }
    }
    await verifyPath(snapshot, handle);
    assertBoundRoot(rootIdentity, snapshot.chain[0].stat);
    return result;
  } catch (error) { throw publicError(error); }
  finally { await handle?.close().catch(() => {}); }
}

/** A bounded exact-byte status response; it never returns file content. */
export async function inspectProjectFileStatus(root, relative, { rootIdentity } = {}) {
  let handle;
  try {
    const parts = relativePath(relative, false), snapshot = await inspectPath(root, parts, false, rootIdentity);
    handle = await openChecked(snapshot, false);
    const size = Number(snapshot.stat.size);
    if (size > PROJECT_FILE_LIMITS.mediaBytes) throw new CliError('PROJECT_FILE_TOO_LARGE', 'File status reads are limited to 10 MiB');
    const bytes = await readBytes(handle, size);
    await verifyPath(snapshot, handle);
    return { path: relative, size, contentHash: contentHash(bytes) };
  } catch (error) { throw publicError(error); }
  finally { await handle?.close().catch(() => {}); }
}
