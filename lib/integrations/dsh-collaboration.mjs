import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { CliError } from '../shared/errors.mjs';
import { redactSecrets } from '../shared/redact.mjs';
import { tx } from '../db/schema.mjs';
import { createConnectionHelpers } from '../db/connection.mjs';
import { createEventHelpers } from '../db/events.mjs';
import { createPeerBindingStore } from '../db/stores/peers.mjs';
import { createPeerHelpers } from '../core/peers/peer-helpers.mjs';
import { providerSessionPeerId } from '../core/peers/session.mjs';
import { createMessageStore } from '../core/coordination/messages.mjs';
import { createTaskStore } from '../core/coordination/tasks.mjs';
import { createEvidenceRuntime } from '../core/peers/evidence-runtime.mjs';
import { createCoordinationState } from '../coordination-state.mjs';
import { createScopedMcpTools } from '../mcp/tools.mjs';
import { resolveProjectDatabase } from '../runtime/project-path.mjs';
import { registerProjectActivity } from '../runtime/projects.mjs';
import { compareProcessIdentity, inspectProcessIdentity } from '../process/identity.mjs';

const fail = (message) => { throw new CliError('DSH_COLLABORATION_CONFLICT', message); };

function verifiedDeadOwner(peer) {
  if (!Number.isSafeInteger(peer?.pid) || peer.pid <= 0 ||
      typeof peer.pid_start_token !== 'string' || !peer.pid_start_token ||
      typeof peer.pid_command_hash !== 'string' || !/^[a-f0-9]{64}$/.test(peer.pid_command_hash)) return false;
  const observed = inspectProcessIdentity(peer.pid);
  if (observed.state === 'dead') return true;
  // A recycled PID has a different start token. A changed command alone does
  // not prove the original process exited (a live process may change its title).
  return observed.state === 'live' && observed.identity?.pid === peer.pid &&
    compareProcessIdentity({ pid: peer.pid, startToken: peer.pid_start_token,
      commandHash: peer.pid_command_hash }, observed.identity) === 'dead';
}

