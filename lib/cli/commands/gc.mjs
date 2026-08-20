// Garbage collection extracted from bin/hcc.mjs.
// Clock-safe GC: lock/history/buffer planning with fencing evidence, runtime
// arbitration for buffer files, and the manual hcc gc command.

import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../../shared/errors.mjs';
import { tx } from '../../db/schema.mjs';
import { parseOpts, validateOpts, wantsHelp } from '../../cli-args.mjs';
import { printResult } from '../../format.mjs';
import { readClockGraceUntil, clockGraceSuppressed } from '../../shared/clock-grace.mjs';
import {
  clockSafetyUnavailable,
  observeClockSafetyInTransaction,
  previewClockSafety
} from '../../core/coordination/clock-safety.mjs';
import {
  captureGcLockSubjects,
  captureHistoryGcPlan,
  createHistoryGcSnapshot,
  finalizeGcLockSubjects,
  finalizeHistoryGcBatches,
  runWithHistoryGcSnapshotCleanup,
  runWithHistoryGcSnapshotCleanupAsync
} from '../../core/coordination/gc-plan.mjs';
import { runOptimisticEvidenceMutation } from '../../core/coordination/optimistic-evidence.mjs';
import { peerEvidenceAllowsReap } from '../../core/peers/evidence.mjs';
import { runtimePath, globalRuntimePath } from '../../runtime/paths.mjs';
import { readRuntime, reclaimRuntimePointerFiles } from '../../runtime/state.mjs';
import { runtimeRequest, runtimeBufferGcUnavailable } from '../../runtime/client.mjs';
import { collectBufferEvidence } from '../../runtime/buffer-evidence.mjs';
import { withBufferDirectoryLease } from '../../runtime/buffer-directory-lease.mjs';
import {
  applyBufferPlan,
  bufferPlanGcCutoffs,
  deferBufferPlan,
  planBufferFiles,
  pruneBufferFiles
} from '../../runtime/buffer-gc.mjs';
import { applyClockSafeBufferPlan } from '../../runtime/buffer-gc-protocol.mjs';

export const RUNTIME_BUFFER_GC_TIMEOUT_MS = 30_000;

