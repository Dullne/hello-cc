import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { observeClockSafetyInTransaction } from '../core/coordination/clock-safety.mjs';
import { tx } from '../db/schema.mjs';
import { clockGraceSuppressed } from '../shared/clock-grace.mjs';
import { CliError } from '../shared/errors.mjs';
import { withBufferDirectoryLeases } from './buffer-directory-lease.mjs';
import {
  applyBufferPlan,
  bufferPlanGcCutoffs,
  refreshBufferPlanEvidence
} from './buffer-gc.mjs';

export const BUFFER_GC_APPLY_BATCH_SIZE = 64;
export const BUFFER_GC_PLAN_TTL_MS = 15_000;

function boundPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty path`);
  }
  return path.resolve(value);
}

export function createBufferGcPlanStore(options = {}) {
  const nowMs = options.nowMs || Date.now;
  const ttlMs = options.ttlMs ?? BUFFER_GC_PLAN_TTL_MS;
  const makeToken = options.makeToken || (() => randomBytes(32).toString('base64url'));
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError('buffer GC token TTL must be a positive safe integer');
  }
  const plans = new Map();

  const deletePlan = (token) => {
    const record = plans.get(token);
    plans.delete(token);
    if (record?.expiryTimer) clearTimeout(record.expiryTimer);
    return record;
  };

  const cleanupExpired = () => {
    const current = nowMs();
    for (const [token, record] of plans) {
      if (record.expiresAt <= current) deletePlan(token);
    }
  };

  return {
    prepare(record) {
      cleanupExpired();
      const root = boundPath(record?.root, 'root');
      const dbPath = boundPath(record?.dbPath, 'dbPath');
      if (!record?.plan || !Array.isArray(record.plan.deleteEntries)) {
        throw new TypeError('valid buffer GC plan required');
      }
      let token;
      do { token = makeToken(); } while (typeof token === 'string' && plans.has(token));
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,}$/.test(token)) {
        throw new TypeError('buffer GC token source returned an invalid token');
      }
      const stored = {
        ...record,
        root,
        dbPath,
        expiresAt: nowMs() + ttlMs
      };
      stored.expiryTimer = setTimeout(() => deletePlan(token), ttlMs);
      stored.expiryTimer.unref?.();
      plans.set(token, stored);
      return token;
    },

    take({ token, root, dbPath } = {}) {
      if (typeof token !== 'string' || token.length === 0) {
        throw new CliError('RUNTIME_GC_TOKEN_INVALID', 'Runtime buffer GC token is invalid');
      }
      const record = plans.get(token);
      if (!record) {
        cleanupExpired();
        throw new CliError('RUNTIME_GC_TOKEN_INVALID', 'Runtime buffer GC token is invalid or already used');
      }
      deletePlan(token);
      if (record.expiresAt <= nowMs()) {
        throw new CliError('RUNTIME_GC_TOKEN_EXPIRED', 'Runtime buffer GC token expired');
      }
      if (record.root !== boundPath(root, 'root') || record.dbPath !== boundPath(dbPath, 'dbPath')) {
        throw new CliError('RUNTIME_GC_TOKEN_BINDING', 'Runtime buffer GC token binding does not match the request');
      }
      cleanupExpired();
      return record;
    },

    cleanupExpired,
    pendingCount() {
      cleanupExpired();
      return plans.size;
    }
  };
}

export function applyClockSafeBufferPlan({
  db,
  plan,
  retentionSec,
  nowSec = () => Math.floor(Date.now() / 1000),
  batchSize = BUFFER_GC_APPLY_BATCH_SIZE,
  afterBatch = null,
  collectEvidence = null
} = {}) {
  if (!db || !plan || !Array.isArray(plan.deleteEntries)) {
    throw new TypeError('database and valid buffer GC plan required');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > BUFFER_GC_APPLY_BATCH_SIZE) {
    throw new TypeError(`buffer GC batch size must be between 1 and ${BUFFER_GC_APPLY_BATCH_SIZE}`);
  }
  const result = {
    deleted: 0,
    protected: plan.protectedEntries?.length || 0,
    deferred: plan.unknownEntries?.length || 0,
    complete: true,
    graceActive: false
  };

  for (let offset = 0; offset < plan.deleteEntries.length; offset += batchSize) {
    const entries = plan.deleteEntries.slice(offset, offset + batchSize);
    const batch = withBufferDirectoryLeases(
      entries.map((entry) => entry.directory.path),
      () => {
        const evidence = collectEvidence
          ? collectEvidence({ offset, entries: [...entries], plan })
          : null;
        const refreshed = evidence
          ? refreshBufferPlanEvidence({ ...plan, deleteEntries: entries }, evidence)
          : { ...plan, protectedEntries: [], unknownEntries: [], deleteEntries: entries };
        const applied = tx(db, () => {
          const observedAt = nowSec();
          if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
            throw new TypeError('nowSec must return a non-negative safe integer');
          }
          const observation = observeClockSafetyInTransaction(db, {
            operation: 'gc',
            gcCutoffs: bufferPlanGcCutoffs(refreshed, retentionSec),
            nowSec: observedAt
          });
          if (clockGraceSuppressed(observedAt, observation.graceUntil)) return null;
          return applyBufferPlan(refreshed);
        });
        return { applied, refreshed };
      }
    );
    if (!batch.applied) {
      result.protected += batch.refreshed.protectedEntries.length;
      result.deferred += batch.refreshed.unknownEntries.length +
        batch.refreshed.deleteEntries.length +
        Math.max(0, plan.deleteEntries.length - offset - entries.length);
      result.complete = false;
      result.graceActive = true;
      break;
    }
    result.deleted += batch.applied.deleted;
    result.protected += batch.refreshed.protectedEntries.length;
    result.deferred += batch.applied.deferred;
    if (batch.applied.deferred > 0) result.complete = false;
    if (afterBatch) afterBatch({ offset, size: entries.length, result: { ...result } });
  }
  return result;
}
