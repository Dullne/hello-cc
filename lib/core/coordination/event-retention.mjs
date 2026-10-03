export const DURABLE_RUNTIME_EVENTS = `
  SELECT MAX(e.id)
  FROM events e
  JOIN peer_bindings b
    ON b.peer = json_extract(e.payload, '$.target_peer')
  WHERE e.type = 'tmux.session.attached'
    AND b.transport = 'tmux'
    AND (b.runtime_target IS NULL OR b.runtime_target = json_extract(e.payload, '$.pane'))
  GROUP BY b.peer, b.runtime_target
  UNION
  SELECT MAX(e.id) FROM events e
  WHERE e.type IN ('web.adoption.paused','web.adoption.resumed') AND json_valid(e.payload)
  GROUP BY json_extract(e.payload, '$.peer'), json_extract(e.payload, '$.pane')
  UNION
  SELECT e.id FROM events e WHERE e.type = 'codex.submission.pending'
  UNION
  SELECT e.id FROM events e WHERE e.type = 'task.result.recorded'
  UNION
  SELECT e.id FROM events e WHERE e.type = 'native.web.submission.pending'
  UNION
  SELECT e.id FROM events e WHERE e.type = 'codex.executor.started'
`;

export function pruneOldEventsPreservingTmuxAuthority(db, cutoff, options = {}) {
  const predicate = `created_at < ? AND id NOT IN (${DURABLE_RUNTIME_EVENTS})`;
  const count = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${predicate}`).get(cutoff).n;
  if (!options.dryRun) db.prepare(`DELETE FROM events WHERE ${predicate}`).run(cutoff);
  return Number(count || 0);
}