export function createGcCommands(deps) {
  const {
    connect, now, helpGc,
    UNKNOWN_EVIDENCE_GRACE_SEC, BUFS_DIR_NAME,
    peerMutationSubject, mutatePeerWithEvidence,
    observeClockSafetyInTransactionOrThrow, observePeerEvidence
  } = deps;

// ─── hcc gc ───────────────────────────────────────────────────────────────────

// Prune stale state. scope='full' always plans technical and history state, but
// manual history is applied only with `hcc gc --history --yes`.
// scope='auto' cleans only high-volume/ephemeral items (events, expired locks,
// stale bufs) so automatic background gc bounds DB growth without deleting
// user-meaningful history.
// `db` is used open; the caller owns its lifecycle.
function captureGcClockSubject(db, {
  bufferGcCutoffs,
  olderThanDays,
  observedAt,
  historyCategories,
  includeStalePeers,
  historySnapshot
}) {
  const retentionSec = olderThanDays * 86400;
  const cutoff = observedAt - retentionSec;
  const lockSubjects = captureGcLockSubjects(db, observedAt);
  const historyPlan = captureHistoryGcPlan(db, cutoff, {
    categories: historyCategories,
    snapshot: historySnapshot
  });

  const stalePeers = includeStalePeers
    ? db.prepare(`
        SELECT p.id
        FROM peers p
        WHERE p.last_seen_at <= ?
        ORDER BY p.id ASC
      `).all(cutoff).map(({ id }) => peerMutationSubject(db, id))
    : [];

  const ownerIds = new Set(lockSubjects.map(({ lock }) => lock.owner));
  for (const subject of stalePeers) {
    if (subject.peer?.id) ownerIds.add(subject.peer.id);
  }
  const owners = [...ownerIds].sort().map((owner) => ({
    owner,
    ...peerMutationSubject(db, owner)
  }));

  return {
    technicalPlan: {
      lockSubjects,
      stalePeers
    },
    owners,
    historyPlan,
    gcCutoffs: [...historySnapshot.gcCutoffs, ...bufferGcCutoffs],
    graceUntil: readClockGraceUntil(db),
    olderThanDays,
    observedAt
  };
}

function observeGcClockSafety(ctx, db, {
  bufferGcCutoffs,
  olderThanDays,
  observedAt,
  historyCategories,
  includeStalePeers,
  historySnapshot
}) {
  try {
    return runOptimisticEvidenceMutation(db, {
      attempts: 5,
      capture: (subjectDb) => captureGcClockSubject(subjectDb, {
        bufferGcCutoffs,
        olderThanDays,
        observedAt,
        historyCategories,
        includeStalePeers,
        historySnapshot
      }),
      observe: (subject) => observeGcEvidence(ctx, subject),
      same: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      beforeMutate: (subject, evidenceByOwner) => observeClockSafetyInTransactionOrThrow(
        db,
        gcClockSafetyOptions(subject, evidenceByOwner, olderThanDays)
      ),
      changedMessage: 'GC subjects changed while clock evidence was being observed; retry',
      mutate: (subject, evidenceByOwner, observation) => ({
        ...observation,
        subject,
        evidenceByOwner,
        expiredLockCount: subject.technicalPlan.lockSubjects.length
      })
    });
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw clockSafetyUnavailable(err);
  }
}

function observeGcEvidence(ctx, subject) {
  return new Map(subject.owners.map(({ owner, peer, binding }) => [
    owner,
    peer
      ? observePeerEvidence(ctx, peer, binding)
      : { state: 'unknown', reason: 'peer_missing' }
  ]));
}

function gcClockSafetyOptions(subject, evidenceByOwner, olderThanDays) {
  return {
    operation: 'gc',
    candidates: [
      ...subject.technicalPlan.lockSubjects.map(({ lock }) => ({
        boundary: Number(lock.expires_at),
        evidence: evidenceByOwner.get(lock.owner)?.state || 'unknown',
        owner: lock.owner,
        resource: lock.resource
      })),
      ...subject.technicalPlan.stalePeers.map(({ peer }) => ({
        boundary: Number(peer.last_seen_at) + olderThanDays * 86400,
        evidence: evidenceByOwner.get(peer.id)?.state || 'unknown',
        owner: peer.id
      }))
    ],
    gcCutoffs: subject.gcCutoffs,
    nowSec: subject.observedAt
  };
}

function previewGcClockSafety(ctx, db, options) {
  try {
    const subject = captureGcClockSubject(db, options);
    const evidenceByOwner = observeGcEvidence(ctx, subject);
    const observation = previewClockSafety(
      db,
      gcClockSafetyOptions(subject, evidenceByOwner, options.olderThanDays)
    );
    return {
      ...observation,
      subject,
      evidenceByOwner,
      expiredLockCount: subject.technicalPlan.lockSubjects.length
    };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw clockSafetyUnavailable(error);
  }
}

function bufferDirectoryPathForbidden(message, directory) {
  return new CliError('PROJECT_PATH_FORBIDDEN', `${message}: ${directory}`);
}

function assertBufferDirectoryComponentsUnchanged(components, directory) {
  for (const component of components) {
    let current;
    try {
      current = fs.lstatSync(component.path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      throw bufferDirectoryPathForbidden(
        'Buffer directory path changed during lease acquisition',
        directory
      );
    }
    if (current.isSymbolicLink() || !current.isDirectory() ||
        current.dev !== component.stat.dev || current.ino !== component.stat.ino) {
      throw bufferDirectoryPathForbidden(
        'Buffer directory path changed during lease acquisition',
        directory
      );
    }
  }
}

function captureRequiredBufferDirectoryComponent(component, description) {
  const stat = fs.lstatSync(component);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw bufferDirectoryPathForbidden(`${description} must be a real directory`, component);
  }
  return { path: component, stat };
}

function captureOptionalBufferDirectory(root, directoryName) {
  const canonicalRoot = fs.realpathSync.native(path.resolve(root));
  const stateDirectory = path.join(canonicalRoot, '.hello-cc');
  const directory = path.join(stateDirectory, directoryName);
  const components = [
    captureRequiredBufferDirectoryComponent(canonicalRoot, 'Project root'),
    captureRequiredBufferDirectoryComponent(stateDirectory, 'Project state directory')
  ];

  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      assertBufferDirectoryComponentsUnchanged(components, directory);
      return null;
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw bufferDirectoryPathForbidden('Buffer directory must be a real directory', directory);
  }
  components.push({ path: directory, stat });
  return { directory, components };
}

function withOptionalBufferDirectoryLease(root, directoryName, callback) {
  const captured = captureOptionalBufferDirectory(root, directoryName);
  if (captured === null) return null;
  return withBufferDirectoryLease(captured.directory, (leasedDirectory) => {
    const assertDirectoryUnchanged = () => {
      assertBufferDirectoryComponentsUnchanged(captured.components, captured.directory);
      if (fs.realpathSync.native(captured.directory) !== leasedDirectory) {
        throw bufferDirectoryPathForbidden(
          'Buffer directory path changed during lease acquisition',
          captured.directory
        );
      }
    };
    assertDirectoryUnchanged();
    const result = callback(leasedDirectory, assertDirectoryUnchanged);
    assertDirectoryUnchanged();
    return result;
  }, { createParent: false });
}

