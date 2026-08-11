// Coordination query commands extracted from bin/hcc.mjs: peers, status, state, prompt.

export function createQueryCommands(deps) {
  const {
    connect, now, printResult, table, CliError, ACTIVE_PEER_TTL,
    parseOpts, required, wantsHelp, helpState,
    resolveTargetPeer, resolveCurrentPeer,
    statusSummary, statusSnapshot, normalizeStateResources,
    renderStatusSummary, renderStateSummary,
    observePeerEvidence, classifyPeerActivity,
    clockGraceSuppressed, readClockGraceUntil,
    commandPath
  } = deps;

  async function cmdPeers(ctx, args) {
    parseOpts(args);
    const db = connect(ctx);
    const t = now();
    const graceActive = clockGraceSuppressed(t, readClockGraceUntil(db));
    const rows = db.prepare(`
      SELECT *, (? - last_seen_at) AS age_sec
      FROM peers
      ORDER BY last_seen_at DESC, id ASC
    `).all(t);
    for (const row of rows) {
      const binding = db.prepare(`SELECT transport, runtime_target FROM peer_bindings WHERE peer = ?`).get(row.id) || null;
      const evidence = observePeerEvidence(ctx, row, binding);
      row.evidence_state = evidence.state;
      row.evidence_reason = evidence.reason;
      Object.assign(row, classifyPeerActivity(row, { activePeerTtl: ACTIVE_PEER_TTL, graceActive }));
    }
    printResult(ctx, rows, (data) => table(data, [
      { label: 'id', value: (r) => r.id },
      { label: 'kind', value: (r) => r.kind },
      { label: 'role', value: (r) => r.role || '' },
      { label: 'status', value: (r) => r.status },
      { label: 'age', value: (r) => `${r.age_sec}s` },
      { label: 'active', value: (r) => r.active ? 'yes' : 'stale' },
      { label: 'branch', value: (r) => r.branch || '' }
    ]));
  }

  async function cmdStatus(ctx, args) {
    const opts = parseOpts(args);
    const identity = resolveTargetPeer(ctx, opts, 'peer', 'shell');
    const peer = identity.id;
    const data = statusSummary(ctx, peer, identity);
    printResult(ctx, data, (s) => renderStatusSummary(s, peer));
  }

  async function cmdState(ctx, args) {
    if (wantsHelp(args)) return helpState();
    const opts = parseOpts(args, { arrays: ['resource'] });
    const identity = resolveTargetPeer(ctx, opts, 'peer', 'shell');
    const peer = identity.id;
    const resources = normalizeStateResources(opts.resource || opts.resources || []);
    const snapshot = statusSnapshot(ctx, peer, { resources, intent: opts.intent || null, scope: opts.scope || null });
    printResult(ctx, snapshot, (data) => renderStateSummary(data, peer));
  }

  async function cmdPrompt(ctx, args) {
    const opts = parseOpts(args);
    const peer = required(opts, 'peer', 'HCC_PEER');
    const kind = opts.kind || 'codex';
    const role = opts.role || 'peer';
    const cmd = `node ${commandPath()} --root ${JSON.stringify(ctx.root)}`;
    const text = `You are ${peer}, a ${kind} ${role} session working in this project.

Use hcc as the shared coordination bus for this terminal session. This
project uses a flat peer mesh: there is no required main/worker hierarchy.

Run these commands before changing files:

${cmd} register --peer ${peer} --kind ${kind} --role ${role}
${cmd} state --peer ${peer}
${cmd} msg inbox --peer ${peer}
${cmd} task next --peer ${peer}

Coordination rules:
- Claim exactly one task before editing.
- If state shows a current task for ${peer}, continue that task before claiming another pending task.
- Before editing a file, directory, module, or shared test resource, run:
  ${cmd} lock acquire --peer ${peer} --resource <path-or-module> [--scope <scope>] --task <task-id>
- If a lock is held by another peer, message that peer instead of editing:
  ${cmd} msg send --from ${peer} --to <peer-id> --body "<question>"
- Report progress or requests through msg send.
- Before stopping, run tests, create a handoff, and release locks:
  ${cmd} handoff create --from ${peer} --task <task-id> --summary "<what changed>" --tests "<commands/results>" --risks "<known risks>"
  ${cmd} task done --peer ${peer} --id <task-id> --summary "<done summary>"
  ${cmd} lock release --peer ${peer} --resource <path-or-module> [--scope <scope>]
`;
    printResult(ctx, { prompt: text }, () => text);
  }

  return { cmdPeers, cmdStatus, cmdState, cmdPrompt };
}
