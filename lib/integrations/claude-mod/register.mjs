// Generated plugins replace this constant with one session-scoped HCC capability.
// Official contract: https://code.claude.com/docs/en/plugins/mods/api
// Exact event fields: https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts
// No Node imports, credentials, permission changes, other-session sends or transcript reads.
const HCC_CONFIG = null;

const config = HCC_CONFIG;
let alive = false, busy = false, ticking = false, connectionId = null, pending = null;
let timer = null, instanceId = '', eventSequence = 0;
const outbox = [];
const observed = new Set();

function event(type, request, details = {}) {
  outbox.push({ eventId: `${instanceId}:${++eventSequence}`, requestId: request.requestId, type, ...details });
}
async function identity($) {
  return await $.session.id() === config.sessionId && await $.session.cwd() === config.cwd;
}
async function post($, route, body) {
  const response = await $.http.fetch(config.endpoint + route, { method: 'POST',
    headers: { Authorization: `Bearer ${config.secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: config.sessionId, cwd: config.cwd, ...body }) });
  const value = JSON.parse(response.text);
  if (!response.ok) throw new Error(value.error?.code || 'CLAUDE_APP_HTTP_ERROR');
  return value;
}
async function flush($) {
  while (outbox.length && alive && connectionId) {
    await post($, '/event', { connectionId, ...outbox[0] });
    outbox.shift();
  }
}
async function tick($) {
  if (!alive || ticking) return;
  ticking = true;
  try {
    if (!await identity($)) { await stop($, 'CLAUDE_APP_IDENTITY_CHANGED'); return; }
    if (!connectionId) {
      const version = await $.session.version();
      const surfaces = await $.session.surfaces();
      const response = await post($, '/connect', { version: version.version, surfaces, instanceId });
      if (!alive) return;
      connectionId = response.connectionId;
    }
    await flush($);
    if (!alive) return;
    // Poll even while busy, so an approval dialog does not expire the lease.
    const response = await post($, '/poll', { connectionId });
    if (!alive || !await identity($)) return;
    if (busy || pending?.invoking) return;
    if (!pending) {
      if (!response.request) return;
      const request = response.request;
      if (observed.has(request.requestId)) return; // never replay after an ambiguous receipt
      observed.add(request.requestId);
      pending = { ...request, turnId: null, invoking: false };
      event('accepted', pending);
    }
    await flush($); // retry a lost receipt, never the actual model submission
    if (!alive || !await identity($)) return;
    const owned = pending;
    owned.invoking = true;
    // Do not await in the timer or a running turn. This call waits until idle.
    // Keep the plugin's attribution; never use asUser or modify permission state.
    Promise.resolve().then(() => $.prompt.submit({ text: owned.prompt })).then(result => {
      if (!alive || pending !== owned) return;
      if (result?.drop) { event('rejected', owned, { reason: String(result.drop).slice(0,500) }); pending = null; }
      else if (!owned.turnId && typeof result?.text === 'string' && result.text !== owned.prompt) {
        event('uncertain', owned, { reason: 'prompt_changed_by_another_hook' }); pending = null;
      }
      // Resolution alone is NOT evidence the model saw it. turn.start binds it.
    }).catch(() => {
      if (!alive || pending !== owned) return;
      event('uncertain', owned, { reason: 'prompt_submit_failed' }); pending = null;
    });
  } catch (error) {
    // A replacement/revocation is final. Transient I/O retains the outbox.
    if (['CLAUDE_APP_CONNECTION_STALE', 'CLAUDE_APP_IDENTITY_MISMATCH', 'PROJECT_PATH_CHANGED'].includes(error?.message)) {
      await stop($, error.message);
    }
  }
  finally { ticking = false; }
}
async function stop($, reason) {
  alive = false;
  timer?.cancel(); timer = null;
  const old = connectionId; connectionId = null; pending = null;
  if (old) { try { await post($, '/disconnect', { connectionId: old, reason }); } catch {} }
}
export function register(on) {
  if (!config) return;
  on('session.start', async ($, e, next) => {
    try {
      if (!await identity($)) return next(e);
      instanceId = `mod-${await $.clock.now()}-${Math.random().toString(36).slice(2)}`;
      alive = true;
      timer = $.clock.every(config.pollMs, () => { void tick($); });
      void tick($);
    } catch { /* a missing/denied Mod API must not interfere with the session */ }
    return next(e);
  });
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'plugin' && e.origin.name === 'hcc-session-link') {
      if (!alive || !pending?.invoking || e.text !== pending.prompt || !await identity($)) {
        return { drop: 'hello-cc connection or session identity changed' };
      }
    }
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    try {
      if (alive && !e.agentId) {
        busy = true;
        if (pending?.invoking && e.text === pending.prompt && await identity($)) {
          pending.turnId = e.turnId;
          event('started', pending, { turnId: e.turnId });
        }
      }
    } catch { /* observation failure cannot rewrite or stop the original turn */ }
    return next(e);
  });
  on('turn.complete', async ($, e, next) => {
    try {
      if (!e.agentId) {
        busy = false;
        if (alive && pending?.turnId === e.turnId) {
          if (await identity($)) {
            const type = e.isAborted || e.reason === 'aborted' ? 'aborted' : e.reason === 'answer' ? 'completed' : 'uncertain';
            event(type, pending, { turnId: e.turnId, answer: String(e.answer || '').slice(0,100000), reason: e.reason || 'unknown_turn_result' });
          }
          pending = null;
        }
      }
    } catch { /* original completion always continues */ }
    return next(e);
  });
  on('session.end', async ($, e, next) => {
    try { await stop($, e.reason || 'session_ended'); }
    finally { return next(e); }
  });
}
