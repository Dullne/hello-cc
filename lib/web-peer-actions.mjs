import path from 'node:path';
import process from 'node:process';
import { intOpt, required } from './cli-args.mjs';
import { CliError } from './errors.mjs';
import {
  lockLabel,
  lockScope,
  locksConflict,
  scopedLockResource
} from './locks.mjs';
import { normalizeStateResources } from './state-render.mjs';

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
  const claimNextTasksForPeer = requireFn(deps.claimNextTasksForPeer, 'claimNextTasksForPeer');
  const connect = requireFn(deps.connect, 'connect');
  const defaultLockTtl = Number(deps.defaultLockTtl ?? DEFAULT_LOCK_TTL);
  const detectBranch = requireFn(deps.detectBranch, 'detectBranch');
  const now = typeof deps.now === 'function' ? deps.now : defaultNow;
  const positiveIntOpt = requireFn(deps.positiveIntOpt, 'positiveIntOpt');
  const queryInbox = requireFn(deps.queryInbox, 'queryInbox');
  const statusSnapshot = requireFn(deps.statusSnapshot, 'statusSnapshot');
  const statusSummary = requireFn(deps.statusSummary, 'statusSummary');
  const takeOverTaskForPeer = requireFn(deps.takeOverTaskForPeer, 'takeOverTaskForPeer');
  const touchPeer = requireFn(deps.touchPeer, 'touchPeer');
  const tx = requireFn(deps.tx, 'tx');
  const upsertPeer = requireFn(deps.upsertPeer, 'upsertPeer');

  function webPeerRegister(projectCtx, peer, input = {}) {
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
      addEvent(db, 'peer.registered', peer, null, { ...row, source: 'web' });
    } finally {
      db.close();
    }
    return { peer: row, summary: `registered ${row.id} (${row.kind}${row.role ? `, ${row.role}` : ''})` };
  }

  function webPeerHeartbeat(projectCtx, peer, input = {}) {
    const ttl = intOpt(input, 'ttl', defaultLockTtl);
    const status = input.status || null;
    const renewLocks = input['renew-locks'] !== false && input.renew_locks !== false;
    const db = connect(projectCtx);
    const t = now();
    let renewed = 0;
    try {
      touchPeer(db, peer, status);
      if (renewLocks) {
        renewed = db.prepare(`
          UPDATE locks SET expires_at = ?
          WHERE owner = ? AND expires_at > ?
        `).run(t + ttl, peer, t).changes;
      }
      addEvent(db, 'peer.heartbeat', peer, null, { status, renewed, source: 'web' });
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
    const id = intOpt(input, 'id', intOpt({ id: input.task }, 'id'));
    if (!id) throw new CliError('BAD_REQUEST', 'task id required');
    const reason = required(input, 'reason');
    const policy = input.policy || 'any';
    const staleAfter = positiveIntOpt(input, 'stale-after', intOpt(input, 'stale_after', activePeerTtl), { max: 86400 * 30 });
    const db = connect(projectCtx);
    try {
      touchPeer(db, peer, 'working');
      const task = takeOverTaskForPeer(db, peer, id, { reason, policy, staleAfter, source: 'web' });
      return { peer, task, summary: `took over task #${task.id}: ${task.title}` };
    } finally {
      db.close();
    }
  }

  function webPeerLockAcquire(projectCtx, peer, input = {}) {
    const requested = scopedLockResource(required(input, 'resource'), input.scope);
    const ttl = intOpt(input, 'ttl', defaultLockTtl);
    const taskId = intOpt(input, 'task', intOpt(input, 'task_id', null));
    const reason = input.reason || '';
    const db = connect(projectCtx);
    try {
      touchPeer(db, peer, 'working');
      const lock = tx(db, () => {
        const t = now();
        const activeLocks = db.prepare('SELECT * FROM locks WHERE expires_at > ?').all(t);
        const conflict = activeLocks.find((row) => locksConflict(row, requested) && row.owner !== peer);
        if (conflict) {
          throw new CliError('LOCK_HELD', `Resource ${lockLabel(requested)} conflicts with lock ${lockLabel(conflict)} held by ${conflict.owner}`, {
            resource: requested.base_resource,
            scope: requested.scope,
            lock_resource: conflict.resource,
            lock_scope: lockScope(conflict),
            owner: conflict.owner,
            expires_at: iso(conflict.expires_at)
          });
        }
        const existing = db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
        db.prepare(`
          INSERT INTO locks(resource, base_resource, scope, owner, task_id, reason, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(resource) DO UPDATE SET
            base_resource = excluded.base_resource,
            scope = excluded.scope,
            owner = excluded.owner,
            task_id = excluded.task_id,
            reason = excluded.reason,
            expires_at = excluded.expires_at
        `).run(requested.resource, requested.base_resource, requested.scope, peer, taskId, reason, t + ttl, existing ? existing.created_at : t);
        addEvent(db, 'lock.acquired', peer, taskId, { resource: requested.base_resource, lock_resource: requested.resource, scope: requested.scope, ttl, previous_owner: existing ? existing.owner : null, source: 'web' });
        return db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
      });
      return { peer, lock, summary: `locked ${lockLabel(lock)} by ${lock.owner} until ${iso(lock.expires_at)}` };
    } finally {
      db.close();
    }
  }

  function webPeerLockRelease(projectCtx, peer, input = {}) {
    const requested = scopedLockResource(required(input, 'resource'), input.scope);
    const force = Boolean(input.force);
    const db = connect(projectCtx);
    try {
      touchPeer(db, peer, null);
      const result = tx(db, () => {
        const existing = db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
        if (!existing) return { released: false, ...requested };
        if (existing.owner !== peer && !force) {
          throw new CliError('LOCK_OWNED', `Lock is owned by ${existing.owner}`, { owner: existing.owner });
        }
        db.prepare('DELETE FROM locks WHERE resource = ?').run(requested.resource);
        addEvent(db, 'lock.released', peer, existing.task_id || null, { resource: requested.base_resource, lock_resource: requested.resource, scope: requested.scope, force, source: 'web' });
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
