import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  DB_SCHEMA_VERSION,
  initSchema,
  readSchemaVersion
} from './schema.mjs';
import { withFileLock } from '../shared/file-lock.mjs';
import { CliError } from '../shared/errors.mjs';
import { captureDirectory } from '../platform/windows-filesystem.mjs';
import { inspectWindowsHomeAncestry, sameWindowsFileIdentity,
  withWindowsPrivateScope } from '../platform/windows-private-state.mjs';

const MAX_BACKUP_COMPONENT_BYTES = 240;
// v1-02: keep at most this many migration backups per database basename.
const MAX_BACKUPS_PER_DB = 5;

function quoteSqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function defaultTimestamp() {
  return new Date().toISOString().replace(/[-:.]/g, '');
}

function defaultSuffix() {
  return randomBytes(4).toString('hex');
}

function backupFilename(dbBasename, fromVersion, toVersion, timestamp, suffix) {
  return `${dbBasename}.pre-v${fromVersion}-to-v${toVersion}.${timestamp}.${suffix}.bak`;
}

function boundedDbBasename(dbPath, fromVersion, toVersion, timestamp) {
  const dbBasename = path.basename(dbPath);
  const finalName = backupFilename(dbBasename, fromVersion, toVersion, timestamp, 'ffffffff');
  const stagingName = `.${dbBasename}.migration-backup-XXXXXX`;
  if (Buffer.byteLength(finalName) <= MAX_BACKUP_COMPONENT_BYTES &&
      Buffer.byteLength(stagingName) <= MAX_BACKUP_COMPONENT_BYTES) {
    return dbBasename;
  }
  const hash = createHash('sha256').update(dbBasename).digest('hex').slice(0, 16);
  return `db-${hash}`;
}

function syncPath(target) {
  const fd = fs.openSync(target, 'r');
  let syncError = null;
  try {
    fs.fsyncSync(fd);
  } catch (err) {
    syncError = err;
  }
  try {
    fs.closeSync(fd);
  } catch (closeError) {
    if (syncError) {
      throw new AggregateError([syncError, closeError], `Failed to sync and close ${target}`);
    }
    throw closeError;
  }
  if (syncError) throw syncError;
}

