import { sanitizePeerPart, shortHash } from './format.mjs';
import { providerSessionPeerId } from './session.mjs';

export { sanitizePeerPart, shortHash } from './format.mjs';

export function autoPeerProviderSession(_kind, observation = {}) {
  return {
    sessionId: observation.sessionId || '',
    resumeId: observation.resumeId || null,
    ancestor: observation.ancestor || null
  };
}

export function autoPeerSessionId(kind, observation = {}) {
  return autoPeerProviderSession(kind, observation).sessionId;
}

export function autoPeerResumeId(kind, observation = {}) {
  return autoPeerProviderSession(kind, observation).resumeId;
}

export function autoPeerKind(kindHint = 'shell', observation = {}) {
  return observation.kind || kindHint || 'shell';
}

export function autoPeerBasis(kind = null, observation = {}) {
  if (observation.basis) return observation.basis;
  const ancestor = observation.ancestor || null;
  if (ancestor && (!kind || ancestor.kind === kind)) return `cli:${ancestor.kind}:${ancestor.pid}`;
  if (observation.tmuxPane) return `tmux:${observation.tmuxPane}`;
  if (observation.tty) return `tty:${observation.tty}`;
  return `ppid:${observation.ppid ?? 0}`;
}

export function autoPeerId(ctx, kindHint = 'shell', observation = {}) {
  const kind = autoPeerKind(kindHint, observation);
  const { sessionId, resumeId } = autoPeerProviderSession(kind, observation);
  const providerId = resumeId || sessionId;
  if (providerId) return providerSessionPeerId(kind, providerId);

  const basis = autoPeerBasis(kind, observation);
  return `${kind}-${shortHash(`${ctx.root}:${basis}`)}`;
}

export function resolveCurrentPeer(ctx, opts = {}, key = 'peer', kindHint = 'shell', observation = {}) {
  const explicit = opts[key] || '';
  const envPeer = observation.env?.HCC_PEER || '';
  if (envPeer) {
    return {
      id: envPeer,
      auto: false,
      corrected_from: explicit && explicit !== envPeer ? explicit : null
    };
  }
  if (explicit) return { id: explicit, auto: false, corrected_from: null };
  return { id: autoPeerId(ctx, kindHint, observation), auto: true };
}

export function currentPeer(ctx, opts = {}, key = 'peer', kindHint = 'shell', observation = {}) {
  return resolveCurrentPeer(ctx, opts, key, kindHint, observation).id;
}
