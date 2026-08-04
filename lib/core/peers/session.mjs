import { shortHash } from './format.mjs';

// sess-04: derive the peer id from a sha1 hash of the FULL provider session
// id/name, not the first 8 raw chars — name-based ids that share a prefix
// (e.g. codex `feature-login` vs `feature-logout`) used to collide into the
// same peer id. The shim script derives the identical value (see
// lib/integrations/shims/script.mjs peer_hash). NOTE: this changes existing
// peer ids for name-based resumes (pre-1.0 intentional identity change).
export function providerSessionPeerId(kind, providerId) {
  return `${kind}-${shortHash(String(providerId || ''))}`;
}

export function providerSessionParts(value) {
  if (!value) return { provider_session_id: null, provider_session_name: null };
  const text = String(value);
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
  return uuidLike
    ? { provider_session_id: text, provider_session_name: null }
    : { provider_session_id: null, provider_session_name: text };
}
