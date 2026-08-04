import { CliError } from '../../shared/errors.mjs';

function requireSafeTimestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

export function leaseDeadline(nowSec, ttl, { option = '--ttl' } = {}) {
  const observedAt = requireSafeTimestamp(nowSec, 'nowSec');
  const duration = requirePositiveSafeInteger(ttl, 'ttl');
  const deadline = observedAt + duration;
  if (!Number.isSafeInteger(deadline)) {
    throw new CliError('BAD_ARGS', `${option} produces an unsafe lease deadline`);
  }
  return deadline;
}

function requirePositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function persistedLockTtls(db, owner, observedAt, includeExpired) {
  const expiryPredicate = includeExpired ? '' : ' AND expires_at > ?';
  const args = includeExpired ? [owner] : [owner, observedAt];
  return db.prepare(`
    SELECT resource, ttl_sec
    FROM locks
    WHERE owner = ?${expiryPredicate}
  `).all(...args);
}

function requireRenewablePersistedTtls(db, owner, observedAt, includeExpired, { cap = null } = {}) {
  for (const row of persistedLockTtls(db, owner, observedAt, includeExpired)) {
    const ttl = Number(row.ttl_sec);
    try {
      requirePositiveSafeInteger(ttl, 'persisted lock TTL');
      leaseDeadline(observedAt, cap === null ? ttl : Math.min(ttl, cap), {
        option: 'persisted lock TTL'
      });
    } catch {
      throw new CliError('BAD_STATE', `Lock ${row.resource} has an unsafe persisted TTL`);
    }
  }
}

export function renewOwnedLocks(db, {
  owner,
  nowSec,
  ttlOverride = null,
  ttlCap = null,
  includeExpired = false
} = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required');
  if (typeof owner !== 'string' || !owner) throw new TypeError('owner is required');
  const observedAt = requireSafeTimestamp(nowSec, 'nowSec');
  const expiryPredicate = includeExpired ? '' : ' AND expires_at > ?';

  if (ttlOverride !== null) {
    const ttl = requirePositiveSafeInteger(ttlOverride, 'ttlOverride');
    const target = leaseDeadline(observedAt, ttl);
    const args = includeExpired
      ? [target, ttl, owner]
      : [target, ttl, owner, observedAt];
    return db.prepare(`
      UPDATE locks
      SET expires_at = MAX(expires_at, ?), ttl_sec = ?
      WHERE owner = ?${expiryPredicate}
    `).run(...args).changes;
  }

  if (ttlCap !== null) {
    const cap = requirePositiveSafeInteger(ttlCap, 'ttlCap');
    leaseDeadline(observedAt, cap, { option: 'hook TTL cap' });
    requireRenewablePersistedTtls(db, owner, observedAt, includeExpired, { cap });
    const args = includeExpired
      ? [observedAt, cap, owner]
      : [observedAt, cap, owner, observedAt];
    return db.prepare(`
      UPDATE locks
      SET expires_at = MAX(expires_at, ? + MIN(ttl_sec, ?))
      WHERE owner = ?${expiryPredicate}
    `).run(...args).changes;
  }

  requireRenewablePersistedTtls(db, owner, observedAt, includeExpired);
  const maxTtl = Number.MAX_SAFE_INTEGER - observedAt;
  const args = includeExpired
    ? [observedAt, owner, maxTtl]
    : [observedAt, owner, observedAt, maxTtl];
  return db.prepare(`
    UPDATE locks
    SET expires_at = MAX(expires_at, ? + ttl_sec)
    WHERE owner = ?${expiryPredicate}
      AND typeof(ttl_sec) = 'integer'
      AND ttl_sec BETWEEN 1 AND ?
  `).run(...args).changes;
}
