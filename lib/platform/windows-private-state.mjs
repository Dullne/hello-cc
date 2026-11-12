import path from 'node:path';
import { CliError } from '../shared/errors.mjs';
import { loadWindowsNative } from './windows-native.mjs';
import { captureDirectory } from './windows-filesystem.mjs';

// Windows object identities are versioned independently from POSIX stat fields.
// Decimal values remain strings so volumes and creation times do not lose bits.
export function isWindowsFileIdentity(value) {
  return value?.platform === 'win32' && value.version === 1 &&
    typeof value.volumeSerial === 'string' && /^(0|[1-9][0-9]*)$/.test(value.volumeSerial) &&
    typeof value.fileId === 'string' && /^[a-f0-9]{32}$/.test(value.fileId) &&
    typeof value.creationTime === 'string' && /^[1-9][0-9]*$/.test(value.creationTime);
}

export function sameWindowsFileIdentity(left, right) {
  return Boolean(isWindowsFileIdentity(left) && isWindowsFileIdentity(right) &&
    left.volumeSerial === right.volumeSerial && left.fileId === right.fileId &&
    left.creationTime === right.creationTime);
}

function forbidden(target) {
  return new CliError('PROJECT_PATH_FORBIDDEN', `Windows private state requires a trusted private filesystem object: ${target}`);
}

function requireMethod(object, name) {
  if (typeof object?.[name] !== 'function') {
    throw new CliError('WINDOWS_NATIVE_UNAVAILABLE', `The Windows private-state component does not provide ${name}.`);
  }
}

// The state transition callback is synchronous. Retain every acquired parent
// until it finishes, including parents of newly created state directories.
let activeScope = null;
export function withWindowsPrivateScope(fn) {
  if (activeScope) return fn();
  const scope = new Map(); activeScope = scope;
  try { return fn(); }
  finally {
    activeScope = null;
    for (const lease of [...scope.values()].reverse()) lease.close();
  }
}

function withDirectory(target, fn, { privateLeaf = true, pin = Boolean(activeScope) } = {}) {
  const key = `${pin}\0${target}`;
  let lease = activeScope?.get(key);
  const owned = !lease;
  if (owned) {
    lease = captureCheckedDirectory(target, { privateLeaf, pin });
    if (activeScope) activeScope.set(key, lease);
  }
  try {
    const native = loadWindowsNative(); requireMethod(native, 'inspectDirectoryAncestry');
    if (native.inspectDirectoryAncestry(target).trusted !== true) throw forbidden(target);
    requireMethod(lease, 'security');
    if (privateLeaf && lease.security().private !== true) throw forbidden(target);
    lease.assertUnchanged();
    const result = fn(lease);
    lease.assertUnchanged();
    if (privateLeaf && lease.security().private !== true) throw forbidden(target);
    return result;
  } finally { if (owned && !activeScope) lease.close(); }
}

function captureCheckedDirectory(target, { privateLeaf = true, pin = true } = {}) {
  // A pin creates a sentinel. Establish trust with a non-mutating observation
  // before acquiring it, then compare the actual retained objects.
  const observed = captureDirectory(target, { pin: false });
  let lease, accepted = false;
  try {
    const native = loadWindowsNative(); requireMethod(native, 'inspectDirectoryAncestry');
    if (native.inspectDirectoryAncestry(target).trusted !== true) throw forbidden(target);
    requireMethod(observed, 'security');
    if (privateLeaf && observed.security().private !== true) throw forbidden(target);
    observed.assertUnchanged();
    lease = pin ? captureDirectory(target, { pin: true }) : observed;
    if (!sameWindowsFileIdentity(observed.snapshot().identity, lease.snapshot().identity) ||
        (privateLeaf && lease.security().private !== true)) throw forbidden(target);
    lease.assertUnchanged();
    accepted = true;
    return lease;
  } catch (error) {
    if (lease && lease !== observed) lease.close();
    throw error;
  } finally { if (!accepted || lease !== observed) observed.close(); }
}

