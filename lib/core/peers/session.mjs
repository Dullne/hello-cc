import { sanitizePeerPart, shortHash } from './format.mjs';

export function providerSessionPeerId(kind, providerId) {
  return `${kind}-${sanitizePeerPart(String(providerId || '').slice(0, 8), shortHash(providerId))}`;
}

export function providerSessionParts(value) {
  if (!value) return { provider_session_id: null, provider_session_name: null };
  const text = String(value);
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
  return uuidLike
    ? { provider_session_id: text, provider_session_name: null }
    : { provider_session_id: null, provider_session_name: text };
}
