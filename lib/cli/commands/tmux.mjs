// Scan + tmux commands extracted from bin/hcc.mjs.
// hcc scan detects provider sessions; the tmux helpers implement DB-proven,
// evidence-checked tmux GC (plan/validate/execute) for hcc-managed sessions.

import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { CliError } from '../../shared/errors.mjs';
import { tx } from '../../db/schema.mjs';
import { intOpt, parseOpts, validateOpts, wantsHelp } from '../../cli-args.mjs';
import { printResult, table } from '../../format.mjs';
import { readRuntime } from '../../runtime/state.mjs';
import { runtimeRequest } from '../../runtime/client.mjs';
import { registerProjectActivity } from '../../runtime/projects.mjs';
import { detectBranch } from '../../project-context.mjs';
import { bindingFromDetected } from '../../core/peers/bindings.mjs';
import { resolvePeerEvidence } from '../../core/peers/evidence.mjs';
import {
  conditionalTmuxKill,
  finalizeTmuxGcBindingMutation,
  validateTmuxDestructiveEvidence,
  validateTmuxGcBindingEvidence,
  validateTmuxGcDeadProcessEvidence
} from '../../core/peers/tmux-safety.mjs';
import { inspectProcessIdentity } from '../../process/identity.mjs';
import {
  ensureTmuxAvailable,
  runTmux,
  tmuxManagedSessionName,
  tmuxPaneInfo,
  tmuxSessionEnvironmentValue
} from '../../tmux.mjs';
import { resolveCurrentPeer } from '../../integrations/peers/identity.mjs';

