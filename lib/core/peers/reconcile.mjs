import path from 'node:path';
import { providerSessionParts } from './session.mjs';
import {
  bindingHasProviderSession,
  bindingProviderSessionValue
} from './bindings.mjs';

function defaultNow() {
  return Math.floor(Date.now() / 1000);
}

function noopEvent() {}

function normalizedRoot(root) {
  return root ? path.resolve(root) : '';
}

function runtimePaneMatches(row, pane) {
  return Boolean(row?.runtime_target && pane?.pane && row.runtime_target === pane.pane);
}

function runtimePidMatches(row, pane) {
  return Boolean(row?.pid && pane?.pid && Number(row.pid) === Number(pane.pid));
}

function runtimeCwdMatches(root, row, pane) {
  const paneCwd = normalizedRoot(pane?.cwd);
  if (!paneCwd) return false;
  const worktree = normalizedRoot(row?.worktree);
  const projectRoot = normalizedRoot(root);
  return Boolean((worktree && paneCwd === worktree) || (projectRoot && paneCwd === projectRoot));
}

function commandEvidence(row) {
  const value = row?.resume_arg || null;
  if (!value || value === '--last' || String(value).startsWith('%')) return null;
  if (!['resume', 'session', 'detected', 'named'].includes(row?.resume_mode)) return null;
  return {
    provider: row.provider || row.kind || null,
    value,
    source: `binding.${row.resume_mode}`
  };
}

function processEvidence(row, inspectProcess) {
  if (typeof inspectProcess !== 'function' || !row?.pid) return null;
  const info = inspectProcess(Number(row.pid), row.provider || row.kind || null);
  if (!info?.provider_session) return null;
  return {
    provider: info.kind || row.provider || row.kind || null,
    value: info.provider_session,
    source: info.source || 'process'
  };
}

function tmuxEvidence(row, pane, opts) {
  const provider = row.provider || row.kind || null;
  const byEvent = eventEvidence(row, opts);
  if (byEvent) return byEvent;
  const byProcess = processEvidence(row, opts.inspectProcess);
  if (byProcess) return byProcess;
  const byCommand = commandEvidence(row);
  if (!byCommand) return null;
  if (!runtimePaneMatches(row, pane) && !runtimePidMatches(row, pane)) return null;
  return {
    ...byCommand,
    provider
  };
}

function eventEvidence(row, opts) {
  if (typeof opts.latestProviderSessionForPeer !== 'function') return null;
  const value = opts.latestProviderSessionForPeer(row.peer, row.provider || row.kind || null);
  if (!value) return null;
  return {
    provider: row.provider || row.kind || null,
    value,
    source: 'events.hook'
  };
}

function existingProviderSessionConflict(db, row, session, provider = row?.provider) {
  if (!session?.provider_session_id && !session?.provider_session_name) return null;
  if (!provider) return null;
  if (session.provider_session_id) {
    return db.prepare(`
      SELECT *
      FROM peer_bindings
      WHERE provider = ?
        AND peer <> ?
        AND provider_session_id = ?
      LIMIT 1
    `).get(provider, row.peer, session.provider_session_id) || null;
  }
  return db.prepare(`
    SELECT *
    FROM peer_bindings
    WHERE provider = ?
      AND peer <> ?
      AND provider_session_name = ?
    LIMIT 1
  `).get(provider, row.peer, session.provider_session_name) || null;
}