// One in-process authority per Agent. All mutations still go through the same
// transactional business functions as the CLI and scoped MCP server.
export function createDshCollaboration({ sessionId, cwd, maxContextChars = 16000, maxToolChars = 16000 }) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 1024 ||
      sessionId.trim() !== sessionId || /[\u0000-\u001f\u007f]/.test(sessionId) ||
      typeof cwd !== 'string' || !path.isAbsolute(cwd)) fail('Agent requires its real session ID and absolute cwd');
  const project = resolveProjectDatabase({ root: cwd, createStateDir: true });
  const ctx = { root: project.root, cwd: project.root, dbPath: project.db, json: true };
  const peer = providerSessionPeerId('dsh', sessionId);
  const owner = `cordis:${randomUUID()}`;
  const now = () => Math.floor(Date.now() / 1000);
  const { addEvent } = createEventHelpers({ now });
  const bindings = createPeerBindingStore({ now, addEvent });
  const { connect: baseConnect } = createConnectionHelpers({ now,
    dedupePeerBindings: bindings.dedupePeerBindings, redactedLogText: text => redactSecrets(text) });
  const connect = (context = ctx, options = {}) => baseConnect(context, { ...options, migrateRegistered: false });
  const peers = createPeerHelpers({ now, addEvent });
  const messages = createMessageStore({ now, addEvent });
  const evidence = createEvidenceRuntime({ now });
  const tasks = createTaskStore({ now, addEvent, sendMessage: messages.sendMessage,
    activePeerTtl: 600, observeClockSafety: evidence.observeTaskTakeoverClockSafety });
  const coordination = createCoordinationState({ connect, now, ...messages, ...tasks, ...evidence });
  let disposed = false;
  let retiring = false;
  const identity = inspectProcessIdentity(process.pid).identity;
  if (!identity) fail('Cannot establish the owning Harness process identity');

  const db = connect();
  try {
    tx(db, () => {
      const previous = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(peer);
      const previousPeer = db.prepare('SELECT * FROM peers WHERE id = ?').get(peer);
      if (previous || previousPeer) {
        // Retain the raw ID after disposal to detect hash collisions on resume.
        if (!previous || previous.provider !== 'dsh' || previous.provider_session_id !== sessionId ||
            previous.provider_session_name !== null || previous.transport !== 'cordis' ||
            previous.runtime_session_id !== sessionId || !previousPeer ||
            !((previous.runtime_target === null && previousPeer.status === 'exited') ||
              (previous.runtime_target !== null && verifiedDeadOwner(previousPeer)))) {
          fail('Session already has a hooks, native, or live Cordis owner; disable the other integration first');
        }
        const replaced = db.prepare(`UPDATE peer_bindings SET runtime_target = ?, updated_at = ?
          WHERE peer = ? AND runtime_target IS ? AND provider = 'dsh' AND provider_session_id = ?
            AND transport = 'cordis' AND runtime_session_id = ?
            AND EXISTS (SELECT 1 FROM peers WHERE id = ? AND status = ? AND pid IS ?
              AND pid_start_token IS ? AND pid_command_hash IS ?)`)
          .run(owner, now(), peer, previous.runtime_target, sessionId, sessionId, peer,
            previousPeer.status, previousPeer.pid, previousPeer.pid_start_token, previousPeer.pid_command_hash);
        if (replaced.changes !== 1) fail('Cordis session ownership changed during recovery');
      }
      peers.upsertPeer(db, { id: peer, kind: 'dsh', role: 'peer', worktree: ctx.root,
        pid: process.pid, processIdentity: identity, status: 'working', capabilities: 'dsh-cordis' });
      bindings.upsertPeerBinding(db, { peer, provider: 'dsh', provider_session_id: sessionId,
        provider_session_name: null, resume_mode: 'session', transport: 'cordis',
        runtime_session_id: sessionId, runtime_target: owner });
      peers.touchPeer(db, peer, 'idle');
      addEvent(db, 'dsh.cordis.opened', peer, null, { session_id: sessionId });
    });
  } finally { db.close(); }
  registerProjectActivity(ctx);

  function assertOwnership(db, allowRetiring = false) {
    if (disposed || (retiring && !allowRetiring)) fail('The Cordis Agent authority has been disposed');
    const row = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(peer);
    if (!row || row.provider !== 'dsh' || row.transport !== 'cordis' || row.runtime_target !== owner ||
        row.provider_session_id !== sessionId || row.runtime_session_id !== sessionId) fail('The Agent no longer owns this peer');
  }
  function owned(fn, transactional = true, allowRetiring = false) {
    if (disposed || (retiring && !allowRetiring)) fail('The Cordis Agent authority has been disposed');
    const db = connect(ctx, { create: false });
    try {
      const run = () => { assertOwnership(db, allowRetiring); return fn(db); };
      return transactional ? tx(db, run) : run();
    }
    finally { db.close(); }
  }
  const authority = { scope: Object.freeze({ root: ctx.root, dbPath: ctx.dbPath, peer, executorId: owner }),
    assertValid: () => { if (disposed || retiring) fail('The Cordis Agent authority has been disposed'); }, assertOwnership };
  const service = createScopedMcpTools({ ctx, authority, connect, now, addEvent,
    touchPeer: (db, id, status) => { assertOwnership(db); if (id !== peer) fail('Peer identity changed'); peers.touchPeer(db, id, status); } });
  let queue = Promise.resolve();
  function call(name, args, signal) {
    const run = queue.then(async () => {
      signal?.throwIfAborted();
      const result = await service.call(name, args);
      signal?.throwIfAborted();
      const value = result.structuredContent;
      const serialized = JSON.stringify(value);
      return serialized.length <= maxToolChars ? JSON.parse(serialized) : {
        ok: value.ok, peer, truncated: true,
        notice: 'Result exceeds the configured bound. Use smaller limits; unread messages remain unread.',
        preview: serialized.slice(0, Math.max(0, Math.floor((maxToolChars - 512) / 2)))
      };
    });
    queue = run.catch(() => {});
    return run;
  }
  function snapshot() {
    return owned(db => {
      const state = coordination.buildHookCoordinationContext(db, ctx, peer);
      const prefix = '[hello-cc Cordis collaboration]\nUse the hcc_* tools for this Agent. They fix the project and peer; do not impersonate other sessions.\n';
      const text = prefix + redactSecrets(state.text);
      const complete = text.length <= maxContextChars;
      return { text: complete ? text : text.slice(0, maxContextChars - 160) +
        '\n[Context truncated. Read hcc_inbox/hcc_state with smaller limits. Truncated messages have not been acknowledged.]',
      messages: complete ? state.messages : [], hasUnread: state.messages.length > 0, complete };
    }, false);
  }
  return {
    peer, sessionId, ctx, list: service.list, call, snapshot,
    ack: items => owned(db => coordination.ackMessages(db, peer, items)),
    status: status => owned(db => peers.touchPeer(db, peer, status === 'running' ? 'working' : 'idle')),
    activity: (event, tool) => owned(db => {
      peers.touchPeer(db, peer, 'working');
      addEvent(db, event, peer, null, { tool });
    }),
    dispose() {
      if (disposed) return;
      retiring = true;
      owned(db => {
        peers.touchPeer(db, peer, 'exited');
        db.prepare('UPDATE peer_bindings SET runtime_target = NULL, updated_at = ? WHERE peer = ? AND runtime_target = ?').run(now(), peer, owner);
        addEvent(db, 'dsh.cordis.closed', peer, null, { session_id: sessionId });
      }, true, true);
      disposed = true;
    }
  };
}
