function requireObservedAt(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('observedAt must be a non-negative safe integer');
  }
  return value;
}

export function refreshHookOwnerIdentity(db, {
  peerId,
  status = null,
  observedAt,
  processIdentity = null
} = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required');
  if (typeof peerId !== 'string' || !peerId) throw new TypeError('peerId is required');
  const timestamp = requireObservedAt(observedAt);
  if (!processIdentity) {
    return db.prepare(`
      UPDATE peers
      SET last_seen_at = ?, status = COALESCE(?, status), pid = NULL,
          pid_start_token = NULL, pid_command_hash = NULL
      WHERE id = ?
    `).run(timestamp, status, peerId).changes;
  }
  return db.prepare(`
    UPDATE peers
    SET last_seen_at = ?, status = COALESCE(?, status), pid = ?,
        pid_start_token = ?, pid_command_hash = ?
    WHERE id = ?
  `).run(timestamp, status, processIdentity.pid, processIdentity.startToken,
    processIdentity.commandHash, peerId).changes;
}