export function createTmuxCommands(deps) {
  const {
    connect, now, addEvent, auditPayload,
    upsertPeer, upsertCanonicalPeerBinding,
    loadDiscover, sameResolvedPath,
    helpTmux,
    canonicalRoot, rootEvidence, processEvidenceFromRow,
    inspectTmuxTarget, isProjectManagedTmuxSession
  } = deps;

async function cmdScan(ctx, args) {
  const opts = parseOpts(args, { booleans: ['register'] });
  const { scanClaudeSessions, scanCodexSessions, scanProcesses } = await loadDiscover();

  const found = [
    ...scanClaudeSessions(),
    ...scanCodexSessions(),
    ...scanProcesses(),
  ].filter((s) => sameResolvedPath(s.hccRoot, ctx.root));

  // Deduplicate by peerId
  const byId = new Map();
  for (const s of found) {
    if (!byId.has(s.peerId)) byId.set(s.peerId, s);
  }
  const results = [...byId.values()];

  if (opts.register && results.length) {
    registerProjectActivity(ctx);
    const db = connect(ctx);
    try {
      for (const s of results) {
        upsertPeer(db, {
          id: s.peerId, kind: s.kind, role: 'peer',
          worktree: s.cwd,
          branch: detectBranch(s.cwd),
          pid: s.pid,
          status: s.status || 'running',
          capabilities: 'detected'
        });
        upsertCanonicalPeerBinding(db, bindingFromDetected(s, s.transport || 'detected'), true);
      }
    } finally {
      db.close();
    }
  }

  printResult(ctx, results, (rows) => {
    if (!rows.length) return 'no active sessions found in this project';
    return table(rows, [
      { label: 'peer',      value: (r) => r.peerId },
      { label: 'kind',      value: (r) => r.kind },
      { label: 'pid',       value: (r) => r.pid || '' },
      { label: 'cwd',       value: (r) => r.cwd },
      { label: 'session',   value: (r) => (r.sessionId || '').slice(0, 16) },
      { label: 'transport', value: (r) => r.transport },
    ]);
  });
}

// ─── hcc tmux ────────────────────────────────────────────────────────────────

function tmuxSessionNameForTarget(target) {
  if (!target) return null;
  try {
    return runTmux(['display-message', '-p', '-t', target, '#{session_name}']).trim() || null;
  } catch {
    return null;
  }
}

function tmuxSessionCreationToken(target) {
  if (!target) return null;
  try {
    return runTmux(['display-message', '-p', '-t', target, '#{session_created}']).trim() || null;
  } catch {
    return null;
  }
}

function tmuxSessionId(target) {
  if (!target) return null;
  try {
    return runTmux(['display-message', '-p', '-t', target, '#{session_id}']).trim() || null;
  } catch {
    return null;
  }
}

function tmuxPaneForTarget(target) {
  if (!target) return null;
  try {
    return runTmux(['display-message', '-p', '-t', target, '#{pane_id}']).trim() || null;
  } catch {
    return null;
  }
}

async function managedRuntimeSessions(ctx) {
  try {
    const runtime = readRuntime(ctx);
    const data = await runtimeRequest(ctx, 'GET', '/api/sessions', null, runtime);
    return data.sessions || [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function strictTmuxClientObservation(sessionName) {
  if (!sessionName) return { state: 'unknown', count: null };
  try {
    const output = runTmux(['list-clients', '-t', sessionName, '-F', '#{client_tty}']);
    return { state: 'known', count: output.trim().split('\n').filter(Boolean).length };
  } catch (error) {
    return { state: 'unknown', count: null, error: error?.message || String(error) };
  }
}

function tmuxAttachmentAuthority(db, peerId, runtimeTarget) {
  const row = db.prepare(`
    SELECT payload
    FROM events
    WHERE type = 'tmux.session.attached'
      AND json_extract(payload, '$.target_peer') = ?
      AND json_extract(payload, '$.pane') = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(peerId, runtimeTarget);
  const payload = parseJsonObject(row?.payload) || {};
  return {
    session: payload.tmux_session || null,
    session_created: payload.tmux_session_created || null,
    session_id: payload.tmux_session_id || null,
    root: payload.hcc_root || null,
    pane: payload.pane || null,
    process_identity: payload.process_identity || null
  };
}

function tmuxGcBindingSubject(ctx, row) {
  const authority = row.authority || {};
  return {
    peer: row.peer || row.id || null,
    status: row.status || null,
    pid: row.pid || null,
    pid_start_token: row.pid_start_token || null,
    pid_command_hash: row.pid_command_hash || null,
    last_seen_at: row.last_seen_at || null,
    transport: row.transport || null,
    runtime_target: row.runtime_target || null,
    runtime_session_id: row.runtime_session_id || null,
    updated_at: row.updated_at || null,
    expected_session: tmuxManagedSessionName(ctx, row.peer || row.id),
    expected_root: ctx.root || null,
    authority: {
      session: authority.session || null,
      session_created: authority.session_created || null,
      session_id: authority.session_id || null,
      root: authority.root || null,
      pane: authority.pane || null,
      process_identity: authority.process_identity || null
    }
  };
}

function tmuxGcBindingSubjectFromDb(db, ctx, peerId) {
  const row = db.prepare(`
    SELECT p.id AS peer, p.status, p.pid, p.pid_start_token,
           p.pid_command_hash, p.last_seen_at,
           b.transport, b.runtime_target, b.runtime_session_id, b.updated_at
    FROM peers p
    JOIN peer_bindings b ON b.peer = p.id
    WHERE p.id = ?
  `).get(peerId);
  if (!row) return null;
  return tmuxGcBindingSubject(ctx, {
    ...row,
    authority: tmuxAttachmentAuthority(db, peerId, row.runtime_target)
  });
}

function sameTmuxGcBindingSubject(planned, current) {
  return Boolean(planned && current) && JSON.stringify(planned) === JSON.stringify(current);
}

const TMUX_GC_CONDITIONAL_TIMEOUT_MS = 5000;

function runBoundedTmuxGcCommand(args) {
  const result = spawnSync('tmux', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input: '',
    timeout: TMUX_GC_CONDITIONAL_TIMEOUT_MS,
    killSignal: 'SIGKILL'
  });
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    throw new CliError(
      timedOut ? 'TMUX_CONDITIONAL_KILL_TIMEOUT' : 'TMUX_ERROR',
      timedOut
        ? `tmux conditional kill exceeded ${TMUX_GC_CONDITIONAL_TIMEOUT_MS}ms`
        : `tmux failed: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim() || `tmux ${args.join(' ')} failed`;
    throw new CliError('TMUX_ERROR', message);
  }
  return result.stdout || '';
}

function casDetachTmuxGcBinding(db, subject, timestamp) {
  return db.prepare(`
    UPDATE peer_bindings
    SET transport = 'detached',
        runtime_target = NULL,
        updated_at = ?
    WHERE peer = ?
      AND transport = 'tmux'
      AND runtime_target = ?
      AND runtime_session_id IS ?
      AND updated_at IS ?
  `).run(
    timestamp,
    subject.peer,
    subject.runtime_target,
    subject.runtime_session_id,
    subject.updated_at
  );
}

function casDetachTmuxGcPeer(db, subject, timestamp) {
  const result = db.prepare(`
    UPDATE peers
    SET status = 'detached',
        last_seen_at = ?
    WHERE id = ?
      AND status IS ?
      AND pid IS ?
      AND pid_start_token IS ?
      AND pid_command_hash IS ?
      AND last_seen_at IS ?
  `).run(
    timestamp,
    subject.peer,
    subject.status,
    subject.pid,
    subject.pid_start_token,
    subject.pid_command_hash,
    subject.last_seen_at
  );
  if (Number(result.changes) !== 1) {
    throw new CliError('TMUX_GC_PEER_CAS_FAILED',
      'tmux GC peer compare-and-swap did not update exactly one row');
  }
  return result;
}

function observeTmuxConditionalTarget(runtimeTarget) {
  let paneInfo = null;
  try { paneInfo = tmuxPaneInfo(runtimeTarget); } catch {}
  const pane = paneInfo?.pane || tmuxPaneForTarget(runtimeTarget);
  const session = tmuxSessionNameForTarget(runtimeTarget);
  const processInspection = inspectProcessIdentity(paneInfo?.pid);
  return {
    session,
    session_created: tmuxSessionCreationToken(session),
    session_id: tmuxSessionId(session),
    root: canonicalRoot(tmuxSessionEnvironmentValue(session, 'HCC_ROOT')),
    pane,
    pane_pid: paneInfo?.pid || null,
    pane_dead: paneInfo?.dead === true,
    process_identity: processInspection.state === 'live' ? processInspection.identity : null,
    process_inspection: processInspection,
    clients: strictTmuxClientObservation(session)
  };
}

function rebindCandidateAuthority(candidate) {
  return {
    session: candidate.expected_session || candidate.session || null,
    session_created: candidate.old_tmux_session_created || null,
    session_id: candidate.old_tmux_session_id || null,
    root: canonicalRoot(candidate.old_hcc_root),
    pane: candidate.old_pane || null,
    process_identity: parseJsonObject(candidate.old_process_identity)
  };
}

function validateTmuxGcDeadRebindEvidence(candidate) {
  const stored = rebindCandidateAuthority(candidate);
  const observed = observeTmuxConditionalTarget(candidate.runtime_target || candidate.session || '');
  return {
    ...validateTmuxGcDeadProcessEvidence(stored, observed),
    stored,
    observed
  };
}

function validateTmuxGcBindingCandidate(subject) {
  const observed = observeTmuxConditionalTarget(subject?.runtime_target || '');
  const ownerEvidence = subject
    ? resolvePeerEvidence({
        peer: subject,
        processes: [processEvidenceFromRow(subject, 'owner')]
      })
    : { state: 'unknown', reason: 'peer_missing' };
  const validationSubject = subject ? {
    ...subject,
    owner_evidence: ownerEvidence,
    expected_root: canonicalRoot(subject.expected_root),
    authority: subject.authority ? {
      ...subject.authority,
      root: canonicalRoot(subject.authority.root)
    } : null
  } : subject;
  return {
    ...validateTmuxGcBindingEvidence(validationSubject, observed),
    stored: subject?.authority || null,
    observed,
    subject
  };
}

function observeRebindEventEvidence(ctx, candidate) {
  const sessionName = candidate.expected_session || candidate.session || null;
  const storedIdentity = parseJsonObject(candidate.old_process_identity);
  const storedRoot = canonicalRoot(candidate.old_hcc_root);
  const storedSessionCreated = candidate.old_tmux_session_created
    ? String(candidate.old_tmux_session_created)
    : null;
  const storedSessionId = candidate.old_tmux_session_id || null;
  const storedPane = candidate.old_pane || null;
  if (!sessionName || !candidate.runtime_target || !storedIdentity || !storedRoot ||
      !storedSessionCreated || !storedSessionId || !storedPane) {
    return { state: 'unknown', reason: 'tmux_event_evidence_incomplete' };
  }

  const target = inspectTmuxTarget(sessionName, candidate.runtime_target);
  const currentSessionCreated = target.session.actual
    ? tmuxSessionCreationToken(target.session.actual)
    : null;
  const currentSessionId = target.session.actual
    ? tmuxSessionId(target.session.actual)
    : null;
  const exactSession = target.session.state === 'live' &&
    target.session.actual === sessionName &&
    currentSessionCreated === storedSessionCreated &&
    currentSessionId === storedSessionId;
  const session = target.session.state === 'dead'
    ? { state: 'dead', expected: `${sessionName}:${storedSessionCreated}`, actual: null }
    : {
        state: exactSession ? 'live' : 'unknown',
        expected: `${sessionName}:${storedSessionCreated}`,
        actual: target.session.actual && currentSessionCreated
          ? `${target.session.actual}:${currentSessionCreated}`
          : null
      };
  const pane = target.pane.actual && target.pane.actual !== storedPane
    ? { state: 'unknown', expected: storedPane, actual: target.pane.actual }
    : { ...target.pane, expected: storedPane };
  const actualRoot = target.session.actual
    ? canonicalRoot(tmuxSessionEnvironmentValue(target.session.actual, 'HCC_ROOT'))
    : null;
  const expectedRoot = canonicalRoot(ctx.root);
  const root = !expectedRoot || !actualRoot
    ? { state: 'unknown', expected: expectedRoot, actual: actualRoot }
    : {
        state: storedRoot === expectedRoot && actualRoot === storedRoot ? 'match' : 'mismatch',
        expected: storedRoot,
        actual: actualRoot
      };
  return resolvePeerEvidence({
    peer: { status: 'working' },
    tmux: {
      managed: true,
      session,
      pane,
      root,
      process: {
        name: 'old-pane',
        storedIdentity,
        current: inspectProcessIdentity(target.paneInfo?.pid || storedIdentity.pid)
      }
    }
  });
}

async function planTmuxGc(ctx, opts) {
  ensureTmuxAvailable({ autoInstall: false });
  const olderThanDays = intOpt(opts, 'older-than', 14);
  if (olderThanDays < 0) throw new CliError('BAD_ARGS', '--older-than must be zero or greater');
  const targetPeer = opts.peer || null;
  const cutoff = now() - olderThanDays * 86400;
  const runtimeSessions = await managedRuntimeSessions(ctx);
  const managedPanes = new Set(runtimeSessions.map((s) => s.pane).filter(Boolean));
  const managedPeers = new Set();
  for (const session of runtimeSessions) {
    if (session.id) managedPeers.add(session.id);
    if (session.peer_id) managedPeers.add(session.peer_id);
  }

  const db = connect(ctx);
  let rows = [];
  let cleanupFailureRows = [];
  try {
    rows = db.prepare(`
      SELECT p.id AS peer, p.kind, p.status, p.pid,
             p.pid_start_token, p.pid_command_hash, p.last_seen_at,
             b.provider, b.provider_session_id, b.provider_session_name,
             b.resume_mode, b.resume_arg, b.command, b.transport,
             b.runtime_session_id, b.runtime_target, b.updated_at
      FROM peer_bindings b
      JOIN peers p ON p.id = b.peer
      WHERE b.transport = 'tmux'
        AND b.runtime_target IS NOT NULL
      ORDER BY b.updated_at ASC, p.last_seen_at ASC, p.id ASC
    `).all();
    rows = rows.map((row) => ({
      ...row,
      authority: tmuxAttachmentAuthority(db, row.peer, row.runtime_target)
    }));
    cleanupFailureRows = db.prepare(`
      SELECT actor AS peer, type, created_at,
             json_extract(payload, '$.old_peer') AS old_peer,
             json_extract(payload, '$.old_tmux_session') AS old_tmux_session,
             json_extract(payload, '$.old_runtime_target') AS old_runtime_target,
             json_extract(payload, '$.new_runtime_target') AS new_runtime_target,
             json_extract(payload, '$.old_pane') AS old_pane,
             json_extract(payload, '$.old_process_identity') AS old_process_identity,
             json_extract(payload, '$.old_hcc_root') AS old_hcc_root,
             json_extract(payload, '$.old_tmux_session_created') AS old_tmux_session_created,
             json_extract(payload, '$.old_tmux_session_id') AS old_tmux_session_id,
             json_extract(payload, '$.reason') AS cleanup_reason
      FROM events
      WHERE type IN ('tmux.session.rebind_cleanup_failed', 'tmux.session.rebind_cleanup_pending')
        AND created_at < ?
      ORDER BY created_at ASC, id ASC
    `).all(cutoff);
  } finally {
    db.close();
  }

  const seenSessions = new Set();
  const candidates = [];
  const skipped = [];
  for (const row of rows) {
    if (targetPeer && row.peer !== targetPeer) continue;
    const bindingSubject = tmuxGcBindingSubject(ctx, row);
    const strictBinding = validateTmuxGcBindingCandidate(bindingSubject);
    const expectedSession = tmuxManagedSessionName(ctx, row.peer);
    const actualSession = tmuxSessionNameForTarget(row.runtime_target);
    const actualPane = tmuxPaneForTarget(row.runtime_target);
    const ageSeconds = Math.max(0, now() - Math.max(Number(row.last_seen_at || 0), Number(row.updated_at || 0)));
    const base = {
      peer: row.peer,
      kind: row.kind || '',
      provider: row.provider,
      session: actualSession || expectedSession,
      expected_session: expectedSession,
      pane: actualPane || row.runtime_target,
      runtime_target: row.runtime_target,
      runtime_session_id: row.runtime_session_id || null,
      last_seen_at: row.last_seen_at || null,
      updated_at: row.updated_at || null,
      age_days: Math.floor(ageSeconds / 86400),
      authority: row.authority
    };
    const skip = (reason, extra = {}) => skipped.push({ ...base, reason, ...extra });

    if (!strictBinding.ok) {
      skip(strictBinding.reason, { evidence_state: 'unknown' });
      continue;
    }

    if (!actualSession || !actualPane) {
      skip('tmux_target_missing');
      continue;
    }
    if (actualSession !== expectedSession) {
      skip('not_hcc_managed_name');
      continue;
    }
    const hccRoot = tmuxSessionEnvironmentValue(actualSession, 'HCC_ROOT');
    if (hccRoot && path.resolve(hccRoot) !== path.resolve(ctx.root)) {
      skip('hcc_root_mismatch', { hcc_root: hccRoot });
      continue;
    }
    if (seenSessions.has(actualSession)) {
      skip('duplicate_db_binding');
      continue;
    }
    seenSessions.add(actualSession);
    if (managedPanes.has(actualPane) || managedPanes.has(row.runtime_target) || managedPeers.has(row.peer) || managedPeers.has(row.runtime_session_id)) {
      skip('runtime_managed');
      continue;
    }
    const clientCount = strictBinding.observed.clients.count;
    if (Math.max(Number(row.last_seen_at || 0), Number(row.updated_at || 0)) >= cutoff) {
      skip('not_old_enough');
      continue;
    }
    candidates.push({
      ...base,
      source: 'binding',
      reason: 'stale_hcc_managed_session',
      hcc_root: hccRoot || null,
      client_count: clientCount,
      evidence_state: 'dead',
      evidence_reason: strictBinding.mode === 'dead_process'
        ? 'tmux_process_confirmed_dead'
        : 'explicit_exited',
      gc_validation_mode: strictBinding.mode,
      gc_validation_subject: bindingSubject
    });
  }
  for (const row of cleanupFailureRows) {
    const rowPeer = row.old_peer || row.peer || '';
    if (targetPeer && rowPeer !== targetPeer) continue;
    const expectedSession = row.old_tmux_session || null;
    const actualSession = tmuxSessionNameForTarget(row.old_runtime_target);
    const actualPane = tmuxPaneForTarget(row.old_runtime_target);
    const ageSeconds = Math.max(0, now() - Number(row.created_at || 0));
    const base = {
      peer: rowPeer,
      kind: '',
      provider: '',
      session: actualSession || expectedSession || '',
      expected_session: expectedSession || '',
      pane: actualPane || row.old_runtime_target || '',
      runtime_target: row.old_runtime_target || null,
      last_seen_at: null,
      updated_at: row.created_at || null,
      age_days: Math.floor(ageSeconds / 86400),
      cleanup_reason: row.cleanup_reason || null,
      old_pane: row.old_pane || null,
      old_process_identity: row.old_process_identity || null,
      old_hcc_root: row.old_hcc_root || null,
      old_tmux_session_created: row.old_tmux_session_created || null,
      old_tmux_session_id: row.old_tmux_session_id || null
    };
    const skip = (reason, extra = {}) => skipped.push({ ...base, reason, ...extra });

    const strictDead = validateTmuxGcDeadRebindEvidence(base);
    if (!strictDead.ok) {
      skip(strictDead.reason, { evidence_state: 'unknown' });
      continue;
    }

    if (!expectedSession || !actualSession || !actualPane) {
      skip('tmux_target_missing');
      continue;
    }
    if (actualSession !== expectedSession) {
      skip('old_runtime_target_changed', { actual_session: actualSession });
      continue;
    }
    const hccRoot = tmuxSessionEnvironmentValue(expectedSession, 'HCC_ROOT');
    if (!isProjectManagedTmuxSession(ctx, expectedSession, hccRoot)) {
      skip('not_hcc_managed_name');
      continue;
    }
    if (rootEvidence(ctx.root, hccRoot).state !== 'match') {
      skip('hcc_root_mismatch', { hcc_root: hccRoot });
      continue;
    }
    if (seenSessions.has(expectedSession)) {
      skip('duplicate_db_binding');
      continue;
    }
    seenSessions.add(expectedSession);
    if (managedPanes.has(actualPane) || managedPanes.has(row.old_runtime_target)) {
      skip('runtime_managed');
      continue;
    }
    const clientCount = strictDead.observed.clients.count;
    candidates.push({
      ...base,
      source: row.type === 'tmux.session.rebind_cleanup_pending' ? 'rebind_cleanup_pending' : 'rebind_cleanup_failed',
      reason: row.type === 'tmux.session.rebind_cleanup_pending'
        ? 'stale_rebind_cleanup_pending_session'
        : 'stale_rebind_cleanup_failed_session',
      session: expectedSession,
      hcc_root: hccRoot || null,
      evidence_state: 'dead',
      evidence_reason: 'tmux_process_confirmed_dead',
      client_count: clientCount
    });
  }
  return { older_than_days: olderThanDays, cutoff, peer: targetPeer, candidates, skipped };
}

function validateTmuxGcCandidate(ctx, candidate, runtimeSessions = [], options = {}) {
  const target = candidate.runtime_target || candidate.session || '';
  const actualSession = tmuxSessionNameForTarget(target);
  const actualPane = tmuxPaneForTarget(target);
  const skip = (reason, extra = {}) => ({ ok: false, reason, ...extra });
  if (!candidate.session || !actualSession || !actualPane) return skip('tmux_target_missing');
  if (actualSession !== candidate.session) {
    return skip('tmux_target_changed', { session: actualSession, pane: actualPane });
  }
  if (candidate.source !== 'binding' && candidate.old_pane !== actualPane) {
    return skip('tmux_pane_changed', { pane: actualPane });
  }
  const hccRoot = tmuxSessionEnvironmentValue(actualSession, 'HCC_ROOT');
  if (!isProjectManagedTmuxSession(ctx, actualSession, hccRoot)) return skip('not_hcc_managed_name');
  if (rootEvidence(ctx.root, hccRoot).state !== 'match') {
    return skip('hcc_root_mismatch', { hcc_root: hccRoot });
  }

  const managedPanes = new Set(runtimeSessions.map((s) => s.pane).filter(Boolean));
  const managedPeers = new Set();
  for (const session of runtimeSessions) {
    if (session.id) managedPeers.add(session.id);
    if (session.peer_id) managedPeers.add(session.peer_id);
  }
  if (managedPanes.has(actualPane) || managedPanes.has(candidate.runtime_target)) {
    return skip('runtime_managed');
  }
  if (candidate.source === 'binding' && (managedPeers.has(candidate.peer) || managedPeers.has(candidate.runtime_session_id))) {
    return skip('runtime_managed');
  }
  const stored = candidate.source === 'binding'
    ? candidate.authority
    : rebindCandidateAuthority(candidate);
  const bindingValidation = candidate.source === 'binding'
    ? options.bindingValidation
    : null;
  const deadValidation = candidate.source !== 'binding' && options.freshEvidence?.state === 'dead'
    ? validateTmuxGcDeadRebindEvidence(candidate)
    : null;
  const validation = bindingValidation || deadValidation || validateTmuxDestructiveEvidence(
    stored, observeTmuxConditionalTarget(target)
  );
  if (!validation.ok) return skip(validation.reason);
  const validationMode = bindingValidation?.mode || (deadValidation ? 'dead_process' : 'live_process');
  const clientCount = validation.observed?.clients?.count;
  return {
    ok: true,
    session: actualSession,
    pane: actualPane,
    hcc_root: hccRoot || null,
    client_count: clientCount,
    stored: validation.stored || stored,
    gc_validation_mode: validationMode,
    dead_process_mode: validationMode === 'dead_process'
  };
}

async function cmdTmux(ctx, args) {
  const sub = args[0];
  if (!sub || wantsHelp(args)) return helpTmux();
  if (sub !== 'gc') throw new CliError('BAD_ARGS', `Unknown tmux command: ${sub}`);

  const opts = parseOpts(args.slice(1), { booleans: ['yes', 'dry-run'] });
  validateOpts('tmux gc', opts, ['peer', 'older-than', 'yes', 'dry-run']);
  if (opts.yes && opts['dry-run']) throw new CliError('BAD_ARGS', 'Use either --yes or --dry-run, not both');

  const dryRun = !opts.yes;
  const actor = resolveCurrentPeer(ctx, {}, 'peer', 'shell').id;
  const plan = await planTmuxGc(ctx, opts);
  const removed = [];
  if (!dryRun) {
    const runtimeSessions = await managedRuntimeSessions(ctx);
    const db = connect(ctx);
    try {
      for (const candidate of plan.candidates) {
        let currentEvidence = null;
        let bindingValidation = null;
        if (candidate.source === 'binding') {
          const currentSubject = tmuxGcBindingSubjectFromDb(db, ctx, candidate.peer);
          if (!sameTmuxGcBindingSubject(candidate.gc_validation_subject, currentSubject)) {
            plan.skipped.push({ ...candidate, reason: 'tmux_binding_subject_changed', revalidated: true });
            continue;
          }
          bindingValidation = validateTmuxGcBindingCandidate(currentSubject);
          if (!bindingValidation.ok || bindingValidation.mode !== candidate.gc_validation_mode) {
            plan.skipped.push({
              ...candidate,
              reason: bindingValidation.ok ? 'tmux_binding_validation_mode_changed' : bindingValidation.reason,
              revalidated: true
            });
            continue;
          }
        } else {
          currentEvidence = observeRebindEventEvidence(ctx, candidate);
        }
        if (candidate.source !== 'binding' && currentEvidence.state !== 'dead') {
          plan.skipped.push({
            ...candidate,
            reason: currentEvidence.state === 'live' ? 'peer_live' : currentEvidence.reason,
            evidence_state: currentEvidence.state,
            revalidated: true
          });
          continue;
        }
        const valid = validateTmuxGcCandidate(ctx, candidate, runtimeSessions, {
          freshEvidence: currentEvidence,
          bindingValidation
        });
        if (!valid.ok) {
          plan.skipped.push({ ...candidate, reason: valid.reason, revalidated: true });
          continue;
        }
        const eventPayload = auditPayload({
          actor,
          target: candidate.peer,
          admin: true,
          peer: candidate.peer,
          tmux_session: candidate.session,
          runtime_target: candidate.runtime_target,
          reason: candidate.reason,
          older_than_days: plan.older_than_days
        });
        if (candidate.source === 'binding') {
          try {
            const t = now();
            finalizeTmuxGcBindingMutation({
              db,
              plannedSubject: candidate.gc_validation_subject,
              readSubject: () => tmuxGcBindingSubjectFromDb(db, ctx, candidate.peer),
              sameSubject: sameTmuxGcBindingSubject,
              conditionalKill: () => conditionalTmuxKill(runBoundedTmuxGcCommand, valid.stored, {
                requireDeadPane: valid.dead_process_mode
              }),
              casBinding: (subject) => casDetachTmuxGcBinding(db, subject, t),
              updatePeer: (subject) => casDetachTmuxGcPeer(db, subject, t)
            });
          } catch (error) {
            plan.skipped.push({
              ...candidate,
              reason: error?.code || 'tmux_gc_binding_finalization_failed',
              error: error?.message || String(error),
              revalidated: true
            });
            continue;
          }
          addEvent(db, 'tmux.session.gc', actor, null, eventPayload);
          removed.push(candidate);
          continue;
        }
        try {
          conditionalTmuxKill(runTmux, valid.stored, {
            requireDeadPane: valid.dead_process_mode
          });
        } catch (error) {
          plan.skipped.push({
            ...candidate,
            reason: error?.code || 'tmux_conditional_kill_failed',
            error: error?.message || String(error),
            revalidated: true
          });
          continue;
        }
        tx(db, () => {
          addEvent(db, 'tmux.session.gc', actor, null, eventPayload);
          removed.push(candidate);
        });
      }
    } finally {
      db.close();
    }
  }

  const data = { dry_run: dryRun, older_than_days: plan.older_than_days, peer: plan.peer, candidates: plan.candidates, skipped: plan.skipped, removed };
  printResult(ctx, data, (r) => {
    const rows = dryRun ? r.candidates : r.removed;
    const title = dryRun
      ? `tmux gc dry-run: ${rows.length} removable hcc-managed session${rows.length === 1 ? '' : 's'}`
      : `tmux gc removed ${rows.length} hcc-managed session${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) return `${title}\n  nothing to clean`;
    return [
      title,
      table(rows, [
        { label: 'peer', value: (row) => row.peer },
        { label: 'session', value: (row) => row.session },
        { label: 'pane', value: (row) => row.pane },
        { label: 'age', value: (row) => `${row.age_days}d` },
        { label: 'reason', value: (row) => row.reason }
      ]),
      dryRun ? 'run again with --yes to delete only these DB-proven hcc-managed tmux sessions' : ''
    ].filter(Boolean).join('\n');
  });
}

  return {
    cmdScan, cmdTmux,
    tmuxSessionNameForTarget, tmuxSessionCreationToken, tmuxSessionId, tmuxPaneForTarget,
    managedRuntimeSessions, parseJsonObject,
    planTmuxGc, validateTmuxGcCandidate,
    strictTmuxClientObservation, tmuxAttachmentAuthority
  };
}
