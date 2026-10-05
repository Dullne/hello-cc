import { DatabaseSync } from 'node:sqlite';

// Acceptance observers race the real runtime's short-lived SQLite connections.
// Match its bounded busy timeout without retrying tasks or hiding query errors.
export function readAcceptanceRows(database, sql, ...values) {
  const db = new DatabaseSync(database, { readOnly: true, timeout: 5000 });
  try { return db.prepare(sql).all(...values); }
  finally { db.close(); }
}