function runGc(ctx, db, {
  olderThanDays = 7,
  dryRun = false,
  scope = 'full',
  protectedBufFiles = null,
  collectBufferEvidenceNow = null,
  bufferCutoffMs = null,
  skipBufferFiles = false,
  history = false,
  observedAt = null
} = {}) {
  const auto = scope === 'auto';
  const historyCategories = auto ? ['events'] : ['events', 'tasks', 'messages', 'handoffs'];
  const applyHistory = auto || history;
  const gcNow = Number.isSafeInteger(observedAt) && observedAt >= 0 ? observedAt : now();
  const retentionSec = olderThanDays * 86400;
  const fixedBufferCutoffMs = Number.isFinite(bufferCutoffMs)
    ? bufferCutoffMs
    : gcNow * 1000 - (auto ? Math.min(olderThanDays, 7) : olderThanDays) * 86400000;
  const bufferRetentionSec = (auto ? Math.min(olderThanDays, 7) : olderThanDays) * 86400;
  const preparedBufferEvidence = !skipBufferFiles && collectBufferEvidenceNow
    ? collectBufferEvidenceNow()
    : null;
  const bufferGcCutoffs = bufferDirectoryPaths(bufferDirectory(ctx)).flatMap((file) => {
    try {
      const stat = fs.lstatSync(file);
      return [Math.max(0, Math.floor(stat.mtimeMs / 1000) + bufferRetentionSec)];
    } catch {
      return [];
    }
  });
  bufferGcCutoffs.push(...(preparedBufferEvidence?.gcCutoffs || []));
  const historySnapshot = createHistoryGcSnapshot(db, gcNow - retentionSec, {
    categories: historyCategories,
    retentionSec
  });
  return runWithHistoryGcSnapshotCleanup(
    db,
    historySnapshot,
    () => runGcWithHistorySnapshot(ctx, db, {
      olderThanDays,
      dryRun,
      auto,
      applyHistory,
      protectedBufFiles,
      collectBufferEvidenceNow,
      preparedBufferEvidence,
      bufferCutoffMs: fixedBufferCutoffMs,
      bufferRetentionSec,
      skipBufferFiles,
      bufferGcCutoffs,
      historyCategories,
      gcNow,
      historySnapshot
    }),
    'History GC run'
  );
}

