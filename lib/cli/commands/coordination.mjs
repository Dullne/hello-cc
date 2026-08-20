// Coordination CLI commands extracted from bin/hcc.mjs: handoff, event,
// heartbeat, ask, broadcast, inject. Factory pattern with injected deps.

import { RUNTIME_SESSION_MUTATION_TIMEOUT_MS } from '../../runtime/client.mjs';

export function createCoordinationCommands(deps) {
  const {
    connect,
    now,
    iso,
    tx,
    addEvent,
    auditPayload,
    touchCurrentPeer,
    resolveCurrentPeer,
    registerProjectActivity,
    parseOpts,
    intOpt,
    required,
    positiveSafeIntOpt,
    wantsHelp,
    helpHandoff,
    helpEvent,
    helpAsk,
    helpBroadcast,
    helpInject,
    printResult,
    table,
    CliError,
    DEFAULT_LOCK_TTL,
    leaseDeadline,
    sendMessage,
    readRuntime,
    runtimeRequest,
    observeLockClockSafety,
    peerEvidenceFromDb,
    renewOwnedLocks,
    normalizeListText,
    changedFiles
  } = deps;

  async function cmdHandoff(ctx, args) {
    const sub = args[0];
    if (!sub || wantsHelp(args)) return helpHandoff();
    if (sub === 'create') return handoffCreate(ctx, args.slice(1));
    if (sub === 'list') return handoffList(ctx, args.slice(1));
    throw new CliError('BAD_ARGS', `Unknown handoff command: ${sub}`);
  }

  async function handoffCreate(ctx, args) {
    const opts = parseOpts(args);
    const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
    const from = identity.id;
    const taskId = intOpt(opts, 'task', null);
    const to = opts.to || null;
    const summary = required(opts, 'summary');
    const files = opts['changed-files']
      ? normalizeListText(opts['changed-files'])
      : JSON.stringify(changedFiles(ctx.cwd));
    const tests = normalizeListText(opts.tests, []);
    const risks = normalizeListText(opts.risks, []);
    const db = connect(ctx);
    touchCurrentPeer(db, ctx, identity, 'idle', 'shell');
    const id = tx(db, () => {
      const info = db.prepare(`
        INSERT INTO handoffs(task_id, from_peer, to_peer, summary, changed_files, tests, risks, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(taskId, from, to, summary, files, tests, risks, now());
      const handoffId = Number(info.lastInsertRowid);
      addEvent(db, 'handoff.created', from, taskId, { handoff_id: handoffId, to });
      if (to) sendMessage(db, from, to, taskId, 'handoff', `Handoff #${handoffId}: ${summary}`);
      return handoffId;
    });
    printResult(ctx, { id, task_id: taskId, from, to, summary, changed_files: files, tests, risks }, (data) => `created handoff #${data.id}${data.to ? ` -> ${data.to}` : ''}`);
  }

  async function handoffList(ctx, args) {
    const opts = parseOpts(args);
    const taskId = intOpt(opts, 'task', null);
    const limit = intOpt(opts, 'limit', 20);
    const db = connect(ctx);
    const rows = taskId
      ? db.prepare('SELECT * FROM handoffs WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(taskId, limit)
      : db.prepare('SELECT * FROM handoffs ORDER BY id DESC LIMIT ?').all(limit);
    printResult(ctx, rows, (data) => table(data, [
      { label: 'id', value: (r) => `#${r.id}` },
      { label: 'task', value: (r) => r.task_id ? `#${r.task_id}` : '' },
      { label: 'from', value: (r) => r.from_peer },
      { label: 'to', value: (r) => r.to_peer || '' },
      { label: 'time', value: (r) => iso(r.created_at) },
      { label: 'summary', value: (r) => r.summary }
    ]));
  }

  async function cmdEvent(ctx, args) {
    const sub = args[0];
    if (!sub || wantsHelp(args)) return helpEvent();
    if (sub === 'tail') return eventTail(ctx, args.slice(1));
    throw new CliError('BAD_ARGS', `Unknown event command: ${sub}`);
  }

  async function eventTail(ctx, args) {
    const opts = parseOpts(args);
    const limit = intOpt(opts, 'limit', 30);
    const db = connect(ctx);
    const rows = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit).reverse();
    printResult(ctx, rows, (data) => table(data, [
      { label: 'id', value: (r) => `#${r.id}` },
      { label: 'type', value: (r) => r.type },
      { label: 'actor', value: (r) => r.actor || '' },
      { label: 'task', value: (r) => r.task_id ? `#${r.task_id}` : '' },
      { label: 'time', value: (r) => iso(r.created_at) }
    ]));
  }

  async function cmdHeartbeat(ctx, args) {
    const opts = parseOpts(args, { booleans: ['renew-locks'] });
    const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
    const peer = identity.id;
    const status = opts.status || null;
    const ttlOverride = opts.ttl === undefined ? null : positiveSafeIntOpt(opts, 'ttl', DEFAULT_LOCK_TTL);
    const t = now();
    if (ttlOverride !== null) leaseDeadline(t, ttlOverride);
    const db = connect(ctx);
    const clockObservation = opts['renew-locks']
      ? observeLockClockSafety(db, ctx, { owner: peer, observedAt: t })
      : null;
    touchCurrentPeer(db, ctx, identity, status, 'shell');
    let renewed = 0;
    if (opts['renew-locks']) {
      const evidenceLive = peerEvidenceFromDb(db, ctx, peer).state === 'live';
      if (clockObservation?.renewed > 0 && ttlOverride === null) {
        renewed = clockObservation.renewed;
      } else if (ttlOverride !== null) {
        renewed = renewOwnedLocks(db, {
          owner: peer,
          nowSec: t,
          ttlOverride,
          includeExpired: evidenceLive
        });
      } else {
        renewed = renewOwnedLocks(db, {
          owner: peer,
          nowSec: t,
          includeExpired: evidenceLive
        });
      }
    }
    addEvent(db, 'peer.heartbeat', peer, null, { status, renewed });
    printResult(ctx, { peer, status, renewed }, (data) => `heartbeat ${data.peer}${data.renewed ? `, renewed locks: ${data.renewed}` : ''}`);
  }

  async function cmdAsk(ctx, args) {
    if (args[0] === '--help' || args[0] === '-h') return helpAsk();
    const opts = parseOpts(args, { booleans: ['inject', 'no-enter'] });
    const recipient = opts.to || opts._[0];
    if (!recipient) throw new CliError('BAD_ARGS', 'Missing peer');
    const body = opts.body || opts._.slice(opts.to ? 0 : 1).join(' ');
    if (!body) throw new CliError('BAD_ARGS', 'Missing message');
    const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
    const sender = identity.id;
    const taskId = intOpt(opts, 'task', null);
    const kind = opts.kind || 'ask';
    const runtime = opts.inject ? readRuntime(ctx) : null;
    const db = connect(ctx);
    touchCurrentPeer(db, ctx, identity, null, 'shell');
    const id = sendMessage(db, sender, recipient, taskId, kind, body);
    let injected = false;
    if (opts.inject) {
      await injectPeer(ctx, recipient, body, !opts['no-enter'], runtime, sender);
      injected = true;
    }
    printResult(ctx, { id, sender, recipient, task_id: taskId, kind, body, injected }, (data) => `asked ${data.recipient} with message #${data.id}${data.injected ? ' and injected terminal input' : ''}`);
  }

  async function cmdBroadcast(ctx, args) {
    if (args[0] === '--help' || args[0] === '-h') return helpBroadcast();
    const opts = parseOpts(args, { booleans: ['inject', 'no-enter'] });
    const body = opts.body || opts._.join(' ');
    if (!body) throw new CliError('BAD_ARGS', 'Missing message');
    const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
    const sender = identity.id;
    const taskId = intOpt(opts, 'task', null);
    const kind = opts.kind || 'broadcast';
    const runtime = opts.inject ? readRuntime(ctx) : null;
    const db = connect(ctx);
    touchCurrentPeer(db, ctx, identity, null, 'shell');
    const id = sendMessage(db, sender, 'all', taskId, kind, body);
    let injected = 0;
    let skipped = 0;
    if (opts.inject) {
      const sessions = await runtimeRequest(ctx, 'GET', '/api/sessions', null, runtime);
      const running = (sessions.sessions || []).filter((session) => session.status === 'running');
      for (const session of running) {
        try {
          await injectPeer(ctx, session.id, body, !opts['no-enter'], runtime, sender);
          injected += 1;
        } catch (err) {
          if (err instanceof CliError && ['NOT_FOUND', 'SESSION_NOT_RUNNING', 'TMUX_ERROR'].includes(err.code)) {
            skipped += 1;
            continue;
          }
          throw err;
        }
      }
    }
    printResult(ctx, { id, sender, recipient: 'all', task_id: taskId, kind, body, injected, skipped }, (data) => {
      const injectedText = data.injected ? ` and injected ${data.injected} terminal(s)` : '';
      const skippedText = data.skipped ? `, skipped ${data.skipped} stale terminal(s)` : '';
      return `broadcast message #${data.id}${injectedText}${skippedText}`;
    });
  }

  async function injectPeer(ctx, peer, text, enter = true, runtime = null, auditActor = null) {
    const actor = auditActor || resolveCurrentPeer(ctx, {}, 'peer', 'shell').id;
    const db = connect(ctx);
    try {
      addEvent(db, 'web.session.input.requested', actor, null, auditPayload({
        actor,
        target: peer,
        peer,
        source: 'cli',
        admin: actor !== peer,
        bytes: text.length,
        enter
      }));
    } finally {
      db.close();
    }
    return runtimeRequest(ctx, 'POST', `/api/sessions/${encodeURIComponent(peer)}/input`, {
      text,
      enter
    }, runtime, { timeoutMs: RUNTIME_SESSION_MUTATION_TIMEOUT_MS });
  }

  async function cmdInject(ctx, args) {
    if (args[0] === '--help' || args[0] === '-h') return helpInject();
    const opts = parseOpts(args, { booleans: ['no-enter'] });
    const peer = opts.peer || opts._[0];
    if (!peer) throw new CliError('BAD_ARGS', 'Missing peer');
    const text = opts.body || opts._.slice(opts.peer ? 0 : 1).join(' ');
    if (!text) throw new CliError('BAD_ARGS', 'Missing text');
    const enter = !opts['no-enter'];
    const result = await injectPeer(ctx, peer, text, enter);
    printResult(ctx, { peer, text, enter, result }, (data) => `injected ${data.peer}${data.enter ? ' and pressed Enter' : ''}`);
  }

  return { cmdHandoff, cmdEvent, cmdHeartbeat, cmdAsk, cmdBroadcast, cmdInject, injectPeer };
}
