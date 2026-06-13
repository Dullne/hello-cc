import { CliError } from './errors.mjs';
import { providerSessionParts } from './provider-commands.mjs';

function defaultNow() {
  return Math.floor(Date.now() / 1000);
}

function noopEvent() {}

export function bindingFromDetected(peer, transport = 'detected') {
  const provider = peer.kind || 'other';
  const session = providerSessionParts(peer.resumeId || peer.sessionId || '');
  return {
    peer: peer.peerId || peer.id,
    provider,
    ...session,
    resume_mode: peer.resumeId ? 'resume' : (peer.sessionId ? 'detected' : 'unknown'),
    resume_arg: peer.resumeId || null,
    command: peer.command || null,
    transport,
    runtime_session_id: peer.peerId || peer.id
  };
}

export function peerBindingRuntimeRank(row) {
  if (row?.runtime_target && row.transport === 'tmux') return 50;
  if (row?.runtime_target) return 40;
  if (['tmux', 'web-pty'].includes(row?.transport)) return 30;
  if (row?.transport === 'hcc-run') return 20;
  if (row?.transport === 'hook') return 10;
  if (row?.transport === 'detected') return 5;
  return 0;
}

export function comparePeerBindings(a, b) {
  return peerBindingRuntimeRank(b) - peerBindingRuntimeRank(a) ||
    Number(b.updated_at || 0) - Number(a.updated_at || 0) ||
    Number(b.created_at || 0) - Number(a.created_at || 0) ||
    String(a.peer || '').localeCompare(String(b.peer || ''));
}

export function bindingHasProviderSession(binding) {
  return Boolean(binding?.provider_session_id || binding?.provider_session_name);
}

export function bindingProviderSessionValue(binding) {
  return binding?.provider_session_id || binding?.provider_session_name || null;
}

export function bindingHasRuntime(binding) {
  return Boolean(binding?.runtime_target) || ['tmux', 'web-pty'].includes(binding?.transport);
}

export function mergeRuntimeBinding(existing, binding) {
  if (!existing || !bindingHasRuntime(existing) || bindingHasRuntime(binding)) return binding;
  return {
    ...binding,
    command: existing.command || binding.command || null,
    transport: existing.transport,
    runtime_session_id: existing.runtime_session_id || binding.runtime_session_id || binding.peer,
    runtime_target: existing.runtime_target || null
  };
}