function runGcWithHistorySnapshot(ctx, db, {
  olderThanDays,
  dryRun,
  auto,
  applyHistory,
  protectedBufFiles,
  collectBufferEvidenceNow,
  preparedBufferEvidence,
  bufferCutoffMs,
  bufferRetentionSec,
  skipBufferFiles,
  bufferGcCutoffs,
  historyCategories,
  gcNow,
  historySnapshot,
  clockObservation: preparedClockObservation = null,
  forceDefer = false
}) {
  const clockObservation = preparedClockObservation || observeGcClockSafety(ctx, db, {
    bufferGcCutoffs,
    olderThanDays,
    observedAt: gcNow,
    historyCategories,
    includeStalePeers: !auto,
    historySnapshot
  });
  const graceActive = forceDefer || clockGraceSuppressed(gcNow, clockObservation.graceUntil);
  let databaseGraceActive = graceActive;
  const beforeDatabaseMutate = () => {
    if (databaseGraceActive) return false;
    try {
      const observedAt = now();
      const allowed = !clockGraceSuppressed(observedAt, readClockGraceUntil(db));
      if (!allowed) databaseGraceActive = true;
      return allowed;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw clockSafetyUnavailable(error);
    }
  };
  const protectedBuffers = protectedBufFiles instanceof Set
    ? protectedBufFiles
    : new Set(protectedBufFiles || []);
  const results = {
    buf_files: 0,
    protected_buf_files: 0,
    deferred_buf_files: 0,
    stale_peers: 0,
    protected_stale_peers: 0,
    deferred_stale_peers: 0,
    old_events: 0,
    old_tasks: 0,
    old_messages: 0,
    old_handoffs: 0,
    protected_old_events: 0,
    protected_old_tasks: 0,
    protected_old_messages: 0,
    protected_old_handoffs: Number(historySnapshot.protectedCounts?.handoffs || 0),
    deferred_old_events: 0,
    deferred_old_tasks: 0,
    deferred_old_messages: 0,
    deferred_old_handoffs: 0,
    expired_locks: 0,
    protected_expired_locks: 0,
    deferred_expired_locks: graceActive ? clockObservation.expiredLockCount : 0,
    deferred_unknown_peers: 0,
    deferred_history: 0,
    deferred_age_based: graceActive
  };

  // Buffer files (high-volume ephemeral). Auto keeps a shorter 7-day window.
  const bufCutoffMs = Number.isFinite(bufferCutoffMs)
    ? bufferCutoffMs
    : gcNow * 1000 - (auto ? Math.min(olderThanDays, 7) : olderThanDays) * 86400000;
  if (!graceActive && !skipBufferFiles) {
    const bufferResult = withOptionalBufferDirectoryLease(ctx.root, BUFS_DIR_NAME, (
      leasedBufsDir,
      assertDirectoryUnchanged
    ) => {
      const currentEvidence = collectBufferEvidenceNow
        ? collectBufferEvidenceNow()
        : preparedBufferEvidence || { protectedPaths: protectedBuffers, unknownPaths: new Set(), gcCutoffs: [] };
      const currentPlan = planBufferFiles({
        directories: [leasedBufsDir],
        cutoffMs: bufCutoffMs,
        protectedPaths: currentEvidence.protectedPaths,
        unknownPaths: currentEvidence.unknownPaths,
        evidenceGcCutoffs: [
          ...(preparedBufferEvidence?.gcCutoffs || []),
          ...(currentEvidence.gcCutoffs || [])
        ]
      });
      assertDirectoryUnchanged();
      const currentObservedAt = now();
      const currentObservation = tx(db, () => observeClockSafetyInTransaction(db, {
        operation: 'gc',
        gcCutoffs: bufferPlanGcCutoffs(currentPlan, bufferRetentionSec),
        nowSec: currentObservedAt
      }));
      if (clockGraceSuppressed(currentObservedAt, currentObservation.graceUntil)) {
        databaseGraceActive = true;
        return deferBufferPlan(currentPlan);
      }
      if (dryRun) {
        return {
          deleted: currentPlan.deleteEntries.length,
          protected: currentPlan.protectedEntries.length,
          deferred: currentPlan.unknownEntries.length
        };
      }
      return applyBufferPlan(currentPlan);
    });
    if (bufferResult !== null) {
      results.buf_files = bufferResult.deleted;
      results.protected_buf_files = bufferResult.protected;
      results.deferred_buf_files = bufferResult.deferred;
    }
  }

  // A clock jump can make every lock look expired at once. Preserve those rows
  // for the grace window so acquisition and heartbeat logic can recover them.
  const expiredLockSubjects = clockObservation.subject.technicalPlan.lockSubjects;
  if (graceActive) {
    results.deferred_expired_locks = Math.max(results.deferred_expired_locks, expiredLockSubjects.length);
  } else {
    const lockResult = finalizeGcLockSubjects(
      db,
      expiredLockSubjects,
      clockObservation.evidenceByOwner,
      {
        dryRun,
        beforeMutate: dryRun ? undefined : beforeDatabaseMutate
      }
    );
    results.expired_locks = lockResult.deleted;
    results.protected_expired_locks = lockResult.live;
    results.deferred_expired_locks += lockResult.deferred;
  }

  if (!auto && databaseGraceActive) {
    results.deferred_stale_peers = clockObservation.subject.technicalPlan.stalePeers.length;
  } else if (!auto) {
    // Stale peers (no heartbeat in N days)
    const stalePeers = clockObservation.subject.technicalPlan.stalePeers;
    for (const subject of stalePeers) {
      const p = subject.peer;
      const evidence = clockObservation.evidenceByOwner.get(p.id) || { state: 'unknown' };
      if (evidence.state === 'live') {
        results.protected_stale_peers++;
        continue;
      }
      if (evidence.state === 'unknown' && !peerEvidenceAllowsReap(evidence, {
        nowSec: gcNow,
        lastSeenAt: Number(p.last_seen_at || 0),
        staleAfterSec: UNKNOWN_EVIDENCE_GRACE_SEC,
        graceUntil: clockObservation.graceUntil
      })) {
        results.deferred_unknown_peers++;
        results.deferred_stale_peers++;
        continue;
      }
      if (dryRun) {
        results.stale_peers++;
        continue;
      }
      if (databaseGraceActive) {
        results.deferred_stale_peers++;
        continue;
      }
      const removed = mutatePeerWithEvidence(db, ctx, p.id, () => {
        db.prepare('DELETE FROM peer_bindings WHERE peer = ?').run(p.id);
        db.prepare('DELETE FROM peers WHERE id = ?').run(p.id);
      }, {
        acceptEvidence: (currentEvidence, currentSubject) => peerEvidenceAllowsReap(currentEvidence, {
          nowSec: now(),
          lastSeenAt: Number(currentSubject.peer.last_seen_at || 0),
          staleAfterSec: UNKNOWN_EVIDENCE_GRACE_SEC,
          graceUntil: readClockGraceUntil(db)
        }),
        beforeMutate: beforeDatabaseMutate
      });
      if (removed.changed) results.stale_peers++;
      else if (removed.evidence?.state === 'live') results.protected_stale_peers++;
      else {
        if (removed.evidence?.state === 'unknown') results.deferred_unknown_peers++;
        results.deferred_stale_peers++;
      }
    }

  }

  const eligibleHistory = historySnapshot.eligibleCounts;
  if (databaseGraceActive) {
    results.deferred_old_events = Number(eligibleHistory.events || 0);
    results.deferred_old_tasks = Number(eligibleHistory.tasks || 0);
    results.deferred_old_messages = Number(eligibleHistory.messages || 0);
    results.deferred_old_handoffs = Number(eligibleHistory.handoffs || 0);
    results.deferred_history = results.deferred_old_events + results.deferred_old_tasks +
      results.deferred_old_messages + results.deferred_old_handoffs;
  } else if (!applyHistory) {
    results.protected_old_events = Number(eligibleHistory.events || 0);
    results.protected_old_tasks = Number(eligibleHistory.tasks || 0);
    results.protected_old_messages = Number(eligibleHistory.messages || 0);
    results.protected_old_handoffs += Number(eligibleHistory.handoffs || 0);
  } else {
    const historyResult = finalizeHistoryGcBatches(db, clockObservation.subject.historyPlan, {
      dryRun,
      dropSnapshot: false,
      beforeMutate: dryRun ? undefined : beforeDatabaseMutate
    });
    results.old_events = historyResult.old_events;
    results.old_tasks = historyResult.old_tasks;
    results.old_messages = historyResult.old_messages;
    results.old_handoffs = historyResult.old_handoffs;
    results.deferred_old_events = Math.max(0, Number(eligibleHistory.events || 0) - results.old_events);
    results.deferred_old_tasks = Math.max(0, Number(eligibleHistory.tasks || 0) - results.old_tasks);
    results.deferred_old_messages = Math.max(0, Number(eligibleHistory.messages || 0) - results.old_messages);
    results.deferred_old_handoffs = Math.max(0, Number(eligibleHistory.handoffs || 0) - results.old_handoffs);
    results.deferred_history = results.deferred_old_events + results.deferred_old_tasks +
      results.deferred_old_messages + results.deferred_old_handoffs;
  }

  results.deferred_age_based = results.deferred_age_based || databaseGraceActive;

  return results;
}

