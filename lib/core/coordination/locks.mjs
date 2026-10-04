import { CliError } from '../../shared/errors.mjs';
import { isPeerEvidenceCompatibilityProtected } from '../peers/evidence.mjs';

export const WHOLE_LOCK_SCOPE = '*';

export function normalizeLockScope(scope) {
  const text = String(scope || '').trim();
  return text || WHOLE_LOCK_SCOPE;
}

export function scopedLockResource(resource, scope = WHOLE_LOCK_SCOPE) {
  const baseResource = String(resource || '').trim();
  const normalizedScope = normalizeLockScope(scope);
  if (!baseResource) throw new CliError('BAD_ARGS', 'Missing --resource');
  return {
    resource: normalizedScope === WHOLE_LOCK_SCOPE
      ? baseResource
      : `scoped:${Buffer.from(JSON.stringify([baseResource, normalizedScope]), 'utf8').toString('base64url')}`,
    base_resource: baseResource,
    scope: normalizedScope
  };
}

export function lockBaseResource(lock) {
  return lock?.base_resource || lock?.resource || '';
}

export function lockScope(lock) {
  return normalizeLockScope(lock?.scope);
}

export function lockLabel(lock) {
  const base = lockBaseResource(lock);
  const scope = lockScope(lock);
  return scope === WHOLE_LOCK_SCOPE ? base : `${base} [${scope}]`;
}

export function lockArgv(resource, scope) {
  const argv = ['--resource', resource];
  if (normalizeLockScope(scope) !== WHOLE_LOCK_SCOPE) argv.push('--scope', normalizeLockScope(scope));
  return argv;
}

export function locksConflict(a, b) {
  return lockBaseResource(a) === lockBaseResource(b) &&
    (lockScope(a) === WHOLE_LOCK_SCOPE || lockScope(b) === WHOLE_LOCK_SCOPE || lockScope(a) === lockScope(b));
}

export function findRequestedLock(db, requested) {
  const row = db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource) || null;
  return row && lockBaseResource(row) === requested.base_resource && lockScope(row) === requested.scope
    ? row
    : null;
}

// Keep the persisted key format compatible with existing locks. A whole-resource
// name can equal a scoped key, but that physical collision is never authority to
// update or remove the other logical resource.
export function upsertRequestedLock(db, requested, lease) {
  const result = db.prepare(`
    INSERT INTO locks(resource, base_resource, scope, owner, task_id, reason, expires_at, created_at, ttl_sec)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource) DO UPDATE SET
      base_resource = excluded.base_resource,
      scope = excluded.scope,
      owner = excluded.owner,
      task_id = excluded.task_id,
      reason = excluded.reason,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at,
      ttl_sec = excluded.ttl_sec
    WHERE COALESCE(NULLIF(locks.base_resource, ''), locks.resource) = excluded.base_resource
      AND COALESCE(NULLIF(locks.scope, ''), '*') = excluded.scope
  `).run(requested.resource, requested.base_resource, requested.scope, lease.owner,
    lease.task_id ?? null, lease.reason || '', lease.expires_at, lease.created_at, lease.ttl_sec);
  if (Number(result.changes) !== 1) {
    throw new CliError('LOCK_RESOURCE_COLLISION', `Resource ${lockLabel(requested)} collides with an existing lock key`, {
      resource: requested.base_resource,
      scope: requested.scope,
      lock_resource: requested.resource
    });
  }
  return findRequestedLock(db, requested);
}

export function visibleLocksWithEvidence(locks, nowSec, {
  graceActive = false,
  evidenceByOwner = new Map()
} = {}) {
  return (locks || []).filter((lock) => graceActive || Number(lock.expires_at) > nowSec ||
    evidenceByOwner.get(lock.owner)?.state === 'live' ||
    isPeerEvidenceCompatibilityProtected(evidenceByOwner.get(lock.owner)));
}
