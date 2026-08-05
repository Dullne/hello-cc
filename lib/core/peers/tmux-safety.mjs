import { compareProcessIdentity } from '../../process/identity.mjs';
import { tx } from '../../db/schema.mjs';
import { CliError } from '../../shared/errors.mjs';

function completeIdentity(identity) {
  return Boolean(
    identity &&
    Number.isInteger(Number(identity.pid)) &&
    Number(identity.pid) > 0 &&
    identity.startToken &&
    /^[a-f0-9]{64}$/i.test(String(identity.commandHash || ''))
  );
}

export function validateTmuxDestructiveEvidence(stored = {}, observed = {}, options = {}) {
  const authority = validateTmuxAuthorityEvidence(stored, observed);
  if (!authority.ok) return authority;
  if (!completeIdentity(observed.process_identity) ||
      compareProcessIdentity(stored.process_identity, observed.process_identity) !== 'live') {
    return { ok: false, reason: 'tmux_process_changed' };
  }
  return validateTmuxClients(observed, options);
}

function validateTmuxAuthorityEvidence(stored, observed) {
  if (!stored.session || !stored.session_created || !stored.session_id || !stored.root || !stored.pane || !completeIdentity(stored.process_identity)) {
    return { ok: false, reason: 'tmux_stored_evidence_incomplete' };
  }
  if (!observed.session || observed.session !== stored.session) {
    return { ok: false, reason: 'tmux_session_changed' };
  }
  if (!observed.session_created || observed.session_created !== stored.session_created) {
    return { ok: false, reason: 'tmux_session_reused' };
  }
  if (!observed.session_id || observed.session_id !== stored.session_id) {
    return { ok: false, reason: 'tmux_session_id_changed' };
  }
  if (!observed.root) return { ok: false, reason: 'tmux_root_unknown' };
  if (observed.root !== stored.root) return { ok: false, reason: 'tmux_root_changed' };
  if (!observed.pane || observed.pane !== stored.pane) {
    return { ok: false, reason: 'tmux_pane_changed' };
  }
  return { ok: true };
}

function validateTmuxClients(observed, options) {
  if (observed.clients?.state !== 'known') {
    return { ok: false, reason: 'tmux_clients_unknown' };
  }
  if (!options.allowClients && Number(observed.clients.count || 0) > 0) {
    return { ok: false, reason: 'tmux_has_clients' };
  }
  return { ok: true };
}

export function validateTmuxGcDeadProcessEvidence(stored = {}, observed = {}, options = {}) {
  const authority = validateTmuxAuthorityEvidence(stored, observed);
  if (!authority.ok) return authority;
  if (!observed.pane_dead) return { ok: false, reason: 'tmux_pane_not_dead' };
  if (Number(observed.pane_pid) !== Number(stored.process_identity.pid)) {
    return { ok: false, reason: 'tmux_dead_process_pid_changed' };
  }
  if (observed.process_inspection?.state !== 'dead' || observed.process_inspection.identity !== null) {
    return { ok: false, reason: 'tmux_process_not_confirmed_dead' };
  }
  return validateTmuxClients(observed, options);
}

export function validateTmuxGcBindingEvidence(subject = {}, observed = {}, options = {}) {
  const authority = subject.authority;
  if (!subject.peer || subject.transport !== 'tmux' || !subject.runtime_target ||
      !subject.expected_session || !subject.expected_root || !authority) {
    return { ok: false, reason: 'tmux_binding_subject_incomplete' };
  }
  if (authority.session !== subject.expected_session) {
    return { ok: false, reason: 'tmux_binding_session_authority_changed' };
  }
  if (authority.root !== subject.expected_root) {
    return { ok: false, reason: 'tmux_binding_root_authority_changed' };
  }
  if (authority.pane !== subject.runtime_target) {
    return { ok: false, reason: 'tmux_binding_pane_authority_changed' };
  }
  if (subject.owner_evidence?.state === 'live') {
    return { ok: false, reason: 'tmux_owner_process_live' };
  }

  const dead = validateTmuxGcDeadProcessEvidence(authority, observed, options);
  if (dead.ok) return { ok: true, mode: 'dead_process' };
  if (subject.status !== 'exited') return dead;

  const live = validateTmuxDestructiveEvidence(authority, observed, options);
  return live.ok ? { ok: true, mode: 'explicit_exit_live' } : live;
}

