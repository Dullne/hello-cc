import path from 'node:path';
import process from 'node:process';
import { intOpt, required } from '../cli-args.mjs';
import { CliError } from '../shared/errors.mjs';
import {
  lockLabel,
  lockScope,
  locksConflict,
  scopedLockResource
} from '../core/coordination/locks.mjs';
import { normalizeStateResources } from '../ui/state-render.mjs';
import {
  clockGraceSuppressed
} from '../shared/clock-grace.mjs';
import {
  captureLockAcquireSubject,
  captureLockRenewalSubject,
  clockCandidatesFromLocks,
  observeLockOwnerEvidence,
  sameLockAcquireSubject
} from '../core/coordination/lock-evidence.mjs';
import { runOptimisticEvidenceMutation } from '../core/coordination/optimistic-evidence.mjs';
import { clockSafetyUnavailable } from '../core/coordination/clock-safety.mjs';

const DEFAULT_ACTIVE_PEER_TTL = 600;
const DEFAULT_LOCK_TTL = 900;

function defaultNow() {
  return Math.floor(Date.now() / 1000);
}

function iso(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toISOString();
}

function requireFn(value, name) {
  if (typeof value !== 'function') throw new TypeError(`createWebPeerActions requires deps.${name}`);
  return value;
}

export function createWebPeerActions(deps = {}) {
  const activePeerTtl = Number(deps.activePeerTtl ?? DEFAULT_ACTIVE_PEER_TTL);
  const addEvent = requireFn(deps.addEvent, 'addEvent');
  const assertTaskOwnerForMutation = requireFn(deps.assertTaskOwnerForMutation, 'assertTaskOwnerForMutation');
  const claimNextTasksForPeer = requireFn(deps.claimNextTasksForPeer, 'claimNextTasksForPeer');
  const connect = requireFn(deps.connect, 'connect');
  const defaultLockTtl = Number(deps.defaultLockTtl ?? DEFAULT_LOCK_TTL);
  const detectBranch = requireFn(deps.detectBranch, 'detectBranch');
  const now = typeof deps.now === 'function' ? deps.now : defaultNow;
  const observeClockSafetyInTransaction = requireFn(
    deps.observeClockSafetyInTransaction,
    'observeClockSafetyInTransaction'
  );
  const observePeerEvidence = typeof deps.observePeerEvidence === 'function' ? deps.observePeerEvidence : null;
  const peerEvidenceFromDb = requireFn(deps.peerEvidenceFromDb, 'peerEvidenceFromDb');
  const positiveIntOpt = requireFn(deps.positiveIntOpt, 'positiveIntOpt');
  const queryInbox = requireFn(deps.queryInbox, 'queryInbox');
  const statusSnapshot = requireFn(deps.statusSnapshot, 'statusSnapshot');
  const statusSummary = requireFn(deps.statusSummary, 'statusSummary');
  const takeOverTaskForPeer = requireFn(deps.takeOverTaskForPeer, 'takeOverTaskForPeer');
  const touchPeer = requireFn(deps.touchPeer, 'touchPeer');
  const tx = requireFn(deps.tx, 'tx');
  const upsertPeer = requireFn(deps.upsertPeer, 'upsertPeer');

  function prepareClockObservation(db, subject, evidenceByOwner) {
    try {
      return observeClockSafetyInTransaction(db, {
        operation: 'ownership',
        candidates: clockCandidatesFromLocks(subject, evidenceByOwner),
        nowSec: subject.observedAt
      });
    } catch (error) {
      throw clockSafetyUnavailable(error);
    }
  }

  function webMutationPeer(peer, input = {}) {
    const actorPeer = String(input.actorPeer || input.actor_peer || '').trim();
    if (!actorPeer) {
      throw new CliError('PEER_IDENTITY_REQUIRED', 'Web peer mutations require a managed session identity');
    }
    if (actorPeer !== peer) {
      throw new CliError('PEER_IDENTITY_MISMATCH', `Web peer action for ${peer} cannot run as ${actorPeer}`, {
        peer,
        actor_peer: actorPeer
      });
    }
    return actorPeer;
  }

  function webAuditPayload(peer, input = {}, extra = {}) {
    const actorPeer = String(input.actorPeer || input.actor_peer || peer).trim() || peer;
    return {
      ...extra,
      source: 'web',
      actor_peer: actorPeer,
      target_peer: peer
    };
  }

  function webPeerRegister(projectCtx, peer, input = {}) {
    webMutationPeer(peer, input);
    const db = connect(projectCtx);
    const row = {
      id: peer,
      kind: input.kind || 'other',
      role: input.role || 'peer',
      worktree: path.resolve(input.worktree || projectCtx.cwd),
      branch: input.branch || detectBranch(projectCtx.cwd),
      pid: intOpt(input, 'pid', process.ppid),
      status: input.status || 'idle',
      capabilities: Array.isArray(input.cap) ? input.cap.join(',') : (input.cap || input.capabilities || 'web')
    };
    try {
      upsertPeer(db, row);
      addEvent(db, 'peer.registered', peer, null, webAuditPayload(peer, input, row));
    } finally {
      db.close();
    }
    return { peer: row, summary: `registered ${row.id} (${row.kind}${row.role ? `, ${row.role}` : ''})` };
  }

  function webPeerHeartbeat(projectCtx, peer, input = {}) {
    webMutationPeer(peer, input);
    const ttlOverride = input.ttl === undefined ? null : intOpt(input, 'ttl', defaultLockTtl);
    const status = input.status || null;
    const renewLocks = input['renew-locks'] !== false && input.renew_locks !== false;
    const db = connect(projectCtx);
    const t = now();
    let renewed = 0;
    try {
      touchPeer(db, peer, status);
      if (renewLocks) {
        try {
          renewed = runOptimisticEvidenceMutation(db, {
            capture: (subjectDb) => {
              try {
                return captureLockRenewalSubject(subjectDb, { owner: peer, now: t });
              } catch (error) {
                throw clockSafetyUnavailable(error);
              }
            },
            observe: (subject) => new Map([[
              peer,
              subject.peer
                ? (observePeerEvidence
                    ? observePeerEvidence(projectCtx, subject.peer, subject.binding)
                    : peerEvidenceFromDb(db, projectCtx, peer))
                : { state: 'unknown', reason: 'peer_missing' }
            ]]),
            same: (left, right) => JSON.stringify(left) === JSON.stringify(right),
            beforeMutate: (subject, evidenceByOwner) =>
              prepareClockObservation(db, subject, evidenceByOwner),
            changedMessage: `Lock subjects changed while renewing locks for ${peer}; retry`,
            mutate: (subject, evidenceByOwner) => {
              const evidenceLive = evidenceByOwner.get(peer)?.state === 'live';
              if (ttlOverride !== null) {
                return evidenceLive
                  ? db.prepare('UPDATE locks SET expires_at = ? + ?, ttl_sec = ? WHERE owner = ?').run(t, ttlOverride, ttlOverride, peer).changes
                  : db.prepare('UPDATE locks SET expires_at = ? + ?, ttl_sec = ? WHERE owner = ? AND expires_at > ?').run(t, ttlOverride, ttlOverride, peer, t).changes;
              }
              return evidenceLive
                ? db.prepare('UPDATE locks SET expires_at = ? + ttl_sec WHERE owner = ?').run(t, peer).changes
                : db.prepare('UPDATE locks SET expires_at = ? + ttl_sec WHERE owner = ? AND expires_at > ?').run(t, peer, t).changes;
            }
          });
        } catch (error) {
          if (error instanceof CliError) throw error;
          throw clockSafetyUnavailable(error);
        }
      }
      addEvent(db, 'peer.heartbeat', peer, null, webAuditPayload(peer, input, { status, renewed }));
    } finally {
      db.close();
    }
    return {
      peer,
      status,
      renewed,
      summary: `heartbeat ${peer}${renewed ? `, renewed locks: ${renewed}` : ''}`
    };
  }

  function webPeerTaskNext(projectCtx, peer, input = {}) {
    webMutationPeer(peer, input);
    const db = connect(projectCtx);
    try {
      touchPeer(db, peer, 'working');
      const count = positiveIntOpt(input, 'count', 1, { max: 50 });
      const result = claimNextTasksForPeer(db, peer, { force: Boolean(input.force), count });
      const task = result.current || result.tasks[0] || null;
      if (!task) return { peer, task: null, tasks: [], summary: 'no pending task' };
      return {
        peer,
        task,
        tasks: result.tasks,
        current: Boolean(result.current),
        summary: result.current
          ? `current task #${task.id}: ${task.title} (${task.status})`
          : result.tasks.length === 1
            ? `claimed task #${task.id}: ${task.title}`
            : `claimed ${result.tasks.length} tasks`
      };
    } finally {
      db.close();
    }
  }

  function webPeerTaskTakeover(projectCtx, peer, input = {}) {
    webMutationPeer(peer, input);
    const id = intOpt(input, 'id', intOpt({ id: input.task }, 'id'));
    if (!id) throw new CliError('BAD_REQUEST', 'task id required');
    const reason = required(input, 'reason');
    const policy = input.force ? 'any' : (input.policy || 'blocked-or-stale');
    const staleAfter = positiveIntOpt(input, 'stale-after', intOpt(input, 'stale_after', activePeerTtl), { max: 86400 * 30 });
    const db = connect(projectCtx);
    try {
      touchPeer(db, peer, 'working');
      const task = takeOverTaskForPeer(db, peer, id, {
        reason,
        policy,
        staleAfter,
        source: 'web',
        ownerEvidenceFor: (owner, _row, ownerRow, binding) => observePeerEvidence
          ? observePeerEvidence(projectCtx, ownerRow, binding)
          : peerEvidenceFromDb(db, projectCtx, owner)
      });
      return { peer, task, summary: `took over task #${task.id}: ${task.title}` };
    } finally {
      db.close();
    }
  }

  function webPeerLockAcquire(projectCtx, peer, input = {}) {
    webMutationPeer(peer, input);
    const requested = scopedLockResource(required(input, 'resource'), input.scope);
    const ttl = intOpt(input, 'ttl', defaultLockTtl);
    const taskId = intOpt(input, 'task', intOpt(input, 'task_id', null));
    const reason = input.reason || '';
    const db = connect(projectCtx);
    try {
      touchPeer(db, peer, 'working');
      const acquisitionNow = now();
      const outcome = runOptimisticEvidenceMutation(db, {
        capture: (subjectDb) => {
          try {
            return captureLockAcquireSubject(subjectDb, {
              taskId,
              requested,
              now: acquisitionNow
            });
          } catch (error) {
            throw clockSafetyUnavailable(error);
          }
        },
        observe: (subject) => observeLockOwnerEvidence(subject, (row, binding) => observePeerEvidence
          ? observePeerEvidence(projectCtx, row, binding)
          : peerEvidenceFromDb(db, projectCtx, row.id)),
        same: sameLockAcquireSubject,
        beforeMutate: (subject, evidenceByOwner) =>
          prepareClockObservation(db, subject, evidenceByOwner),
        changedMessage: `Lock subjects changed while acquiring ${lockLabel(requested)}; retry`,
        mutate: (subject, evidenceByOwner, clockObservation) => {
        const t = subject.observedAt;
        if (taskId) {
          const task = subject.task;
          if (!task) throw new CliError('NOT_FOUND', `Task #${taskId} does not exist`);
          assertTaskOwnerForMutation(db, peer, task, 'lock-acquire');
        }
        // During clock grace, every retained lock row still conflicts. A fixed
        // look-back cannot protect locks across an arbitrarily long sleep.
        const graceActive = clockGraceSuppressed(t, clockObservation.graceUntil);
        const conflict = subject.locks.find((row) =>
          row.owner !== peer && locksConflict(row, requested) && (
            graceActive || Number(row.expires_at) > t ||
            evidenceByOwner.get(row.owner)?.state === 'live'
          )
        );
        if (conflict) {
          return { error: new CliError('LOCK_HELD', `Resource ${lockLabel(requested)} conflicts with lock ${lockLabel(conflict)} held by ${conflict.owner}`, {
            resource: requested.base_resource,
            scope: requested.scope,
            lock_resource: conflict.resource,
            lock_scope: lockScope(conflict),
            owner: conflict.owner,
            expires_at: iso(conflict.expires_at)
          }) };
        }
        const existing = subject.locks.find((row) => row.resource === requested.resource) || null;
        db.prepare(`
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
        `).run(requested.resource, requested.base_resource, requested.scope, peer, taskId, reason, t + ttl, t, ttl);
        addEvent(db, 'lock.acquired', peer, taskId, webAuditPayload(peer, input, { resource: requested.base_resource, lock_resource: requested.resource, scope: requested.scope, ttl, previous_owner: existing ? existing.owner : null }));
        return { lock: db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource) };
        }
      });
      if (outcome.error) throw outcome.error;
      const lock = outcome.lock;
      return { peer, lock, summary: `locked ${lockLabel(lock)} by ${lock.owner} until ${iso(lock.expires_at)}` };
    } finally {
      db.close();
    }
  }

  function webPeerLockRelease(projectCtx, peer, input = {}) {
    webMutationPeer(peer, input);
    const requested = scopedLockResource(required(input, 'resource'), input.scope);
    const force = false;
    const db = connect(projectCtx);
    try {
      touchPeer(db, peer, null);
      const result = tx(db, () => {
        const existing = db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
        if (!existing) return { released: false, ...requested };
        if (existing.owner !== peer) {
          throw new CliError('LOCK_OWNED', `Lock is owned by ${existing.owner}`, { owner: existing.owner });
        }
        db.prepare('DELETE FROM locks WHERE resource = ?').run(requested.resource);
        addEvent(db, 'lock.released', peer, existing.task_id || null, webAuditPayload(peer, input, { resource: requested.base_resource, lock_resource: requested.resource, scope: requested.scope, force }));
        return { released: true, ...requested };
      });
      return { peer, result, summary: result.released ? `released ${lockLabel(result)}` : `no lock for ${lockLabel(result)}` };
    } finally {
      db.close();
    }
  }

  function webPeerInbox(projectCtx, peer, input = {}) {
    const db = connect(projectCtx);
    try {
      const messages = queryInbox(db, peer, Boolean(input.all), intOpt(input, 'limit', 20));
      return {
        peer,
        messages,
        summary: messages.length ? `${messages.length} message${messages.length === 1 ? '' : 's'}` : 'no messages'
      };
    } finally {
      db.close();
    }
  }

  function webPeerAction(projectCtx, peer, action, input = {}) {
    const normalized = String(action || '').replace(/_/g, '-');
    if (!peer) throw new CliError('BAD_REQUEST', 'peer required');
    if (normalized === 'status') {
      const status = statusSummary(projectCtx, peer);
      return { ok: true, action: normalized, peer, summary: `active=${status.active_peers}, stale=${status.stale_peers}, locks=${status.active_locks}, unread=${status.unread ?? 0}`, data: status };
    }
    if (normalized === 'state') {
      const data = statusSnapshot(projectCtx, peer, {
        resources: normalizeStateResources(input.resource || input.resources || []),
        intent: input.intent || null,
        scope: input.scope || null
      });
      return { ok: true, action: normalized, peer, summary: data.automation?.next_action?.reason || 'state loaded', data };
    }
    if (normalized === 'inbox') {
      const data = webPeerInbox(projectCtx, peer, input);
      return { ok: true, action: normalized, peer, summary: data.summary, data };
    }
    if (normalized === 'task-next') {
      const data = webPeerTaskNext(projectCtx, peer, input);
      return { ok: true, action: normalized, peer, summary: data.summary, data };
    }
    if (normalized === 'task-takeover') {
      const data = webPeerTaskTakeover(projectCtx, peer, input);
      return { ok: true, action: normalized, peer, summary: data.summary, data };
    }
    if (normalized === 'lock-acquire') {
      const data = webPeerLockAcquire(projectCtx, peer, input);
      return { ok: true, action: normalized, peer, summary: data.summary, data };
    }
    if (normalized === 'lock-release') {
      const data = webPeerLockRelease(projectCtx, peer, input);
      return { ok: true, action: normalized, peer, summary: data.summary, data };
    }
    if (normalized === 'heartbeat') {
      const data = webPeerHeartbeat(projectCtx, peer, input);
      return { ok: true, action: normalized, peer, summary: data.summary, data };
    }
    if (normalized === 'register') {
      const data = webPeerRegister(projectCtx, peer, input);
      return { ok: true, action: normalized, peer, summary: data.summary, data };
    }
    throw new CliError('BAD_REQUEST', `Unknown peer action: ${action}`);
  }

  return {
    webPeerAction,
    webPeerHeartbeat,
    webPeerInbox,
    webPeerLockAcquire,
    webPeerLockRelease,
    webPeerRegister,
    webPeerTaskNext,
    webPeerTaskTakeover
  };
}
