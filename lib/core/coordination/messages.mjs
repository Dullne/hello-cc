import { CliError } from '../../errors.mjs';

function defaultNow() {
  return Math.floor(Date.now() / 1000);
}

function noopEvent() {}

export function createMessageStore(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : defaultNow;
  const addEvent = typeof deps.addEvent === 'function' ? deps.addEvent : noopEvent;

  function sendMessage(db, sender, recipient, taskId, kind, body, meta = {}) {
    const replyTo = meta.reply_to || null;
    const threadId = meta.thread_id || null;
    const info = db.prepare(`
      INSERT INTO messages(sender, recipient, task_id, kind, body, reply_to, thread_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sender, recipient || 'all', taskId || null, kind || 'note', body, replyTo, threadId, now());
    const messageId = Number(info.lastInsertRowid);
    if (!threadId) {
      db.prepare('UPDATE messages SET thread_id = ? WHERE id = ?').run(messageId, messageId);
    }
    addEvent(db, 'message.sent', sender, taskId || null, {
      message_id: messageId,
      recipient: recipient || 'all',
      kind: kind || 'note',
      reply_to: replyTo,
      thread_id: threadId || messageId
    });
    return messageId;
  }

  function queryInbox(db, peer, includeAll, limit) {
    return db.prepare(`
      SELECT
        m.id, m.sender, m.recipient, m.task_id, m.kind, m.body,
        m.reply_to, m.thread_id, m.created_at, r.read_at
      FROM messages m
      LEFT JOIN message_reads r
        ON r.message_id = m.id AND r.peer = ?
      WHERE
        (m.recipient IS NULL OR m.recipient = '' OR m.recipient = 'all' OR m.recipient = ?)
        AND (? = 1 OR r.read_at IS NULL)
      ORDER BY m.id ASC
      LIMIT ?
    `).all(peer, peer, includeAll ? 1 : 0, limit);
  }

  function queryTimelineMessages(db, peer, limit) {
    if (!peer) {
      return db.prepare(`
        SELECT id, sender, recipient, task_id, kind, body, reply_to, thread_id, created_at
        FROM messages
        ORDER BY id DESC
        LIMIT ?
      `).all(limit).reverse();
    }
    return db.prepare(`
      SELECT
        m.id, m.sender, m.recipient, m.task_id, m.kind, m.body,
        m.reply_to, m.thread_id, m.created_at, r.read_at
      FROM messages m
      LEFT JOIN message_reads r
        ON r.message_id = m.id AND r.peer = ?
      WHERE
        m.sender = ?
        OR m.recipient IS NULL
        OR m.recipient = ''
        OR m.recipient = 'all'
        OR m.recipient = ?
      ORDER BY m.id DESC
      LIMIT ?
    `).all(peer, peer, peer, limit).reverse();
  }

  function getMessage(db, id) {
    return db.prepare(`
      SELECT id, sender, recipient, task_id, kind, body, reply_to, thread_id, created_at
      FROM messages
      WHERE id = ?
    `).get(id);
  }

  function queryMessageThread(db, messageId, limit) {
    const message = getMessage(db, messageId);
    if (!message) throw new CliError('NOT_FOUND', `Message #${messageId} does not exist`);
    const threadId = message.thread_id || message.id;
    const rows = db.prepare(`
      SELECT id, sender, recipient, task_id, kind, body, reply_to, thread_id, created_at
      FROM messages
      WHERE id = ? OR thread_id = ?
      ORDER BY id ASC
      LIMIT ?
    `).all(message.id, threadId, limit);
    return { message, thread_id: threadId, messages: rows };
  }

  function ackMessage(db, peer, message) {
    db.prepare(`
      INSERT INTO message_reads(message_id, peer, read_at)
      VALUES (?, ?, ?)
      ON CONFLICT(message_id, peer) DO UPDATE SET read_at = excluded.read_at
    `).run(message.id, peer, now());
    addEvent(db, 'message.ack', peer, message.task_id || null, { message_id: message.id });
  }

  return {
    ackMessage,
    getMessage,
    queryInbox,
    queryMessageThread,
    queryTimelineMessages,
    sendMessage
  };
}
