// Structured workers retain their peer and provider-session identity even when
// disconnected. Terminal requests may inspect these identities only to refuse
// a conflicting launch; a claimed binding never authorizes taking ownership.
export function hasStructuredSessionOwner(db, peer, binding = null, kind = null) {
  return Boolean(db.prepare(`SELECT 1 FROM peer_bindings
    WHERE transport IN ('native', 'app-server') AND
      (peer = ? OR (provider = ? AND
        ((? IS NOT NULL AND provider_session_id = ?) OR
         (? IS NOT NULL AND provider_session_name = ?)))) LIMIT 1`)
    .get(peer, binding?.provider || kind || null,
      binding?.provider_session_id || null, binding?.provider_session_id || null,
      binding?.provider_session_name || null, binding?.provider_session_name || null));
}
