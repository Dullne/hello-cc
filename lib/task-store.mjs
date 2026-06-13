import { tx } from './db-schema.mjs';
import { CliError } from './errors.mjs';

const DEFAULT_ACTIVE_PEER_TTL = 600;

function defaultNow() {
  return Math.floor(Date.now() / 1000);
}

function noopEvent() {}

function noopMessage() {
  return null;
}

export function createTaskStore(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : defaultNow;
  const addEvent = typeof deps.addEvent === 'function' ? deps.addEvent : noopEvent;
  const sendMessage = typeof deps.sendMessage === 'function' ? deps.sendMessage : noopMessage;
  const activePeerTtl = Number(deps.activePeerTtl || DEFAULT_ACTIVE_PEER_TTL);

  function claimTaskRowsForPeer(db, peer, ids, { force = false, source = null } = {}) {
    return tx(db, () => {
      const tasks = [];
      for (const id of ids) {
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        if (!row) throw new CliError('NOT_FOUND', `Task #${id} does not exist`);
        if (row.owner && row.owner !== peer && !force) {
          throw new CliError('TASK_OWNED', `Task #${id} is owned by ${row.owner}`, { owner: row.owner });
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

  function takeoverPolicyDetails(db, row, peer, { policy = 'any', staleAfter = activePeerTtl } = {}) {
    const normalized = String(policy || 'any').toLowerCase();
    const allowed = new Set(['any', 'blocked', 'stale', 'blocked-or-stale']);
    if (!allowed.has(normalized)) {
      throw new CliError('BAD_ARGS', `Unsupported takeover policy: ${policy}`);
    }
    const previousOwner = row.owner || null;
    const blocked = row.status === 'blocked';
    const ownerRow = previousOwner ? db.prepare('SELECT id, last_seen_at FROM peers WHERE id = ?').get(previousOwner) : null;
    const ownerAge = ownerRow ? now() - Number(ownerRow.last_seen_at || 0) : null;
    const ownerStale = Boolean(previousOwner && previousOwner !== peer && (!ownerRow || ownerAge > staleAfter));
    const alreadyOwner = previousOwner === peer;
    const ok = alreadyOwner ||
      normalized === 'any' ||
      (normalized === 'blocked' && blocked) ||
      (normalized === 'stale' && ownerStale) ||
      (normalized === 'blocked-or-stale' && (blocked || ownerStale));
    return { policy: normalized, blocked, owner_stale: ownerStale, owner_age_sec: ownerAge, stale_after_sec: staleAfter, ok };
  }

  function takeOverTaskForPeer(db, peer, id, { reason, policy = 'any', staleAfter = activePeerTtl, source = null } = {}) {
    return tx(db, () => {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!row) throw new CliError('NOT_FOUND', `Task #${id} does not exist`);
      if (['done', 'abandoned'].includes(row.status)) {
        throw new CliError('BAD_STATE', `Task #${id} is ${row.status}`);
      }
      const policyDetails = takeoverPolicyDetails(db, row, peer, { policy, staleAfter });
      if (!policyDetails.ok) {
        throw new CliError('TAKEOVER_POLICY', `Task #${id} does not match takeover policy ${policyDetails.policy}`, {
          task_id: id,
          status: row.status,
          owner: row.owner || null,
          policy: policyDetails.policy,
          owner_stale: policyDetails.owner_stale,
          owner_age_sec: policyDetails.owner_age_sec,
          stale_after_sec: policyDetails.stale_after_sec
        });
      }
      const previousOwner = row.owner || null;
      const previousAssignee = row.assignee || null;
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
        stale_after_sec: staleAfter,
        ...(source ? { source } : {})
      });
      if (previousOwner && previousOwner !== peer) {
        sendMessage(db, peer, previousOwner, id, 'task.takeover', `Task #${id} taken over by ${peer}: ${reason}`);
      }
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
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

  return {
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
