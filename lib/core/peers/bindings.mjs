import { providerSessionParts } from './session.mjs';

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