function updatePeerProviderSession(db, row, candidate, opts) {
  const t = opts.now();
  const provider = candidate.provider || row.provider;
  const session = providerSessionParts(candidate.value);
  const conflict = existingProviderSessionConflict(db, row, session, provider);
  if (conflict) {
    return {
      peer: row.peer,
      provider,
      action: 'skipped',
      reason: 'provider_session_conflict',
      conflict_peer: conflict.peer,
      provider_session: bindingProviderSessionValue(session)
    };
  }

  try {
    db.prepare(`
      UPDATE peer_bindings
      SET provider = ?,
          provider_session_id = ?,
          provider_session_name = ?,
          resume_mode = CASE
            WHEN resume_mode IN ('unknown', 'attached', 'auto', 'command') THEN ?
            ELSE resume_mode
          END,
          resume_arg = COALESCE(NULLIF(resume_arg, runtime_target), ?),
          updated_at = ?
      WHERE peer = ?
    `).run(
      provider,
      session.provider_session_id || null,
      session.provider_session_name || null,
      candidate.source === 'binding.session' ? 'session' : 'detected',
      candidate.value,
      t,
      row.peer
    );
  } catch (err) {
    const text = `${err?.code || ''} ${err?.message || ''} ${err?.errstr || ''}`;
    if (!/UNIQUE constraint failed/i.test(text)) throw err;
    const conflict = existingProviderSessionConflict(db, row, session, provider);
    return {
      peer: row.peer,
      provider,
      action: 'skipped',
      reason: 'provider_session_conflict',
      conflict_peer: conflict?.peer || null,
      provider_session: bindingProviderSessionValue(session)
    };
  }
  opts.addEvent(db, 'provider.session.backfilled', row.peer, null, {
    provider,
    provider_session: candidate.value,
    source: candidate.source,
    runtime_target: row.runtime_target || null
  });
  return {
    peer: row.peer,
    provider,
    action: 'backfilled',
    source: candidate.source,
    provider_session: candidate.value,
    runtime_target: row.runtime_target || null
  };
}

export function reconcileRunningPeerBindings(db, projectCtx = {}, options = {}) {
  const opts = {
    now: typeof options.now === 'function' ? options.now : defaultNow,
    addEvent: typeof options.addEvent === 'function' ? options.addEvent : noopEvent,
    inspectProcess: options.inspectProcess || null,
    latestProviderSessionForPeer: options.latestProviderSessionForPeer || null,
    panes: Array.isArray(options.panes) ? options.panes : []
  };
  const paneByTarget = new Map(opts.panes.filter((pane) => pane?.pane).map((pane) => [pane.pane, pane]));
  const paneByPid = new Map();
  for (const pane of opts.panes) {
    if (pane?.pid && !paneByPid.has(Number(pane.pid))) paneByPid.set(Number(pane.pid), pane);
  }

  const rows = db.prepare(`
    SELECT p.id AS peer, p.kind, p.status, p.worktree, p.pid, p.last_seen_at,
           b.provider, b.provider_session_id, b.provider_session_name,
           b.resume_mode, b.resume_arg, b.command, b.transport,
           b.runtime_session_id, b.runtime_target, b.updated_at
    FROM peer_bindings b
    JOIN peers p ON p.id = b.peer
    WHERE b.transport = 'tmux'
      AND b.runtime_target IS NOT NULL
      AND p.status IN ('running', 'working', 'busy')
    ORDER BY p.last_seen_at DESC, b.updated_at DESC
  `).all();

  const results = [];
  for (const row of rows) {
    if (bindingHasProviderSession(row)) {
      results.push({
        peer: row.peer,
        provider: row.provider,
        action: 'skipped',
        reason: 'provider_session_known',
        provider_session: bindingProviderSessionValue(row)
      });
      continue;
    }

    const pane = paneByTarget.get(row.runtime_target) || paneByPid.get(Number(row.pid));
    if (!pane) {
      results.push({ peer: row.peer, provider: row.provider, action: 'skipped', reason: 'no_live_tmux_pane' });
      continue;
    }
    if (!runtimePaneMatches(row, pane)) {
      results.push({ peer: row.peer, provider: row.provider, action: 'skipped', reason: 'runtime_target_mismatch' });
      continue;
    }
    if (!runtimePidMatches(row, pane) && !runtimeCwdMatches(projectCtx.root, row, pane)) {
      results.push({ peer: row.peer, provider: row.provider, action: 'skipped', reason: 'weak_runtime_evidence' });
      continue;
    }

    const candidate = tmuxEvidence(row, pane, opts);
    if (!candidate?.value) {
      results.push({ peer: row.peer, provider: row.provider, action: 'skipped', reason: 'no_strong_provider_evidence' });
      continue;
    }
    results.push(updatePeerProviderSession(db, row, candidate, opts));
  }
  return {
    checked: rows.length,
    backfilled: results.filter((result) => result.action === 'backfilled').length,
    results
  };
}
