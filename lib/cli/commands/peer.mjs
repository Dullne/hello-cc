// Peer management commands extracted from bin/hcc.mjs.

import {
  RUNTIME_SESSION_MUTATION_TIMEOUT_MS,
  RUNTIME_SESSION_START_TIMEOUT_MS
} from '../../runtime/client.mjs';
import { captureSelectedCwdSnapshot } from '../../process/selected-cwd-identity.mjs';
import { assertCodexTerminalLaunch } from '../../core/sessions/codex-thread-root.mjs';
import { CODEX_SESSION_ORIGIN_ENV } from '../../core/sessions/codex-thread-root.mjs';
import { buildPeerInvocation } from '../../integrations/providers.mjs';
import { createWindowsTerminal, findWindowsTerminal, listWindowsTerminals,
  attachWindowsTerminalSession, stopWindowsTerminalSession } from '../windows-terminal.mjs';

export function createPeerCommands(deps) {
  const {
    connect, now, tx, addEvent, auditPayload, printResult, CliError, parseOpts,
    detectBranch, buildPeerCommand, childSessionEnv, inferPeerKind,
    findProviderSessionBinding, bindingHasRuntime,
    resolveCurrentPeer, helpPeer, wantsHelp, CLI_NAME, cmdPeers,
    runtimeRequest, readRuntime,
    upsertPeer, upsertCanonicalPeerBinding, storedPeerIdentity,
    path, process, Map, table
  } = deps;

async function cmdPeer(ctx, args) {
  const sub = args[0];
  if (!sub || wantsHelp(args)) return helpPeer();
  if (sub === 'list') return peerList(ctx, args.slice(1));
  if (sub === 'start') return peerStart(ctx, args.slice(1));
  if (sub === 'attach') return peerAttach(ctx, args.slice(1));
  if (sub === 'stop') return peerStop(ctx, args.slice(1));
  throw new CliError('BAD_ARGS', `Unknown peer command: ${sub}`);
}

async function peerList(ctx, args) {
  parseOpts(args);
  try {
    let data, structuredUnavailable = false;
    if (process.platform === 'win32') {
      data = { sessions: (await listWindowsTerminals(ctx)).sessions };
      try {
        const structured = await runtimeRequest(ctx, 'GET', '/api/sessions');
        data.sessions.push(...(structured.sessions || []).filter(session => ['native', 'app-server'].includes(session.type)));
      } catch (error) {
        if (!['RUNTIME_NOT_RUNNING', 'RUNTIME_UNREACHABLE'].includes(error.code)) throw error;
        structuredUnavailable = true;
      }
    } else data = await runtimeRequest(ctx, 'GET', '/api/sessions');
    const db = connect(ctx);
    let bindings;
    try {
      bindings = new Map(db.prepare('SELECT * FROM peer_bindings').all().map((row) => [row.peer, row]));
      if (structuredUnavailable) {
        for (const peer of db.prepare('SELECT * FROM peers').all()) {
          const binding = bindings.get(peer.id);
          if (['native', 'app-server'].includes(binding?.transport)) data.sessions.push({ ...peer,
            id: binding.runtime_session_id || peer.id, peer_id: peer.id, type: binding.transport });
        }
      }
    } finally {
      db.close();
    }
    const rows = (data.sessions || []).map((session) => ({
      ...session,
      binding: bindings.get(session.peerId || session.peer_id || session.id) || bindings.get(session.id) || null
    }));
    printResult(ctx, rows, (items) => table(items, [
      { label: 'id', value: (r) => r.id },
      { label: 'peer', value: (r) => (r.peerId || r.peer_id) !== r.id ? (r.peerId || r.peer_id || '') : '' },
      { label: 'kind', value: (r) => r.kind },
      { label: 'role', value: (r) => r.role || '' },
      { label: 'status', value: (r) => r.status },
      { label: 'type', value: (r) => r.type || '' },
      { label: 'pane', value: (r) => r.pane || '' },
      { label: 'provider', value: (r) => r.binding ? r.binding.provider : '' },
      { label: 'resume', value: (r) => r.binding ? r.binding.resume_mode : '' },
      { label: 'session', value: (r) => r.binding ? (r.binding.provider_session_id || r.binding.provider_session_name || '') : '' },
      { label: 'pid', value: (r) => r.pid || '' },
      { label: 'command', value: (r) => r.command || '' }
    ]));
  } catch (err) {
    if (err instanceof CliError && ['RUNTIME_NOT_RUNNING', 'RUNTIME_UNREACHABLE'].includes(err.code)) {
      return cmdPeers(ctx, []);
    }
    throw err;
  }
}

async function peerStart(ctx, args) {
  const sep = args.indexOf('--');
  const optArgs = sep >= 0 ? args.slice(0, sep) : args;
  const cmdArgs = sep >= 0 ? args.slice(sep + 1) : [];
  const opts = parseOpts(optArgs, { booleans: ['last', 'continue', 'fork', 'force', 'restart-env'] });
  const actor = resolveCurrentPeer(ctx, {}, 'peer', 'shell').id;
  const id = opts.peer || opts._[0];
  if (!id) throw new CliError('BAD_ARGS', 'Missing peer');
  const firstCommand = cmdArgs[0] || '';
  const kind = inferPeerKind(id, opts.kind, firstCommand);
  const role = opts.role || 'peer';
  const cwd = path.resolve(opts.cwd || ctx.root);
  const cwdIdentity = captureSelectedCwdSnapshot(cwd);
  if (process.platform === 'win32') {
    const built = buildPeerInvocation(id, kind, opts, cmdArgs);
    let origin;
    const db = connect(ctx);
    try {
      origin = assertCodexTerminalLaunch(db, built.binding, { command: built.command, argv: [built.file, ...built.args],
        root: ctx.root, rootIdentity: ctx.initialRootIdentity, cwd, cwdIdentity });
      if (!opts.force) {
        const conflict = findProviderSessionBinding(db, built.binding);
        if (bindingHasRuntime(conflict) && conflict.peer !== id) throw new CliError('PROVIDER_SESSION_IN_USE',
          `This provider session is already bound to ${conflict.peer}`);
      }
      addEvent(db, 'peer.start.requested', actor, null, auditPayload({ actor, target: id, peer: id,
        source: 'cli', admin: actor !== id, kind, role, command: built.command, cwd }));
    } finally { db.close(); }
    const result = await createWindowsTerminal(ctx, { peerId: id, kind, role, cwd: cwdIdentity.canonical, cwdIdentity,
      command: { file: built.file, args: built.args }, binding: built.binding,
      env: childSessionEnv({ HCC_PEER: id, HCC_ROOT: ctx.root, HCC_DB: ctx.dbPath,
        ...(origin ? { [CODEX_SESSION_ORIGIN_ENV]: origin } : {}) }, process.env, { rootIdentity: ctx.initialRootIdentity }),
      cols: process.stdout.columns || 100, rows: process.stdout.rows || 30
    }, { restartOnEnvChange: Boolean(opts['restart-env']) });
    const verb = result.already ? 'already running' : 'started';
    printResult(ctx, result.session, session => `${verb} ${session.peerId} (${session.kind}, ${session.role}) pid=${session.pid}`);
    return;
  }
  const built = buildPeerCommand(id, kind, opts, cmdArgs);
  const command = built.command;
  const binding = { ...built.binding, transport: 'tmux', runtime_session_id: id };

  let runtime;
  try { runtime = readRuntime(ctx); } catch (e) {
    if (e instanceof CliError && e.code === 'RUNTIME_NOT_RUNNING') {
      throw new CliError('RUNTIME_NOT_RUNNING',
        `No running web runtime found. Start ${CLI_NAME} web first, then ${CLI_NAME} peer start ${id}`);
    }
    throw e;
  }

  await runtimeRequest(ctx, 'GET', '/api/runtime', null, runtime, {
    timeoutMs: RUNTIME_SESSION_START_TIMEOUT_MS
  });
  const db = connect(ctx);
  try {
    tx(db, () => {
      assertCodexTerminalLaunch(db, binding, { command, root: ctx.root,
        rootIdentity: ctx.initialRootIdentity, cwd, cwdIdentity });
      if (!opts.force) {
        const conflict = findProviderSessionBinding(db, binding);
        if (bindingHasRuntime(conflict)) {
          const providerSession = binding.provider_session_id || binding.provider_session_name || '';
          throw new CliError('PROVIDER_SESSION_IN_USE', `${binding.provider} session ${providerSession} is already bound to ${conflict.peer}`, {
            peer: conflict.peer,
            provider: conflict.provider,
            provider_session: providerSession
          });
        }
      }
      const previousOwner = db.prepare(`
        SELECT pid, pid_start_token, pid_command_hash
        FROM peers WHERE id = ?
      `).get(id) || null;
      upsertPeer(db, {
        id, kind, role,
        worktree: cwd,
        branch: detectBranch(cwd),
        pid: previousOwner?.pid || null,
        processIdentity: storedPeerIdentity(previousOwner),
        status: 'starting',
        capabilities: 'tmux'
      });
      addEvent(db, 'peer.start.requested', actor, null, auditPayload({
        actor,
        target: id,
        peer: id,
        source: 'cli',
        admin: actor !== id,
        kind,
        role,
        command,
        cwd
      }));
    });
  } finally {
    db.close();
  }
  const data = await runtimeRequest(ctx, 'POST', '/api/sessions', {
    id,
    kind,
    role,
    command,
    cwd,
    cwdIdentity,
    binding,
    env: childSessionEnv(),
    restartOnEnvChange: Boolean(opts['restart-env']),
    providerForce: Boolean(opts.force)
  }, runtime, { timeoutMs: RUNTIME_SESSION_START_TIMEOUT_MS });
  printResult(ctx, data.session, (session) =>
    `started ${session.id} (${session.kind}, ${session.role})${session.pane ? ` pane=${session.pane}` : ` pid=${session.pid}`}`);
}

async function peerAttach(ctx, args) {
  const opts = parseOpts(args, { booleans: ['force'] });
  const actor = resolveCurrentPeer(ctx, {}, 'peer', 'shell').id;
  const id = opts.peer || opts._[0];
  if (!id) throw new CliError('BAD_ARGS', 'Missing peer');
  if (process.platform === 'win32') {
    if (opts.pane) throw new CliError('WINDOWS_ATTACH_UNSUPPORTED', 'Windows attach opens an HCC managed terminal by peer; existing console windows cannot be adopted');
    const { client, session } = await findWindowsTerminal(ctx, id);
    if (ctx.json) return printResult(ctx, session, value => `managed terminal ${value.peerId}`);
    const result = await attachWindowsTerminalSession(client, session, { force: Boolean(opts.force) });
    if (!result.detached) process.exitCode = result.exitCode ?? 0;
    return;
  }
  const pane = opts.pane || process.env.TMUX_PANE || null;
  const kind = opts.kind || null;
  const role = opts.role || 'peer';
  const cwd = opts.cwd ? path.resolve(opts.cwd) : null;

  let runtime;
  try { runtime = readRuntime(ctx); } catch (e) {
    if (e instanceof CliError && e.code === 'RUNTIME_NOT_RUNNING') {
      throw new CliError('RUNTIME_NOT_RUNNING',
        `No running web runtime found. Start ${CLI_NAME} web first, then ${CLI_NAME} peer attach ${id}`);
    }
    throw e;
  }
  await runtimeRequest(ctx, 'GET', '/api/runtime', null, runtime, {
    timeoutMs: RUNTIME_SESSION_START_TIMEOUT_MS
  });
  const db = connect(ctx);
  try {
    addEvent(db, 'peer.attach.requested', actor, null, auditPayload({
      actor,
      target: id,
      peer: id,
      source: 'cli',
      admin: actor !== id,
      pane,
      kind,
      role,
      cwd
    }));
  } finally {
    db.close();
  }
  const data = await runtimeRequest(ctx, 'POST', '/api/sessions/attach', {
    id,
    kind,
    role,
    pane,
    cwd,
    force: Boolean(opts.force)
  }, runtime, { timeoutMs: RUNTIME_SESSION_START_TIMEOUT_MS });
  printResult(ctx, data.session, (session) => `attached ${session.id} (${session.kind}, ${session.role}) pane=${session.pane}`);
}

async function peerStop(ctx, args) {
  const opts = parseOpts(args, { booleans: ['force'] });
  const actor = resolveCurrentPeer(ctx, {}, 'peer', 'shell').id;
  const id = opts.peer || opts._[0];
  if (!id) throw new CliError('BAD_ARGS', 'Missing peer');
  let runtimeId = id;
  if (process.platform === 'win32') {
    let selected;
    try { selected = await findWindowsTerminal(ctx, id); }
    catch (error) {
      if (error.code !== 'TERMINAL_NOT_FOUND') throw error;
      const data = await runtimeRequest(ctx, 'GET', '/api/sessions');
      const matches = (data.sessions || []).filter(session => ['native', 'app-server'].includes(session.type) &&
        (session.id === id || session.peerId === id || session.peer_id === id));
      if (matches.length !== 1) throw error;
      runtimeId = matches[0].id;
    }
    if (selected) {
      const stopped = await stopWindowsTerminalSession(selected.client, selected.session, { force: Boolean(opts.force) });
      printResult(ctx, stopped, value => `stopped ${value.peerId}`);
      return;
    }
  }
  let data;
  try {
    const db = connect(ctx);
    try {
      addEvent(db, 'peer.stop.requested', actor, null, auditPayload({
        actor,
        target: id,
        peer: id,
        source: 'cli',
        admin: actor !== id
      }));
    } finally {
      db.close();
    }
    data = await runtimeRequest(
      ctx,
      'POST',
      `/api/sessions/${encodeURIComponent(runtimeId)}/stop`,
      {},
      null,
      { timeoutMs: RUNTIME_SESSION_MUTATION_TIMEOUT_MS }
    );
  } catch (err) {
    if (process.platform !== 'win32' && err instanceof CliError && err.code === 'RUNTIME_NOT_RUNNING') {
      // No server: just update the DB to mark the peer as exited
      const db = connect(ctx);
      try {
        db.prepare('UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ?').run('exited', now(), id);
        addEvent(db, 'peer.stopped', actor, null, auditPayload({
          actor,
          target: id,
          peer: id,
          admin: actor !== id
        }));
      } finally { db.close(); }
      printResult(ctx, { id, status: 'exited' }, (s) => `stopped ${s.id} (no server running — DB marked exited)`);
      return;
    }
    throw err;
  }
  printResult(ctx, data.session, (session) => `stopped ${session.id}`);
}


  return { cmdPeer };
}
