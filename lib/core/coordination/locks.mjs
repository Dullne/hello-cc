import { CliError } from '../../shared/errors.mjs';

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
