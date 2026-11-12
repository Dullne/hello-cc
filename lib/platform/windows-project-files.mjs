import { captureDirectory } from './windows-filesystem.mjs';
import { privateComponent, projectFilePathParts, PROJECT_FILE_LIMITS } from '../web/project-files.mjs';
import { CliError } from '../shared/errors.mjs';

function checkPrivate(parts) {
  if (parts.some(name => privateComponent(name) || /^\.hcc-cwd-pin-/i.test(name))) {
    throw new CliError('PROJECT_FILE_FORBIDDEN', 'This private or cache path is excluded from project previews');
  }
}

function checkRoot(lease, expected) {
  if (!expected) return;
  expected.assertUnchanged?.();
  const snapshot = lease.snapshot();
  const fields = ['version', 'platform', 'volumeSerial', 'fileId', 'creationTime'];
  if (snapshot.canonical !== expected.canonical || fields.some(key => snapshot.identity[key] !== expected.identity?.[key])) {
    throw new CliError('PROJECT_PATH_CHANGED', 'The selected project directory changed');
  }
}

export function readWindowsProjectFile(root, relative, { rootIdentity, maxBytes = PROJECT_FILE_LIMITS.textBytes, requireComplete = false } = {}) {
  const parts = projectFilePathParts(relative, false); checkPrivate(parts);
  const lease = captureDirectory(root, { pin: false }); let file;
  try {
    checkRoot(lease, rootIdentity);
    if (typeof lease.openFile !== 'function') throw new CliError('WINDOWS_NATIVE_UNAVAILABLE', 'Handle-based Windows file reads are unavailable.');
    file = lease.openFile(relative);
    const snapshot = file.snapshot(); checkPrivate(snapshot.actualComponents);
    if (requireComplete && BigInt(snapshot.size) > BigInt(maxBytes)) throw new CliError('PROJECT_FILE_TOO_LARGE', 'The file exceeds the allowed read size');
    const bytes = file.read(maxBytes);
    file.assertUnchanged(); checkRoot(lease, rootIdentity);
    return { snapshot, bytes, truncated: BigInt(snapshot.size) > BigInt(bytes.length) };
  } finally { file?.close(); lease.close(); }
}

export function listWindowsProjectFiles(root, relative = '', { rootIdentity } = {}) {
  const parts = projectFilePathParts(relative, true); checkPrivate(parts);
  const lease = captureDirectory(root, { pin: false }); let directory;
  try {
    checkRoot(lease, rootIdentity);
    if (typeof lease.openDirectory !== 'function') throw new CliError('WINDOWS_NATIVE_UNAVAILABLE', 'Handle-based Windows directory listing is unavailable.');
    directory = lease.openDirectory(relative);
    checkPrivate(directory.snapshot().actualComponents);
    const listed = directory.list({ maxScanned: PROJECT_FILE_LIMITS.scannedEntries });
    const entries = listed.entries.filter(item => !privateComponent(item.name) && !/^\.hcc-cwd-pin-/i.test(item.name))
      .map(item => ({ ...item, path: relative ? `${relative}/${item.name}` : item.name }));
    directory.assertUnchanged(); checkRoot(lease, rootIdentity);
    entries.sort((a, b) => a.type === b.type ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === 'directory' ? -1 : 1);
    return { path: relative, entries: entries.slice(0, PROJECT_FILE_LIMITS.entries),
      truncated: listed.truncated || entries.length > PROJECT_FILE_LIMITS.entries };
  } finally { directory?.close(); lease.close(); }
}

export function prepareWindowsProjectFileParent(root, relative, { rootIdentity } = {}) {
  const parts = projectFilePathParts(relative, false); checkPrivate(parts);
  const lease = captureDirectory(root); let handle;
  try {
    checkRoot(lease, rootIdentity); handle = lease.openDirectory(parts.slice(0, -1).join('/'));
    const snapshot = handle.snapshot(); checkPrivate(snapshot.actualComponents); let name = parts.at(-1), target;
    try { target = handle.openFile(name); const actual = target.snapshot().actualComponents; checkPrivate(actual); name = actual.at(-1); }
    catch (error) { if (!['PROJECT_FILE_NOT_FOUND', 'PROJECT_FILE_FORBIDDEN', 'PROJECT_FILE_NOT_DIRECTORY'].includes(error?.code)) throw error; }
    finally { target?.close(); }
    return { snapshot: { ...snapshot, absolute: snapshot.canonical, platform: 'win32', rootIdentity }, handle, name };
  } catch (error) { handle?.close(); throw error; }
  finally { lease.close(); }
}

