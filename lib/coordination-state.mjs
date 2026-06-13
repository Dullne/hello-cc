import {
  deriveAutomation,
  renderAutomationContext
} from './automation.mjs';
import {
  annotateTasksWithLiveness,
  formatOpenTaskLine
} from './task-liveness.mjs';
import { lockLabel } from './locks.mjs';
import { timelineFromRows } from './timeline.mjs';

const DEFAULT_ACTIVE_PEER_TTL = 600;
const DEFAULT_LOCK_TTL = 900;
const DEFAULT_CLI_NAME = 'hcc';

function defaultNow() {
  return Math.floor(Date.now() / 1000);
}

function requireFn(value, name) {
  if (typeof value !== 'function') throw new TypeError(`createCoordinationState requires deps.${name}`);
  return value;
}

export function createCoordinationState(deps = {}) {
  const activePeerTtl = Number(deps.activePeerTtl ?? DEFAULT_ACTIVE_PEER_TTL);
  const cliName = deps.cliName || DEFAULT_CLI_NAME;
  const connect = requireFn(deps.connect, 'connect');
  const defaultLockTtl = Number(deps.defaultLockTtl ?? DEFAULT_LOCK_TTL);
  const now = typeof deps.now === 'function' ? deps.now : defaultNow;
  const queryInbox = requireFn(deps.queryInbox, 'queryInbox');
  const queryOpenTasks = requireFn(deps.queryOpenTasks, 'queryOpenTasks');
  const queryTimelineMessages = requireFn(deps.queryTimelineMessages, 'queryTimelineMessages');
  const touchCurrentPeer = typeof deps.touchCurrentPeer === 'function'
    ? deps.touchCurrentPeer
    : () => {};

  function collectStateSnapshot(db, ctx, peer = null, opts = {}) {
    const t = now();
    const peers = db.prepare(`
      SELECT id, kind, role, status, worktree, branch, pid, capabilities,
             created_at, last_seen_at, (? - last_seen_at) AS age_sec
      FROM peers
      ORDER BY last_seen_at DESC, id ASC
      LIMIT 200
    `).all(t);
    const taskRows = queryOpenTasks(db, 200);
    const locks = db.prepare(`
      SELECT resource, base_resource, scope, owner, task_id, reason, expires_at, created_at
      FROM locks
      WHERE expires_at > ?
      ORDER BY resource ASC
      LIMIT 200
    `).all(t);
    const tasks = annotateTasksWithLiveness(taskRows, peers, locks, t, activePeerTtl);
    const messages = peer
      ? queryInbox(db, peer, false, 50)
      : db.prepare(`
          SELECT id, sender, recipient, task_id, kind, body, reply_to, thread_id, created_at
          FROM messages
          ORDER BY id DESC
          LIMIT 50
        `).all().reverse();
    const timelineMessages = queryTimelineMessages(db, peer, 80);
    const handoffs = db.prepare(`
      SELECT id, task_id, from_peer, to_peer, summary, changed_files, tests, risks, created_at
      FROM handoffs
      ORDER BY id DESC
      LIMIT 50
    `).all().reverse();
    const events = db.prepare(`
      SELECT id, type, actor, task_id, payload, created_at
      FROM events
      ORDER BY id DESC
      LIMIT 80
    `).all().reverse();
    const snapshot = {
      root: ctx.root,
      db: ctx.dbPath,
      now: t,
      active_peer_ttl: activePeerTtl,
      peers,
      tasks,
      locks,
      messages,
      handoffs,
      events
    };
    snapshot.timeline = timelineFromRows({ messages: timelineMessages, handoffs, tasks, locks, events }, peer);
    snapshot.automation = deriveAutomation(snapshot, peer, opts, {
      activePeerTtl,
      defaultLockTtl,
      cliName
    });
    return snapshot;
  }

  function buildHookCoordinationContext(db, ctx, peerId) {
    const snapshot = collectStateSnapshot(db, ctx, peerId);
    const openTasks = snapshot.tasks.slice(0, 8);
    const unread = snapshot.messages.slice(0, 5);
    const peers = snapshot.peers.slice(0, 8);
    const parts = [
      '[hello-cc coordination]',
      `peer: ${peerId}`,
      'This is live project coordination context injected by hello-cc.',
      'You are not isolated for project coordination: hcc is the source of truth for other Claude/Codex/shell sessions in this project.',
      'If the user asks what other sessions are doing, what tasks exist, or whether you can see other sessions, do not answer from generic model knowledge and do not say sessions are isolated. Run hcc status, hcc state, hcc peers, hcc task list, hcc msg inbox, and hcc lock list, then answer from those results.',
      'Tasks are project work facts, not read/unread items. Open tasks stay relevant to every session until they are marked done or abandoned. Messages are the unread/ack notification channel.',
      'If you already own a current task, continue that task until handoff/done/blocked; do not claim a different task just because a new prompt arrived.',
      'When a hello-cc message asks for a response, reply with hcc msg reply --id <message-id> --body "<answer>" so the answer stays in the same thread.'
    ];

    if (peers.length > 0) {
      parts.push('[hello-cc known peers]');
      parts.push(...peers.map((peer) => {
        const age = Math.max(0, snapshot.now - Number(peer.last_seen_at || 0));
        const active = age <= activePeerTtl ? 'active' : 'stale';
        return `- ${peer.id} ${peer.kind || 'other'} ${peer.status || 'idle'} ${active}`;
      }));
    } else {
      parts.push('[hello-cc known peers]\n(none)');
    }

    if (snapshot.automation.current_task) {
      const task = snapshot.automation.current_task;
      parts.push('[hello-cc current task]');
      parts.push(`#${task.id} ${task.status}: ${task.title}`);
    }

    if (openTasks.length > 0) {
      parts.push('[hello-cc open tasks]');
      parts.push(...openTasks.map((task) => `- ${formatOpenTaskLine(task)}`));
    } else {
      parts.push('[hello-cc open tasks]\n(none)');
    }

    if (unread.length > 0) {
      parts.push('[hello-cc unread messages]');
      parts.push(...unread.map((m) =>
        `- #${m.id} from ${m.sender}${m.task_id ? ` task #${m.task_id}` : ''}${m.reply_to ? ` reply #${m.reply_to}` : ''}: ${m.body}`
      ));
    } else {
      parts.push('[hello-cc unread messages]\n(none)');
    }

    if (snapshot.locks.length > 0) {
      parts.push('[hello-cc active locks]');
      parts.push(...snapshot.locks.slice(0, 8).map((lock) =>
        `- ${lockLabel(lock)} owner=${lock.owner}${lock.task_id ? ` task #${lock.task_id}` : ''}`));
    } else {
      parts.push('[hello-cc active locks]\n(none)');
    }

    parts.push(renderAutomationContext(snapshot.automation));

    return { text: parts.join('\n'), messages: unread };
  }

  function ackMessages(db, peerId, messages) {
    if (!messages.length) return;
    const t = now();
    for (const m of messages) {
      db.prepare(`
        INSERT INTO message_reads(message_id, peer, read_at)
        VALUES (?, ?, ?)
        ON CONFLICT(message_id, peer) DO UPDATE SET read_at = excluded.read_at
      `).run(m.id, peerId, t);
    }
  }

  function statusSummary(ctx, peer = null, identity = null) {
    const db = connect(ctx);
    try {
      if (identity) touchCurrentPeer(db, ctx, identity, null, 'shell');
      const t = now();
      const activePeers = db.prepare('SELECT COUNT(*) AS n FROM peers WHERE last_seen_at >= ?').get(t - activePeerTtl).n;
      const stalePeers = db.prepare('SELECT COUNT(*) AS n FROM peers WHERE last_seen_at < ?').get(t - activePeerTtl).n;
      const taskRows = db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status ORDER BY status').all();
      const locks = db.prepare('SELECT COUNT(*) AS n FROM locks WHERE expires_at > ?').get(t).n;
      const unread = peer ? queryInbox(db, peer, false, 1000).length : null;
      const recent = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 8').all().reverse();
      return {
        root: ctx.root,
        db: ctx.dbPath,
        active_peers: activePeers,
        stale_peers: stalePeers,
        tasks: taskRows,
        active_locks: locks,
        unread,
        recent_events: recent
      };
    } finally {
      db.close();
    }
  }

  function statusSnapshot(ctx, peer = null, opts = {}) {
    const db = connect(ctx);
    try {
      return collectStateSnapshot(db, ctx, peer, opts);
    } finally {
      try {
        db.close();
      } catch {
        // Ignore close failures for short-lived snapshots.
      }
    }
  }

  return {
    ackMessages,
    buildHookCoordinationContext,
    collectStateSnapshot,
    statusSnapshot,
    statusSummary
  };
}
