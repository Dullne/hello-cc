// Lifecycle CLI commands extracted from bin/hcc.mjs: init, register, env, join.

export function createLifecycleCommands(deps) {
  const {
    connect, now, addEvent, printResult, CliError, parseOpts, intOpt,
    registerProjectActivity, resolveCurrentPeer, resolveTargetPeer,
    upsertPeer, upsertCanonicalPeerBinding, detectBranch,
    writeGuidance, helpEnv, helpJoin, shellExports, path, process
  } = deps;

  async function cmdInit(ctx, args) {
    registerProjectActivity(ctx);
    const opts = parseOpts(args, { booleans: ['no-guidance'] });
    const db = connect(ctx);
    const guidance = opts['no-guidance'] ? null : writeGuidance(ctx);
    addEvent(db, 'mesh.init', 'human', null, { root: ctx.root, db: ctx.dbPath, guidance });
    printResult(ctx, { root: ctx.root, db: ctx.dbPath, guidance }, (data) => [
      'hello-cc initialized',
      `root: ${data.root}`,
      `db: ${data.db}`,
      data.guidance ? `guidance: ${data.guidance}` : 'guidance: skipped'
    ].join('\n'));
  }

  async function cmdRegister(ctx, args) {
    registerProjectActivity(ctx);
    const opts = parseOpts(args, { arrays: ['cap'] });
    const identity = resolveCurrentPeer(ctx, opts, 'peer', opts.kind || 'shell');
    const id = identity.id;
    const db = connect(ctx);
    const peer = {
      id,
      kind: opts.kind || 'other',
      role: opts.role || '',
      worktree: path.resolve(opts.worktree || ctx.cwd),
      branch: opts.branch || detectBranch(ctx.cwd),
      pid: intOpt(opts, 'pid', process.ppid),
      status: opts.status || 'idle',
      capabilities: Array.isArray(opts.cap) ? opts.cap.join(',') : (opts.cap || opts.capabilities || '')
    };
    upsertPeer(db, peer);
    addEvent(db, 'peer.registered', id, null, peer);
    printResult(ctx, peer, (data) => `registered ${data.id} (${data.kind}${data.role ? `, ${data.role}` : ''})`);
  }

  async function cmdEnv(ctx, args) {
    if (args[0] === '--help' || args[0] === '-h') return helpEnv();
    const opts = parseOpts(args);
    const peer = resolveTargetPeer(ctx, opts, 'peer', 'shell').id;
    const values = {
      HCC_PEER: peer,
      HCC_ROOT: ctx.root,
      HCC_DB: ctx.dbPath
    };
    printResult(ctx, values, (data) => shellExports(data));
  }

  async function cmdJoin(ctx, args) {
    if (args[0] === '--help' || args[0] === '-h') return helpJoin();
    registerProjectActivity(ctx);
    const opts = parseOpts(args, { arrays: ['cap'] });
    const identity = resolveCurrentPeer(ctx, opts, 'peer', opts.kind || 'shell');
    const id = identity.id;
    const peer = {
      id,
      kind: opts.kind || 'other',
      role: opts.role || 'peer',
      worktree: path.resolve(opts.worktree || ctx.cwd),
      branch: opts.branch || detectBranch(ctx.cwd),
      pid: intOpt(opts, 'pid', process.ppid),
      status: opts.status || 'working',
      capabilities: Array.isArray(opts.cap) ? opts.cap.join(',') : (opts.cap || opts.capabilities || 'manual-shell')
    };
    const db = connect(ctx);
    try {
      upsertPeer(db, peer);
      upsertCanonicalPeerBinding(db, {
        peer: id,
        provider: peer.kind,
        provider_session_id: null,
        provider_session_name: null,
        resume_mode: 'manual',
        resume_arg: null,
        command: null,
        transport: 'manual-shell',
        runtime_session_id: id
      }, true);
      addEvent(db, 'peer.joined', id, null, { kind: peer.kind, role: peer.role, root: ctx.root });
    } finally {
      db.close();
    }
    const exports = {
      HCC_PEER: id,
      HCC_ROOT: ctx.root,
      HCC_DB: ctx.dbPath
    };
    printResult(ctx, exports, (data) => shellExports(data));
  }

  return { cmdInit, cmdRegister, cmdEnv, cmdJoin };
}
