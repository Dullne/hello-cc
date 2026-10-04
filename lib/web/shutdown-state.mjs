import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { contextForProject } from '../runtime/paths.mjs';
import { clearRuntime } from '../runtime/state.mjs';
import { readProjectRegistry } from '../runtime/projects.mjs';

// This budget bounds work admitted between synchronous operations. Nonblocking
// leases avoid contention waits; their worker startup/release and filesystem
// validation retain their own bounds. This is not a total shutdown deadline.
export function cleanupRuntimeState({
  ctx, sessions, connectWebProject, now, ownerIdentity,
  budgetMs = 1000, monotonicNow = () => performance.now(),
  readProjects = readProjectRegistry, clearPointers = clearRuntime
}) {
  const deadline = monotonicNow() + budgetMs;
  const expired = () => monotonicNow() >= deadline;
  const result = { detachedProjects: 0, skippedProjects: 0 };
  const pointerOptions = { nonblocking: true, expectedIdentity: ownerIdentity, deadline, monotonicNow };
  // Only this process instance may clear its pointers. A missing identity is
  // left for the normal stale-pointer recovery path after the owner exits.
  if (ownerIdentity) {
    try { clearPointers(ctx, ownerIdentity.pid, pointerOptions); } catch {}
    const seen = new Set([path.resolve(ctx.root)]);
    try {
      if (!expired()) for (const project of readProjects()) {
        if (expired()) break;
        const root = path.resolve(project.root);
        if (seen.has(root)) continue;
        seen.add(root);
        clearPointers({ root }, ownerIdentity.pid, { ...pointerOptions, clearGlobal: false });
      }
    } catch {}
  }

  const byProject = new Map();
  for (const session of sessions.values()) {
    if (expired()) return result;
    // The PTY factory predates explicit session.type; serialization uses the
    // same PTY default. Require its actual handle before accepting that shape.
    const type = session.type ?? (session.pty && typeof session.pty === 'object' ? 'pty' : null);
    if (session.status !== 'running' || !['tmux', 'pty'].includes(type)) continue;
    const peer = session.peerId || session.id;
    if (!peer) continue;
    try {
      const projectCtx = session.ctx || contextForProject(path.resolve(session.root || ctx.root), null, { json: ctx.json });
      const identity = projectCtx.rootIdentity?.identity;
      const key = [projectCtx.root, projectCtx.dbPath, identity?.dev, identity?.ino, identity?.birthtimeNs].join('\0');
      if (!byProject.has(key)) byProject.set(key, { projectCtx, sessions: [] });
      byProject.get(key).sessions.push({ peer, id: session.id, type,
        pane: session.pane, pid: session.pid });
    } catch { result.skippedProjects++; }
  }
  for (const { projectCtx, sessions: owned } of byProject.values()) {
    if (expired()) break;
    let db;
    try {
      db = connectWebProject(projectCtx, { create: false, existingSchema: true });
      if (expired()) continue;
      // Do not use tx(): its normal write path retries busy writers. Both
      // advisory changes either commit together now or are left for recovery.
      db.exec('BEGIN IMMEDIATE');
      try {
        projectCtx.rootIdentity?.assertUnchanged();
        const ids = [];
        const binding = db.prepare(`SELECT p.pid, b.transport, b.runtime_session_id, b.runtime_target
          FROM peers p JOIN peer_bindings b ON b.peer = p.id WHERE p.id = ?`);
        for (const session of owned) {
          if (expired()) break;
          const row = binding.get(session.peer);
          if (!row || row.transport !== (session.type === 'tmux' ? 'tmux' : 'web-pty') ||
              row.runtime_session_id !== session.id ||
              (session.type === 'tmux' && row.runtime_target !== session.pane) ||
              (Number.isInteger(session.pid) && row.pid !== session.pid)) continue;
          ids.push(session.peer);
        }
        if (ids.length && !expired()) {
          const placeholders = ids.map(() => '?').join(',');
          db.prepare(`UPDATE peers SET status = 'detached' WHERE id IN (${placeholders}) AND status IN ('running','working','busy')`).run(...ids);
          db.prepare(`UPDATE peer_bindings SET runtime_target = NULL, updated_at = ? WHERE peer IN (${placeholders})`).run(now(), ...ids);
        }
        if (expired()) db.exec('ROLLBACK');
        else { db.exec('COMMIT'); result.detachedProjects++; }
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    } catch { result.skippedProjects++; }
    finally { try { db?.close(); } catch {} }
  }
  return result;
}