export function inspectWindowsPrivateDirectory(target) {
  return withDirectory(target, lease => lease.snapshot());
}

export function inspectWindowsHomeAncestry(target) {
  return withDirectory(target, () => true, { privateLeaf: false });
}

function withMutableDirectory(target, fn, options = {}) {
  return withDirectory(target, lease => {
    const directory = lease.openDirectory('');
    try { return fn(directory); }
    finally { directory.close(); }
  }, { ...options, pin: true });
}

export function createWindowsPrivateDirectory(target) {
  return withMutableDirectory(path.dirname(target), parent => {
    requireMethod(parent, 'createDirectory'); requireMethod(parent, 'flush');
    let created;
    try {
      created = parent.createDirectory(path.basename(target), { private: true });
      if (created.security().private !== true) throw forbidden(target);
      try { parent.flush(); }
      catch (error) {
        throw new CliError('WINDOWS_STATE_PUBLICATION_UNCONFIRMED',
          'Windows private directory was created, but its parent flush could not be confirmed.', { reason: error.code });
      }
    } catch (error) { if (error?.code !== 'PROJECT_FILE_EXISTS') throw error; }
    finally { created?.close(); }
    return inspectWindowsPrivateDirectory(target);
  }, { privateLeaf: false });
}

export function listWindowsPrivateDirectory(target, { maxEntries = 256 } = {}) {
  return withDirectory(target, lease => {
    requireMethod(lease, 'openDirectory');
    const directory = lease.openDirectory('');
    try {
      const listing = directory.list({ maxScanned: maxEntries + 2 });
      const sentinelName = lease.snapshot().sentinelName;
      if (!Number.isSafeInteger(listing.scanned) || !Array.isArray(listing.omittedNames)) {
        throw new CliError('WINDOWS_NATIVE_UNAVAILABLE', 'Private state requires complete Windows directory enumeration.');
      }
      const owned = name => typeof sentinelName === 'string' && listing.ownedSentinelSeen === true && name === sentinelName;
      const entries = listing.entries.filter(entry => !owned(entry.name));
      if (listing.truncated || entries.length > maxEntries || listing.omittedNames.some(name => !owned(name)) ||
          listing.scanned !== listing.entries.length + listing.omittedNames.length) throw forbidden(target);
      return entries.map(entry => entry.name);
    } finally { directory.close(); }
  });
}

function withPrivateFile(file, fn) {
  return withDirectory(path.dirname(file), parent => {
    requireMethod(parent, 'openFile');
    const handle = parent.openFile(path.basename(file));
    try {
      requireMethod(handle, 'security');
      const snapshot = handle.snapshot();
      if (snapshot.nlink !== '1' || handle.security().private !== true) throw forbidden(file);
      const result = fn(handle, snapshot);
      handle.assertUnchanged();
      if (handle.security().private !== true) throw forbidden(file);
      return result;
    } finally { handle.close(); }
  });
}

export function readWindowsPrivateFile(file, { maxBytes = 65536, missing = false } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 10 * 1024 * 1024) {
    throw new CliError('BAD_ARGS', 'Private file size limit is invalid');
  }
  try {
    return withPrivateFile(file, (handle, snapshot) => {
      if (!/^(0|[1-9][0-9]*)$/.test(snapshot.size) || BigInt(snapshot.size) > BigInt(maxBytes)) throw forbidden(file);
      return handle.read(maxBytes);
    });
  } catch (error) {
    if (missing && error?.code === 'PROJECT_FILE_NOT_FOUND') return null;
    throw error;
  }
}