function bufferDirectory(ctx) {
  return path.resolve(path.join(ctx.root, '.hello-cc', BUFS_DIR_NAME));
}

function bufferDirectoryPaths(directory) {
  try {
    return fs.readdirSync(directory).map((name) => path.resolve(directory, name));
  } catch {
    return [];
  }
}

function deferEligibleBufferFiles(directory, cutoffMs) {
  return pruneBufferFiles({
    directories: [directory],
    cutoffMs,
    unknownPaths: bufferDirectoryPaths(directory),
    dryRun: true
  });
}

function localBufferEvidence(ctx, db, directory, unknownTracker = null, candidatePaths = null) {
  return collectBufferEvidence({
    directories: [directory],
    projectDbs: [{ ctx, db }],
    observePeer: observePeerEvidence,
    unknownTracker,
    candidatePaths
  });
}

function runtimePointerPresent(ctx) {
  return Boolean(process.env.HCC_RUNTIME_URL ||
    fs.existsSync(runtimePath(ctx)) ||
    fs.existsSync(globalRuntimePath()));
}

function reclaimUnavailableRuntimePointers(ctx, { dryRun = false } = {}) {
  if (process.env.HCC_RUNTIME_URL) return { allowed: false, gcCutoffs: [] };
  const gcCutoffs = [];
  const result = reclaimRuntimePointerFiles([runtimePath(ctx), globalRuntimePath()], {
    dryRun,
    onReclaim: ({ gcCutoff }) => {
      if (Number.isSafeInteger(gcCutoff)) gcCutoffs.push(gcCutoff);
    }
  });
  return { allowed: !result.blocked, gcCutoffs };
}

function requireBufferGcResult(value) {
  const result = {};
  for (const key of ['deleted', 'protected', 'deferred']) {
    const count = Number(value?.[key]);
    if (!Number.isInteger(count) || count < 0) {
      throw new CliError('RUNTIME_BAD_RESPONSE', `Runtime buffer GC returned an invalid ${key} count`);
    }
    result[key] = count;
  }
  return result;
}

