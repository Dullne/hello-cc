import { readClockGraceUntil } from '../../shared/clock-grace.mjs';
import { locksConflict } from './locks.mjs';

export function captureLockAcquireSubject(db, options = {}) {
  const taskId = options.taskId || null;
  const requested = options.requested || null;
  const observedAt = Number(options.now);
  const task = taskId ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) || null : null;
  const lockRows = requested
    ? db.prepare(`
        SELECT * FROM locks
        WHERE base_resource = ?
           OR (base_resource IS NULL AND resource = ?)
        ORDER BY resource ASC
      `).all(requested.base_resource, requested.base_resource)
    : db.prepare('SELECT * FROM locks ORDER BY resource ASC').all();
  const locks = lockRows
    .filter((lock) => !requested || locksConflict(lock, requested));
  const expiredLocks = locks.filter((lock) => Number(lock.expires_at) <= observedAt);
  const owners = [];
  for (const owner of [...new Set(expiredLocks.map((lock) => lock.owner).filter(Boolean))].sort()) {
    const peer = db.prepare(`
      SELECT id, status, pid, pid_start_token, pid_command_hash, last_seen_at
      FROM peers WHERE id = ?
    `).get(owner) || null;
    const binding = db.prepare(`
      SELECT peer, transport, runtime_target, updated_at
      FROM peer_bindings WHERE peer = ?
    `).get(owner) || null;
    owners.push({ owner, peer, binding });
  }
  return { task, locks, owners, graceUntil: readClockGraceUntil(db), observedAt };
}

export function sameLockAcquireSubject(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function observeLockOwnerEvidence(subject, observePeer) {
  return new Map((subject.owners || []).map(({ owner, peer, binding }) => [
    owner,
    peer ? observePeer(peer, binding) : { state: 'unknown', reason: 'peer_missing' }
  ]));
}
