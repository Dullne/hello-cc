// Runtime evidence helpers extracted from bin/hcc.mjs.
// Process/tmux evidence observation, optimistic evidence-checked peer
// mutation, and clock-safety observation adapters shared by web + GC.

import fs from 'node:fs';
import path from 'node:path';
import { tx } from '../../db/schema.mjs';
import {
  clockSafetyUnavailable,
  observeClockSafety,
  observeClockSafetyInTransaction
} from '../../core/coordination/clock-safety.mjs';
import {
  captureLockAcquireSubject,
  clockCandidatesFromLocks,
  observeLockOwnerEvidence
} from '../../core/coordination/lock-evidence.mjs';
import { resolvePeerEvidence } from '../../core/peers/evidence.mjs';
import { inspectProcessIdentity } from '../../process/identity.mjs';
import {
  runTmux,
  tmuxManagedSessionName,
  tmuxManagedSessionNameMatches,
  tmuxManagedSessionPrefixMatches,
  tmuxPaneInfo,
  tmuxSessionEnvironmentValue
} from '../../tmux.mjs';

export function createEvidenceRuntime({ now }) {
function isProjectManagedTmuxSession(projectCtx, sessionName, sessionRoot = null) {
  return tmuxManagedSessionPrefixMatches(projectCtx, sessionName, sessionRoot);
}

function liveProcessIdentity(pid) {
  const inspected = inspectProcessIdentity(pid);
  return inspected.state === 'live' ? inspected.identity : null;
}

function storedPeerIdentity(row) {
  return row?.pid ? {
    pid: Number(row.pid),
    startToken: row.pid_start_token,
    commandHash: row.pid_command_hash
  } : null;
}

function processEvidenceFromRow(row, name = 'peer') {
  return {
    name,
    storedIdentity: storedPeerIdentity(row),
    current: inspectProcessIdentity(row?.pid)
  };
}

function canonicalRoot(value) {
  if (!value) return null;
  try { return fs.realpathSync(value); }
  catch {
    try { return path.resolve(value); } catch { return null; }
  }
}

function rootEvidence(expected, actual) {
  const expectedRoot = canonicalRoot(expected);
  const actualRoot = canonicalRoot(actual);
  if (!expectedRoot || !actualRoot) {
    return { state: 'unknown', expected: expectedRoot, actual: actualRoot };
  }
  return {
    state: expectedRoot === actualRoot ? 'match' : 'mismatch',
    expected: expectedRoot,
    actual: actualRoot
  };
}

function tmuxTargetMissing(error) {
  return /can't find pane|can't find session|no server running/i.test(String(error?.message || ''));
}

function inspectTmuxTarget(expectedSession, target) {
  let actualSession = null;
  try {
    actualSession = runTmux(['display-message', '-p', '-t', target, '#{session_name}']).trim() || null;
  } catch (targetError) {
    try {
      runTmux(['has-session', '-t', expectedSession]);
      actualSession = expectedSession;
    } catch (sessionError) {
      return {
        session: { state: tmuxTargetMissing(sessionError) ? 'dead' : 'unknown', expected: expectedSession, actual: null },
        pane: { state: tmuxTargetMissing(targetError) ? 'dead' : 'unknown', expected: target, actual: null },
        paneInfo: null
      };
    }
  }
  if (!actualSession) {
    try {
      runTmux(['has-session', '-t', expectedSession]);
      actualSession = expectedSession;
    } catch (sessionError) {
      return {
        session: { state: tmuxTargetMissing(sessionError) ? 'dead' : 'unknown', expected: expectedSession, actual: null },
        pane: { state: 'unknown', expected: target, actual: null },
        paneInfo: null
      };
    }
  }

  try {
    const paneInfo = tmuxPaneInfo(target);
    const expectedPane = target === `${expectedSession}:0.0` ? paneInfo.pane : target;
    return {
      session: { state: 'live', expected: expectedSession, actual: actualSession },
      pane: { state: paneInfo.dead ? 'dead' : 'live', expected: expectedPane, actual: paneInfo.pane },
      paneInfo
    };
  } catch (error) {
    return {
      session: { state: 'live', expected: expectedSession, actual: actualSession },
      pane: { state: tmuxTargetMissing(error) ? 'dead' : 'unknown', expected: target, actual: null },
      paneInfo: null
    };
  }
}

function observePeerEvidence(projectCtx, row, binding = null) {
  if (binding?.transport !== 'tmux') {
    return resolvePeerEvidence({ peer: row, processes: [processEvidenceFromRow(row)] });
  }

  const expectedSession = tmuxManagedSessionName(projectCtx, row.id);
  const runtimeTarget = binding.runtime_target || `${expectedSession}:0.0`;
  const target = inspectTmuxTarget(expectedSession, runtimeTarget);
  const panePid = target.paneInfo?.pid || row.pid;
  const paneProcess = {
    name: 'pane',
    storedIdentity: Number(row?.pid) === Number(panePid) ? storedPeerIdentity(row) : null,
    current: inspectProcessIdentity(panePid)
  };
  const actualRoot = target.session.actual
    ? tmuxSessionEnvironmentValue(target.session.actual, 'HCC_ROOT')
    : null;
  if (target.session.actual && tmuxManagedSessionNameMatches(
    projectCtx,
    target.session.actual,
    row.id,
    actualRoot
  )) {
    target.session.expected = target.session.actual;
  }
  return resolvePeerEvidence({
    peer: row,
    processes: [processEvidenceFromRow(row, 'owner')],
    tmux: {
      managed: true,
      session: target.session,
      pane: target.pane,
      root: rootEvidence(projectCtx.root, actualRoot),
      process: paneProcess
    }
  });
}

function peerEvidenceFromDb(db, projectCtx, peerId) {
  const row = db.prepare(`
    SELECT id, status, pid, pid_start_token, pid_command_hash
    FROM peers WHERE id = ?
  `).get(peerId);
  if (!row) return { state: 'unknown', reason: 'peer_missing' };
  const binding = db.prepare(`
    SELECT transport, runtime_target FROM peer_bindings WHERE peer = ?
  `).get(peerId) || null;
  return observePeerEvidence(projectCtx, row, binding);
}

function providerOwnerEvidenceFromDb(db, peerId) {
  const row = db.prepare(`
    SELECT id, status, pid, pid_start_token, pid_command_hash
    FROM peers WHERE id = ?
  `).get(peerId);
  return row
    ? resolvePeerEvidence({ peer: row, processes: [processEvidenceFromRow(row, 'provider-owner')] })
    : { state: 'unknown', reason: 'peer_missing' };
}

function peerMutationSubject(db, peerId) {
  const peer = db.prepare(`
    SELECT id, status, pid, pid_start_token, pid_command_hash, last_seen_at
    FROM peers WHERE id = ?
  `).get(peerId) || null;
  const binding = db.prepare(`
    SELECT peer, transport, runtime_target, updated_at
    FROM peer_bindings WHERE peer = ?
  `).get(peerId) || null;
  return { peer, binding };
}

function mutatePeerWithEvidence(db, projectCtx, peerId, mutate, options = {}) {
  const acceptEvidence = typeof options.acceptEvidence === 'function'
    ? options.acceptEvidence
    : (evidence) => evidence.state === 'dead';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const subject = peerMutationSubject(db, peerId);
    if (!subject.peer) return { changed: false, evidence: { state: 'unknown', reason: 'peer_missing' } };
    const evidence = observePeerEvidence(projectCtx, subject.peer, subject.binding);
    if (!acceptEvidence(evidence, subject)) return { changed: false, evidence };
    let subjectChanged = false;
    let blocked = false;
    const changed = tx(db, () => {
      if (options.beforeMutate?.({ subject, evidence }) === false) {
        blocked = true;
        return false;
      }
      const current = peerMutationSubject(db, peerId);
      if (JSON.stringify(current) !== JSON.stringify(subject)) {
        subjectChanged = true;
        return false;
      }
      mutate(current, evidence);
      return true;
    });
    if (blocked) return { changed: false, evidence, blocked: true };
    if (!subjectChanged) return { changed, evidence };
  }
  return { changed: false, evidence: { state: 'unknown', reason: 'subject_changed' } };
}