function requirePreparedBufferGc(value, { retentionSec, dryRun }) {
  const counts = requireBufferGcResult(value);
  const observedAt = Number(value?.observedAt);
  const cutoffMs = Number(value?.cutoffMs);
  if (!Number.isSafeInteger(observedAt) || observedAt < 0 ||
      !Number.isSafeInteger(cutoffMs) ||
      cutoffMs !== observedAt * 1000 - retentionSec * 1000 ||
      !Array.isArray(value?.gcCutoffs) || value.gcCutoffs.some((cutoff) =>
        !Number.isSafeInteger(cutoff) || cutoff < 0)) {
    throw new CliError('RUNTIME_BAD_RESPONSE', 'Runtime buffer GC returned invalid derived timing');
  }
  if ((!dryRun && (typeof value?.token !== 'string' || value.token.length === 0)) ||
      (dryRun && Object.hasOwn(value || {}, 'token'))) {
    throw new CliError('RUNTIME_BAD_RESPONSE', 'Runtime buffer GC returned an invalid plan token');
  }
  return { ...counts, observedAt, cutoffMs, gcCutoffs: [...value.gcCutoffs], token: value.token || null };
}

function deferredPreparedBufferGc(prepared, graceActive = false) {
  return {
    deleted: 0,
    protected: prepared.protected,
    deferred: prepared.deferred + prepared.deleted,
    complete: false,
    graceActive
  };
}

async function prepareManualBufferGc(ctx, db, { retentionSec, dryRun }) {
  const directory = bufferDirectory(ctx);
  const unknownTracker = new Map();
  const pointerGcCutoffs = [];
  const recoverRuntimePointers = () => {
    const recovery = reclaimUnavailableRuntimePointers(ctx, { dryRun });
    pointerGcCutoffs.push(...recovery.gcCutoffs);
    return recovery.allowed;
  };
  const pointerPresent = runtimePointerPresent(ctx);
  let runtime = null;
  try { runtime = readRuntime(ctx); } catch (error) {
    if (pointerPresent && !recoverRuntimePointers()) {
      const observedAt = now();
      const cutoffMs = observedAt * 1000 - retentionSec * 1000;
      const deferred = requireBufferGcResult(deferEligibleBufferFiles(directory, cutoffMs));
      return { mode: 'unavailable', observedAt, cutoffMs, retentionSec, gcCutoffs: [], token: null, ...deferred };
    }
    if (error?.code !== 'RUNTIME_NOT_RUNNING') throw error;
  }

  if (runtime) {
    try {
      const prepared = await runtimeRequest(ctx, 'POST', '/api/runtime/gc-buffers', {
        phase: 'prepare',
        retentionSec,
        dryRun
      }, runtime, { timeoutMs: RUNTIME_BUFFER_GC_TIMEOUT_MS });
      return {
        mode: 'runtime',
        runtime,
        retentionSec,
        ...requirePreparedBufferGc(prepared, { retentionSec, dryRun })
      };
    } catch (error) {
      if (runtimeBufferGcUnavailable(error)) {
        if (!recoverRuntimePointers()) {
          const observedAt = now();
          const cutoffMs = observedAt * 1000 - retentionSec * 1000;
          const deferred = requireBufferGcResult(deferEligibleBufferFiles(directory, cutoffMs));
          return { mode: 'unavailable', observedAt, cutoffMs, retentionSec, gcCutoffs: [], token: null, ...deferred };
        }
        runtime = null;
      } else {
        throw error;
      }
    }
  }

  const observedAt = now();
  const cutoffMs = observedAt * 1000 - retentionSec * 1000;
  const { protectedPaths, unknownPaths, gcCutoffs } = localBufferEvidence(ctx, db, directory, unknownTracker);
  const plan = planBufferFiles({
    directories: [directory],
    cutoffMs,
    protectedPaths,
    unknownPaths,
    evidenceGcCutoffs: gcCutoffs
  });
  return {
    mode: 'local',
    observedAt,
    cutoffMs,
    retentionSec,
    gcCutoffs: [...bufferPlanGcCutoffs(plan, retentionSec), ...pointerGcCutoffs],
    token: null,
    plan,
    directory,
    unknownTracker,
    deleted: plan.deleteEntries.length,
    protected: plan.protectedEntries.length,
    deferred: plan.unknownEntries.length
  };
}

