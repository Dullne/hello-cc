import { CliError } from '../errors.mjs';

export const DB_SCHEMA_VERSION = 5;

const sleepBuffer = new SharedArrayBuffer(4);
const sleepView = new Int32Array(sleepBuffer);

function now() {
  return Math.floor(Date.now() / 1000);
}

function sleepSync(ms) {
  Atomics.wait(sleepView, 0, 0, ms);
}

function isSqliteBusy(err) {
  const text = `${err?.code || ''} ${err?.message || ''} ${err?.errstr || ''}`;
  return err?.errcode === 5 ||
    err?.errcode === 6 ||
    err?.errcode === 261 ||
    /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(text);
}

export function execWithBusyRetry(db, sql, { attempts = 30, delayMs = 100, ignoreBusy = false } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      db.exec(sql);
      return true;
    } catch (err) {
      if (!isSqliteBusy(err)) throw err;
      if (attempt === attempts - 1) {
        if (ignoreBusy) return false;
        throw err;
      }
      sleepSync(delayMs);
    }
  }
  return false;
}

export function tx(db, fn) {
  execWithBusyRetry(db, 'BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Ignore rollback failures; the original error is more useful.
    }
    throw err;
  }
}

export function initSchema(db, { beforePostMigrationIndexes = null } = {}) {
  const existingVersion = readSchemaVersion(db);
  if (existingVersion > DB_SCHEMA_VERSION) {
    throw new CliError('DB_SCHEMA_TOO_NEW', `Database schema version ${existingVersion} is newer than this hcc (${DB_SCHEMA_VERSION})`, {
      db_schema_version: existingVersion,
      supported_schema_version: DB_SCHEMA_VERSION
    });
  }
  createBaseSchema(db);
  runSchemaMigrations(db);
  if (typeof beforePostMigrationIndexes === 'function') beforePostMigrationIndexes(db);
  createPostMigrationIndexes(db);
}

function createBaseSchema(db) {
  execWithBusyRetry(db, `
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      role TEXT,
      worktree TEXT,
      branch TEXT,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'idle',
      capabilities TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS peer_bindings (
      peer TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_session_id TEXT,
      provider_session_name TEXT,
      resume_mode TEXT NOT NULL DEFAULT 'new',
      resume_arg TEXT,
      command TEXT,
      transport TEXT NOT NULL,
      runtime_session_id TEXT,
      runtime_target TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (peer) REFERENCES peers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      assignee TEXT,
      owner TEXT,
      parent_id INTEGER,
      team_role TEXT,
      priority INTEGER NOT NULL DEFAULT 100,
      created_by TEXT,
      claimed_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      recipient TEXT,
      task_id INTEGER,
      kind TEXT NOT NULL DEFAULT 'note',
      body TEXT NOT NULL,
      reply_to INTEGER,
      thread_id INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_reads (
      message_id INTEGER NOT NULL,
      peer TEXT NOT NULL,
      read_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, peer),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS locks (
      resource TEXT PRIMARY KEY,
      base_resource TEXT,
      scope TEXT NOT NULL DEFAULT '*',
      owner TEXT NOT NULL,
      task_id INTEGER,
      reason TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      from_peer TEXT NOT NULL,
      to_peer TEXT,
      summary TEXT NOT NULL,
      changed_files TEXT,
      tests TEXT,
      risks TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      actor TEXT,
      task_id INTEGER,
      payload TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority, id);
    CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient_id ON messages(recipient, id);
    CREATE INDEX IF NOT EXISTS idx_events_id ON events(id);
    CREATE INDEX IF NOT EXISTS idx_locks_expires ON locks(expires_at);
  `);
}

function createPostMigrationIndexes(db) {
  execWithBusyRetry(db, `
    CREATE INDEX IF NOT EXISTS idx_peer_bindings_provider_session ON peer_bindings(provider, provider_session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_bindings_provider_session_id_unique
      ON peer_bindings(provider, provider_session_id)
      WHERE provider_session_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_bindings_provider_session_name_unique
      ON peer_bindings(provider, provider_session_name)
      WHERE provider_session_name IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_bindings_runtime_target_unique
      ON peer_bindings(runtime_target)
      WHERE runtime_target IS NOT NULL;
  `);
}

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((col) => col.name));
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(tableName));
}