export function createPeerBindingStore(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : defaultNow;
  const addEvent = typeof deps.addEvent === 'function' ? deps.addEvent : noopEvent;

  function dedupePeerBindingRows(db, rows, eventType, payload = {}) {
    if (!rows || rows.length < 2) return 0;
    const ordered = [...rows].sort(comparePeerBindings);
    const survivor = ordered[0];
    let deleted = 0;
    for (const row of ordered.slice(1)) {
      db.prepare('DELETE FROM peer_bindings WHERE peer = ?').run(row.peer);
      deleted += 1;
      addEvent(db, eventType, survivor.peer, null, {
        ...payload,
        kept_peer: survivor.peer,
        removed_peer: row.peer,
        removed_transport: row.transport || null,
        removed_runtime_target: row.runtime_target || null
      });
    }
    return deleted;
  }

  function dedupeProviderSessionColumn(db, column) {
    const groups = db.prepare(`
      SELECT provider, ${column} AS session_value
      FROM peer_bindings
      WHERE ${column} IS NOT NULL
      GROUP BY provider, ${column}
      HAVING COUNT(*) > 1
    `).all();
    let deleted = 0;
    for (const group of groups) {
      const rows = db.prepare(`
        SELECT *
        FROM peer_bindings
        WHERE provider = ? AND ${column} = ?
      `).all(group.provider, group.session_value);
      deleted += dedupePeerBindingRows(db, rows, 'provider.session.deduped', {
        provider: group.provider,
        provider_session: group.session_value,
        provider_session_column: column
      });
    }
    return deleted;
  }

  function dedupeRuntimeTargets(db) {
    const groups = db.prepare(`
      SELECT runtime_target
      FROM peer_bindings
      WHERE runtime_target IS NOT NULL
      GROUP BY runtime_target
      HAVING COUNT(*) > 1
    `).all();
    let deleted = 0;
    for (const group of groups) {
      const rows = db.prepare(`
        SELECT *
        FROM peer_bindings
        WHERE runtime_target = ?
      `).all(group.runtime_target);
      deleted += dedupePeerBindingRows(db, rows, 'runtime.target.deduped', {
        runtime_target: group.runtime_target
      });
    }
    return deleted;
  }

  function dedupePeerBindings(db) {
    for (let i = 0; i < 5; i += 1) {
      const deleted =
        dedupeProviderSessionColumn(db, 'provider_session_id') +
        dedupeProviderSessionColumn(db, 'provider_session_name') +
        dedupeRuntimeTargets(db);
      if (!deleted) return;
    }
  }

  function findProviderSessionBinding(db, binding) {
    if (!bindingHasProviderSession(binding)) return null;
    return db.prepare(`
      SELECT *
      FROM peer_bindings
      WHERE provider = ?
        AND peer <> ?
        AND (
          (? IS NOT NULL AND provider_session_id = ?)
          OR (? IS NOT NULL AND provider_session_name = ?)
        )
      LIMIT 1
    `).get(
      binding.provider,
      binding.peer,
      binding.provider_session_id || null,
      binding.provider_session_id || null,
      binding.provider_session_name || null,
      binding.provider_session_name || null
    ) || null;
  }

  function canonicalizePeerBinding(db, binding, options = {}) {
    const existing = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(binding.peer);
    let next = mergeRuntimeBinding(existing, binding);
    const conflict = findProviderSessionBinding(db, next);
    if (!conflict) return { peer: next.peer, binding: next, merged_from: null };

    const incomingRuntime = bindingHasRuntime(next);
    const conflictRuntime = bindingHasRuntime(conflict);
    const providerSession = bindingProviderSessionValue(next);
    const override = Boolean(options.override);

    if (override && incomingRuntime) {
      db.prepare('DELETE FROM peer_bindings WHERE peer = ?').run(conflict.peer);
      return { peer: next.peer, binding: next, merged_from: conflict.peer };
    }

    if (conflictRuntime && !incomingRuntime) {
      next = mergeRuntimeBinding(conflict, { ...next, peer: conflict.peer });
      return { peer: conflict.peer, binding: next, merged_from: binding.peer };
    }

    if (!conflictRuntime && incomingRuntime) {
      db.prepare('DELETE FROM peer_bindings WHERE peer = ?').run(conflict.peer);
      return { peer: next.peer, binding: next, merged_from: conflict.peer };
    }

    if (!conflictRuntime && !incomingRuntime) {
      next = {
        ...next,
        peer: conflict.peer,
        command: conflict.command || next.command || null,
        runtime_session_id: conflict.runtime_session_id || next.runtime_session_id || conflict.peer
      };
      return { peer: conflict.peer, binding: next, merged_from: binding.peer };
    }

    if (conflict.runtime_target && next.runtime_target && conflict.runtime_target === next.runtime_target) {
      next = mergeRuntimeBinding(conflict, { ...next, peer: conflict.peer });
      return { peer: conflict.peer, binding: next, merged_from: binding.peer };
    }

    throw new CliError('PROVIDER_SESSION_IN_USE', `${next.provider} session ${providerSession} is already bound to ${conflict.peer}`, {
      peer: conflict.peer,
      provider: conflict.provider,
      provider_session: providerSession,
      runtime_target: conflict.runtime_target || null
    });
  }

  function upsertPeerBinding(db, binding, force = false) {
    const t = now();
    const existing = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(binding.peer);
    binding = mergeRuntimeBinding(existing, binding);
    if ((binding.provider_session_id || binding.provider_session_name) && !force) {
      const conflict = findProviderSessionBinding(db, binding);
      if (conflict) {
        const providerSession = bindingProviderSessionValue(conflict);
        throw new CliError('PROVIDER_SESSION_IN_USE', `${binding.provider} session ${providerSession} is already bound to ${conflict.peer}`, {
          peer: conflict.peer,
          provider: conflict.provider,
          provider_session: providerSession
        });
      }
    }
    db.prepare(`
      INSERT INTO peer_bindings(
        peer, provider, provider_session_id, provider_session_name, resume_mode,
        resume_arg, command, transport, runtime_session_id, runtime_target, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(peer) DO UPDATE SET
        provider = excluded.provider,
        provider_session_id = excluded.provider_session_id,
        provider_session_name = excluded.provider_session_name,
        resume_mode = excluded.resume_mode,
        resume_arg = excluded.resume_arg,
        command = excluded.command,
        transport = excluded.transport,
        runtime_session_id = excluded.runtime_session_id,
        runtime_target = excluded.runtime_target,
        updated_at = excluded.updated_at
    `).run(
      binding.peer,
      binding.provider,
      binding.provider_session_id || null,
      binding.provider_session_name || null,
      binding.resume_mode || 'new',
      binding.resume_arg || null,
      binding.command || null,
      binding.transport,
      binding.runtime_session_id || binding.peer,
      binding.runtime_target || null,
      t,
      t
    );
  }

  function upsertCanonicalPeerBinding(db, binding, force = false, options = {}) {
    const result = canonicalizePeerBinding(db, binding, options);
    upsertPeerBinding(db, result.binding, force);
    return result;
  }

  return {
    canonicalizePeerBinding,
    dedupePeerBindings,
    dedupePeerBindingRows,
    dedupeProviderSessionColumn,
    dedupeRuntimeTargets,
    findProviderSessionBinding,
    upsertCanonicalPeerBinding,
    upsertPeerBinding
  };
}
