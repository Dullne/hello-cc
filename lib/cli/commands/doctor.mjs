// Database health check command extracted from bin/hcc.mjs.

import fs from 'node:fs';
import { printResult } from '../../format.mjs';

export function createDoctorCommand({ connectReadOnly, readSchemaVersion, DB_SCHEMA_VERSION, CLI_NAME }) {
  async function cmdDoctor(ctx, args) {
    if (args[0] === '--help' || args[0] === '-h') {
      console.log(`${CLI_NAME} doctor [--json]

Runs a read-only health check on the project database: PRAGMA integrity_check,
schema compatibility, persistent journal mode, DB and WAL file sizes, and
per-table row counts. Exits non-zero for corruption or an unsupported schema.
`);
      return;
    }
    const db = connectReadOnly(ctx);
    let report;
    try {
      const integrity = db.prepare('PRAGMA integrity_check').get();
      const quick = db.prepare('PRAGMA quick_check').get();
      const schemaVersion = readSchemaVersion(db);
      const journalMode = db.prepare('PRAGMA journal_mode').get();
      const synchronous = db.prepare('PRAGMA synchronous').get();
      const walAutocheckpoint = db.prepare('PRAGMA wal_autocheckpoint').get();
      const userVersion = db.prepare('PRAGMA user_version').get();
      const fk = db.prepare('PRAGMA foreign_keys').get();
      const counts = {};
      for (const table of ['peers', 'peer_bindings', 'tasks', 'messages', 'message_reads', 'locks', 'handoffs', 'events']) {
        try { counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } catch { counts[table] = null; }
      }
      report = {
        root: ctx.root,
        db: ctx.dbPath,
        integrity_check: integrity ? Object.values(integrity)[0] : null,
        quick_check: quick ? Object.values(quick)[0] : null,
        schema_version: schemaVersion,
        supported_schema_version: DB_SCHEMA_VERSION,
        schema_compatible: schemaVersion > 0 && schemaVersion <= DB_SCHEMA_VERSION,
        migration_required: schemaVersion > 0 && schemaVersion < DB_SCHEMA_VERSION,
        user_version: userVersion ? Object.values(userVersion)[0] : 0,
        journal_mode: journalMode ? Object.values(journalMode)[0] : null,
        diagnostic_connection: {
          synchronous: synchronous ? Object.values(synchronous)[0] : null,
          wal_autocheckpoint: walAutocheckpoint ? Object.values(walAutocheckpoint)[0] : null,
          foreign_keys: fk ? Object.values(fk)[0] : null
        },
        runtime_connection_defaults: {
          synchronous: 'NORMAL',
          wal_autocheckpoint: 1000,
          foreign_keys: true
        },
        row_counts: counts
      };
    } finally {
      db.close();
    }
    try {
      report.db_size_bytes = fs.statSync(ctx.dbPath).size;
      const walPath = `${ctx.dbPath}-wal`;
      report.wal_size_bytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    } catch {}

    const healthy = report.integrity_check === 'ok' && report.schema_compatible;
    printResult(ctx, report, (r) => {
      const lines = [
        `doctor (${r.root}):`,
        `  integrity_check: ${r.integrity_check}`,
        `  quick_check:     ${r.quick_check}`,
        `  schema:          ${r.schema_version} (supported ${r.supported_schema_version})`,
        `  journal_mode:    ${r.journal_mode}  synchronous: ${r.diagnostic_connection.synchronous}  wal_autocheckpoint: ${r.diagnostic_connection.wal_autocheckpoint}  foreign_keys: ${r.diagnostic_connection.foreign_keys}`,
        `  db size:         ${r.db_size_bytes ?? '?'} bytes${r.wal_size_bytes ? `  (wal ${r.wal_size_bytes})` : ''}`,
        `  rows:            ` + Object.entries(r.row_counts).map(([k, v]) => `${k}=${v}`).join('  ')
      ];
      return lines.join('\n');
    });
    if (!healthy) process.exitCode = 1;
  }

  return { cmdDoctor };
}