export function readSchemaVersion(db) {
  const metaExists = tableExists(db, 'meta');
  const metaVersion = metaExists ? Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0) : 0;
  const pragmaVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  const migrationVersion = tableExists(db, 'schema_migrations')
    ? Number(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version || 0)
    : 0;
  return Math.max(metaVersion, pragmaVersion, migrationVersion);
}

function writeSchemaVersion(db, version) {
  db.prepare(`
    INSERT INTO meta(key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(version));
  db.exec(`PRAGMA user_version = ${Number(version)}`);
}

function recordSchemaMigration(db, version, name) {
  db.prepare(`
    INSERT INTO schema_migrations(version, name, applied_at)
    VALUES (?, ?, ?)
    ON CONFLICT(version) DO NOTHING
  `).run(version, name, now());
}

function addColumnIfMissing(db, tableName, columnName, ddl) {
  const columns = tableColumns(db, tableName);
  if (!columns.has(columnName)) db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
}

function runSchemaMigrations(db) {
  const migrations = [
    {
      version: 1,
      name: 'baseline',
      up() {
        // createBaseSchema already created the baseline tables.
      }
    },
    {
      version: 2,
      name: 'peer binding runtime targets',
      up(database) {
        addColumnIfMissing(database, 'peer_bindings', 'runtime_target', 'runtime_target TEXT');
      }
    },
    {
      version: 3,
      name: 'threaded messages',
      up(database) {
        addColumnIfMissing(database, 'messages', 'reply_to', 'reply_to INTEGER');
        addColumnIfMissing(database, 'messages', 'thread_id', 'thread_id INTEGER');
        database.exec(`
          UPDATE messages SET thread_id = id WHERE thread_id IS NULL;
          CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id, id);
        `);
      }
    },
    {
      version: 4,
      name: 'team task hierarchy',
      up(database) {
        addColumnIfMissing(database, 'tasks', 'parent_id', 'parent_id INTEGER');
        addColumnIfMissing(database, 'tasks', 'team_role', 'team_role TEXT');
        database.exec('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id, priority, id);');
      }
    },
    {
      version: 5,
      name: 'scoped advisory locks',
      up(database) {
        addColumnIfMissing(database, 'locks', 'base_resource', 'base_resource TEXT');
        addColumnIfMissing(database, 'locks', 'scope', "scope TEXT NOT NULL DEFAULT '*'");
        database.exec(`
          UPDATE locks
          SET base_resource = resource
          WHERE base_resource IS NULL OR base_resource = '';
          UPDATE locks
          SET scope = '*'
          WHERE scope IS NULL OR scope = '';
          CREATE INDEX IF NOT EXISTS idx_locks_base_scope ON locks(base_resource, scope);
        `);
      }
    }
  ];
  let version = readSchemaVersion(db);
  if (version > DB_SCHEMA_VERSION) {
    throw new CliError('DB_SCHEMA_TOO_NEW', `Database schema version ${version} is newer than this hcc (${DB_SCHEMA_VERSION})`, {
      db_schema_version: version,
      supported_schema_version: DB_SCHEMA_VERSION
    });
  }
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)));
  tx(db, () => {
    for (const migration of migrations) {
      if (version >= migration.version && applied.has(migration.version)) continue;
      migration.up(db);
      recordSchemaMigration(db, migration.version, migration.name);
      applied.add(migration.version);
      version = migration.version;
      writeSchemaVersion(db, version);
    }
    if (version === 0) {
      version = DB_SCHEMA_VERSION;
    }
    for (const migration of migrations) {
      if (migration.version <= version) recordSchemaMigration(db, migration.version, migration.name);
    }
    writeSchemaVersion(db, version);
  });
}
