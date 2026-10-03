// Persist Web terminal detachment separately from process liveness. Existing
// audit events survive a runtime restart without changing the database schema.

function identityFor(value = {}) {
  const identity = value.adoptionIdentity || value.identity || value;
  const processIdentity = identity.process_identity || identity.processIdentity || {};
  return {
    pid: identity.pid || processIdentity.pid || value.pid || null,
    process_start_token: identity.process_start_token || processIdentity.startToken || null,
    tmux_session_created: identity.tmux_session_created || identity.session_created || null,
    tmux_session_id: identity.tmux_session_id || identity.session_id || null
  };
}

export function writeAdoptionState(db, session, paused, time) {
  const peer = session?.peerId || session?.peer || session?.id;
  if (typeof peer !== 'string' || !peer || typeof paused !== 'boolean' ||
      !Number.isSafeInteger(time) || time < 0) {
    throw new TypeError('Adoption state requires a peer, a boolean paused value, and an integer timestamp');
  }
  const payload = {
    peer,
    pane: session.pane || null,
    identity: identityFor(session),
    source: 'web',
    target_peer: peer,
    runtime_session_id: session.id || null
  };
  db.prepare(`
    INSERT INTO events(type, actor, task_id, payload, created_at)
    VALUES (?, 'web', NULL, ?, ?)
  `).run(paused ? 'web.adoption.paused' : 'web.adoption.resumed', JSON.stringify(payload), time);
  return { ...payload, paused };
}

export function adoptionPaused(db, { peer, pane = null, ...observed } = {}) {
  if (typeof peer !== 'string' || !peer) return false;
  const event = db.prepare(`
    SELECT type, payload FROM events
    WHERE type IN ('web.adoption.paused', 'web.adoption.resumed')
      AND json_valid(payload)
      AND json_extract(payload, '$.peer') = ?
      AND (? IS NULL OR json_extract(payload, '$.pane') = ? OR json_extract(payload, '$.pane') IS NULL)
    ORDER BY id DESC LIMIT 1
  `).get(peer, pane, pane);
  if (!event || event.type !== 'web.adoption.paused') return false;
  const stored = identityFor(JSON.parse(event.payload));
  const current = identityFor(observed);
  // Known identity changes mean a different live terminal. An unavailable
  // observation cannot silently revoke an intentional pause.
  for (const key of Object.keys(stored)) {
    if (stored[key] !== null && current[key] !== null && String(stored[key]) !== String(current[key])) return false;
  }
  return true;
}