export function finalizeTmuxGcBindingMutation(options = {}) {
  const {
    db,
    plannedSubject,
    readSubject,
    sameSubject,
    conditionalKill,
    casBinding,
    updatePeer,
    beforeBegin
  } = options;
  for (const [name, fn] of Object.entries({ readSubject, sameSubject, conditionalKill, casBinding, updatePeer })) {
    if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (!db) throw new TypeError('db is required');
  if (typeof beforeBegin === 'function') beforeBegin();

  return tx(db, () => {
    const currentSubject = readSubject();
    if (!sameSubject(plannedSubject, currentSubject)) {
      throw new CliError('TMUX_GC_BINDING_SUBJECT_CHANGED',
        'tmux GC binding subject changed before final mutation');
    }
    conditionalKill();
    const bindingResult = casBinding(currentSubject);
    if (Number(bindingResult?.changes) !== 1) {
      throw new CliError('TMUX_GC_BINDING_CAS_FAILED',
        'tmux GC binding compare-and-swap did not update exactly one row');
    }
    updatePeer(currentSubject);
    return currentSubject;
  });
}

export function prepareTmuxRestartBinding(db, {
  peer,
  runtimeTarget,
  nowSec
} = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required');
  if (typeof peer !== 'string' || !peer) throw new TypeError('peer is required');
  if (typeof runtimeTarget !== 'string' || !runtimeTarget) {
    throw new TypeError('runtimeTarget is required');
  }
  if (!Number.isSafeInteger(nowSec) || nowSec < 0) {
    throw new TypeError('nowSec must be a non-negative safe integer');
  }
  const row = db.prepare(`
    SELECT transport, runtime_target, updated_at
    FROM peer_bindings
    WHERE peer = ?
  `).get(peer);
  if (!row) return { ok: false, reason: 'tmux_binding_missing' };
  if (row.transport !== 'tmux') return { ok: false, reason: 'tmux_binding_transport_changed' };
  if (row.runtime_target === runtimeTarget) return { ok: true, restored: false };
  if (row.runtime_target !== null) return { ok: false, reason: 'tmux_binding_target_changed' };

  const previousUpdatedAt = Number(row.updated_at);
  if (!Number.isSafeInteger(previousUpdatedAt) || previousUpdatedAt < 0) {
    return { ok: false, reason: 'tmux_binding_timestamp_invalid' };
  }
  const preparedUpdatedAt = Math.max(nowSec, previousUpdatedAt + 1);
  if (!Number.isSafeInteger(preparedUpdatedAt)) {
    return { ok: false, reason: 'tmux_binding_timestamp_invalid' };
  }
  const updated = db.prepare(`
    UPDATE peer_bindings
    SET runtime_target = ?, updated_at = ?
    WHERE peer = ? AND transport = 'tmux' AND runtime_target IS NULL
      AND updated_at IS ?
  `).run(runtimeTarget, preparedUpdatedAt, peer, previousUpdatedAt);
  if (Number(updated.changes) !== 1) {
    return { ok: false, reason: 'tmux_binding_subject_changed' };
  }
  return {
    ok: true,
    restored: true,
    peer,
    runtimeTarget,
    previousUpdatedAt,
    preparedUpdatedAt
  };
}

export function rollbackTmuxRestartBinding(db, preparation) {
  if (!preparation?.restored) return true;
  const updated = db.prepare(`
    UPDATE peer_bindings
    SET runtime_target = NULL, updated_at = ?
    WHERE peer = ? AND transport = 'tmux' AND runtime_target = ?
      AND updated_at = ?
  `).run(
    preparation.previousUpdatedAt,
    preparation.peer,
    preparation.runtimeTarget,
    preparation.preparedUpdatedAt
  );
  return Number(updated.changes) === 1;
}

const KILL_OK = 'HCC_CONDITIONAL_KILL_OK';
const KILL_MISMATCH = 'HCC_CONDITIONAL_KILL_MISMATCH';
const RENAME_OK = 'HCC_CONDITIONAL_RENAME_OK';
const RENAME_MISMATCH = 'HCC_CONDITIONAL_RENAME_MISMATCH';

function conditionalFields(stored, {
  code = 'TMUX_CONDITIONAL_KILL_MISMATCH',
  operation = 'conditional-kill'
} = {}) {
  const fields = {
    session: String(stored?.session || ''),
    sessionCreated: String(stored?.session_created || ''),
    sessionId: String(stored?.session_id || ''),
    pane: String(stored?.pane || ''),
    panePid: String(stored?.process_identity?.pid || '')
  };
  if (!/^[a-zA-Z0-9_.-]+$/.test(fields.session) ||
      !/^\d+$/.test(fields.sessionCreated) ||
      !/^\$\d+$/.test(fields.sessionId) ||
      !/^%\d+$/.test(fields.pane) ||
      !/^\d+$/.test(fields.panePid)) {
    throw new CliError(code, `Stored tmux ${operation} identity is incomplete or invalid`);
  }
  return fields;
}

function tmuxIdentityCondition(fields) {
  return `#{&&:#{==:#{session_name},${fields.session}},#{&&:#{==:#{session_created},${fields.sessionCreated}},#{&&:#{==:#{session_id},${fields.sessionId}},#{&&:#{==:#{pane_id},${fields.pane}},#{==:#{pane_pid},${fields.panePid}}}}}}`;
}

export function conditionalTmuxKill(runTmux, stored, options = {}) {
  if (typeof runTmux !== 'function') throw new TypeError('runTmux must be a function');
  const fields = conditionalFields(stored);
  if (typeof options.beforeConditional === 'function') options.beforeConditional();
  const identityCondition = tmuxIdentityCondition(fields);
  const processCondition = options.requireDeadPane
    ? `#{&&:${identityCondition},#{==:#{pane_dead},1}}`
    : identityCondition;
  const condition = options.allowClients
    ? processCondition
    : `#{&&:${processCondition},#{==:#{session_attached},0}}`;
  const successCommand = `display-message -p ${KILL_OK} ; kill-session -t '${fields.sessionId}'`;
  let output = '';
  try {
    output = runTmux([
      'if-shell', '-F', '-t', fields.session,
      condition,
      successCommand,
      `display-message -p ${KILL_MISMATCH}`
    ]);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('TMUX_ERROR',
      `Conditional tmux kill command failed: ${error?.message || error}`);
  }
  if (!String(output).split('\n').includes(KILL_OK)) {
    throw new CliError('TMUX_CONDITIONAL_KILL_MISMATCH', 'Conditional tmux kill target changed before execution');
  }
  return { killed: true };
}

export function conditionalTmuxRename(runTmux, stored, newName, options = {}) {
  if (typeof runTmux !== 'function') throw new TypeError('runTmux must be a function');
  const fields = conditionalFields(stored, {
    code: 'TMUX_CONDITIONAL_RENAME_MISMATCH',
    operation: 'conditional-rename'
  });
  const targetName = String(newName || '');
  if (!/^[a-zA-Z0-9_.-]+$/.test(targetName) || targetName === fields.session) {
    throw new CliError('TMUX_CONDITIONAL_RENAME_MISMATCH', 'Replacement tmux session name is incomplete or invalid');
  }
  if (typeof options.beforeConditional === 'function') options.beforeConditional();
  const identityCondition = tmuxIdentityCondition(fields);
  const condition = options.allowClients
    ? identityCondition
    : `#{&&:${identityCondition},#{==:#{session_attached},0}}`;
  const successCommand = `display-message -p ${RENAME_OK} ; rename-session -t '${fields.sessionId}' ${targetName}`;
  let output = '';
  try {
    output = runTmux([
      'if-shell', '-F', '-t', fields.session,
      condition,
      successCommand,
      `display-message -p ${RENAME_MISMATCH}`
    ]);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('TMUX_ERROR',
      `Conditional tmux rename command failed: ${error?.message || error}`);
  }
  if (!String(output).split('\n').includes(RENAME_OK)) {
    throw new CliError('TMUX_CONDITIONAL_RENAME_MISMATCH', 'Conditional tmux rename target changed before execution');
  }
  return { renamed: true, session: targetName };
}
