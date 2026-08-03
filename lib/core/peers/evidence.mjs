import { compareProcessIdentity } from '../../process/identity.mjs';

const DEFAULT_ACTIVE_PEER_TTL = 600;

export function classifyPeerActivity(peer = {}, options = {}) {
  const activePeerTtl = Number(options.activePeerTtl ?? DEFAULT_ACTIVE_PEER_TTL);
  const graceActive = Boolean(options.graceActive);
  const evidenceState = peer.evidence_state || peer.evidence?.state || 'unknown';
  const age = Number(peer.age_sec);
  const active = evidenceState === 'live' ||
    (evidenceState !== 'dead' && (graceActive || (Number.isFinite(age) && age <= activePeerTtl)));
  return { active, stale: !active };
}

function processState(evidence) {
  if (!evidence || compareProcessIdentity(evidence.storedIdentity, evidence.storedIdentity) !== 'live') {
    return 'unknown';
  }
  if (evidence.current?.state === 'unknown') return 'unknown';
  if (evidence.current?.state === 'dead') return 'dead';
  if (evidence.current?.state !== 'live') return 'unknown';
  return compareProcessIdentity(evidence.storedIdentity, evidence.current.identity);
}

function aggregateProcesses(processes) {
  if (!Array.isArray(processes) || processes.length === 0) {
    return { state: 'unknown', reason: 'process_evidence_missing' };
  }
  const states = processes.map(processState);
  if (states.includes('live')) {
    return { state: 'live', reason: 'process_identity_match' };
  }
  if (states.every((state) => state === 'dead')) {
    const missing = processes.every((item) => item?.current?.state === 'dead');
    return {
      state: 'dead',
      reason: missing ? 'process_missing' : 'process_identity_mismatch'
    };
  }
  return { state: 'unknown', reason: 'process_identity_incomplete' };
}

function tmuxProcessState(tmux) {
  return processState(tmux?.process);
}

function tmuxConfirmedDead(tmux) {
  const exactSession = tmux?.session?.state === 'live' &&
    tmux?.session?.expected === tmux?.session?.actual;
  return tmux?.session?.state === 'dead' ||
    (exactSession && tmux?.pane?.state === 'dead');
}

function tmuxVerifiedLive(tmux) {
  return tmux?.session?.state === 'live' &&
    tmux?.session?.expected === tmux?.session?.actual &&
    tmux?.pane?.state === 'live' &&
    tmux?.pane?.expected === tmux?.pane?.actual &&
    tmux?.root?.state === 'match' &&
    tmuxProcessState(tmux) === 'live';
}

export function resolvePeerEvidence(input = {}) {
  if (input.peer?.status === 'exited') {
    return { state: 'dead', reason: 'explicit_exited' };
  }

  const ordinaryProcess = aggregateProcesses(input.processes);
  if (ordinaryProcess.state === 'live') return ordinaryProcess;

  const tmux = input.tmux?.managed ? input.tmux : null;
  if (!tmux) return ordinaryProcess;

  if (tmuxVerifiedLive(tmux)) {
    return { state: 'live', reason: 'tmux_identity_match' };
  }

  if (tmux.root?.state === 'mismatch') {
    return { state: 'unknown', reason: 'tmux_root_mismatch' };
  }
  const paneProcess = tmuxProcessState(tmux);
  if (tmuxConfirmedDead(tmux) && paneProcess === 'dead') {
    return { state: 'dead', reason: 'tmux_and_process_dead' };
  }
  return { state: 'unknown', reason: 'tmux_evidence_incomplete' };
}
