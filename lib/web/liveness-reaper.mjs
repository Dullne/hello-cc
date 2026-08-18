// Clock-aware liveness reaper, extracted from lib/web/runtime-main.mjs.
// Backstop for peers that died without an exit signal: wall-vs-monotonic
// drift detection, per-project stale candidates, and evidence-checked
// mutation through the shared clock-safety observer.

import path from 'node:path';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { CLOCK_GRACE_SEC, classifyClockDrift, clockGraceSuppressed, readClockGraceUntil } from '../shared/clock-grace.mjs';
import { peerEvidenceAllowsReap } from '../core/peers/evidence.mjs';

export function createLivenessReaper(deps) {
  const {
    ctx, projectContexts, sessions,
    sessionsForProject, connectWebProject,
    now, addEvent,
    peerEvidenceFromDb, mutatePeerWithEvidence, observeClockSafetyOrThrow,
    UNKNOWN_EVIDENCE_GRACE_SEC, redactedLogText, sameResolvedPath
  } = deps;


  // ── Liveness reaper ───────────────────────────────────────────────────────
  // Backstop for peers that died without an exit signal (kill -9, crash, a
  // provider Stop hook that never fired). Confirmed-dead owners are reaped
  // immediately; unknown evidence must remain stale through the shared grace.
  // This only detaches DB state and never authorizes tmux destruction.
  let reaperInFlight = false;
  // Compare wall time with a monotonic clock so an event-loop stall or machine
  // sleep does not look like a wall-clock step. Only their drift is safety
  // relevant; on a jump, the shared observer evaluates current owner evidence.
  let lastClockProbe = { wallMs: Date.now(), monotonicMs: performance.now() };
  function detectClockJump() {
    const current = { wallMs: Date.now(), monotonicMs: performance.now() };
    const wallDeltaMs = current.wallMs - lastClockProbe.wallMs;
    const monotonicDeltaMs = current.monotonicMs - lastClockProbe.monotonicMs;
    lastClockProbe = current;
    const jump = classifyClockDrift({ wallDeltaMs, monotonicDeltaMs });
    if (jump) {
      console.error(redactedLogText(`[${new Date().toISOString()}] wall-clock ${jump.kind} drift detected (${jump.driftMs >= 0 ? '+' : ''}${Math.round(jump.driftMs / 1000)}s); evaluating ownership evidence with a ${CLOCK_GRACE_SEC}s unknown-evidence grace window`));
    }
    return jump;
  }

  function runtimeProjectContexts() {
    const contexts = new Map([[path.resolve(ctx.root), ctx]]);
    for (const projectCtx of projectContexts.values()) {
      if (!sameResolvedPath(projectCtx.root, ctx.root)) {
        try {
          if (!fs.statSync(projectCtx.root).isDirectory() || !fs.statSync(projectCtx.dbPath).isFile()) continue;
        } catch {
          continue;
        }
      }
      contexts.set(path.resolve(projectCtx.root), projectCtx);
    }
    return [...contexts.values()];
  }

  function runClockAwareReaper() {
    if (reaperInFlight) return;
    reaperInFlight = true;
    try {
      // Probe exactly once per scheduler tick. A clock jump is machine-wide;
      // each project feeds that signal and its own evidence snapshot through
      // the shared observer rather than maintaining runtime-only grace state.
      const jump = detectClockJump();
      for (const projectCtx of runtimeProjectContexts()) {
        let db = null;
        try {
          db = connectWebProject(projectCtx, { migrateRegistered: false, create: false });
          const t = now();
          const managedPeerIds = new Set();
          for (const session of sessionsForProject(projectCtx)) {
            if (session.status !== 'running') continue;
            const managedId = session.peerId || session.id;
            if (managedId && peerEvidenceFromDb(db, projectCtx, managedId).state === 'live') {
              managedPeerIds.add(managedId);
            }
          }
          const rows = db.prepare(`
            SELECT p.id, p.status, p.pid, p.pid_start_token, p.pid_command_hash, p.last_seen_at,
                   b.transport, b.runtime_target
            FROM peers p
            LEFT JOIN peer_bindings b ON b.peer = p.id
            WHERE p.status IN ('running', 'working', 'busy')
              AND p.last_seen_at < ?
          `).all(t - UNKNOWN_EVIDENCE_GRACE_SEC);
          const candidates = rows.map((row) => {
            const evidence = peerEvidenceFromDb(db, projectCtx, row.id);
            return {
              boundary: Number(row.last_seen_at) + UNKNOWN_EVIDENCE_GRACE_SEC,
              evidence: evidence.state,
              owner: row.id
            };
          });
          observeClockSafetyOrThrow(db, {
            operation: 'ownership',
            candidates,
            nowSec: t,
            clockJump: jump
          });
          // Unknown evidence is the only reason a jump opens blanket grace.
          // Probes above completed before the observer's write transaction.
          if (clockGraceSuppressed(t, readClockGraceUntil(db))) continue;
          for (const row of rows) {
            if (managedPeerIds.has(row.id)) continue;
            mutatePeerWithEvidence(db, projectCtx, row.id, (subject, evidence) => {
              db.prepare('UPDATE peers SET status = ? WHERE id = ?').run('exited', row.id);
              db.prepare('UPDATE peer_bindings SET runtime_target = NULL, updated_at = ? WHERE peer = ?').run(t, row.id);
              try {
                addEvent(db, 'peer.reaped', 'web-runtime', null, {
                  peer: row.id,
                  pid: subject.peer.pid,
                  reason: evidence.reason
                });
              } catch {}
            }, {
              acceptEvidence: (currentEvidence, subject) => peerEvidenceAllowsReap(currentEvidence, {
                nowSec: now(),
                lastSeenAt: Number(subject.peer.last_seen_at),
                staleAfterSec: UNKNOWN_EVIDENCE_GRACE_SEC,
                graceUntil: readClockGraceUntil(db)
              }),
              beforeMutate: ({ subject, evidence: currentEvidence }) => peerEvidenceAllowsReap(currentEvidence, {
                nowSec: now(),
                lastSeenAt: Number(subject.peer.last_seen_at),
                staleAfterSec: UNKNOWN_EVIDENCE_GRACE_SEC,
                graceUntil: readClockGraceUntil(db)
              })
            });
          }
        } catch (err) {
          console.error(redactedLogText(`[${new Date().toISOString()}] liveness reaper failed for ${projectCtx.root}: ${err?.message || err}`));
        } finally {
          try { db?.close(); } catch {}
        }
      }
    } finally {
      reaperInFlight = false;
    }
  }
  const reaperPoller = setInterval(runClockAwareReaper, 30000);

  return { reaperPoller, runtimeProjectContexts, runClockAwareReaper, detectClockJump };
}
