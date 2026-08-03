const CURRENT_TMUX_AUTHORITIES = `
  SELECT MAX(e.id)
  FROM events e
  JOIN peer_bindings b
    ON b.peer = json_extract(e.payload, '$.target_peer')
  WHERE e.type = 'tmux.session.attached'
    AND b.transport = 'tmux'
    AND (b.runtime_target IS NULL OR b.runtime_target = json_extract(e.payload, '$.pane'))
  GROUP BY b.peer, b.runtime_target
`;

export function pruneOldEventsPreservingTmuxAuthority(db, cutoff, options = {}) {
  const predicate = `created_at < ? AND id NOT IN (${CURRENT_TMUX_AUTHORITIES})`;
  const count = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${predicate}`).get(cutoff).n;
  if (!options.dryRun) db.prepare(`DELETE FROM events WHERE ${predicate}`).run(cutoff);
  return Number(count || 0);
}
