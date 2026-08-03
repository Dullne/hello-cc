const DEFAULT_ACTIVE_PEER_TTL = 600;

import { clockGraceSuppressed } from '../../shared/clock-grace.mjs';
import { inspectProcessIdentity } from '../../process/identity.mjs';
import { classifyPeerActivity, resolvePeerEvidence } from './evidence.mjs';

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function rowEvidence(row) {
  if (row?.evidence_state) {
    return { state: row.evidence_state, reason: row.evidence_reason || 'observed' };
  }
  const storedIdentity = row?.pid ? {
    pid: Number(row.pid),
    startToken: row.pid_start_token,
    commandHash: row.pid_command_hash
  } : null;
  return resolvePeerEvidence({
    peer: row,
    processes: row?.pid ? [{
      name: 'peer',
      storedIdentity,
      current: inspectProcessIdentity(row.pid)
    }] : []
  });
}

export function taskRelatedLocks(task, locks) {
  const taskId = Number(task?.id || 0);
  const owner = task?.owner || '';
  return (locks || []).filter((lock) => {
    if (taskId && Number(lock.task_id || 0) === taskId) return true;
    return Boolean(owner && lock.owner === owner);
  });
}

export function taskOwnerLiveness(task, peers, locks, t = nowSec(), activePeerTtl = DEFAULT_ACTIVE_PEER_TTL, graceUntil = 0) {
  const owner = task?.owner || null;
  const relatedLocks = taskRelatedLocks(task, locks);
  if (!owner) {
    return {
      owner_known: false,
      owner_active: null,
      owner_stale: false,
      owner_age_sec: null,
      owner_evidence_state: 'unknown',
      owner_evidence_reason: 'owner_missing',
      related_lock_count: relatedLocks.length,
      takeover_ready: false
    };
  }
  const ownerRow = (peers || []).find((row) => row.id === owner) || null;
  const ownerAge = ownerRow
    ? Number(ownerRow.age_sec ?? (t - Number(ownerRow.last_seen_at || 0)))
    : null;
  const evidence = ownerRow ? rowEvidence(ownerRow) : { state: 'unknown', reason: 'peer_missing' };
  // hb-05: after a wall-clock jump (sleep/NTP), age is untrustworthy for the
  // grace window; treat every owner as active so a live owner's task is never
  // spuriously marked stale/takeover-able.
  const graceActive = clockGraceSuppressed(t, graceUntil);
  const activity = classifyPeerActivity({
    ...ownerRow,
    age_sec: ownerAge,
    evidence_state: evidence.state,
    evidence_reason: evidence.reason
  }, { activePeerTtl, graceActive });
  const ownerActive = Boolean(ownerRow && activity.active);
  const ownerStale = !ownerActive;
  const takeoverStatus = ['claimed', 'running', 'review', 'blocked'].includes(task.status);
  return {
    owner_known: Boolean(ownerRow),
    owner_active: ownerActive,
    owner_stale: ownerStale,
    owner_age_sec: Number.isFinite(ownerAge) ? ownerAge : null,
    owner_evidence_state: evidence.state,
    owner_evidence_reason: evidence.reason,
    related_lock_count: relatedLocks.length,
    takeover_ready: Boolean(takeoverStatus && ownerStale && relatedLocks.length === 0)
  };
}

export function annotateTasksWithLiveness(tasks, peers, locks, t = nowSec(), activePeerTtl = DEFAULT_ACTIVE_PEER_TTL, graceUntil = 0) {
  return (tasks || []).map((task) => ({
    ...task,
    ...taskOwnerLiveness(task, peers, locks, t, activePeerTtl, graceUntil)
  }));
}

export function taskOwnerStateText(task) {
  if (!task?.owner) return '';
  if (task.owner_stale) {
    if (task.takeover_ready) return 'stale/no-lock';
    const locks = Number(task.related_lock_count || 0);
    return locks ? `stale/locks=${locks}` : 'stale';
  }
  if (task.owner_active) return 'active';
  return '';
}

export function summarizeTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    owner: task.owner || null,
    assignee: task.assignee || null,
    parent_id: task.parent_id || null,
    team_role: task.team_role || null,
    priority: task.priority,
    owner_active: task.owner_active ?? null,
    owner_stale: Boolean(task.owner_stale),
    owner_age_sec: task.owner_age_sec ?? null,
    owner_evidence_state: task.owner_evidence_state || 'unknown',
    owner_evidence_reason: task.owner_evidence_reason || null,
    related_lock_count: Number(task.related_lock_count || 0),
    takeover_ready: Boolean(task.takeover_ready)
  };
}

export function formatOpenTaskLine(task) {
  const parts = [`#${task.id}`, task.status];
  if (task.owner) parts.push(`owner=${task.owner}`);
  if (task.assignee) parts.push(`assignee=${task.assignee}`);
  const ownerState = taskOwnerStateText(task);
  if (ownerState) parts.push(`owner_state=${ownerState}`);
  return `${parts.join(' ')}: ${task.title}`;
}
