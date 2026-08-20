// Runtime-side automatic buffer GC, extracted from lib/web/runtime-main.mjs.
// Plans and applies buffer-file GC with runtime arbitration: live-session
// path snapshots, cross-project evidence collection, fenced plan tokens,
// and the periodic auto-GC sweep.

import path from 'node:path';
import { CliError } from '../shared/errors.mjs';
import { clockSafetyUnavailable } from '../core/coordination/clock-safety.mjs';
import { collectBufferEvidence } from '../runtime/buffer-evidence.mjs';
import { applyClockSafeBufferPlan, createBufferGcPlanStore } from '../runtime/buffer-gc-protocol.mjs';
import { bufferPlanGcCutoffs, planBufferFiles } from '../runtime/buffer-gc.mjs';

export function createBufferGcRuntime(deps) {
  const {
    sessions,
    connectWebProject, runtimeProjectContexts,
    now, runGc, bufferDirectory,
    canonicalRoot, observePeerEvidence, redactedLogText, sameResolvedPath
  } = deps;

  const bufferGcPlanStore = createBufferGcPlanStore();
  const bufferUnknownTracker = new Map();
  const bufferDirectoriesByProject = new Map();

  // ── Automatic GC ──────────────────────────────────────────────────────────
  // Bound events/WAL growth without manual `hcc gc` (conc-05). Auto scope only
  // prunes high-volume/ephemeral items (events >14d, expired locks, stale bufs),
  // never peers/tasks/messages/handoffs. Runs once at startup then every 6h.
  let autoGcInFlight = false;
  function runningBufferPathSnapshot(projectCtx) {
    const protectedPaths = new Set();
    const projectKey = canonicalRoot(projectCtx.root) || path.resolve(projectCtx.root);
    const projectDirectories = bufferDirectoriesByProject.get(projectKey) || new Set();
    for (const session of sessions.values()) {
      for (const file of [session.outFile, session.inFile, session.resizeFile, session.pipeFile, session.metaFile]) {
        if (!file) continue;
        const resolved = path.resolve(file);
        if (sameResolvedPath(session.root, projectCtx.root)) projectDirectories.add(path.dirname(resolved));
        if (session.status === 'running') protectedPaths.add(resolved);
      }
    }
    bufferDirectoriesByProject.set(projectKey, projectDirectories);
    return { protectedPaths, projectDirectories };
  }

  function collectRuntimeBufferEvidence(directories, candidatePaths = null) {
    const projectDbs = [];
    const opened = [];
    try {
      for (const projectCtx of runtimeProjectContexts()) {
        try {
          const db = connectWebProject(projectCtx, { migrateRegistered: false, create: false });
          opened.push(db);
          projectDbs.push({ ctx: projectCtx, db });
        } catch (error) {
          projectDbs.push({
            ctx: projectCtx,
            db: { prepare() { throw error; } }
          });
        }
      }
      return collectBufferEvidence({
        directories,
        projectDbs,
        sessions: [...sessions.values()],
        observePeer: observePeerEvidence,
        unknownTracker: bufferUnknownTracker,
        candidatePaths
      });
    } finally {
      for (const db of opened) {
        try { db.close(); } catch {}
      }
    }
  }

  function prepareRuntimeBufferGc(projectCtx, { dryRun, retentionSec }) {
    const observedAt = now();
    const cutoffMs = observedAt * 1000 - retentionSec * 1000;
    const { projectDirectories } = runningBufferPathSnapshot(projectCtx);
    const directories = new Set([bufferDirectory(projectCtx), ...projectDirectories]);
    const { protectedPaths, unknownPaths, gcCutoffs } = collectRuntimeBufferEvidence(directories);
    const plan = planBufferFiles({
      directories,
      cutoffMs,
      protectedPaths,
      unknownPaths,
      evidenceGcCutoffs: gcCutoffs
    });
    const prepared = {
      observedAt,
      cutoffMs,
      retentionSec,
      deleted: plan.deleteEntries.length,
      protected: plan.protectedEntries.length,
      deferred: plan.unknownEntries.length,
      gcCutoffs: bufferPlanGcCutoffs(plan, retentionSec)
    };
    if (!dryRun) {
      prepared.token = bufferGcPlanStore.prepare({
        root: projectCtx.root,
        dbPath: projectCtx.dbPath,
        observedAt,
        retentionSec,
        plan
      });
    }
    return prepared;
  }

  function applyPreparedRuntimeBufferGc(projectCtx, token) {
    const prepared = bufferGcPlanStore.take({
      token,
      root: projectCtx.root,
      dbPath: projectCtx.dbPath
    });
    let db = null;
    try {
      db = connectWebProject(projectCtx);
      return applyClockSafeBufferPlan({
        db,
        plan: prepared.plan,
        retentionSec: prepared.retentionSec,
        nowSec: now,
        collectEvidence: ({ entries }) => collectRuntimeBufferEvidence(
          new Set(entries.map((entry) => entry.directory.path)),
          entries.map((entry) => entry.path)
        )
      });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw clockSafetyUnavailable(error);
    } finally {
      try { db?.close(); } catch {}
    }
  }

  function runAutoGc() {
    if (autoGcInFlight) return;
    autoGcInFlight = true;
    try {
      for (const projectCtx of runtimeProjectContexts()) {
        let db = null;
        try {
          db = connectWebProject(projectCtx, { migrateRegistered: false, create: false });
          const result = runGc(projectCtx, db, {
            olderThanDays: 14,
            dryRun: false,
            scope: 'auto',
            collectBufferEvidenceNow: (directory) => collectRuntimeBufferEvidence([
              directory
            ])
          });
          const appliedDatabaseRows = result.expired_locks + result.old_events;
          if (appliedDatabaseRows > 0) {
            try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); } catch {}
          }
        } catch (err) {
          console.error(redactedLogText(`[${new Date().toISOString()}] auto-gc failed for ${projectCtx.root}: ${err?.message || err}`));
        } finally {
          try { db?.close(); } catch {}
        }
      }
    } finally {
      autoGcInFlight = false;
    }
  }
  const gcPoller = setInterval(runAutoGc, 6 * 60 * 60 * 1000);

  return {
    gcPoller, runAutoGc,
    collectRuntimeBufferEvidence, prepareRuntimeBufferGc, applyPreparedRuntimeBufferGc,
    runningBufferPathSnapshot, bufferGcPlanStore
  };
}
