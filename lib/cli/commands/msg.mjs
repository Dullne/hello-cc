// Message CLI commands extracted from bin/hcc.mjs.
// Factory pattern: all bin/hcc.mjs dependencies are injected.

export function createMsgCommands(deps) {
  const {
    connect,
    now,
    iso,
    touchCurrentPeer,
    resolveCurrentPeer,
    registerProjectActivity,
    parseOpts,
    intOpt,
    required,
    wantsHelp,
    helpMsg,
    printResult,
    table,
    sleep,
    CliError,
    ackMessage,
    getMessage,
    queryInbox,
    queryMessageThread,
    sendMessage
  } = deps;

  async function cmdMsg(ctx, args) {
    const sub = args[0];
    if (!sub || wantsHelp(args)) return helpMsg();
    if (sub === 'send') return msgSend(ctx, args.slice(1));
    if (sub === 'inbox') return msgInbox(ctx, args.slice(1));
    if (sub === 'ack') return msgAck(ctx, args.slice(1));
    if (sub === 'reply') return msgReply(ctx, args.slice(1));
    if (sub === 'thread') return msgThread(ctx, args.slice(1));
    throw new CliError('BAD_ARGS', `Unknown msg command: ${sub}`);
  }

  async function msgSend(ctx, args) {
    const opts = parseOpts(args);
    const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
    const sender = identity.id;
    const recipient = opts.to || 'all';
    const body = required(opts, 'body');
    const taskId = intOpt(opts, 'task', null);
    const kind = opts.kind || 'note';
    const db = connect(ctx);
    touchCurrentPeer(db, ctx, identity, null, 'shell');
    const id = sendMessage(db, sender, recipient, taskId, kind, body);
    printResult(ctx, { id, sender, recipient, task_id: taskId, kind, body, reply_to: null, thread_id: id },
      (data) => `sent message #${data.id} ${data.sender} -> ${data.recipient}`);
  }

  async function msgInbox(ctx, args) {
    const opts = parseOpts(args, { booleans: ['all'] });
    const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
    const peer = identity.id;
    const waitSec = intOpt(opts, 'wait', 0);
    const limit = intOpt(opts, 'limit', 20);
    const includeAll = Boolean(opts.all);
    const db = connect(ctx);
    touchCurrentPeer(db, ctx, identity, null, 'shell');
    const deadline = Date.now() + waitSec * 1000;
    let rows = queryInbox(db, peer, includeAll, limit);
    while (!rows.length && waitSec > 0 && Date.now() < deadline) {
      await sleep(1000);
      rows = queryInbox(db, peer, includeAll, limit);
    }
    printResult(ctx, rows, (data) => table(data, [
      { label: 'id', value: (r) => `#${r.id}` },
      { label: 'from', value: (r) => r.sender },
      { label: 'kind', value: (r) => r.kind },
      { label: 'task', value: (r) => r.task_id ? `#${r.task_id}` : '' },
      { label: 'reply', value: (r) => r.reply_to ? `#${r.reply_to}` : '' },
      { label: 'thread', value: (r) => r.thread_id ? `#${r.thread_id}` : '' },
      { label: 'time', value: (r) => iso(r.created_at) },
      { label: 'body', value: (r) => r.body }
    ]));
  }

  async function msgAck(ctx, args) {
    const opts = parseOpts(args);
    const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
    const peer = identity.id;
    const id = intOpt(opts, 'id', intOpt({ id: opts._[0] }, 'id'));
    if (!id) throw new CliError('BAD_ARGS', 'Missing --id');
    const db = connect(ctx);
    touchCurrentPeer(db, ctx, identity, null, 'shell');
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    if (!message) throw new CliError('NOT_FOUND', `Message #${id} does not exist`);
    ackMessage(db, peer, message);
    printResult(ctx, { id, peer }, (data) => `acknowledged message #${data.id} for ${data.peer}`);
  }

  async function msgReply(ctx, args) {
    const opts = parseOpts(args);
    const id = intOpt(opts, 'id', intOpt({ id: opts._[0] }, 'id'));
    if (!id) throw new CliError('BAD_ARGS', 'Missing --id');
    const body = required(opts, 'body');
    const db = connect(ctx);
    const original = getMessage(db, id);
    if (!original) throw new CliError('NOT_FOUND', `Message #${id} does not exist`);
    const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
    const sender = identity.id;
    touchCurrentPeer(db, ctx, identity, null, 'shell');
    const recipient = opts.to || original.sender;
    const taskId = intOpt(opts, 'task', original.task_id || null);
    const kind = opts.kind || 'reply';
    const threadId = original.thread_id || original.id;
    const replyId = sendMessage(db, sender, recipient, taskId, kind, body, {
      reply_to: original.id,
      thread_id: threadId
    });
    ackMessage(db, sender, original);
    printResult(ctx, {
      id: replyId,
      sender,
      recipient,
      task_id: taskId,
      kind,
      body,
      reply_to: original.id,
      thread_id: threadId
    }, (data) => `sent reply #${data.id} to #${data.reply_to} ${data.sender} -> ${data.recipient}`);
  }

  async function msgThread(ctx, args) {
    const opts = parseOpts(args);
    const id = intOpt(opts, 'id', intOpt({ id: opts._[0] }, 'id'));
    if (!id) throw new CliError('BAD_ARGS', 'Missing --id');
    const limit = intOpt(opts, 'limit', 50);
    const db = connect(ctx);
    const data = queryMessageThread(db, id, limit);
    printResult(ctx, data, (thread) => {
      const lines = [`thread #${thread.thread_id} (${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'})`];
      for (const message of thread.messages) {
        const parts = [
          `#${message.id}`,
          `${message.sender} -> ${message.recipient || 'all'}`,
          message.task_id ? `task #${message.task_id}` : '',
          message.reply_to ? `reply #${message.reply_to}` : '',
          message.kind || 'note',
          iso(message.created_at)
        ].filter(Boolean).join(' ');
        lines.push(`${parts}\n  ${message.body}`);
      }
      return lines.join('\n');
    });
  }

  return { cmdMsg };
}