export function publishWindowsPrivateManifest(file, contents, expected = null) {
  return withMutableDirectory(path.dirname(file), parent => {
    requireMethod(parent, 'publish');
    requireMethod(parent, 'flush');
    let expectedIdentity, expectedBytes;
    if (expected !== null) {
      expectedIdentity = withPrivateFile(file, (handle, snapshot) => {
        if (BigInt(snapshot.size) > 16384n) throw forbidden(file);
        let actual;
        try { expectedBytes = handle.read(16384); actual = JSON.parse(expectedBytes.toString('utf8')); }
        catch { throw forbidden(file); }
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw forbidden(file);
        return snapshot.identity;
      });
    }
    const result = parent.publish(path.basename(file), Buffer.from(`${JSON.stringify(contents)}\n`), {
      operation: expected === null ? 'create' : 'replace', private: true,
      ...(expectedIdentity ? { expectedIdentity, expectedBytes } : {})
    });
    try { parent.flush(); }
    catch (error) {
      throw new CliError('WINDOWS_STATE_PUBLICATION_UNCONFIRMED',
        'Windows private state was published, but its directory flush could not be confirmed.', { reason: error.code });
    }
    return result;
  });
}

export function flushWindowsPrivateDirectory(target) {
  return withMutableDirectory(target, directory => { requireMethod(directory, 'flush'); return directory.flush(); });
}

// SQLite writes through its own handle. This separate metadata handle permits
// those writes while refusing path replacement until the connection closes.
export function captureWindowsPrivateDatabase(file, { create = false } = {}) {
  const root = captureCheckedDirectory(path.dirname(file));
  let parent;
  try { parent = root.openDirectory(''); }
  finally { root.close(); }
  let handle;
  try {
    requireMethod(parent, 'openMutableFile');
    try { handle = parent.openMutableFile(path.basename(file)); }
    catch (error) {
      if (!create || error?.code !== 'PROJECT_FILE_NOT_FOUND') throw error;
      requireMethod(parent, 'publish'); requireMethod(parent, 'flush');
      try { parent.publish(path.basename(file), Buffer.alloc(0), { operation: 'create', private: true }); }
      catch (creationError) { if (creationError?.code !== 'PROJECT_FILE_EXISTS') throw creationError; }
      parent.flush();
      handle = parent.openMutableFile(path.basename(file));
    }
    let closed = false;
    const hold = {
      assertUnchanged() {
        if (closed) throw forbidden(file);
        parent.assertUnchanged(); handle.assertUnchanged();
        if (parent.security().private !== true || handle.security().private !== true || handle.snapshot().nlink !== '1') {
          throw forbidden(file);
        }
      },
      inspectSidecars() {
        hold.assertUnchanged();
        for (const suffix of ['-wal', '-shm', '-journal']) {
          let sidecar;
          try {
            sidecar = parent.openMutableFile(path.basename(file) + suffix);
            sidecar.assertUnchanged();
            if (sidecar.security().private !== true || sidecar.snapshot().nlink !== '1') throw forbidden(file + suffix);
          } catch (error) { if (error?.code !== 'PROJECT_FILE_NOT_FOUND') throw error; }
          finally { sidecar?.close(); }
        }
        hold.assertUnchanged();
      },
      close() {
        if (closed) return;
        closed = true;
        try { handle.close(); } finally { parent.close(); }
      }
    };
    hold.assertUnchanged(); hold.inspectSidecars();
    return hold;
  } catch (error) {
    try { handle?.close(); } finally { parent.close(); }
    throw error;
  }
}

