// Team CLI commands extracted from bin/hcc.mjs.

export function createTeamCommands(deps) {
  const {
    connect, now, tx, addEvent, touchCurrentPeer, resolveCurrentPeer,
    parseOpts, intOpt, wantsHelp, helpTeam, printResult, CliError,
    CLI_NAME, sendMessage,
    taskById, teamChildren, teamSummary,
    inferTeamItems, assignTeamWorkers, expandTeamWorkers,
    shellQuoteArg
  } = deps;

  async function cmdTeam(ctx, args) {
    const sub = args[0];
    if (!sub || wantsHelp(args)) return helpTeam();
    if (sub === 'plan') return teamPlan(ctx, args.slice(1));
    if (sub === 'start') return teamStart(ctx, args.slice(1));
    if (sub === 'status') return teamStatus(ctx, args.slice(1));
    throw new CliError('BAD_ARGS', `Unknown team command: ${sub}`);
  }

  async function teamPlan(ctx, args) {
    const opts = parseOpts(args, { arrays: ['item'] });
    const parentId = intOpt(opts, 'from-task', intOpt(opts, 'task', intOpt({ task: opts._[0] }, 'task')));
    if (!parentId) throw new CliError('BAD_ARGS', 'Missing --from-task');
    const db = connect(ctx);
    const parent = taskById(db, parentId);
    if (!parent) throw new CliError('NOT_FOUND', `Task #${parentId} does not exist`);
    const items = assignTeamWorkers(inferTeamItems(parent, opts), opts.workers, parentId);
    const data = { parent, items };
    printResult(ctx, data, (plan) => {
      const lines = [`team plan for task #${plan.parent.id}: ${plan.parent.title}`];
      plan.items.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.role}: ${item.title}${item.assignee ? ` -> ${item.assignee}` : ''}`);
      });
      lines.push('', `start: ${CLI_NAME} team start --from-task ${plan.parent.id} ${plan.items.map((item) => `--item ${shellQuoteArg(`${item.assignee ? `${item.assignee}:` : ''}${item.role}:${item.title}`)}`).join(' ')}`.trim());
      return lines.join('\n');
    });
  }

  async function teamStart(ctx, args) {
    const opts = parseOpts(args, { arrays: ['item'], booleans: ['force'] });
    const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
    const actor = identity.id;
    const parentId = intOpt(opts, 'from-task', intOpt(opts, 'task', intOpt({ task: opts._[0] }, 'task')));
    if (!parentId) throw new CliError('BAD_ARGS', 'Missing --from-task');
    const priorityBase = intOpt(opts, 'priority', 100);
    const db = connect(ctx);
    touchCurrentPeer(db, ctx, identity, null, 'shell');
    const result = tx(db, () => {
      const parent = taskById(db, parentId);
      if (!parent) throw new CliError('NOT_FOUND', `Task #${parentId} does not exist`);
      const existing = teamChildren(db, parentId);
      if (existing.length && !opts.force) {
        throw new CliError('TEAM_EXISTS', `Task #${parentId} already has ${existing.length} team subtask(s); use --force to add more`, {
          parent_id: parentId,
          children: existing.map((task) => task.id)
        });
      }
      const items = assignTeamWorkers(inferTeamItems(parent, opts), opts.workers, parentId);
      const t = now();
      const children = [];
      items.forEach((item, index) => {
        const info = db.prepare(`
          INSERT INTO tasks(title, body, status, assignee, owner, parent_id, team_role, priority, created_by, created_at, updated_at)
          VALUES (?, ?, 'pending', ?, NULL, ?, ?, ?, ?, ?, ?)
        `).run(
          item.title,
          opts.body || `Subtask for #${parentId}: ${parent.title}`,
          item.assignee || null,
          parentId,
          item.role || `worker-${index + 1}`,
          priorityBase + index,
          actor,
          t,
          t
        );
        const taskId = Number(info.lastInsertRowid);
        addEvent(db, 'task.created', actor, taskId, {
          title: item.title,
          assignee: item.assignee || null,
          priority: priorityBase + index,
          parent_id: parentId,
          team_role: item.role || null
        });
        if (item.assignee) sendMessage(db, actor, item.assignee, taskId, 'task', `Task #${taskId} assigned: ${item.title}`);
        children.push(taskById(db, taskId));
      });
      addEvent(db, 'team.started', actor, parentId, {
        child_tasks: children.map((task) => task.id),
        workers: expandTeamWorkers(opts.workers || [], parentId)
      });
      return { parent, children };
    });
    printResult(ctx, result, (data) => {
      const lines = [`started team for task #${data.parent.id}: ${data.children.length} subtask${data.children.length === 1 ? '' : 's'}`];
      for (const child of data.children) {
        lines.push(`- #${child.id} ${child.team_role || 'worker'}${child.assignee ? ` -> ${child.assignee}` : ''}: ${child.title}`);
      }
      return lines.join('\n');
    });
  }

  async function teamStatus(ctx, args) {
    const opts = parseOpts(args);
    const parentId = intOpt(opts, 'task', intOpt(opts, 'from-task', intOpt({ task: opts._[0] }, 'task')));
    if (!parentId) throw new CliError('BAD_ARGS', 'Missing --task');
    const db = connect(ctx);
    const data = teamSummary(db, parentId);
    printResult(ctx, data, (summary) => {
      const countText = Object.entries(summary.counts).map(([status, count]) => `${status}:${count}`).join(', ') || 'none';
      const lines = [
        `team task #${summary.parent.id}: ${summary.parent.title}`,
        `parent status: ${summary.parent.status}`,
        `subtasks: ${summary.children.length} (${countText})`
      ];
      for (const child of summary.children) {
        lines.push(`- #${child.id} ${child.status} ${child.team_role || 'worker'}${child.owner ? ` owner=${child.owner}` : ''}${child.assignee ? ` assignee=${child.assignee}` : ''}: ${child.title}`);
      }
      if (summary.handoffs.length) {
        lines.push('handoffs:');
        for (const handoff of summary.handoffs.slice(-8)) {
          lines.push(`- #${handoff.id} task #${handoff.task_id || ''} ${handoff.from_peer}${handoff.to_peer ? ` -> ${handoff.to_peer}` : ''}: ${handoff.summary}`);
        }
      }
      return lines.join('\n');
    });
  }

  return { cmdTeam };
}
