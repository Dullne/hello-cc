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

export function peerEvidenceAllowsReap(evidence = {}, options = {}) {
  if (evidence.state === 'dead') return true;
  if (evidence.state !== 'unknown') return false;
  const nowSec = Number(options.nowSec);
  const lastSeenAt = Number(options.lastSeenAt);
  const staleAfterSec = Number(options.staleAfterSec);
  const graceUntil = Number(options.graceUntil ?? 0);
  if (![nowSec, lastSeenAt, staleAfterSec, graceUntil].every((value) =>
    Number.isSafeInteger(value) && value >= 0)) return false;
  return nowSec - lastSeenAt >= staleAfterSec && nowSec >= graceUntil;
}

function processState(evidence) {
  if (!evidence) return 'unknown';
  if (compareProcessIdentity(evidence.storedIdentity, evidence.storedIdentity) !== 'live') {
    // CS-06: no usable stored fingerprint (legacy row without pid_start_token /
    // pid_command_hash, or a missing pid). We cannot claim ownership — but a
    // process that is demonstrably gone is still a dead process, so such peers
    // are reaped once their process exits. A live-but-unverifiable process
    // stays 'unknown' (protected).
    return evidence.current?.state === 'dead' ? 'dead' : 'unknown';
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
  const ordinaryProcess = aggregateProcesses(input.processes);
  if (ordinaryProcess.state === 'live') return ordinaryProcess;

  const tmux = input.tmux?.managed ? input.tmux : null;
  if (ordinaryProcess.state === 'unknown' && tmux && tmuxVerifiedLive(tmux)) {
    return { state: 'live', reason: 'tmux_identity_match' };
  }

  if (input.peer?.status === 'exited') {
    return { state: 'dead', reason: 'explicit_exited' };
  }
  if (ordinaryProcess.state === 'dead' || !tmux) return ordinaryProcess;

  if (tmux.root?.state === 'mismatch') {
    return { state: 'unknown', reason: 'tmux_root_mismatch' };
  }
  const paneProcess = tmuxProcessState(tmux);
  if (tmuxConfirmedDead(tmux) && paneProcess === 'dead') {
    return { state: 'dead', reason: 'tmux_and_process_dead' };
  }
  return { state: 'unknown', reason: 'tmux_evidence_incomplete' };
}
