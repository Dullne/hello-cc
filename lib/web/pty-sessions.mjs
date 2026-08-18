// PTY-backed web sessions, extracted from lib/web/runtime-main.mjs.
// startPtySession spawns node-pty children as tracked peers; the input
// normalization helpers (options, peer id, backend choice) feed both the
// PTY and tmux session factories.

import path from 'node:path';
import process from 'node:process';
import {
  buildPeerCommand,
  defaultSessionCommand,
  hasResumeOpts
} from '../integrations/providers.mjs';
import { providerSessionPeerId } from '../core/peers/session.mjs';
import { childSessionEnv } from '../core/sessions/launch.mjs';
import { detectBranch } from '../project-context.mjs';

export function createPtySessions(deps) {
  const {
    pty, ctx, sessions,
    broadcast, closeSessionClients, sessionKey,
    connectWebProject, nextProjectSessionId,
    startTmuxManagedSession,
    now, addEvent, auditPayload, refreshPeerIoHeartbeat,
    upsertPeer, upsertCanonicalPeerBinding,
    requestActorPeer, requestSource
  } = deps;

  function startPtySession(input) {
    const pctx = input.projectCtx || ctx;
    const kind = input.kind || 'shell';
    const id = input.id || nextProjectSessionId(pctx, kind);
    const actorPeer = requestActorPeer(input, id);
    const auditSource = requestSource(input, 'web');
    const key = sessionKey(pctx, id);
    if (sessions.has(key) && sessions.get(key).status === 'running') {
      return sessions.get(key);
    }
    const role = input.role || 'peer';
    const command = input.command || defaultSessionCommand(kind);
    const cwd = path.resolve(input.cwd || pctx.root);
    const callerEnv = input.env && typeof input.env === 'object' ? input.env : process.env;
    const shell = callerEnv.SHELL || process.env.SHELL || 'bash';
    const env = childSessionEnv({
      HCC_PEER: id,
      HCC_ROOT: pctx.root,
      HCC_DB: pctx.dbPath,
      TERM: 'xterm-256color'
    }, callerEnv);
    const size = input.size || { cols: 100, rows: 30 };
    const child = pty.spawn(shell, ['-c', command], {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd,
      env
    });
    const session = {
      id,
      peerId: id,
      actorPeer,
      auditSource,
      actionTokens: new Set(),
      root: pctx.root,
      ctx: pctx,
      kind,
      role,
      command,
      cwd,
      pid: child.pid,
      pty: child,
      status: 'running',
      createdAt: now(),
      exitedAt: null,
      buffer: '',
      clients: new Set()
    };
    sessions.set(key, session);
    const db = connectWebProject(pctx);
    try {
      upsertPeer(db, {
        id,
        kind,
        role,
        worktree: cwd,
        branch: detectBranch(cwd),
        pid: child.pid,
        status: 'running',
        capabilities: 'web-pty'
      });
      const canonical = upsertCanonicalPeerBinding(db, {
        peer: id,
        provider: input.binding?.provider || kind,
        provider_session_id: input.binding?.provider_session_id || null,
        provider_session_name: input.binding?.provider_session_name || null,
        resume_mode: input.binding?.resume_mode || 'new',
        resume_arg: input.binding?.resume_arg || null,
        command,
        transport: 'web-pty',
        runtime_session_id: id
      }, Boolean(input.force));
      session.peerId = canonical.peer;
      session.binding = { ...canonical.binding };
      addEvent(db, 'web.session.started', actorPeer, null, auditPayload({
        actor: actorPeer,
        target: session.peerId || id,
        source: auditSource,
        admin: actorPeer !== (session.peerId || id),
        command,
        cwd,
        pid: child.pid
      }));
    } finally {
      db.close();
    }
    child.onData((data) => {
      session.buffer += data;
      if (session.buffer.length > 250000) session.buffer = session.buffer.slice(-200000);
      broadcast(session, { type: 'data', data });
      refreshPeerIoHeartbeat(session);
    });
    child.onExit((event) => {
      session.status = 'exited';
      session.exitedAt = now();
      const db = connectWebProject(pctx);
      try {
        db.prepare('UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ?').run('exited', now(), id);
        addEvent(db, 'web.session.exited', session.actorPeer || id, null, auditPayload({
          actor: session.actorPeer || id,
          target: session.peerId || id,
          source: session.auditSource || 'web',
          ...event
        }));
      } finally {
        db.close();
      }
      broadcast(session, { type: 'exit', event });
      closeSessionClients(session);
    });
    return session;
  }

  function webSessionBuildOptions(input) {
    const mode = input.mode || 'new';
    if (mode === 'new') return {};
    if (mode === 'resume') {
      const resume = String(input.resume || '').trim();
      if (!resume) throw new CliError('BAD_REQUEST', 'resume session required');
      return { resume };
    }
    if (mode === 'last') return { last: true };
    if (mode === 'continue') return { continue: true };
    throw new CliError('BAD_REQUEST', `Unsupported session mode: ${mode}`);
  }

  function webSessionPeerId(projectCtx, kind, opts, input) {
    if (input.id) return input.id;
    if (opts.resume) return providerSessionPeerId(kind, opts.resume);
    return nextProjectSessionId(projectCtx, kind);
  }

  function normalizeWebSessionInput(input) {
    const pctx = input.projectCtx || ctx;
    const kind = input.kind || 'shell';
    if (!['claude', 'codex', 'shell'].includes(kind)) {
      throw new CliError('BAD_REQUEST', `Unsupported session kind: ${kind}`);
    }
    if (input.command || input.binding) return { ...input, kind, projectCtx: pctx };

    const opts = webSessionBuildOptions(input);
    if (kind === 'shell' && hasResumeOpts(opts)) {
      throw new CliError('BAD_REQUEST', 'Resume modes are only supported for codex and claude sessions');
    }
    if (kind !== 'claude' && opts.continue) {
      throw new CliError('BAD_REQUEST', 'continue is only supported for claude sessions');
    }
    if (kind !== 'codex' && opts.last) {
      throw new CliError('BAD_REQUEST', 'last is only supported for codex sessions');
    }

    const id = webSessionPeerId(pctx, kind, opts, input);
    const built = buildPeerCommand(id, kind, opts, []);
    return {
      ...input,
      id,
      kind,
      command: built.command,
      binding: built.binding,
      projectCtx: pctx
    };
  }

  function startSession(input) {
    const normalized = normalizeWebSessionInput(input);
    if (normalized.backend === 'pty') return startPtySession(normalized);
    return startTmuxManagedSession(normalized);
  }

  return {
    startPtySession, webSessionBuildOptions, webSessionPeerId,
    normalizeWebSessionInput, startSession
  };
}
