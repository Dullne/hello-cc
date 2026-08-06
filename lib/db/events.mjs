// Shared DB event/audit helpers extracted from bin/hcc.mjs.
// These are pure functions with a single dependency (now()) that callers
// inject, so they can be reused by CLI commands, web routes, and tests.

function defaultNow() {
  return Math.floor(Date.now() / 1000);
}

export function createEventHelpers({ now = defaultNow } = {}) {
  function addEvent(db, type, actor, taskId, payload) {
    db.prepare(`
      INSERT INTO events(type, actor, task_id, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(type, actor || null, taskId || null, JSON.stringify(payload || {}), now());
  }

  function auditPayload({ actor = null, target = null, source = 'cli', admin = false, ...extra } = {}) {
    const payload = { ...extra, source };
    if (actor) payload.actor_peer = actor;
    if (target) payload.target_peer = target;
    if (admin) payload.admin = true;
    return payload;
  }

  function requestActorPeer(input = {}, fallback = 'web') {
    return String(input.auditActorPeer || fallback || 'web').trim() || 'web';
  }

  function requestSource(input = {}, fallback = 'web') {
    return String(input.auditSource || fallback || 'web').trim() || fallback;
  }

  return { addEvent, auditPayload, requestActorPeer, requestSource };
}
