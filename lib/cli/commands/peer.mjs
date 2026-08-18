// Peer management commands extracted from bin/hcc.mjs.

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
    const data = await runtimeRequest(ctx, 'GET', '/api/sessions');
    const db = connect(ctx);
    let bindings;
    try {
      bindings = new Map(db.prepare('SELECT * FROM peer_bindings').all().map((row) => [row.peer, row]));
    } finally {
      db.close();
    }
    const rows = (data.sessions || []).map((session) => ({
      ...session,
      binding: bindings.get(session.peer_id || session.id) || bindings.get(session.id) || null
    }));
    printResult(ctx, rows, (items) => table(items, [
      { label: 'id', value: (r) => r.id },
      { label: 'peer', value: (r) => r.peer_id && r.peer_id !== r.id ? r.peer_id : '' },
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

  await runtimeRequest(ctx, 'GET', '/api/runtime', null, runtime);
  const db = connect(ctx);
  try {
    tx(db, () => {
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
    binding,
    env: childSessionEnv(),
    restartOnEnvChange: Boolean(opts['restart-env']),
    providerForce: Boolean(opts.force)
  }, runtime);
  printResult(ctx, data.session, (session) =>
    `started ${session.id} (${session.kind}, ${session.role})${session.pane ? ` pane=${session.pane}` : ` pid=${session.pid}`}`);
}

async function peerAttach(ctx, args) {
  const opts = parseOpts(args, { booleans: ['force'] });
  const actor = resolveCurrentPeer(ctx, {}, 'peer', 'shell').id;
  const id = opts.peer || opts._[0];
  if (!id) throw new CliError('BAD_ARGS', 'Missing peer');
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
  await runtimeRequest(ctx, 'GET', '/api/runtime', null, runtime);
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
  }, runtime);
  printResult(ctx, data.session, (session) => `attached ${session.id} (${session.kind}, ${session.role}) pane=${session.pane}`);
}

async function peerStop(ctx, args) {
  const opts = parseOpts(args);
  const actor = resolveCurrentPeer(ctx, {}, 'peer', 'shell').id;
  const id = opts.peer || opts._[0];
  if (!id) throw new CliError('BAD_ARGS', 'Missing peer');
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
    data = await runtimeRequest(ctx, 'POST', `/api/sessions/${encodeURIComponent(id)}/stop`, {});
  } catch (err) {
    if (err instanceof CliError && err.code === 'RUNTIME_NOT_RUNNING') {
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
