import { tx } from '../../db/schema.mjs';
import { CliError } from '../../shared/errors.mjs';
import { clockGraceSuppressed, readClockGraceUntil } from '../../shared/clock-grace.mjs';
import { inspectProcessIdentity } from '../../process/identity.mjs';
import { peerEvidenceAllowsReap, resolvePeerEvidence } from '../peers/evidence.mjs';

const DEFAULT_ACTIVE_PEER_TTL = 600;
const UNKNOWN_EVIDENCE_GRACE_SEC = 120;

function defaultNow() {
  return Math.floor(Date.now() / 1000);
}

function noopEvent() {}

function noopMessage() {
  return null;
}

function processEvidenceForPeer(row) {
  return resolvePeerEvidence({
    peer: row,
    processes: row?.pid ? [{
      name: 'peer',
      storedIdentity: {
        pid: Number(row.pid),
        startToken: row.pid_start_token,
        commandHash: row.pid_command_hash
      },
      current: inspectProcessIdentity(row.pid)
    }] : []
  });
}

export function createTaskStore(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : defaultNow;
  const addEvent = typeof deps.addEvent === 'function' ? deps.addEvent : noopEvent;
  const sendMessage = typeof deps.sendMessage === 'function' ? deps.sendMessage : noopMessage;
  const observeClockSafety = typeof deps.observeClockSafety === 'function'
    ? deps.observeClockSafety
    : null;
  const activePeerTtl = Number(deps.activePeerTtl || DEFAULT_ACTIVE_PEER_TTL);

  function taskOwnedError(peer, row, action) {
    return new CliError('TASK_OWNED', `Task #${row.id} is owned by ${row.owner}`, {
      owner: row.owner,
      task_id: row.id,
      attempted_by: peer,
      action,
      notify_owner: true
    });
  }

  function takeoverSubject(db, id) {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) || null;
    const ownerRow = row?.owner ? db.prepare(`
      SELECT id, status, pid, pid_start_token, pid_command_hash, last_seen_at
      FROM peers WHERE id = ?
    `).get(row.owner) || null : null;
    const binding = row?.owner ? db.prepare(`
      SELECT peer, transport, runtime_target, updated_at
      FROM peer_bindings WHERE peer = ?
    `).get(row.owner) || null : null;
    return { row, ownerRow, binding, graceUntil: readClockGraceUntil(db) };
  }

  function sameTakeoverSubject(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function claimTaskRowsForPeer(db, peer, ids, { force = false, source = null } = {}) {
    return tx(db, () => {
      const tasks = [];
      for (const id of ids) {
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        if (!row) throw new CliError('NOT_FOUND', `Task #${id} does not exist`);
        if (row.owner && row.owner !== peer && !force) {
          throw taskOwnedError(peer, row, 'claim');
        }
        if (row.assignee && row.assignee !== peer && !force) {
          throw new CliError('TASK_ASSIGNED', `Task #${id} is assigned to ${row.assignee}`, { assignee: row.assignee });
        }
        if (!['pending', 'blocked', 'claimed', 'running'].includes(row.status) && !force) {
          throw new CliError('BAD_STATE', `Task #${id} is ${row.status}`);
        }
        const t = now();
        db.prepare(`
          UPDATE tasks
          SET owner = ?, status = 'claimed', claimed_at = COALESCE(claimed_at, ?), updated_at = ?
          WHERE id = ?
        `).run(peer, t, t, id);
        addEvent(db, 'task.claimed', peer, id, {
          previous_owner: row.owner,
          force,
          ...(source ? { source } : {})
        });
        tasks.push(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
      }
      return tasks;
    });
  }

  function takeoverPolicyDetails(db, row, peer, {
    policy = 'blocked-or-stale',
    staleAfter = activePeerTtl,
    ownerEvidence = null,
    ownerRow: suppliedOwnerRow = undefined,
    graceUntil: suppliedGraceUntil = undefined
  } = {}) {
    const normalized = String(policy || 'any').toLowerCase();
    const allowed = new Set(['any', 'blocked', 'stale', 'blocked-or-stale']);
    if (!allowed.has(normalized)) {
      throw new CliError('BAD_ARGS', `Unsupported takeover policy: ${policy}`);
    }
    const previousOwner = row.owner || null;
    const blocked = row.status === 'blocked';
    const ownerRow = suppliedOwnerRow === undefined && previousOwner ? db.prepare(`
      SELECT id, status, pid, pid_start_token, pid_command_hash, last_seen_at
      FROM peers WHERE id = ?
    `).get(previousOwner) : (suppliedOwnerRow || null);
    const ownerAge = ownerRow ? now() - Number(ownerRow.last_seen_at || 0) : null;
    const evidence = ownerEvidence || { state: 'unknown', reason: ownerRow ? 'evidence_not_observed' : 'peer_missing' };
    const ownerDead = evidence.state === 'dead';
    const ownerLive = evidence.state === 'live';
    // hb-05: during a wall-clock grace window (sleep/NTP jump) age is
    // untrustworthy; never treat the owner as stale so a live owner's task is
    // not taken over right after the machine wakes.
    const graceUntil = suppliedGraceUntil === undefined ? readClockGraceUntil(db) : suppliedGraceUntil;
    const graceActive = clockGraceSuppressed(now(), graceUntil);
    const unknownExpired = ownerRow && peerEvidenceAllowsReap(evidence, {
      nowSec: now(),
      lastSeenAt: Number(ownerRow.last_seen_at || 0),
      staleAfterSec: Math.max(staleAfter, UNKNOWN_EVIDENCE_GRACE_SEC),
      graceUntil
    });
    const ownerStale = Boolean(previousOwner && previousOwner !== peer && (
      !ownerRow || ownerDead ||
      (!ownerLive && !graceActive && unknownExpired)
    ));
    const alreadyOwner = previousOwner === peer;
    const ok = alreadyOwner ||
      normalized === 'any' ||
      (normalized === 'blocked' && blocked) ||
      (normalized === 'stale' && ownerStale) ||
      (normalized === 'blocked-or-stale' && (blocked || ownerStale));
    return {
      policy: normalized,
      blocked,
      owner_stale: ownerStale,
      owner_age_sec: ownerAge,
      owner_evidence_state: evidence.state,
      owner_evidence_reason: evidence.reason,
      stale_after_sec: staleAfter,
      ok
    };
  }

  function takeOverTaskForPeer(db, peer, id, {
    reason,
    policy = 'blocked-or-stale',
    staleAfter = activePeerTtl,
    source = null,
    ownerEvidence = null,
    ownerEvidenceFor = null
  } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const subject = takeoverSubject(db, id);
      const row = subject.row;
      if (!row) throw new CliError('NOT_FOUND', `Task #${id} does not exist`);
      if (['done', 'abandoned'].includes(row.status)) {
        throw new CliError('BAD_STATE', `Task #${id} is ${row.status}`);
      }
      const observedEvidence = row.owner && typeof ownerEvidenceFor === 'function'
        ? ownerEvidenceFor(row.owner, row, subject.ownerRow, subject.binding)
        : (ownerEvidence || (subject.ownerRow
            ? processEvidenceForPeer(subject.ownerRow)
            : { state: 'unknown', reason: 'peer_missing' }));
      if (observeClockSafety) {
        observeClockSafety({
          db,
          row,
          ownerRow: subject.ownerRow,
          binding: subject.binding,
          evidence: observedEvidence,
          staleAfter
        });
      }
      let subjectChanged = false;
      const result = tx(db, () => {
        const current = takeoverSubject(db, id);
        if (!sameTakeoverSubject(subject, current)) {
          subjectChanged = true;
          return null;
        }
        const policyDetails = takeoverPolicyDetails(db, current.row, peer, {
          policy,
          staleAfter,
          ownerEvidence: observedEvidence,
          ownerRow: current.ownerRow,
          graceUntil: current.graceUntil
        });
        if (!policyDetails.ok) {
          throw new CliError('TAKEOVER_POLICY', `Task #${id} does not match takeover policy ${policyDetails.policy}`, {
            task_id: id,
            status: current.row.status,
            owner: current.row.owner || null,
            policy: policyDetails.policy,
            owner_stale: policyDetails.owner_stale,
            owner_age_sec: policyDetails.owner_age_sec,
            owner_evidence_state: policyDetails.owner_evidence_state,
            owner_evidence_reason: policyDetails.owner_evidence_reason,
            stale_after_sec: policyDetails.stale_after_sec
          });
        }
        const previousOwner = current.row.owner || null;
        const previousAssignee = current.row.assignee || null;
        const t = now();
        db.prepare(`
          UPDATE tasks
          SET owner = ?, status = 'claimed', claimed_at = COALESCE(claimed_at, ?), updated_at = ?
          WHERE id = ?
        `).run(peer, t, t, id);
        addEvent(db, 'task.takeover', peer, id, {
          previous_owner: previousOwner,
          previous_assignee: previousAssignee,
          reason,
          policy: policyDetails.policy,
          owner_stale: policyDetails.owner_stale,
          owner_evidence_state: policyDetails.owner_evidence_state,
          owner_evidence_reason: policyDetails.owner_evidence_reason,
          stale_after_sec: staleAfter,
          ...(source ? { source } : {})
        });
        if (previousOwner && previousOwner !== peer) {
          sendMessage(db, peer, previousOwner, id, 'task.takeover', `Task #${id} taken over by ${peer}: ${reason}`);
        }
        return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      });
      if (!subjectChanged) return result;
    }
    throw new CliError('SUBJECT_CHANGED', `Task #${id} changed while owner evidence was being observed; retry`, {
      task_id: id,
      retryable: true
    });
  }

  function queryOpenTasks(db, limit, peer = null) {
    const sql = `
      SELECT * FROM tasks
      WHERE status NOT IN ('done', 'abandoned')
        ${peer ? 'AND (owner = ? OR assignee = ?)' : ''}
      ORDER BY
        CASE status
          WHEN 'claimed' THEN 0
          WHEN 'running' THEN 1
          WHEN 'pending' THEN 2
          WHEN 'blocked' THEN 3
          WHEN 'review' THEN 4
          ELSE 5
        END,
        priority ASC,
        id ASC
      LIMIT ?
    `;
    return peer
      ? db.prepare(sql).all(peer, peer, limit)
      : db.prepare(sql).all(limit);
  }

  function taskById(db, id) {
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  }

  function teamChildren(db, parentId) {
    return db.prepare(`
      SELECT *
      FROM tasks
      WHERE parent_id = ?
      ORDER BY priority ASC, id ASC
    `).all(parentId);
  }

  function teamSummary(db, parentId) {
    const parent = taskById(db, parentId);
    if (!parent) throw new CliError('NOT_FOUND', `Task #${parentId} does not exist`);
    const children = teamChildren(db, parentId);
    const handoffs = db.prepare(`
      SELECT *
      FROM handoffs
      WHERE task_id = ? OR task_id IN (SELECT id FROM tasks WHERE parent_id = ?)
      ORDER BY id ASC
    `).all(parentId, parentId);
    const counts = {};
    for (const child of children) counts[child.status] = (counts[child.status] || 0) + 1;
    return { parent, children, handoffs, counts };
  }

  function claimNextTasksForPeer(db, peer, { force = false, count = 1 } = {}) {
    return tx(db, () => {
      if (!force) {
        const current = db.prepare(`
          SELECT * FROM tasks
          WHERE owner = ?
            AND status IN ('claimed', 'running', 'review', 'blocked')
          ORDER BY
            CASE status
              WHEN 'running' THEN 0
              WHEN 'claimed' THEN 1
              WHEN 'review' THEN 2
              WHEN 'blocked' THEN 3
              ELSE 4
            END,
            priority ASC,
            id ASC
          LIMIT 1
        `).get(peer);
        if (current) return { current: { ...current, current: true }, tasks: [] };
      }
      const rows = db.prepare(`
        SELECT * FROM tasks
        WHERE status = 'pending'
          AND owner IS NULL
          AND (assignee IS NULL OR assignee = ?)
        ORDER BY CASE WHEN assignee = ? THEN 0 ELSE 1 END, priority ASC, id ASC
        LIMIT ?
      `).all(peer, peer, count);
      if (!rows.length) return { current: null, tasks: [] };
      const t = now();
      const claimed = [];
      for (const row of rows) {
        const changes = db.prepare(`
          UPDATE tasks
          SET owner = ?, status = 'claimed', claimed_at = ?, updated_at = ?
          WHERE id = ? AND owner IS NULL AND status = 'pending'
        `).run(peer, t, t, row.id).changes;
        if (!changes) continue;
        addEvent(db, 'task.claimed', peer, row.id, { next: true, count });
        claimed.push(db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id));
      }
      return { current: null, tasks: claimed };
    });
  }

  function assertTaskOwnerForMutation(db, peer, row, action) {
    if (!row.owner || row.owner === peer) return;
    throw taskOwnedError(peer, row, action);
  }

  return {
    assertTaskOwnerForMutation,
    claimNextTasksForPeer,
    claimTaskRowsForPeer,
    queryOpenTasks,
    takeOverTaskForPeer,
    taskById,
    teamChildren,
    teamSummary,
    takeoverPolicyDetails
  };
}