async function applyManualBufferGc(ctx, db, prepared, { dryRun, graceActive }) {
  if (dryRun) {
    return graceActive || prepared.mode === 'unavailable'
      ? deferredPreparedBufferGc(prepared, graceActive)
      : { ...requireBufferGcResult(prepared), complete: true, graceActive: false };
  }
  if (prepared.mode === 'unavailable') return deferredPreparedBufferGc(prepared);
  if (prepared.mode === 'local') {
    if (graceActive) return deferredPreparedBufferGc(prepared, true);
    try {
      return applyClockSafeBufferPlan({
        db,
        plan: prepared.plan,
        retentionSec: prepared.retentionSec,
        collectEvidence: ({ entries }) => localBufferEvidence(
          ctx,
          db,
          prepared.directory,
          prepared.unknownTracker,
          entries.map((entry) => entry.path)
        )
      });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw clockSafetyUnavailable(error);
    }
  }
  try {
    const applied = await runtimeRequest(ctx, 'POST', '/api/runtime/gc-buffers', {
      phase: 'apply',
      token: prepared.token
    }, prepared.runtime, { timeoutMs: RUNTIME_BUFFER_GC_TIMEOUT_MS });
    const counts = requireBufferGcResult(applied);
    if (typeof applied?.complete !== 'boolean' || typeof applied?.graceActive !== 'boolean') {
      throw new CliError('RUNTIME_BAD_RESPONSE', 'Runtime buffer GC returned invalid completion state');
    }
    return { ...counts, complete: applied.complete, graceActive: applied.graceActive };
  } catch (error) {
    if (runtimeBufferGcUnavailable(error)) return deferredPreparedBufferGc(prepared);
    throw error;
  }
}

async function runManualGc(ctx, db, {
  olderThanDays,
  dryRun,
  history
}) {
  const retentionSec = olderThanDays * 86400;
  const preparedBuffer = await prepareManualBufferGc(ctx, db, { retentionSec, dryRun });
  const gcNow = preparedBuffer.observedAt;
  const historyCategories = ['events', 'tasks', 'messages', 'handoffs'];
  const historySnapshot = createHistoryGcSnapshot(db, gcNow - retentionSec, {
    categories: historyCategories,
    retentionSec
  });
  return runWithHistoryGcSnapshotCleanupAsync(
    db,
    historySnapshot,
    async () => {
      const observationOptions = {
        bufferGcCutoffs: preparedBuffer.gcCutoffs,
        olderThanDays,
        observedAt: gcNow,
        historyCategories,
        includeStalePeers: true,
        historySnapshot
      };
      const clockObservation = dryRun
        ? previewGcClockSafety(ctx, db, observationOptions)
        : observeGcClockSafety(ctx, db, observationOptions);
      const graceActive = clockGraceSuppressed(gcNow, clockObservation.graceUntil);
      const bufferResult = await applyManualBufferGc(ctx, db, preparedBuffer, { dryRun, graceActive });
      let graceBeforeDatabaseApply = false;
      if (!dryRun) {
        try {
          const finalObservedAt = now();
          graceBeforeDatabaseApply = clockGraceSuppressed(
            finalObservedAt,
            readClockGraceUntil(db)
          );
        } catch (error) {
          throw clockSafetyUnavailable(error);
        }
      }
      const forceDefer = graceActive || (!dryRun && !bufferResult.complete) ||
        preparedBuffer.mode === 'unavailable' || graceBeforeDatabaseApply;
      const results = runGcWithHistorySnapshot(ctx, db, {
        olderThanDays,
        dryRun,
        auto: false,
        applyHistory: history,
        protectedBufFiles: null,
        bufferCutoffMs: preparedBuffer.cutoffMs,
        skipBufferFiles: true,
        bufferGcCutoffs: preparedBuffer.gcCutoffs,
        historyCategories,
        gcNow,
        historySnapshot,
        clockObservation,
        forceDefer
      });
      results.buf_files = bufferResult.deleted;
      results.protected_buf_files = bufferResult.protected;
      results.deferred_buf_files = bufferResult.deferred;
      return results;
    },
    'Manual GC run'
  );
}

function gcRetentionDays(opts) {
  const raw = opts['older-than'];
  if (raw === undefined) return 7;
  if (typeof raw !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new CliError('BAD_ARGS', '--older-than must be a canonical non-negative integer');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(value * 86400000)) {
    throw new CliError('BAD_ARGS', '--older-than exceeds the safe integer range');
  }
  return value;
}

