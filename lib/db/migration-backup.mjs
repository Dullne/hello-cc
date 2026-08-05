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