function mutateConfirmedDeadPeer(db, projectCtx, peerId, mutate, options = {}) {
  return mutatePeerWithEvidence(db, projectCtx, peerId, mutate, options);
}

function observeClockSafetyOrThrow(db, options) {
  try {
    return observeClockSafety(db, options);
  } catch (err) {
    throw clockSafetyUnavailable(err);
  }
}

function observeClockSafetyInTransactionOrThrow(db, options) {
  try {
    return observeClockSafetyInTransaction(db, options);
  } catch (err) {
    throw clockSafetyUnavailable(err);
  }
}

function prepareLockClockObservation(db, subject, evidenceByOwner) {
  return observeClockSafetyInTransactionOrThrow(db, {
    operation: 'ownership',
    candidates: clockCandidatesFromLocks(subject, evidenceByOwner),
    nowSec: subject.observedAt
  });
}

function observeLockClockSafety(db, projectCtx, {
  requested = null,
  taskId = null,
  owner = null,
  observedAt = now()
} = {}) {
  try {
    const subject = captureLockAcquireSubject(db, {
      taskId,
      requested,
      now: observedAt
    });
    const evidenceByOwner = observeLockOwnerEvidence(subject, (row, binding) =>
      observePeerEvidence(projectCtx, row, binding));
    const candidates = subject.locks
      .filter((lock) => Number(lock.expires_at) <= observedAt && (!owner || lock.owner === owner))
      .map((lock) => ({
        boundary: Number(lock.expires_at),
        evidence: evidenceByOwner.get(lock.owner)?.state || 'unknown',
        owner: lock.owner,
        resource: lock.resource
      }));
    return observeClockSafetyOrThrow(db, {
      operation: 'ownership',
      candidates,
      nowSec: observedAt
    });
  } catch (err) {
    throw clockSafetyUnavailable(err);
  }
}

function observeTaskTakeoverClockSafety({ db, row, ownerRow, evidence, staleAfter }) {
  const boundary = ownerRow
    ? Number(ownerRow.last_seen_at || 0) + Number(staleAfter)
    : 0;
  return observeClockSafetyOrThrow(db, {
    operation: 'ownership',
    candidates: row?.owner ? [{
      boundary,
      evidence: evidence?.state || 'unknown',
      owner: row.owner
    }] : [],
    nowSec: now()
  });
}

  return {
    isProjectManagedTmuxSession, liveProcessIdentity, storedPeerIdentity,
    processEvidenceFromRow, canonicalRoot, rootEvidence, tmuxTargetMissing,
    inspectTmuxTarget, observePeerEvidence, peerEvidenceFromDb,
    providerOwnerEvidenceFromDb, peerMutationSubject, mutatePeerWithEvidence,
    mutateConfirmedDeadPeer, observeClockSafetyOrThrow,
    observeClockSafetyInTransactionOrThrow, prepareLockClockObservation,
    observeLockClockSafety, observeTaskTakeoverClockSafety
  };
}