export function listWindowsContextFiles(root, query, { rootIdentity, limit, maxEntries, timeBudgetMs, ignored, now }) {
  const lease = captureDirectory(root, { pin: false });
  const allowed = parts => !parts.some(name => ignored.has(name.toLowerCase()) || privateComponent(name) || /^\.hcc-cwd-pin-/i.test(name));
  const paths = [], pending = [''], needle = query.toLocaleLowerCase(); let exact = null, seen = 0, truncated = false;
  const deadline = now() + timeBudgetMs;
  const skip = error => ['BAD_ARGS', 'PROJECT_FILE_FORBIDDEN', 'PROJECT_FILE_NOT_FOUND', 'PROJECT_FILE_NOT_DIRECTORY'].includes(error?.code);
  try {
    checkRoot(lease, rootIdentity);
    if (query && allowed(query.split('/'))) {
      let file;
      try {
        file = lease.openFile(query); const snapshot = file.snapshot();
        if (allowed(snapshot.actualComponents)) { exact = snapshot.actualComponents.join('/'); paths.push(exact); }
      } catch (error) { if (!skip(error)) throw error; } finally { file?.close(); }
    }
    while (pending.length) {
      if (now() >= deadline || seen >= maxEntries || paths.length >= limit) { truncated = true; break; }
      const relative = pending.shift(); let directory;
      try {
        directory = lease.openDirectory(relative);
        if (!allowed(directory.snapshot().actualComponents)) continue;
        const listing = directory.list({ maxScanned: Math.min(5000, maxEntries - seen), timeBudgetMs: Math.min(60000, Math.max(0, Math.floor(deadline - now()))) }); seen += listing.scanned;
        if (listing.truncated) truncated = true;
        for (const entry of listing.entries) {
          if (now() >= deadline) { truncated = true; break; }
          if (!allowed([entry.name])) continue;
          const name = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.type === 'directory') pending.push(name);
          else if (name !== exact && name.toLocaleLowerCase().includes(needle)) {
            paths.push(name); if (paths.length >= limit) { truncated = true; break; }
          }
        }
        directory.assertUnchanged();
      } catch (error) { if (!skip(error)) throw error; } finally { directory?.close(); }
      if (truncated) break;
    }
    lease.assertUnchanged(); checkRoot(lease, rootIdentity);
    return { paths: paths.sort(), truncated };
  } finally { lease.close(); }
}

export function publishWindowsProjectFile(root, relative, bytes, { rootIdentity, operation, expectedSnapshot, expectedBytes } = {}) {
  const parts = projectFilePathParts(relative, false); checkPrivate(parts);
  if (!Buffer.isBuffer(bytes) || bytes.length > PROJECT_FILE_LIMITS.mediaBytes || !['create', 'replace'].includes(operation)) {
    throw new CliError('BAD_ARGS', 'A bounded byte buffer and create or replace operation are required.');
  }
  const lease = captureDirectory(root); let parent, previous;
  try {
    checkRoot(lease, rootIdentity);
    parent = lease.openDirectory(parts.slice(0, -1).join('/'));
    checkPrivate(parent.snapshot().actualComponents);
    if (operation === 'replace') {
      previous = parent.openFile(parts.at(-1)); checkPrivate(previous.snapshot().actualComponents); previous.close(); previous = null;
    }
    if (typeof parent.publish !== 'function') throw new CliError('WINDOWS_NATIVE_UNAVAILABLE', 'Handle-based publication is unavailable.');
    const receipt = parent.publish(parts.at(-1), bytes, operation === 'create' ? { operation } :
      { operation, expectedIdentity: expectedSnapshot?.identity, expectedBytes });
    try { checkRoot(lease, rootIdentity); }
    catch (error) {
      throw new CliError('PROJECT_FILE_WRITE_UNCONFIRMED', 'The file was published but its project binding could not be confirmed.', { cause: error?.code });
    }
    return receipt;
  } finally { previous?.close(); parent?.close(); lease.close(); }
}