function removeStagingDirectory(tempDirectory) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Failed to remove migration backup staging directory: ${tempDirectory}`, {
    cause: lastError
  });
}

function verifyBackup(backupPath) {
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const rows = backup.prepare('PRAGMA quick_check').all();
    if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') {
      throw new Error(`Migration backup failed SQLite quick_check: ${backupPath}`);
    }
  } finally {
    backup.close();
  }
}

export function initSchemaWithBackup(db, dbPath, {
  beforePostMigrationIndexes = null,
  ensureBackup = ensureMigrationBackup,
  withLock = withFileLock
} = {}) {
  const initialize = (lockedDbPath = dbPath) => initSchema(db, {
    beforeMigration: ({ fromVersion, toVersion }) =>
      ensureBackup(db, lockedDbPath, fromVersion, toVersion),
    beforePostMigrationIndexes
  });
  if (readSchemaVersion(db) >= DB_SCHEMA_VERSION) return initialize();
  return withLock(dbPath, (lockedDbPath) => initialize(lockedDbPath));
}

export function ensureMigrationBackup(db, dbPath, fromVersion, toVersion, {
  timestamp = defaultTimestamp,
  suffix = defaultSuffix,
  verifySnapshot = verifyBackup
} = {}) {
  if (!Number.isInteger(fromVersion) || fromVersion < 0 ||
      !Number.isInteger(toVersion) || toVersion <= fromVersion) {
    throw new TypeError(`Invalid migration version range: ${fromVersion} to ${toVersion}`);
  }
  // v1-03: under a racing migration, this connection may already observe the
  // migrated version (another process migrated between our stale version read
  // and this call). Backing it up would mislabel an already-migrated DB as
  // pre-v<from>-to-v<to>; skip the backup entirely in that case.
  try {
    const pragma = db.prepare('PRAGMA user_version').get();
    const actualVersion = Number(pragma?.user_version || 0);
    if (Number.isInteger(actualVersion) && actualVersion >= toVersion) return null;
  } catch {
    // Cannot read the version — proceed conservatively with the backup.
  }
  const timestampValue = timestamp();
  if (!/^\d{8}T\d{9}Z$/.test(timestampValue)) {
    throw new TypeError(`Invalid migration backup timestamp: ${timestampValue}`);
  }

  const directory = path.dirname(path.resolve(dbPath));
  const dbBasename = boundedDbBasename(dbPath, fromVersion, toVersion, timestampValue);
  if (process.platform === 'win32') return ensureWindowsMigrationBackup(db, directory, dbBasename,
    fromVersion, toVersion, timestampValue, suffix, verifySnapshot);
  let tempDirectory;
  let backupPath;
  let operationError = null;
  try {
    tempDirectory = fs.mkdtempSync(path.join(directory, `.${dbBasename}.migration-backup-`));
    fs.chmodSync(tempDirectory, 0o700);
    const tempPath = path.join(tempDirectory, 'snapshot.db');
    db.exec(`VACUUM INTO ${quoteSqlString(tempPath)};`);
    fs.chmodSync(tempPath, 0o600);
    syncPath(tempPath);
    verifySnapshot(tempPath);

    for (let attempt = 0; attempt < 128; attempt += 1) {
      const suffixValue = suffix();
      if (!/^[a-f0-9]{8}$/.test(suffixValue)) {
        throw new TypeError(`Invalid migration backup suffix: ${suffixValue}`);
      }
      const candidate = path.join(
        directory,
        backupFilename(dbBasename, fromVersion, toVersion, timestampValue, suffixValue)
      );
      try {
        // Linking publishes the already-verified inode exclusively. EEXIST is
        // safe for regular files and symlinks: neither is followed or replaced.
        fs.linkSync(tempPath, candidate);
        backupPath = candidate;
        break;
      } catch (err) {
        if (err?.code === 'EEXIST') continue;
        throw err;
      }
    }
    if (!backupPath) throw new Error('Unable to allocate a unique migration backup path');
  } catch (err) {
    operationError = err;
  }

  let cleanupError = null;
  if (tempDirectory) {
    try {
      removeStagingDirectory(tempDirectory);
    } catch (err) {
      cleanupError = err;
    }
  }
  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      'Migration backup failed and staging cleanup also failed'
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;

  syncPath(directory);
  rotateBackups(directory, dbBasename, backupPath);
  return backupPath;
}

function ensureWindowsMigrationBackup(db, directory, dbBasename, fromVersion, toVersion,
  timestamp, suffix, verifySnapshot) {
  return withWindowsPrivateScope(() => {
    // Check ancestry before creating a pin, then keep it pinned across every
    // SQLite pathname operation. The staging file receives a private DACL even
    // when an explicitly selected database has a readable, trusted parent.
    inspectWindowsHomeAncestry(directory);
    const lease = captureDirectory(directory, { pin: true });
    let parent;
    try { parent = lease.openDirectory(''); } finally { lease.close(); }
    let staging, stagingIdentity, handle, immutable, backupPath, error, cleanupError;
    try {
      const stageBase = Buffer.byteLength(`.${dbBasename}.migration-backup-${'0'.repeat(32)}.tmp`) <= MAX_BACKUP_COMPONENT_BYTES
        ? dbBasename : `db-${createHash('sha256').update(dbBasename).digest('hex').slice(0, 16)}`;
      for (let attempt = 0; attempt < 128; attempt++) {
        const candidate = `.${stageBase}.migration-backup-${randomBytes(16).toString('hex')}.tmp`;
        try {
          const receipt = parent.publish(candidate, Buffer.alloc(0), { operation: 'create', private: true });
          staging = candidate; stagingIdentity = receipt.identity; break;
        } catch (creationError) { if (creationError.code !== 'PROJECT_FILE_EXISTS') throw creationError; }
      }
      if (!staging) throw new Error('Unable to allocate a unique migration staging file');
      handle = parent.openMutableFile(staging);
      if (!sameWindowsFileIdentity(handle.snapshot().identity, stagingIdentity) || handle.security().private !== true) {
        throw new CliError('PROJECT_FILE_CHANGED', 'Migration staging file changed after creation');
      }
      const stagingPath = path.join(directory, staging);
      // VACUUM INTO accepts an existing empty file. Its retained native handle
      // allows SQLite writes while preventing replacement or parent rebinding.
      db.exec(`VACUUM INTO ${quoteSqlString(stagingPath)};`);
      handle.assertUnchanged();
      // Windows FlushFileBuffers requires write access. The retained native
      // file and ancestry make this r+ open select the same staging object.
      const fd = fs.openSync(stagingPath, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      handle.assertUnchanged();
      immutable = parent.openPublishSource(staging);
      if (!sameWindowsFileIdentity(immutable.snapshot().identity, stagingIdentity) || immutable.security().private !== true) {
        throw new Error('Migration staging file changed before verification');
      }
      // Keep the no-DELETE binding alongside the no-WRITE reader while SQLite
      // verifies the pathname. Release only the former for final publication.
      verifySnapshot(stagingPath);
      handle.assertUnchanged(); immutable.assertUnchanged();
      handle.close(); handle = immutable; immutable = null;
      // This reader permits DELETE sharing for rename, but excludes writes.
      // Keep verified bytes immutable until the expected-identity rename ends.
      for (let attempt = 0; attempt < 128; attempt++) {
        const suffixValue = suffix();
        if (!/^[a-f0-9]{8}$/.test(suffixValue)) throw new TypeError(`Invalid migration backup suffix: ${suffixValue}`);
        const name = backupFilename(dbBasename, fromVersion, toVersion, timestamp, suffixValue);
        if (handle.security().private !== true) throw new CliError('PROJECT_PATH_FORBIDDEN', 'Migration snapshot permissions changed before publication');
        try {
          // This publishes the verified object without reading it into a
          // bounded project-file Buffer, so large databases remain supported.
          parent.renameFile(staging, name, { expectedIdentity: stagingIdentity });
          staging = null; backupPath = path.join(directory, name);
          let receipt;
          try {
            receipt = parent.openFile(name);
            if (!sameWindowsFileIdentity(receipt.snapshot().identity, stagingIdentity) || receipt.security().private !== true) {
              throw new Error('Published backup identity or permissions changed');
            }
            receipt.assertUnchanged();
          } catch (failure) {
            throw new CliError('PROJECT_FILE_WRITE_UNCONFIRMED', 'Migration backup publication could not be confirmed', { reason: failure.code });
          } finally { receipt?.close(); }
          handle.close(); handle = null; break;
        } catch (publicationError) { if (publicationError.code !== 'PROJECT_FILE_EXISTS') throw publicationError; }
      }
      if (!backupPath) throw new Error('Unable to allocate a unique migration backup path');
      // Native rename also flushes this directory. Require a confirmed parent
      // flush before returning the backup and allowing schema changes.
      parent.flush();
      rotateWindowsBackups(parent, dbBasename, path.basename(backupPath));
    } catch (failure) { error = failure; }
    finally {
      handle?.close(); immutable?.close();
      if (staging && stagingIdentity) {
        try { parent.removeFile(staging, { expectedIdentity: stagingIdentity }); }
        catch (failure) { if (failure.code !== 'PROJECT_FILE_NOT_FOUND') cleanupError = failure; }
      }
      parent.close();
    }
    if (error && cleanupError) throw new AggregateError([error, cleanupError], 'Migration backup and staging cleanup failed');
    if (error) throw error;
    if (cleanupError) throw cleanupError;
    return backupPath;
  });
}

function rotateWindowsBackups(parent, dbBasename, publishedName) {
  const escaped = dbBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\.pre-v(\\d+)-to-v(\\d+)\\.(\\d{8}T\\d{9}Z)\\.([a-f0-9]{8})\\.bak$`);
  let listing;
  try { listing = parent.list({ maxScanned: 5000 }); } catch { return; }
  if (listing.truncated) return;
  const backups = listing.entries.flatMap(entry => {
    const match = entry.type === 'file' && pattern.exec(entry.name);
    return match ? [{ name: entry.name, timestamp: match[3] }] : [];
  }).sort((a, b) => a.name === publishedName ? -1 : b.name === publishedName ? 1 :
    b.timestamp.localeCompare(a.timestamp) || b.name.localeCompare(a.name));
  for (const old of backups.slice(MAX_BACKUPS_PER_DB)) {
    let file;
    try {
      file = parent.openFile(old.name);
      if (file.security().private !== true) continue;
      const expectedIdentity = file.snapshot().identity;
      file.assertUnchanged(); file.close(); file = null;
      parent.removeFile(old.name, { expectedIdentity });
    } catch {} finally { file?.close(); }
  }
}

// v1-02: prune old migration backups for this database, keeping the most
// recent MAX_BACKUPS_PER_DB. Backups are full DB copies; without rotation a
// long-lived project accumulates them on every failed/racing migration attempt.
function rotateBackups(directory, dbBasename, publishedPath) {
  const escapedBasename = dbBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const backupPattern = new RegExp(
    `^${escapedBasename}\\.pre-v(\\d+)-to-v(\\d+)\\.(\\d{8}T\\d{9}Z)\\.([a-f0-9]{8})\\.bak$`
  );
  const publishedName = path.basename(publishedPath);
  let entries = [];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return;
  }
  const backups = entries
    .map((name) => {
      const match = name.match(backupPattern);
      if (!match) return null;
      try {
        if (!fs.lstatSync(path.join(directory, name)).isFile()) return null;
        return { name, timestamp: match[3] };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.name === publishedName) return b.name === publishedName ? 0 : -1;
      if (b.name === publishedName) return 1;
      return b.timestamp.localeCompare(a.timestamp) || b.name.localeCompare(a.name);
    });
  for (const old of backups.slice(MAX_BACKUPS_PER_DB)) {
    try { fs.rmSync(path.join(directory, old.name), { force: true }); } catch {}
  }
}
