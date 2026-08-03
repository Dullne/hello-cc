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

const KILL_OK = 'HCC_CONDITIONAL_KILL_OK';
const KILL_MISMATCH = 'HCC_CONDITIONAL_KILL_MISMATCH';

function conditionalFields(stored) {
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
    throw new CliError('TMUX_CONDITIONAL_KILL_MISMATCH', 'Stored tmux conditional-kill identity is incomplete or invalid');
  }
  return fields;
}

export function conditionalTmuxKill(runTmux, stored, options = {}) {
  if (typeof runTmux !== 'function') throw new TypeError('runTmux must be a function');
  const fields = conditionalFields(stored);
  if (typeof options.beforeConditional === 'function') options.beforeConditional();
  const identityCondition = `#{&&:#{==:#{session_name},${fields.session}},#{&&:#{==:#{session_created},${fields.sessionCreated}},#{&&:#{==:#{session_id},${fields.sessionId}},#{&&:#{==:#{pane_id},${fields.pane}},#{==:#{pane_pid},${fields.panePid}}}}}}`;
  const processCondition = options.requireDeadPane
    ? `#{&&:${identityCondition},#{==:#{pane_dead},1}}`
    : identityCondition;
  const condition = options.allowClients
    ? processCondition
    : `#{&&:${processCondition},#{==:#{session_attached},0}}`;
  const successCommand = `display-message -p ${KILL_OK} ; kill-session -t ${fields.sessionId}`;
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