export function openWindowsPrivateAppendResource(file) {
  const root = captureCheckedDirectory(path.dirname(file));
  let parent;
  try { parent = root.openDirectory(''); }
  finally { root.close(); }
  let append;
  try {
    requireMethod(parent, 'openAppendFile');
    append = parent.openAppendFile(path.basename(file), { private: true });
    let closed = false;
    const assertUnchanged = () => {
      if (closed) throw forbidden(file);
      parent.assertUnchanged(); append.assertUnchanged();
      if (parent.security().private !== true || append.security().private !== true || append.snapshot().nlink !== '1') {
        throw forbidden(file);
      }
    };
    assertUnchanged();
    return Object.freeze({
      native: append,
      assertUnchanged,
      write(data) {
        if (typeof data !== 'string' && !Buffer.isBuffer(data)) throw new CliError('BAD_ARGS', 'Private log writes require text or a Buffer');
        const bytes = typeof data === 'string' ? Buffer.from(data) : data;
        if (bytes.length > 10 * 1024 * 1024) throw new CliError('BAD_ARGS', 'Private log writes are limited to 10 MiB');
        assertUnchanged();
        const result = append.write(bytes);
        assertUnchanged();
        return result;
      },
      snapshot() { assertUnchanged(); return append.snapshot(); },
      security() { assertUnchanged(); return append.security(); },
      close() {
        if (closed) return;
        closed = true;
        try { append.close(); } finally { parent.close(); }
      }
    });
  } catch (error) {
    try { append?.close(); } finally { parent.close(); }
    throw error;
  }
}

export function removeWindowsPrivateDirectory(target, expectedIdentity) {
  if (!isWindowsFileIdentity(expectedIdentity)) throw forbidden(target);
  // The transition owns these temporary inspection pins. Other processes'
  // leases and SQLite holds remain active and cause native DELETE admission to
  // fail. The parent stays pinned across native reacquisition of this identity.
  for (const pin of [false, true]) {
    const key = `${pin}\0${target}`;
    const lease = activeScope?.get(key);
    if (lease) { activeScope.delete(key); lease.close(); }
  }
  return withMutableDirectory(path.dirname(target), parent => {
    const native = loadWindowsNative(); requireMethod(native, 'removePrivateDirectory');
    return native.removePrivateDirectory(parent, path.basename(target), expectedIdentity);
  });
}

export function rotateWindowsPrivateAppendResource(file, resource, maxBytes = 5 * 1024 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !resource || typeof resource.snapshot !== 'function') {
    throw new CliError('BAD_ARGS', 'Private log rotation requires an owned append resource and a byte limit');
  }
  resource.assertUnchanged(); const snapshot = resource.snapshot();
  if (BigInt(snapshot.size) <= BigInt(maxBytes)) return resource;
  resource.close();
  let reopened, rotated = false;
  try { return withMutableDirectory(path.dirname(file), parent => {
    requireMethod(parent, 'renameFile'); requireMethod(parent, 'removeFile');
    const name = path.basename(file), previous = `${name}.1`; let current, backup;
    try {
      // A retained append owner has write access, which this ordinary read
      // cannot share. Reject it before removing an existing backup.
      current = parent.openFile(name);
      if (!sameWindowsFileIdentity(current.snapshot().identity, snapshot.identity) || current.security().private !== true) throw forbidden(file);
    } finally { current?.close(); }
    let backupSnapshot;
    try {
      backup = parent.openFile(previous); backupSnapshot = backup.snapshot();
      if (backup.security().private !== true || backupSnapshot.nlink !== '1') throw forbidden(`${file}.1`);
    } catch (error) { if (error?.code !== 'PROJECT_FILE_NOT_FOUND') throw error; }
    finally { backup?.close(); }
    if (backupSnapshot) parent.removeFile(previous, { expectedIdentity: backupSnapshot.identity });
    parent.renameFile(name, previous, { expectedIdentity: snapshot.identity });
    rotated = true; reopened = openWindowsPrivateAppendResource(file); return reopened;
  }); } catch (error) {
    reopened?.close();
    if (rotated) throw new CliError('WINDOWS_LOG_ROTATION_UNCONFIRMED', 'The previous log was archived but reopening the active log could not be confirmed', { cause: error?.code });
    throw error;
  }
}

export function unsupportedWindowsPrivateOperation(operation) {
  throw new CliError('WINDOWS_NATIVE_UNAVAILABLE', `The Windows private-state component does not provide ${operation}.`);
}
