// Task CLI commands extracted from bin/hcc.mjs.

const TASK_STATUS_SHORTCUTS = new Set(['running', 'review', 'blocked', 'abandoned']);

export function createTaskCommands(deps) {
  const {
    connect, now, tx, addEvent, auditPayload, touchCurrentPeer, resolveCurrentPeer,
    parseOpts, intOpt, required, positiveIntOpt, parseTaskIds, wantsHelp, helpTask,
    printResult, table, CliError, ACTIVE_PEER_TTL,
    sendMessage, readRuntime, runtimeRequest, injectPeer,
    queryOpenTasks, claimNextTasksForPeer, claimTaskRowsForPeer,
    takeOverTaskForPeer, assertTaskOwnerForMutation,
    annotateTasksWithLiveness, taskOwnerStateText, taskRowsText,
    observePeerEvidence, clockGraceSuppressed, readClockGraceUntil
  } = deps;

  async function cmdTask(ctx, args) {
    const sub = args[0];
    if (!sub || wantsHelp(args)) return helpTask();
    if (sub === 'create') return taskCreate(ctx, args.slice(1));
    if (sub === 'dispatch') return taskDispatch(ctx, args.slice(1));
    if (sub === 'list') return taskList(ctx, args.slice(1));
    if (sub === 'claim') return taskClaim(ctx, args.slice(1));
    if (sub === 'takeover') return taskTakeover(ctx, args.slice(1));
    if (sub === 'next') return taskNext(ctx, args.slice(1));
    if (sub === 'update') return taskUpdate(ctx, args.slice(1));
    if (sub === 'done') return taskDone(ctx, args.slice(1));
    if (TASK_STATUS_SHORTCUTS.has(sub)) return taskStatusShortcut(ctx, sub, args.slice(1));
    throw new CliError('BAD_ARGS', `Unknown task command: ${sub}`);
  }

  async function taskCreate(ctx, args) {
    const opts = parseOpts(args);
    const title = required(opts, 'title');
    const body = opts.body || '';
    const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
    const createdBy = identity.id;
    const assignee = opts.to || opts.assignee || null;
    const priority = intOpt(opts, 'priority', 100);
    const parentId = intOpt(opts, 'parent', null);
    const teamRole = opts.role || opts['team-role'] || null;
    const db = connect(ctx);
    touchCurrentPeer(db, ctx, identity, null, 'shell');
    const t = now();
    const id = tx(db, () => {
      if (parentId && !db.prepare('SELECT id FROM tasks WHERE id = ?').get(parentId)) {
        throw new CliError('NOT_FOUND', `Parent task #${parentId} does not exist`);
      }
      const info = db.prepare(`
        INSERT INTO tasks(title, body, status, assignee, owner, parent_id, team_role, priority, created_by, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(title, body, assignee, parentId, teamRole, priority, createdBy, t, t);
      const taskId = Number(info.lastInsertRowid);
      addEvent(db, 'task.created', createdBy, taskId, { title, assignee, priority, parent_id: parentId, team_role: teamRole });
      if (assignee) {
        sendMessage(db, createdBy, assignee, taskId, 'task', `Task #${taskId} assigned: ${title}`);
      }
      return taskId;
    });
    printResult(ctx, { id, title, assignee, priority, parent_id: parentId, team_role: teamRole },
      (data) => `created task #${data.id}: ${data.title}${data.assignee ? ` -> ${data.assignee}` : ''}${data.parent_id ? ` (child of #${data.parent_id})` : ''}`);
  }

  function dispatchPromptText(task, customMessage = null) {
    if (customMessage) return customMessage;
    return [
      `Please pick up hello-cc task #${task.id}: ${task.title}.`,
      `Run hcc task claim --id ${task.id}, then follow project coordination rules, create a handoff, and mark the task done when finished.`
    ].join(' ');
  }

  function currentOwnedTaskForPeer(db, peer) {
    return db.prepare(`
      SELECT *
      FROM tasks
      WHERE owner = ?
        AND status IN ('claimed', 'running', 'review', 'blocked')
      ORDER BY
        CASE status
          WHEN 'running' THEN 0
          WHEN 'claimed' THEN 1
          WHEN 'review' THEN 2
          WHEN 'blocked' THEN 3
          ELSE 4
        END,
        priority ASC,
        id ASC
      LIMIT 1
    `).get(peer);
  }

  function findRuntimeSessionForPeer(runtimeData, peer) {
    return (runtimeData?.sessions || []).find((session) => {
      const sessionPeer = session.peer_id || session.id;
      return session.status === 'running' && (session.id === peer || sessionPeer === peer);
    }) || null;
  }

  function sessionLooksProviderInteractive(session) {
    return Boolean(session) && ['claude', 'codex'].includes(session.kind);
  }

  async function taskDispatch(ctx, args) {
    const opts = parseOpts(args, { booleans: ['force', 'no-inject'] });
    const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
    const actor = identity.id;
    const target = required(opts, 'to');
    const requestedTaskId = intOpt(opts, 'id', intOpt({ id: opts._[0] }, 'id'));
    const title = requestedTaskId ? (opts.title || null) : required(opts, 'title');
    const body = opts.body || '';
    const priority = intOpt(opts, 'priority', 100);
    const customMessage = opts.message ? String(opts.message) : null;
    const injectAllowed = !Boolean(opts['no-inject']);

    let task = null;
    let messageId = null;
    let currentTask = null;
    let previousAssignee = null;
    const db = connect(ctx);
    try {
      touchCurrentPeer(db, ctx, identity, null, 'shell');
      const t = now();
      task = tx(db, () => {
        if (requestedTaskId) {
          const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(requestedTaskId);
          if (!existing) throw new CliError('NOT_FOUND', `Task #${requestedTaskId} does not exist`);
          if (['done', 'abandoned'].includes(existing.status)) {
            throw new CliError('BAD_STATE', `Task #${requestedTaskId} is ${existing.status}`);
          }
          if (existing.owner && existing.owner !== target) {
            throw new CliError('TASK_OWNED', `Task #${requestedTaskId} is owned by ${existing.owner}`, {
              owner: existing.owner,
              task_id: requestedTaskId,
              attempted_by: actor,
              target
            });
          }
          previousAssignee = existing.assignee || null;
          db.prepare('UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?').run(target, t, requestedTaskId);
          return db.prepare('SELECT * FROM tasks WHERE id = ?').get(requestedTaskId);
        }
        const info = db.prepare(`
          INSERT INTO tasks(title, body, status, assignee, owner, parent_id, team_role, priority, created_by, created_at, updated_at)
          VALUES (?, ?, 'pending', ?, NULL, NULL, NULL, ?, ?, ?, ?)
        `).run(title, body, target, priority, actor, t, t);
        const taskId = Number(info.lastInsertRowid);
        addEvent(db, 'task.created', actor, taskId, { title, assignee: target, priority, parent_id: null, team_role: null });
        return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      });
      const durableMessage = dispatchPromptText(task, customMessage);
      messageId = sendMessage(db, actor, target, task.id, 'task', durableMessage);
      currentTask = currentOwnedTaskForPeer(db, target);
    } finally {
      db.close();
    }

    const durableMessage2 = dispatchPromptText(task, customMessage);
    let session = null;
    let injected = false;
    let injectionReason = injectAllowed ? 'runtime_unavailable' : 'no_inject';
    const busyTask = currentTask && Number(currentTask.id) !== Number(task.id) ? currentTask : null;
    if (injectAllowed) {
      let runtime = null;
      let runtimeData = null;
      try {
        runtime = readRuntime(ctx);
        runtimeData = await runtimeRequest(ctx, 'GET', '/api/sessions', null, runtime);
      } catch (err) {
        if (!(err instanceof CliError) || !['RUNTIME_NOT_RUNNING', 'RUNTIME_UNREACHABLE'].includes(err.code)) throw err;
      }
      session = runtimeData ? findRuntimeSessionForPeer(runtimeData, target) : null;
      if (!session) {
        injectionReason = runtimeData ? 'session_not_running' : 'runtime_unavailable';
      } else if (!customMessage && !sessionLooksProviderInteractive(session)) {
        injectionReason = 'unsupported_session_kind';
      } else if (busyTask && !Boolean(opts.force)) {
        injectionReason = 'target_busy';
      } else {
        try {
          await injectPeer(ctx, target, durableMessage2, true, runtime, actor);
          injected = true;
          injectionReason = 'injected';
        } catch (err) {
          if (!(err instanceof CliError)) throw err;
          if (['RUNTIME_NOT_RUNNING', 'RUNTIME_UNREACHABLE'].includes(err.code)) {
            injectionReason = 'runtime_unavailable';
          } else if (['NOT_FOUND', 'SESSION_NOT_RUNNING'].includes(err.code)) {
            injectionReason = 'session_not_running';
          } else {
            throw err;
          }
        }
      }
    }

    const eventDb = connect(ctx);
    try {
      addEvent(eventDb, 'task.dispatched', actor, task.id, auditPayload({
        actor, target, source: 'cli', admin: actor !== target,
        task_id: task.id, title: task.title, message_id: messageId,
        injected, injection_reason: injectionReason, busy_task: busyTask?.id || null,
        previous_assignee: previousAssignee
      }));
    } finally {
      eventDb.close();
    }
    const result = {
      task,
      target,
      message_id: messageId,
      message: durableMessage2,
      injected,
      delivery: injected ? 'message+inject' : 'message-only',
      injection_reason: injectionReason,
      session: session ? {
        id: session.id,
        peer_id: session.peer_id || session.id,
        kind: session.kind,
        status: session.status
      } : null,
      previous_assignee: previousAssignee,
      blocked_by_task: busyTask ? {
        id: busyTask.id,
        status: busyTask.status,
        title: busyTask.title
      } : null
    };
    printResult(ctx, result, (data) => {
      const base = `dispatched task #${data.task.id} to ${data.target} with message #${data.message_id}`;
      if (data.injected) return `${base} and injected live input`;
      if (data.injection_reason === 'target_busy' && data.blocked_by_task) {
        return `${base} (not injected: ${data.target} already owns task #${data.blocked_by_task.id})`;
      }
      if (data.injection_reason === 'unsupported_session_kind' && data.session) {
        return `${base} (not injected: managed ${data.session.kind} session needs an explicit shell-safe message)`;
      }
      if (data.injection_reason === 'session_not_running') return `${base} (not injected: target is not a running managed session)`;
      if (data.injection_reason === 'runtime_unavailable') return `${base} (not injected: web runtime is unavailable)`;
      if (data.injection_reason === 'no_inject') return `${base} (message only)`;
      return `${base} (not injected: ${data.injection_reason})`;
    });
  }

  async function taskList(ctx, args) {
    const opts = parseOpts(args, { booleans: ['all'] });
    const status = opts.status || null;
    const peer = opts.peer || null;
    const limit = intOpt(opts, 'limit', 50);
    const db = connect(ctx);
    let rows;
    if (status && peer) {
      rows = db.prepare(`SELECT * FROM tasks WHERE status = ? AND (owner = ? OR assignee = ?) ORDER BY priority ASC, id ASC LIMIT ?`).all(status, peer, peer, limit);
    } else if (status) {
      rows = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, id ASC LIMIT ?').all(status, limit);
    } else if (opts.all && peer) {
      rows = db.prepare(`SELECT * FROM tasks WHERE owner = ? OR assignee = ? ORDER BY status ASC, priority ASC, id ASC LIMIT ?`).all(peer, peer, limit);
    } else if (opts.all) {
      rows = db.prepare('SELECT * FROM tasks ORDER BY status ASC, priority ASC, id ASC LIMIT ?').all(limit);
    } else if (peer) {
      rows = queryOpenTasks(db, limit, peer);
    } else {
      rows = queryOpenTasks(db, limit);
    }
    const t = now();
    const peers = db.prepare(`SELECT id, status, pid, pid_start_token, pid_command_hash, last_seen_at, (? - last_seen_at) AS age_sec FROM peers`).all(t);
    for (const peerRow of peers) {
      const binding = db.prepare(`SELECT transport, runtime_target FROM peer_bindings WHERE peer = ?`).get(peerRow.id) || null;
      const evidence = observePeerEvidence(ctx, peerRow, binding);
      peerRow.evidence_state = evidence.state;
      peerRow.evidence_reason = evidence.reason;
    }
    const graceUntil = readClockGraceUntil(db);
    const locks = clockGraceSuppressed(t, graceUntil)
      ? db.prepare('SELECT * FROM locks').all()
      : db.prepare('SELECT * FROM locks WHERE expires_at > ?').all(t);
    rows = annotateTasksWithLiveness(rows, peers, locks, t, ACTIVE_PEER_TTL, graceUntil);
    printResult(ctx, rows, (data) => table(data, [
      { label: 'id', value: (r) => `#${r.id}` },
      { label: 'status', value: (r) => r.status },
      { label: 'prio', value: (r) => r.priority },
      { label: 'assignee', value: (r) => r.assignee || '' },
      { label: 'owner', value: (r) => r.owner || '' },
      { label: 'owner_state', value: (r) => taskOwnerStateText(r) },
      { label: 'parent', value: (r) => r.parent_id ? `#${r.parent_id}` : '' },
      { label: 'role', value: (r) => r.team_role || '' },
      { label: 'title', value: (r) => r.title }
    ]));
  }

  async function taskClaim(ctx, args) {
    const opts = parseOpts(args, { booleans: ['force'], arrays: ['id', 'ids'] });
    const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
    const peer = identity.id;
    const ids = parseTaskIds(opts);
    const db = connect(ctx);
    touchCurrentPeer(db, ctx, identity, 'working', 'shell');
    let tasks;
    try {
      tasks = claimTaskRowsForPeer(db, peer, ids, { force: Boolean(opts.force) });
    } catch (err) {
      notifyTaskOwnerConflict(ctx, err);
      throw err;
    }
    printResult(ctx, ids.length === 1 ? tasks[0] : tasks, (data) => taskRowsText(Array.isArray(data) ? data : [data], 'claimed'));
  }

  function notifyTaskOwnerConflict(ctx, err) {
    if (err?.code !== 'TASK_OWNED' || !err.extra?.notify_owner) return;
    const { owner, task_id: taskId, attempted_by: attemptedBy, action } = err.extra;
    if (!owner || !attemptedBy || owner === attemptedBy) return;
    let db = null;
    try {
      db = connect(ctx);
      sendMessage(db, attemptedBy, owner, taskId || null, 'task.owner-conflict',
        `Task #${taskId} is owned by ${owner}; ${attemptedBy} attempted ${action || 'modify'} and hello-cc left ownership unchanged.`);
      err.extra.notified = true;
    } catch {
      err.extra.notified = false;
    } finally {
      try { db?.close(); } catch {}
    }
  }

  async function taskTakeover(ctx, args) {
    const opts = parseOpts(args, { booleans: ['force'] });
    const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
    const peer = identity.id;
    const id = intOpt(opts, 'id', intOpt({ id: opts._[0] }, 'id'));
    if (!id) throw new CliError('BAD_ARGS', 'Missing --id');
    const reason = required(opts, 'reason');
    const policy = opts.force ? 'any' : (opts.policy || 'blocked-or-stale');
    const staleAfter = positiveIntOpt(opts, 'stale-after', ACTIVE_PEER_TTL, { max: 86400 * 30 });
    const db = connect(ctx);
    touchCurrentPeer(db, ctx, identity, 'working', 'shell');
    const task = takeOverTaskForPeer(db, peer, id, {
      reason, policy, staleAfter,
      ownerEvidenceFor: (_owner, _row, ownerRow, binding) => observePeerEvidence(ctx, ownerRow, binding)
    });
    printResult(ctx, task, (data) => `took over task #${data.id}: ${data.title}`);
  }

  async function taskNext(ctx, args) {
    const opts = parseOpts(args, { booleans: ['force'] });
    const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
    const peer = identity.id;
    const count = positiveIntOpt(opts, 'count', 1, { max: 50 });
    const db = connect(ctx);
    touchCurrentPeer(db, ctx, identity, 'working', 'shell');
    const result = claimNextTasksForPeer(db, peer, { force: Boolean(opts.force), count });
    printResult(ctx, count === 1 ? (result.current || result.tasks[0] || null) : result, (data) => {
      if (!data) return 'no pending task';
      if (data.current === true) return `current task #${data.id}: ${data.title} (${data.status})`;
      if (data.current) return `current task #${data.current.id}: ${data.current.title} (${data.current.status})`;
      if (data.tasks) return data.tasks.length ? taskRowsText(data.tasks, 'claimed') : 'no pending task';
      return `claimed task #${data.id}: ${data.title}`;
    });
  }

  async function taskUpdate(ctx, args) {
    const opts = parseOpts(args, { booleans: ['force'] });
    const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
    const peer = identity.id;
    const id = intOpt(opts, 'id', intOpt({ id: opts._[0] }, 'id'));
    const status = required(opts, 'status');
    if (!['pending', 'claimed', 'running', 'review', 'blocked', 'done', 'abandoned'].includes(status)) {
      throw new CliError('BAD_ARGS', `Unsupported status: ${status}`);
    }
    if (!id) throw new CliError('BAD_ARGS', 'Missing --id');
    const db = connect(ctx);
    touchCurrentPeer(db, ctx, identity, status === 'done' ? 'idle' : 'working', 'shell');
    let task;
    try {
      task = tx(db, () => {
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        if (!row) throw new CliError('NOT_FOUND', `Task #${id} does not exist`);
        assertTaskOwnerForMutation(db, peer, row, `update:${status}`);
        const t = now();
        const completedAt = status === 'done' ? t : row.completed_at;
        db.prepare(`UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?`).run(status, completedAt, t, id);
        addEvent(db, `task.${status}`, peer, id, { summary: opts.summary || opts.reason || '' });
        if (opts.body) {
          sendMessage(db, peer, opts.to || 'all', id, 'task.update', opts.body);
        }
        return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      });
    } catch (err) {
      notifyTaskOwnerConflict(ctx, err);
      throw err;
    }
    printResult(ctx, task, (data) => `task #${data.id} -> ${data.status}`);
  }

  async function taskStatusShortcut(ctx, status, args) {
    return taskUpdate(ctx, args.concat(['--status', status]));
  }

  async function taskDone(ctx, args) {
    const opts = parseOpts(args, { booleans: ['force'] });
    opts.status = 'done';
    if (opts.summary && !opts.body) opts.body = opts.summary;
    return taskUpdate(ctx, args.concat(['--status', 'done']));
  }

  return { cmdTask, notifyTaskOwnerConflict };
}