async function cmdGc(ctx, args) {
  if (wantsHelp(args)) return helpGc();
  const valuedDestructiveFlag = args.find((arg) =>
    typeof arg === 'string' && (/^--yes=/.test(arg) || /^--history=/.test(arg)));
  if (valuedDestructiveFlag) {
    throw new CliError('BAD_ARGS', `${valuedDestructiveFlag.split('=', 1)[0]} does not accept a value`);
  }
  const opts = parseOpts(args, { booleans: ['yes', 'force', 'history'] });
  validateOpts('gc', opts, ['older-than', 'yes', 'history']);
  if (opts.yes !== undefined && opts.yes !== true) {
    throw new CliError('BAD_ARGS', '--yes does not accept a value');
  }
  if (opts.history !== undefined && opts.history !== true) {
    throw new CliError('BAD_ARGS', '--history does not accept a value');
  }
  const olderThanDays = gcRetentionDays(opts);
  const dryRun = opts.yes !== true;
  const db = connect(ctx);
  let results;
  try {
    results = await runManualGc(ctx, db, {
      olderThanDays,
      dryRun,
      history: opts.history === true
    });
    const appliedDatabaseRows = results.stale_peers + results.expired_locks +
      results.old_events + results.old_tasks + results.old_messages + results.old_handoffs;
    if (!dryRun && appliedDatabaseRows > 0) {
      // Reclaim WAL after deleting many rows (conc-05). Best-effort: may be busy
      // with other connections; the result is reported but never blocks.
      try {
        const cp = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (cp) results.wal_checkpoint = cp;
      } catch {}
    }
  } finally {
    db.close();
  }

  printResult(ctx, results, (r) => {
    const lines = [`gc completed${dryRun ? ' (dry-run, add --yes to apply)' : ''}:`];
    if (r.buf_files)     lines.push(`  buffer files:   ${r.buf_files}`);
    if (r.protected_buf_files) lines.push(`  protected buffer files: ${r.protected_buf_files}`);
    if (r.deferred_buf_files) lines.push(`  buffer files deferred: ${r.deferred_buf_files}`);
    if (r.stale_peers)   lines.push(`  stale peers:    ${r.stale_peers}`);
    if (r.protected_stale_peers) lines.push(`  protected stale peers: ${r.protected_stale_peers}`);
    if (r.deferred_stale_peers) lines.push(`  stale peers deferred: ${r.deferred_stale_peers}`);
    if (r.deferred_unknown_peers) lines.push(`  unknown peers deferred: ${r.deferred_unknown_peers}`);
    if (r.deferred_history) lines.push(`  history rows deferred: ${r.deferred_history}`);
    if (r.deferred_age_based) lines.push('  age-based cleanup deferred by clock grace');
    if (r.old_events)    lines.push(`  old events:     ${r.old_events}`);
    if (r.old_tasks)     lines.push(`  old tasks:      ${r.old_tasks}`);
    if (r.old_messages)  lines.push(`  old messages:   ${r.old_messages}`);
    if (r.old_handoffs)  lines.push(`  old handoffs:   ${r.old_handoffs}`);
    if (r.protected_old_events) lines.push(`  protected old events: ${r.protected_old_events}`);
    if (r.protected_old_tasks) lines.push(`  protected old tasks: ${r.protected_old_tasks}`);
    if (r.protected_old_messages) lines.push(`  protected old messages: ${r.protected_old_messages}`);
    if (r.protected_old_handoffs) lines.push(`  protected old handoffs: ${r.protected_old_handoffs}`);
    if (r.deferred_old_events) lines.push(`  old events deferred: ${r.deferred_old_events}`);
    if (r.deferred_old_tasks) lines.push(`  old tasks deferred: ${r.deferred_old_tasks}`);
    if (r.deferred_old_messages) lines.push(`  old messages deferred: ${r.deferred_old_messages}`);
    if (r.deferred_old_handoffs) lines.push(`  old handoffs deferred: ${r.deferred_old_handoffs}`);
    if (r.expired_locks) lines.push(`  expired locks:  ${r.expired_locks}`);
    if (r.protected_expired_locks) lines.push(`  protected expired locks: ${r.protected_expired_locks}`);
    if (r.deferred_expired_locks) lines.push(`  expired locks deferred by clock grace: ${r.deferred_expired_locks}`);
    if (r.wal_checkpoint) lines.push(`  wal checkpoint: ${r.wal_checkpoint.busy ? 'busy' : 'ok'} (log ${r.wal_checkpoint.log}, checkpointed ${r.wal_checkpoint.checkpointed})`);
    if (!r.buf_files && !r.protected_buf_files && !r.deferred_buf_files && !r.stale_peers &&
        !r.protected_stale_peers && !r.deferred_stale_peers && !r.old_events && !r.old_tasks &&
        !r.old_messages && !r.old_handoffs && !r.expired_locks && !r.deferred_expired_locks &&
        !r.protected_expired_locks && !r.deferred_unknown_peers && !r.deferred_history &&
        !r.protected_old_events && !r.protected_old_tasks && !r.protected_old_messages &&
        !r.protected_old_handoffs && !r.deferred_age_based) {
      lines.push('  nothing to clean');
    }
    // v1-06: warn when history tables are retained so the user knows to add
    // --history for events/tasks/messages/handoffs pruning.
    if (!dryRun && opts.history !== true) {
      lines.push('  (history tables retained; add --history to prune events/tasks/messages/handoffs)');
    }
    return lines.join('\n');
  });
}

  return {
    cmdGc, runGc, runGcWithHistorySnapshot, bufferDirectory,
    observeGcClockSafety, previewGcClockSafety, runManualGc,
    prepareManualBufferGc, applyManualBufferGc, gcRetentionDays
  };
}
