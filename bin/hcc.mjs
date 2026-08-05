#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CliError } from '../lib/shared/errors.mjs';
import { publicCliFailure } from '../lib/shared/errors.mjs';
import { redactCliArgs, redactSecrets } from '../lib/shared/redact.mjs';
import {
  CLOCK_GRACE_SEC,
  classifyClockDrift,
  clockGraceSuppressed,
  readClockGraceUntil
} from '../lib/shared/clock-grace.mjs';
import {
  clockSafetyUnavailable,
  observeClockSafety,
  observeClockSafetyInTransaction,
  previewClockSafety
} from '../lib/core/coordination/clock-safety.mjs';
import {
  DB_SCHEMA_VERSION,
  execWithBusyRetry,
  readSchemaVersion,
  tx
} from '../lib/db/schema.mjs';
import { initSchemaWithBackup } from '../lib/db/migration-backup.mjs';
import { resolveProjectDatabase } from '../lib/runtime/project-path.mjs';
import {
  intOpt,
  parseOpts,
  positiveSafeIntOpt,
  required,
  splitGlobalArgs,
  validateOpts,
  wantsHelp
} from '../lib/cli-args.mjs';
import { leaseDeadline, renewOwnedLocks } from '../lib/core/coordination/lease-renewal.mjs';
import {
  commandPath,
  createContext as createCliContext,
  packageRoot,
  shellCommand as shellCommandWithQuote,
  tailFile
} from '../lib/cli-runtime.mjs';
import { createCoordinationState } from '../lib/coordination-state.mjs';
import {
  formatJson,
  printResult,
  shellExports,
  shellQuoteArg,
  table
} from '../lib/format.mjs';
import { readPackageMeta } from '../lib/package-meta.mjs';
import {
  removeGuidanceBlocks as removeGuidanceBlocksForRoot,
  writeGuidance as writeGuidanceForRoot
} from '../lib/guidance.mjs';
import {
  contextForProject,
  globalRuntimePath,
  projectDbPath,
  runtimePath,
  webLogPath
} from '../lib/runtime/paths.mjs';
import {
  clearRuntime,
  readGlobalRuntimeFile,
  readHealthyGlobalRuntime,
  readHealthyRuntime,
  readRuntime,
  readRuntimeFile,
  reclaimRuntimePointerFiles,
  runtimeProcessIdentity,
  writeGlobalRuntime,
  writeRuntime
} from '../lib/runtime/state.mjs';
import { createFatalShutdownController } from '../lib/runtime/fatal-shutdown.mjs';
import { runtimeBufferGcUnavailable, runtimeRequest } from '../lib/runtime/client.mjs';
import {
  applyBufferPlan,
  bufferPlanGcCutoffs,
  deferBufferPlan,
  planBufferFiles,
  pruneBufferFiles
} from '../lib/runtime/buffer-gc.mjs';
import {
  applyClockSafeBufferPlan,
  createBufferGcPlanStore
} from '../lib/runtime/buffer-gc-protocol.mjs';
import {
  collectBufferEvidence,
  externalBufferEvidence,
  externalBufferOwnerKey,
  externalBufferSessionIds,
  readExternalBufferMetadata
} from '../lib/runtime/buffer-evidence.mjs';
import { withBufferDirectoryLease } from '../lib/runtime/buffer-directory-lease.mjs';
import {
  detectBranch,
  detectRoot
} from '../lib/project-context.mjs';
import {
  changedFiles,
  normalizeListText
} from '../lib/handoff.mjs';
import {
  annotateTasksWithLiveness,
  taskOwnerStateText
} from '../lib/core/peers/liveness.mjs';
import {
  normalizeStateResources,
  renderStateSummary,
  renderStatusSummary
} from '../lib/ui/state-render.mjs';
import { createHelpFunctions } from '../lib/ui/help.mjs';
import { createMessageStore } from '../lib/core/coordination/messages.mjs';
import { createTaskStore } from '../lib/core/coordination/tasks.mjs';
import {
  classifyPeerActivity,
  peerEvidenceAllowsReap,
  resolvePeerEvidence
} from '../lib/core/peers/evidence.mjs';
import { refreshHookOwnerIdentity } from '../lib/core/peers/hook-owner.mjs';
import {
  conditionalTmuxKill,
  conditionalTmuxRename,
  finalizeTmuxGcBindingMutation,
  prepareTmuxRestartBinding,
  rollbackTmuxRestartBinding,
  validateTmuxDestructiveEvidence,
  validateTmuxGcBindingEvidence,
  validateTmuxGcDeadProcessEvidence
} from '../lib/core/peers/tmux-safety.mjs';
import {
  inspectProcessIdentity,
  waitForLiveProcessIdentity
} from '../lib/process/identity.mjs';
import {
  capturePtyStartupEvidence,
  installPtyTerminationHandlers,
  ptyStartupFailureDisposition,
  ptyTerminationSignal,
  stopPtyAfterStartupFailure,
  trackPtyExit
} from '../lib/process/pty-lifecycle.mjs';
import {
  parseTaskIds,
  positiveIntOpt,
  taskRowsText
} from '../lib/task-cli.mjs';
import {
  LAUNCH_FINGERPRINT_ENV,
  PROVIDER_STATE_ENV,
  WEB_CHILD_ENV,
  childSessionEnv,
  isolatedEnvCommandArgs,
  isRelaunchableProviderSession,
  launchFingerprint,
  providerRestartReason
} from '../lib/core/sessions/launch.mjs';
import {
  expectedWebHost,
  isLoopbackHost,
  listenServer,
  localRuntimeUrl,
  makeWebToken,
  nextSessionId,
  publicRuntimeUrl,
  rememberRuntimeToken,
  requestUrl,
  runtimeBaseUrl,
  validateWebTokenOpts,
  webRuntimeMatchesRequest
} from '../lib/web/runtime.mjs';
import {
  authOk,
  isLoopbackRemote,
  readJsonRequest,
  requestIsSecure,
  requestMatchesProxyOrigin,
  requestOriginMatches,
  sendFile,
  sendHttp,
  sendJson,
  tokenMatches
} from '../lib/web/http.mjs';
import { createWebPeerActions } from '../lib/web/peer-actions.mjs';
import {
  API_VERSION,
  apiVersionUnsupportedBody,
  readHttpApiVersion,
  readWebSocketApiVersion
} from '../lib/web/api-version.mjs';
import { ensureSelfSignedCert } from '../lib/web/tls.mjs';
import * as webUiTemplate from '../lib/web/ui-template.mjs';
import {
  bindingFromRun,
  buildPeerCommand,
  defaultSessionCommand,
  hasResumeOpts,
  inferPeerKind
} from '../lib/integrations/providers.mjs';
import {
  providerSessionParts,
  providerSessionPeerId
} from '../lib/core/peers/session.mjs';
import {
  bindingHasRuntime,
  bindingFromDetected
} from '../lib/core/peers/bindings.mjs';
import { reconcileRunningPeerBindings } from '../lib/core/peers/reconcile.mjs';
import { createPeerBindingStore } from '../lib/db/stores/peers.mjs';
import {
  ensureTmuxAvailable,
  runTmux,
  tmuxCapturePane,
  tmuxCursorInfo,
  tmuxCursorPayload,
  tmuxEnvironmentArgs,
  tmuxHasSession,
  tmuxKillSession,
  tmuxLaunchFingerprint,
  tmuxListSessionNames,
  tmuxManagedSessionName,
  tmuxManagedSessionNameMatches,
  tmuxManagedSessionPrefixMatches,
  tmuxPaneInfo,
  tmuxProviderState,
  tmuxSendLiteral,
  tmuxSessionEnvironmentValue,
  tmuxSessionHasClients
} from '../lib/tmux.mjs';
import {
  lockArgv,
  lockBaseResource,
  lockLabel,
  lockScope,
  locksConflict,
  normalizeLockScope,
  scopedLockResource
} from '../lib/core/coordination/locks.mjs';
import {
  captureLockAcquireSubject,
  clockCandidatesFromLocks,
  observeLockOwnerEvidence,
  sameLockAcquireSubject
} from '../lib/core/coordination/lock-evidence.mjs';
import { runOptimisticEvidenceMutation } from '../lib/core/coordination/optimistic-evidence.mjs';
import {
  captureGcLockSubjects,
  captureHistoryGcPlan,
  createHistoryGcSnapshot,
  finalizeGcLockSubjects,
  finalizeHistoryGcBatches,
  runWithHistoryGcSnapshotCleanup,
  runWithHistoryGcSnapshotCleanupAsync
} from '../lib/core/coordination/gc-plan.mjs';
import {
  assignTeamWorkers,
  expandTeamWorkers,
  inferTeamItems
} from '../lib/core/coordination/teams.mjs';
import {
  autoPeerBasis,
  autoPeerKind,
  autoPeerProviderSession,
  autoPeerResumeId,
  autoPeerSessionId,
  readAncestorCliInfo,
  resolveCurrentPeer,
  resumeIdFromArgs,
  sanitizePeerPart,
  shortHash
} from '../lib/integrations/peers/identity.mjs';
import { inspectProviderProcess } from '../lib/integrations/peers/processes.mjs';
import {
  projectRecord,
  readProjectRegistry,
  registerProject,
  registerProjectActivity,
  writeProjectRegistry
} from '../lib/runtime/projects.mjs';

// Lazy-load lib modules (they may import node-pty which needs to be optional)
const _libDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'lib');
async function loadDiscover() { return import(path.join(_libDir, 'discover.mjs')); }
async function loadSetup()    { return import(path.join(_libDir, 'setup.mjs')); }

const PACKAGE_META = readPackageMeta(path.resolve(fileURLToPath(import.meta.url), '..', '..'));
const VERSION = PACKAGE_META.version;
const PRODUCT_NAME = 'hello-cc';
const CLI_NAME = 'hcc';
const NPM_PACKAGE_NAME = PACKAGE_META.name;
const DEFAULT_LOCK_TTL = 900;
const ACTIVE_PEER_TTL = 600;
const UNKNOWN_EVIDENCE_GRACE_SEC = 120;
// Detected peers older than this (seconds, last_seen) or already exited are
// hidden from the Web "Detected" list so it reflects recent activity instead of
// accumulating every peer/test fixture that ever registered.
const DETECTED_PEER_MAX_AGE = 3600;

const {
  helpMain,
  helpTask,
  helpTeam,
  helpState,
  helpJoin,
  helpEnv,
  helpMsg,
  helpAsk,
  helpBroadcast,
  helpInject,
  helpPeer,
  helpTmux,
  helpGc,
  helpLock,
  helpHandoff,
  helpEvent,
  helpRun,
  helpUp,
  helpDown,
  helpUpdate,
  helpUninstall,
  helpInstallHooks,
  helpShim,
  helpWeb
} = createHelpFunctions({
  productName: PRODUCT_NAME,
  version: VERSION,
  cliName: CLI_NAME,
  npmPackageName: NPM_PACKAGE_NAME
});

function isProjectManagedTmuxSession(projectCtx, sessionName, sessionRoot = null) {
  return tmuxManagedSessionPrefixMatches(projectCtx, sessionName, sessionRoot);
}

function liveProcessIdentity(pid) {
  const inspected = inspectProcessIdentity(pid);
  return inspected.state === 'live' ? inspected.identity : null;
}

function storedPeerIdentity(row) {
  return row?.pid ? {
    pid: Number(row.pid),
    startToken: row.pid_start_token,
    commandHash: row.pid_command_hash
  } : null;
}

function processEvidenceFromRow(row, name = 'peer') {
  return {
    name,
    storedIdentity: storedPeerIdentity(row),
    current: inspectProcessIdentity(row?.pid)
  };
}

function canonicalRoot(value) {
  if (!value) return null;
  try { return fs.realpathSync(value); }
  catch {
    try { return path.resolve(value); } catch { return null; }
  }
}

function rootEvidence(expected, actual) {
  const expectedRoot = canonicalRoot(expected);
  const actualRoot = canonicalRoot(actual);
  if (!expectedRoot || !actualRoot) {
    return { state: 'unknown', expected: expectedRoot, actual: actualRoot };
  }
  return {
    state: expectedRoot === actualRoot ? 'match' : 'mismatch',
    expected: expectedRoot,
    actual: actualRoot
  };
}

function tmuxTargetMissing(error) {
  return /can't find pane|can't find session|no server running/i.test(String(error?.message || ''));
}

function inspectTmuxTarget(expectedSession, target) {
  let actualSession = null;
  try {
    actualSession = runTmux(['display-message', '-p', '-t', target, '#{session_name}']).trim() || null;
  } catch (targetError) {
    try {
      runTmux(['has-session', '-t', expectedSession]);
      actualSession = expectedSession;
    } catch (sessionError) {
      return {
        session: { state: tmuxTargetMissing(sessionError) ? 'dead' : 'unknown', expected: expectedSession, actual: null },
        pane: { state: tmuxTargetMissing(targetError) ? 'dead' : 'unknown', expected: target, actual: null },
        paneInfo: null
      };
    }
  }
  if (!actualSession) {
    try {
      runTmux(['has-session', '-t', expectedSession]);
      actualSession = expectedSession;
    } catch (sessionError) {
      return {
        session: { state: tmuxTargetMissing(sessionError) ? 'dead' : 'unknown', expected: expectedSession, actual: null },
        pane: { state: 'unknown', expected: target, actual: null },
        paneInfo: null
      };
    }
  }

  try {
    const paneInfo = tmuxPaneInfo(target);
    const expectedPane = target === `${expectedSession}:0.0` ? paneInfo.pane : target;
    return {
      session: { state: 'live', expected: expectedSession, actual: actualSession },
      pane: { state: paneInfo.dead ? 'dead' : 'live', expected: expectedPane, actual: paneInfo.pane },
      paneInfo
    };
  } catch (error) {
    return {
      session: { state: 'live', expected: expectedSession, actual: actualSession },
      pane: { state: tmuxTargetMissing(error) ? 'dead' : 'unknown', expected: target, actual: null },
      paneInfo: null
    };
  }
}

function observePeerEvidence(projectCtx, row, binding = null) {
  if (binding?.transport !== 'tmux') {
    return resolvePeerEvidence({ peer: row, processes: [processEvidenceFromRow(row)] });
  }

  const expectedSession = tmuxManagedSessionName(projectCtx, row.id);
  const runtimeTarget = binding.runtime_target || `${expectedSession}:0.0`;
  const target = inspectTmuxTarget(expectedSession, runtimeTarget);
  const panePid = target.paneInfo?.pid || row.pid;
  const paneProcess = {
    name: 'pane',
    storedIdentity: Number(row?.pid) === Number(panePid) ? storedPeerIdentity(row) : null,
    current: inspectProcessIdentity(panePid)
  };
  const actualRoot = target.session.actual
    ? tmuxSessionEnvironmentValue(target.session.actual, 'HCC_ROOT')
    : null;
  if (target.session.actual && tmuxManagedSessionNameMatches(
    projectCtx,
    target.session.actual,
    row.id,
    actualRoot
  )) {
    target.session.expected = target.session.actual;
  }
  return resolvePeerEvidence({
    peer: row,
    processes: [processEvidenceFromRow(row, 'owner')],
    tmux: {
      managed: true,
      session: target.session,
      pane: target.pane,
      root: rootEvidence(projectCtx.root, actualRoot),
      process: paneProcess
    }
  });
}

function peerEvidenceFromDb(db, projectCtx, peerId) {
  const row = db.prepare(`
    SELECT id, status, pid, pid_start_token, pid_command_hash
    FROM peers WHERE id = ?
  `).get(peerId);
  if (!row) return { state: 'unknown', reason: 'peer_missing' };
  const binding = db.prepare(`
    SELECT transport, runtime_target FROM peer_bindings WHERE peer = ?
  `).get(peerId) || null;
  return observePeerEvidence(projectCtx, row, binding);
}

function providerOwnerEvidenceFromDb(db, peerId) {
  const row = db.prepare(`
    SELECT id, status, pid, pid_start_token, pid_command_hash
    FROM peers WHERE id = ?
  `).get(peerId);
  return row
    ? resolvePeerEvidence({ peer: row, processes: [processEvidenceFromRow(row, 'provider-owner')] })
    : { state: 'unknown', reason: 'peer_missing' };
}

function peerMutationSubject(db, peerId) {
  const peer = db.prepare(`
    SELECT id, status, pid, pid_start_token, pid_command_hash, last_seen_at
    FROM peers WHERE id = ?
  `).get(peerId) || null;
  const binding = db.prepare(`
    SELECT peer, transport, runtime_target, updated_at
    FROM peer_bindings WHERE peer = ?
  `).get(peerId) || null;
  return { peer, binding };
}

function mutatePeerWithEvidence(db, projectCtx, peerId, mutate, options = {}) {
  const acceptEvidence = typeof options.acceptEvidence === 'function'
    ? options.acceptEvidence
    : (evidence) => evidence.state === 'dead';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const subject = peerMutationSubject(db, peerId);
    if (!subject.peer) return { changed: false, evidence: { state: 'unknown', reason: 'peer_missing' } };
    const evidence = observePeerEvidence(projectCtx, subject.peer, subject.binding);
    if (!acceptEvidence(evidence, subject)) return { changed: false, evidence };
    let subjectChanged = false;
    let blocked = false;
    const changed = tx(db, () => {
      if (options.beforeMutate?.({ subject, evidence }) === false) {
        blocked = true;
        return false;
      }
      const current = peerMutationSubject(db, peerId);
      if (JSON.stringify(current) !== JSON.stringify(subject)) {
        subjectChanged = true;
        return false;
      }
      mutate(current, evidence);
      return true;
    });
    if (blocked) return { changed: false, evidence, blocked: true };
    if (!subjectChanged) return { changed, evidence };
  }
  return { changed: false, evidence: { state: 'unknown', reason: 'subject_changed' } };
}

function mutateConfirmedDeadPeer(db, projectCtx, peerId, mutate, options = {}) {
  return mutatePeerWithEvidence(db, projectCtx, peerId, mutate, options);
}

function observeClockSafetyOrThrow(db, options) {
  try {
    return observeClockSafety(db, options);
  } catch (err) {
    throw clockSafetyUnavailable(err);
  }
}

function observeClockSafetyInTransactionOrThrow(db, options) {
  try {
    return observeClockSafetyInTransaction(db, options);
  } catch (err) {
    throw clockSafetyUnavailable(err);
  }
}

function prepareLockClockObservation(db, subject, evidenceByOwner) {
  return observeClockSafetyInTransactionOrThrow(db, {
    operation: 'ownership',
    candidates: clockCandidatesFromLocks(subject, evidenceByOwner),
    nowSec: subject.observedAt
  });
}

function observeLockClockSafety(db, projectCtx, {
  requested = null,
  taskId = null,
  owner = null,
  observedAt = now()
} = {}) {
  try {
    const subject = captureLockAcquireSubject(db, {
      taskId,
      requested,
      now: observedAt
    });
    const evidenceByOwner = observeLockOwnerEvidence(subject, (row, binding) =>
      observePeerEvidence(projectCtx, row, binding));
    const candidates = subject.locks
      .filter((lock) => Number(lock.expires_at) <= observedAt && (!owner || lock.owner === owner))
      .map((lock) => ({
        boundary: Number(lock.expires_at),
        evidence: evidenceByOwner.get(lock.owner)?.state || 'unknown',
        owner: lock.owner,
        resource: lock.resource
      }));
    return observeClockSafetyOrThrow(db, {
      operation: 'ownership',
      candidates,
      nowSec: observedAt
    });
  } catch (err) {
    throw clockSafetyUnavailable(err);
  }
}

function observeTaskTakeoverClockSafety({ db, row, ownerRow, evidence, staleAfter }) {
  const boundary = ownerRow
    ? Number(ownerRow.last_seen_at || 0) + Number(staleAfter)
    : 0;
  return observeClockSafetyOrThrow(db, {
    operation: 'ownership',
    candidates: row?.owner ? [{
      boundary,
      evidence: evidence?.state || 'unknown',
      owner: row.owner
    }] : [],
    nowSec: now()
  });
}

function splitProcessArgs(line) {
  const args = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const ch of String(line || '')) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += '\\';
  if (current) args.push(current);
  return args;
}

function sameResolvedPath(a, b) {
  if (!a || !b) return false;
  function key(value) {
    try { return fs.realpathSync(value); }
    catch { return path.resolve(value); }
  }
  return key(a) === key(b);
}

const {
  ackMessage,
  getMessage,
  queryInbox,
  queryMessageThread,
  queryTimelineMessages,
  sendMessage
} = createMessageStore({ now, addEvent });
const {
  assertTaskOwnerForMutation,
  claimNextTasksForPeer,
  claimTaskRowsForPeer,
  queryOpenTasks,
  takeOverTaskForPeer,
  taskById,
  teamChildren,
  teamSummary
} = createTaskStore({
  activePeerTtl: ACTIVE_PEER_TTL,
  addEvent,
  now,
  observeClockSafety: observeTaskTakeoverClockSafety,
  sendMessage
});
const {
  ackMessages,
  buildHookCoordinationContext,
  statusSnapshot,
  statusSummary
} = createCoordinationState({
  activePeerTtl: ACTIVE_PEER_TTL,
  cliName: CLI_NAME,
  connect,
  defaultLockTtl: DEFAULT_LOCK_TTL,
  now,
  queryInbox,
  queryOpenTasks,
  queryTimelineMessages,
  observePeerEvidence
});
const {
  webPeerAction
} = createWebPeerActions({
  activePeerTtl: ACTIVE_PEER_TTL,
  addEvent,
  assertTaskOwnerForMutation,
  claimNextTasksForPeer,
  connect,
  defaultLockTtl: DEFAULT_LOCK_TTL,
  detectBranch,
  now,
  observeClockSafetyInTransaction,
  observePeerEvidence,
  positiveIntOpt,
  peerEvidenceFromDb,
  queryInbox,
  statusSnapshot,
  statusSummary,
  takeOverTaskForPeer,
  touchPeer,
  tx,
  upsertPeer
});
// Directory under .hello-cc/ for optional external PTY buffer files.
const BUFS_DIR_NAME = 'bufs';

function now() {
  return Math.floor(Date.now() / 1000);
}

function iso(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toISOString();
}

function redactedLogText(value) {
  const redacted = redactSecrets(value);
  if (typeof redacted === 'string') return redacted;
  const serialized = JSON.stringify(redacted);
  return serialized === undefined ? String(redacted) : serialized;
}

function renderWebIndex(nonce) {
  return webUiTemplate.webIndexHtml({ nonce });
}

function renderWebLogin(nonce) {
  if (typeof webUiTemplate.webLoginPage === 'function') return webUiTemplate.webLoginPage({ nonce });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>hello-cc - sign in</title></head><body>
<main><h1>hello-cc</h1><form action="/" method="get"><label>Access token <input name="token" type="password" required></label><button type="submit">Sign in</button></form></main>
</body></html>`;
}

function sendWebHtml(res, render) {
  const nonce = randomBytes(18).toString('base64url');
  sendHttp(res, 200, 'text/html; charset=utf-8', render(nonce), { nonce });
}

function webErrorStatus(err) {
  if (!(err instanceof CliError)) return 500;
  if (err.code === 'REGISTRY_BUSY') return 503;
  if (['BAD_ARGS', 'BAD_REQUEST', 'PEER_IDENTITY_REQUIRED', 'REQUEST_TOO_LARGE'].includes(err.code)) return 400;
  if (['PEER_IDENTITY_MISMATCH', 'TASK_OWNED', 'LOCK_OWNED', 'PROJECT_NOT_REGISTERED', 'PROJECT_PATH_FORBIDDEN'].includes(err.code)) return 403;
  if (['NOT_FOUND'].includes(err.code)) return 404;
  if (['LOCK_HELD', 'SESSION_NOT_RUNNING'].includes(err.code)) return 409;
  return 500;
}

function autoPeerDefaults(ctx, kindHint = 'shell', status = 'working') {
  const kind = autoPeerKind(kindHint);
  const ancestor = readAncestorCliInfo();
  return {
    kind,
    role: 'peer',
    worktree: ctx.cwd,
    branch: detectBranch(ctx.cwd),
    pid: ancestor?.kind === kind ? ancestor.pid : process.ppid,
    status,
    capabilities: 'auto-shell'
  };
}

function shellCommand(args) {
  return shellCommandWithQuote(args, shellQuoteArg);
}

function resolveTargetPeer(ctx, opts = {}, key = 'peer', kindHint = 'shell') {
  if (opts[key]) return { id: opts[key], auto: false, target: true };
  return resolveCurrentPeer(ctx, opts, key, kindHint);
}

let projectMigrationFanoutDepth = 0;
const migratedRegisteredProjectDbs = new Set();
// xx-05: cooldown before retrying a sibling project DB whose migration failed.
const MIGRATION_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

function connect(ctx, options = {}) {
  if (options.create === false && !fs.existsSync(ctx.dbPath)) {
    throw new CliError('NOT_FOUND', `Project database does not exist: ${ctx.dbPath}`);
  }
  if (options.create !== false) fs.mkdirSync(path.dirname(ctx.dbPath), { recursive: true });
  const db = new DatabaseSync(ctx.dbPath, { timeout: 5000 });
  db.exec('PRAGMA busy_timeout = 5000;');
  execWithBusyRetry(db, 'PRAGMA journal_mode = WAL;', { ignoreBusy: true });
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA wal_autocheckpoint = 1000;');
  db.exec('PRAGMA foreign_keys = ON;');
  initSchemaWithBackup(db, ctx.dbPath, {
    beforePostMigrationIndexes: dedupePeerBindings
  });
  if (options.migrateRegistered !== false) migrateRegisteredProjectDbs(ctx);
  return db;
}

function connectReadOnly(ctx) {
  if (!fs.existsSync(ctx.dbPath) || !fs.statSync(ctx.dbPath).isFile()) {
    throw new CliError('NOT_FOUND', `Project database does not exist: ${ctx.dbPath}`);
  }
  return new DatabaseSync(ctx.dbPath, { timeout: 5000, readOnly: true });
}

function migrateRegisteredProjectDbs(ctx) {
  if (projectMigrationFanoutDepth > 0) return;
  projectMigrationFanoutDepth += 1;
  try {
    const currentDb = path.resolve(ctx.dbPath);
    const seen = new Set([currentDb]);
    for (const project of readProjectRegistry()) {
      let resolved;
      try {
        resolved = resolveProjectDatabase({
          root: project.root,
          db: project.db || path.join(project.root, '.hello-cc', 'mesh.db'),
          createStateDir: false
        });
      } catch (err) {
        console.error(redactedLogText(`[${new Date().toISOString()}] skipping registered project DB migration for ${project.db || project.root}: ${err?.message || err}`));
        continue;
      }
      const root = resolved.root;
      const dbPath = resolved.db;
      if (seen.has(dbPath)) continue;
      seen.add(dbPath);
      const cacheKey = `${dbPath}:${DB_SCHEMA_VERSION}`;
      if (migratedRegisteredProjectDbs.has(cacheKey)) continue;
      if (!fs.existsSync(root) || !fs.existsSync(dbPath)) continue;
      // xx-05: a persistently failing sibling (corrupt, read-only, or a slow
      // network FS) must not re-pay the full multi-second failure attempt on
      // every connect. A sidecar marker records the last failure; skip the DB
      // for a cooldown window instead of retrying on every command/request.
      const failedMarker = `${dbPath}.migration-failed`;
      try {
        if (Date.now() - fs.statSync(failedMarker).mtimeMs < MIGRATION_FAILURE_COOLDOWN_MS) continue;
      } catch {}
      let db = null;
      try {
        db = new DatabaseSync(dbPath, { timeout: 5000 });
        db.exec('PRAGMA busy_timeout = 5000;');
        execWithBusyRetry(db, 'PRAGMA journal_mode = WAL;', { ignoreBusy: true });
        db.exec('PRAGMA synchronous = NORMAL;');
        db.exec('PRAGMA foreign_keys = ON;');
        initSchemaWithBackup(db, dbPath, {
          beforePostMigrationIndexes: dedupePeerBindings
        });
        migratedRegisteredProjectDbs.add(cacheKey);
        try { fs.rmSync(failedMarker, { force: true }); } catch {}
      } catch (err) {
        // A corrupt or busy sibling project DB must not fail commands or crash
        // the shared runtime for unrelated projects. Skip it and keep going.
        console.error(redactedLogText(`[${new Date().toISOString()}] skipping registered project DB migration for ${dbPath}: ${err?.message || err}`));
        try { fs.writeFileSync(failedMarker, String(now())); } catch {}
        continue;
      } finally {
        try { db?.close(); } catch {}
      }
    }
  } finally {
    projectMigrationFanoutDepth -= 1;
  }
}

function addEvent(db, type, actor, taskId, payload) {
  db.prepare(`
    INSERT INTO events(type, actor, task_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(type, actor || null, taskId || null, JSON.stringify(payload || {}), now());
}

function auditPayload({ actor = null, target = null, source = 'cli', admin = false, ...extra } = {}) {
  const payload = { ...extra, source };
  if (actor) payload.actor_peer = actor;
  if (target) payload.target_peer = target;
  if (admin) payload.admin = true;
  return payload;
}

function requestActorPeer(input = {}, fallback = 'web') {
  return String(input.auditActorPeer || fallback || 'web').trim() || 'web';
}

function requestSource(input = {}, fallback = 'web') {
  return String(input.auditSource || fallback || 'web').trim() || fallback;
}

function latestHookProviderSession(db, peer) {
  if (!peer) return null;
  try {
    const row = db.prepare(`
      SELECT COALESCE(
        json_extract(payload, '$.session_id'),
        json_extract(payload, '$.sessionId'),
        json_extract(payload, '$.conversation_id'),
        json_extract(payload, '$.conversationId')
      ) AS session_id
      FROM events
      WHERE actor = ?
        AND type LIKE 'hook.%'
      ORDER BY id DESC
      LIMIT 1
    `).get(peer);
    return row?.session_id || null;
  } catch {
    return null;
  }
}

const {
  dedupePeerBindings,
  findProviderSessionBinding,
  upsertCanonicalPeerBinding
} = createPeerBindingStore({ now, addEvent });

function upsertPeer(db, peer) {
  const t = now();
  const identity = Object.hasOwn(peer, 'processIdentity')
    ? peer.processIdentity
    : liveProcessIdentity(peer.pid);
  db.prepare(`
    INSERT INTO peers(id, kind, role, worktree, branch, pid, pid_start_token, pid_command_hash, status, capabilities, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      role = excluded.role,
      worktree = excluded.worktree,
      branch = excluded.branch,
      pid = excluded.pid,
      pid_start_token = excluded.pid_start_token,
      pid_command_hash = excluded.pid_command_hash,
      -- hb-08: an incidental upsert with the default 'idle' status must not
      -- resurrect a peer that was explicitly marked exited/detached.
      status = CASE WHEN excluded.status = 'idle' AND peers.status IN ('exited', 'detached')
                    THEN peers.status ELSE excluded.status END,
      capabilities = excluded.capabilities,
      last_seen_at = excluded.last_seen_at
  `).run(
    peer.id,
    peer.kind || 'other',
    peer.role || '',
    peer.worktree || '',
    peer.branch || '',
    peer.pid || null,
    identity?.startToken || null,
    identity?.commandHash || null,
    peer.status || 'idle',
    peer.capabilities || '',
    t,
    t
  );
}

function touchPeer(db, id, status = null) {
  if (!id) return;
  const existing = db.prepare('SELECT id FROM peers WHERE id = ?').get(id);
  if (!existing) {
    upsertPeer(db, {
      id,
      kind: 'other',
      role: 'auto',
      worktree: process.cwd(),
      branch: detectBranch(process.cwd()),
      pid: process.ppid,
      status: status || 'idle',
      capabilities: ''
    });
  } else {
    db.prepare(`
      UPDATE peers
      SET last_seen_at = ?, status = COALESCE(?, status)
      WHERE id = ?
    `).run(now(), status, id);
  }
}

function touchCurrentPeer(db, ctx, resolved, status = null, kindHint = 'shell') {
  registerProjectActivity(ctx);
  const identity = typeof resolved === 'string'
    ? { id: resolved, auto: false }
    : resolved;
  if (!identity || !identity.id) return;
  if (!identity.auto) {
    touchPeer(db, identity.id, status);
    return;
  }

  const existing = db.prepare('SELECT id FROM peers WHERE id = ?').get(identity.id);
  if (existing) {
    touchPeer(db, identity.id, status);
    return;
  }

  const kind = autoPeerKind(kindHint);
  const sessionId = autoPeerSessionId(kind);
  const resumeId = autoPeerResumeId(kind);
  upsertPeer(db, {
    id: identity.id,
    ...autoPeerDefaults(ctx, kindHint, status || 'idle')
  });
  upsertCanonicalPeerBinding(db, {
    peer: identity.id,
    provider: kind,
    ...providerSessionParts(resumeId || sessionId),
    resume_mode: resumeId ? 'resume' : (sessionId ? 'detected' : 'auto'),
    resume_arg: resumeId || null,
    command: null,
    transport: process.env.TMUX_PANE ? 'auto-tmux' : 'auto-shell',
    runtime_session_id: identity.id
  }, true);
  addEvent(db, 'peer.auto_joined', identity.id, null, {
    root: ctx.root,
    basis: autoPeerBasis(kind),
    provider_session: resumeId || sessionId || null
  });
}

function formatHookEventName(hookType) {
  const known = {
    sessionstart: 'SessionStart',
    userpromptsubmit: 'UserPromptSubmit',
    stop: 'Stop',
    posttooluse: 'PostToolUse',
    pretooluse: 'PreToolUse'
  };
  const compact = String(hookType || '').replace(/[^a-z]/gi, '').toLowerCase();
  return known[compact] || String(hookType || 'unknown');
}

function writeGuidance(ctx) {
  return writeGuidanceForRoot(ctx.root);
}

function removeGuidanceBlocks(ctx) {
  return removeGuidanceBlocksForRoot(ctx.root);
}

async function cmdInit(ctx, args) {
  registerProjectActivity(ctx);
  const opts = parseOpts(args, { booleans: ['no-guidance'] });
  const db = connect(ctx);
  const guidance = opts['no-guidance'] ? null : writeGuidance(ctx);
  addEvent(db, 'mesh.init', 'human', null, { root: ctx.root, db: ctx.dbPath, guidance });
  printResult(ctx, { root: ctx.root, db: ctx.dbPath, guidance }, (data) => [
    'hello-cc initialized',
    `root: ${data.root}`,
    `db: ${data.db}`,
    data.guidance ? `guidance: ${data.guidance}` : 'guidance: skipped'
  ].join('\n'));
}

async function cmdRegister(ctx, args) {
  registerProjectActivity(ctx);
  const opts = parseOpts(args, { arrays: ['cap'] });
  const identity = resolveCurrentPeer(ctx, opts, 'peer', opts.kind || 'shell');
  const id = identity.id;
  const db = connect(ctx);
  const peer = {
    id,
    kind: opts.kind || 'other',
    role: opts.role || '',
    worktree: path.resolve(opts.worktree || ctx.cwd),
    branch: opts.branch || detectBranch(ctx.cwd),
    pid: intOpt(opts, 'pid', process.ppid),
    status: opts.status || 'idle',
    capabilities: Array.isArray(opts.cap) ? opts.cap.join(',') : (opts.cap || opts.capabilities || '')
  };
  upsertPeer(db, peer);
  addEvent(db, 'peer.registered', id, null, peer);
  printResult(ctx, peer, (data) => `registered ${data.id} (${data.kind}${data.role ? `, ${data.role}` : ''})`);
}

async function cmdEnv(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpEnv();
  const opts = parseOpts(args);
  const peer = resolveTargetPeer(ctx, opts, 'peer', 'shell').id;
  const values = {
    HCC_PEER: peer,
    HCC_ROOT: ctx.root,
    HCC_DB: ctx.dbPath
  };
  printResult(ctx, values, (data) => shellExports(data));
}

async function cmdJoin(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpJoin();
  registerProjectActivity(ctx);
  const opts = parseOpts(args, { arrays: ['cap'] });
  const identity = resolveCurrentPeer(ctx, opts, 'peer', opts.kind || 'shell');
  const id = identity.id;
  const peer = {
    id,
    kind: opts.kind || 'other',
    role: opts.role || 'peer',
    worktree: path.resolve(opts.worktree || ctx.cwd),
    branch: opts.branch || detectBranch(ctx.cwd),
    pid: intOpt(opts, 'pid', process.ppid),
    status: opts.status || 'working',
    capabilities: Array.isArray(opts.cap) ? opts.cap.join(',') : (opts.cap || opts.capabilities || 'manual-shell')
  };
  const db = connect(ctx);
  try {
    upsertPeer(db, peer);
    upsertCanonicalPeerBinding(db, {
      peer: id,
      provider: peer.kind,
      provider_session_id: null,
      provider_session_name: null,
      resume_mode: 'manual',
      resume_arg: null,
      command: null,
      transport: 'manual-shell',
      runtime_session_id: id
    }, true);
    addEvent(db, 'peer.joined', id, null, peer);
  } finally {
    db.close();
  }
  const values = {
    HCC_PEER: id,
    HCC_ROOT: ctx.root,
    HCC_DB: ctx.dbPath
  };
  printResult(ctx, { peer, env: values }, (data) => shellExports(data.env));
}

async function cmdHeartbeat(ctx, args) {
  const opts = parseOpts(args, { booleans: ['renew-locks'] });
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const status = opts.status || null;
  const ttlOverride = opts.ttl === undefined ? null : positiveSafeIntOpt(opts, 'ttl', DEFAULT_LOCK_TTL);
  const t = now();
  if (ttlOverride !== null) leaseDeadline(t, ttlOverride);
  const db = connect(ctx);
  const clockObservation = opts['renew-locks']
    ? observeLockClockSafety(db, ctx, { owner: peer, observedAt: t })
    : null;
  touchCurrentPeer(db, ctx, identity, status, 'shell');
  let renewed = 0;
  if (opts['renew-locks']) {
    const evidenceLive = peerEvidenceFromDb(db, ctx, peer).state === 'live';
    if (clockObservation?.renewed > 0 && ttlOverride === null) {
      renewed = clockObservation.renewed;
    } else if (ttlOverride !== null) {
      renewed = renewOwnedLocks(db, {
        owner: peer,
        nowSec: t,
        ttlOverride,
        includeExpired: evidenceLive
      });
    } else {
      renewed = renewOwnedLocks(db, {
        owner: peer,
        nowSec: t,
        includeExpired: evidenceLive
      });
    }
  }
  addEvent(db, 'peer.heartbeat', peer, null, { status, renewed });
  printResult(ctx, { peer, status, renewed }, (data) => `heartbeat ${data.peer}${data.renewed ? `, renewed locks: ${data.renewed}` : ''}`);
}

async function cmdPeers(ctx, args) {
  parseOpts(args);
  const db = connect(ctx);
  const t = now();
  const graceActive = clockGraceSuppressed(t, readClockGraceUntil(db));
  const rows = db.prepare(`
    SELECT *, (? - last_seen_at) AS age_sec
    FROM peers
    ORDER BY last_seen_at DESC, id ASC
  `).all(t);
  for (const row of rows) {
    const binding = db.prepare(`
      SELECT transport, runtime_target FROM peer_bindings WHERE peer = ?
    `).get(row.id) || null;
    const evidence = observePeerEvidence(ctx, row, binding);
    row.evidence_state = evidence.state;
    row.evidence_reason = evidence.reason;
    Object.assign(row, classifyPeerActivity(row, { activePeerTtl: ACTIVE_PEER_TTL, graceActive }));
  }
  printResult(ctx, rows, (data) => table(data, [
    { label: 'id', value: (r) => r.id },
    { label: 'kind', value: (r) => r.kind },
    { label: 'role', value: (r) => r.role || '' },
    { label: 'status', value: (r) => r.status },
    { label: 'age', value: (r) => `${r.age_sec}s` },
    { label: 'active', value: (r) => r.active ? 'yes' : 'stale' },
    { label: 'branch', value: (r) => r.branch || '' }
  ]));
}

const TASK_STATUS_SHORTCUTS = new Set(['running', 'review', 'blocked', 'abandoned']);

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
  if (!['claude', 'codex'].includes(session?.kind)) return false;
  if (session.provider_session_known) return true;
  const command = String(session.command || '');
  if (/^tmux\s+%/.test(command)) return false;
  return /\b(?:claude|codex)(?:\s|$)/.test(command);
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

  const durableMessage = dispatchPromptText(task, customMessage);
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
        await injectPeer(ctx, target, durableMessage, true, runtime, actor);
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
      actor,
      target,
      source: 'cli',
      admin: actor !== target,
      peer: target,
      title: task.title,
      message_id: messageId,
      injected,
      delivery: injected ? 'message+inject' : 'message-only',
      injection_reason: injectionReason,
      session_id: session?.id || null,
      session_kind: session?.kind || null,
      previous_assignee: previousAssignee,
      blocked_by_task_id: busyTask?.id || null
    }));
  } finally {
    eventDb.close();
  }

  const result = {
    task,
    target,
    message_id: messageId,
    message: durableMessage,
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
    rows = db.prepare(`
      SELECT * FROM tasks
      WHERE status = ? AND (owner = ? OR assignee = ?)
      ORDER BY priority ASC, id ASC LIMIT ?
    `).all(status, peer, peer, limit);
  } else if (status) {
    rows = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, id ASC LIMIT ?').all(status, limit);
  } else if (opts.all && peer) {
    rows = db.prepare(`
      SELECT * FROM tasks
      WHERE owner = ? OR assignee = ?
      ORDER BY status ASC, priority ASC, id ASC
      LIMIT ?
    `).all(peer, peer, limit);
  } else if (opts.all) {
    rows = db.prepare('SELECT * FROM tasks ORDER BY status ASC, priority ASC, id ASC LIMIT ?').all(limit);
  } else if (peer) {
    rows = queryOpenTasks(db, limit, peer);
  } else {
    rows = queryOpenTasks(db, limit);
  }
  const t = now();
  const peers = db.prepare(`
    SELECT id, status, pid, pid_start_token, pid_command_hash,
           last_seen_at, (? - last_seen_at) AS age_sec
    FROM peers
  `).all(t);
  for (const peerRow of peers) {
    const binding = db.prepare(`
      SELECT transport, runtime_target FROM peer_bindings WHERE peer = ?
    `).get(peerRow.id) || null;
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
    sendMessage(
      db,
      attemptedBy,
      owner,
      taskId || null,
      'task.owner-conflict',
      `Task #${taskId} is owned by ${owner}; ${attemptedBy} attempted ${action || 'modify'} and hello-cc left ownership unchanged.`
    );
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
  // Default to blocked-or-stale so an active owner's task is not silently
  // taken over (hb-07/conc-04). --force restores the old unconditional 'any'
  // behavior; --policy still wins when given explicitly.
  const policy = opts.force ? 'any' : (opts.policy || 'blocked-or-stale');
  const staleAfter = positiveIntOpt(opts, 'stale-after', ACTIVE_PEER_TTL, { max: 86400 * 30 });
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, 'working', 'shell');
  const task = takeOverTaskForPeer(db, peer, id, {
    reason,
    policy,
    staleAfter,
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
      db.prepare(`
        UPDATE tasks
        SET status = ?, completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(status, completedAt, t, id);
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

async function cmdMsg(ctx, args) {
  const sub = args[0];
  if (!sub || wantsHelp(args)) return helpMsg();
  if (sub === 'send') return msgSend(ctx, args.slice(1));
  if (sub === 'inbox') return msgInbox(ctx, args.slice(1));
  if (sub === 'ack') return msgAck(ctx, args.slice(1));
  if (sub === 'reply') return msgReply(ctx, args.slice(1));
  if (sub === 'thread') return msgThread(ctx, args.slice(1));
  throw new CliError('BAD_ARGS', `Unknown msg command: ${sub}`);
}

async function msgSend(ctx, args) {
  const opts = parseOpts(args);
  const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
  const sender = identity.id;
  const recipient = opts.to || 'all';
  const body = required(opts, 'body');
  const taskId = intOpt(opts, 'task', null);
  const kind = opts.kind || 'note';
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const id = sendMessage(db, sender, recipient, taskId, kind, body);
  printResult(ctx, { id, sender, recipient, task_id: taskId, kind, body, reply_to: null, thread_id: id },
    (data) => `sent message #${data.id} ${data.sender} -> ${data.recipient}`);
}

async function msgInbox(ctx, args) {
  const opts = parseOpts(args, { booleans: ['all'] });
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const waitSec = intOpt(opts, 'wait', 0);
  const limit = intOpt(opts, 'limit', 20);
  const includeAll = Boolean(opts.all);
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const deadline = Date.now() + waitSec * 1000;
  let rows = queryInbox(db, peer, includeAll, limit);
  while (!rows.length && waitSec > 0 && Date.now() < deadline) {
    await sleep(1000);
    rows = queryInbox(db, peer, includeAll, limit);
  }
  printResult(ctx, rows, (data) => table(data, [
    { label: 'id', value: (r) => `#${r.id}` },
    { label: 'from', value: (r) => r.sender },
    { label: 'kind', value: (r) => r.kind },
    { label: 'task', value: (r) => r.task_id ? `#${r.task_id}` : '' },
    { label: 'reply', value: (r) => r.reply_to ? `#${r.reply_to}` : '' },
    { label: 'thread', value: (r) => r.thread_id ? `#${r.thread_id}` : '' },
    { label: 'time', value: (r) => iso(r.created_at) },
    { label: 'body', value: (r) => r.body }
  ]));
}

async function msgAck(ctx, args) {
  const opts = parseOpts(args);
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const id = intOpt(opts, 'id', intOpt({ id: opts._[0] }, 'id'));
  if (!id) throw new CliError('BAD_ARGS', 'Missing --id');
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!message) throw new CliError('NOT_FOUND', `Message #${id} does not exist`);
  ackMessage(db, peer, message);
  printResult(ctx, { id, peer }, (data) => `acknowledged message #${data.id} for ${data.peer}`);
}

async function msgReply(ctx, args) {
  const opts = parseOpts(args);
  const id = intOpt(opts, 'id', intOpt({ id: opts._[0] }, 'id'));
  if (!id) throw new CliError('BAD_ARGS', 'Missing --id');
  const body = required(opts, 'body');
  const db = connect(ctx);
  const original = getMessage(db, id);
  if (!original) throw new CliError('NOT_FOUND', `Message #${id} does not exist`);
  const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
  const sender = identity.id;
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const recipient = opts.to || original.sender;
  const taskId = intOpt(opts, 'task', original.task_id || null);
  const kind = opts.kind || 'reply';
  const threadId = original.thread_id || original.id;
  const replyId = sendMessage(db, sender, recipient, taskId, kind, body, {
    reply_to: original.id,
    thread_id: threadId
  });
  ackMessage(db, sender, original);
  printResult(ctx, {
    id: replyId,
    sender,
    recipient,
    task_id: taskId,
    kind,
    body,
    reply_to: original.id,
    thread_id: threadId
  }, (data) => `sent reply #${data.id} to #${data.reply_to} ${data.sender} -> ${data.recipient}`);
}

async function msgThread(ctx, args) {
  const opts = parseOpts(args);
  const id = intOpt(opts, 'id', intOpt({ id: opts._[0] }, 'id'));
  if (!id) throw new CliError('BAD_ARGS', 'Missing --id');
  const limit = intOpt(opts, 'limit', 50);
  const db = connect(ctx);
  const data = queryMessageThread(db, id, limit);
  printResult(ctx, data, (thread) => {
    const lines = [`thread #${thread.thread_id} (${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'})`];
    for (const message of thread.messages) {
      const parts = [
        `#${message.id}`,
        `${message.sender} -> ${message.recipient || 'all'}`,
        message.task_id ? `task #${message.task_id}` : '',
        message.reply_to ? `reply #${message.reply_to}` : '',
        message.kind || 'note',
        iso(message.created_at)
      ].filter(Boolean).join(' ');
      lines.push(`${parts}\n  ${message.body}`);
    }
    return lines.join('\n');
  });
}

async function cmdAsk(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpAsk();
  const opts = parseOpts(args, { booleans: ['inject', 'no-enter'] });
  const recipient = opts.to || opts._[0];
  if (!recipient) throw new CliError('BAD_ARGS', 'Missing peer');
  const body = opts.body || opts._.slice(opts.to ? 0 : 1).join(' ');
  if (!body) throw new CliError('BAD_ARGS', 'Missing message');
  const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
  const sender = identity.id;
  const taskId = intOpt(opts, 'task', null);
  const kind = opts.kind || 'ask';
  const runtime = opts.inject ? readRuntime(ctx) : null;
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const id = sendMessage(db, sender, recipient, taskId, kind, body);
  let injected = false;
  if (opts.inject) {
    await injectPeer(ctx, recipient, body, !opts['no-enter'], runtime, sender);
    injected = true;
  }
  printResult(ctx, { id, sender, recipient, task_id: taskId, kind, body, injected }, (data) => `asked ${data.recipient} with message #${data.id}${data.injected ? ' and injected terminal input' : ''}`);
}

async function cmdBroadcast(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpBroadcast();
  const opts = parseOpts(args, { booleans: ['inject', 'no-enter'] });
  const body = opts.body || opts._.join(' ');
  if (!body) throw new CliError('BAD_ARGS', 'Missing message');
  const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
  const sender = identity.id;
  const taskId = intOpt(opts, 'task', null);
  const kind = opts.kind || 'broadcast';
  const runtime = opts.inject ? readRuntime(ctx) : null;
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const id = sendMessage(db, sender, 'all', taskId, kind, body);
  let injected = 0;
  let skipped = 0;
  if (opts.inject) {
    const sessions = await runtimeRequest(ctx, 'GET', '/api/sessions', null, runtime);
    const running = (sessions.sessions || []).filter((session) => session.status === 'running');
    for (const session of running) {
      try {
        await injectPeer(ctx, session.id, body, !opts['no-enter'], runtime, sender);
        injected += 1;
      } catch (err) {
        if (err instanceof CliError && ['NOT_FOUND', 'SESSION_NOT_RUNNING', 'TMUX_ERROR'].includes(err.code)) {
          skipped += 1;
          continue;
        }
        throw err;
      }
    }
  }
  printResult(ctx, { id, sender, recipient: 'all', task_id: taskId, kind, body, injected, skipped }, (data) => {
    const injectedText = data.injected ? ` and injected ${data.injected} terminal(s)` : '';
    const skippedText = data.skipped ? `, skipped ${data.skipped} stale terminal(s)` : '';
    return `broadcast message #${data.id}${injectedText}${skippedText}`;
  });
}

async function injectPeer(ctx, peer, text, enter = true, runtime = null, auditActor = null) {
  const actor = auditActor || resolveCurrentPeer(ctx, {}, 'peer', 'shell').id;
  const db = connect(ctx);
  try {
    addEvent(db, 'web.session.input.requested', actor, null, auditPayload({
      actor,
      target: peer,
      peer,
      source: 'cli',
      admin: actor !== peer,
      bytes: text.length,
      enter
    }));
  } finally {
    db.close();
  }
  return runtimeRequest(ctx, 'POST', `/api/sessions/${encodeURIComponent(peer)}/input`, {
    text,
    enter
  }, runtime);
}

async function cmdInject(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpInject();
  const opts = parseOpts(args, { booleans: ['no-enter'] });
  const peer = opts.peer || opts._[0];
  if (!peer) throw new CliError('BAD_ARGS', 'Missing peer');
  const text = opts.body || opts._.slice(opts.peer ? 0 : 1).join(' ');
  if (!text) throw new CliError('BAD_ARGS', 'Missing text');
  const enter = !opts['no-enter'];
  const result = await injectPeer(ctx, peer, text, enter);
  printResult(ctx, { peer, text, enter, result }, (data) => `injected ${data.peer}${data.enter ? ' and pressed Enter' : ''}`);
}

async function cmdPeer(ctx, args) {
  const sub = args[0];
  if (!sub || wantsHelp(args)) return helpPeer();
  if (sub === 'list') return peerList(ctx, args.slice(1));
  if (sub === 'start') return peerStart(ctx, args.slice(1));
  if (sub === 'attach') return peerAttach(ctx, args.slice(1));
  if (sub === 'stop') return peerStop(ctx, args.slice(1));
  throw new CliError('BAD_ARGS', `Unknown peer command: ${sub}`);
}

async function peerList(ctx, args) {
  parseOpts(args);
  try {
    const data = await runtimeRequest(ctx, 'GET', '/api/sessions');
    const db = connect(ctx);
    let bindings;
    try {
      bindings = new Map(db.prepare('SELECT * FROM peer_bindings').all().map((row) => [row.peer, row]));
    } finally {
      db.close();
    }
    const rows = (data.sessions || []).map((session) => ({
      ...session,
      binding: bindings.get(session.peer_id || session.id) || bindings.get(session.id) || null
    }));
    printResult(ctx, rows, (items) => table(items, [
      { label: 'id', value: (r) => r.id },
      { label: 'peer', value: (r) => r.peer_id && r.peer_id !== r.id ? r.peer_id : '' },
      { label: 'kind', value: (r) => r.kind },
      { label: 'role', value: (r) => r.role || '' },
      { label: 'status', value: (r) => r.status },
      { label: 'type', value: (r) => r.type || '' },
      { label: 'pane', value: (r) => r.pane || '' },
      { label: 'provider', value: (r) => r.binding ? r.binding.provider : '' },
      { label: 'resume', value: (r) => r.binding ? r.binding.resume_mode : '' },
      { label: 'session', value: (r) => r.binding ? (r.binding.provider_session_id || r.binding.provider_session_name || '') : '' },
      { label: 'pid', value: (r) => r.pid || '' },
      { label: 'command', value: (r) => r.command || '' }
    ]));
  } catch (err) {
    if (err instanceof CliError && ['RUNTIME_NOT_RUNNING', 'RUNTIME_UNREACHABLE'].includes(err.code)) {
      return cmdPeers(ctx, []);
    }
    throw err;
  }
}

async function peerStart(ctx, args) {
  const sep = args.indexOf('--');
  const optArgs = sep >= 0 ? args.slice(0, sep) : args;
  const cmdArgs = sep >= 0 ? args.slice(sep + 1) : [];
  const opts = parseOpts(optArgs, { booleans: ['last', 'continue', 'fork', 'force', 'restart-env'] });
  const actor = resolveCurrentPeer(ctx, {}, 'peer', 'shell').id;
  const id = opts.peer || opts._[0];
  if (!id) throw new CliError('BAD_ARGS', 'Missing peer');
  const firstCommand = cmdArgs[0] || '';
  const kind = inferPeerKind(id, opts.kind, firstCommand);
  const role = opts.role || 'peer';
  const cwd = path.resolve(opts.cwd || ctx.root);
  const built = buildPeerCommand(id, kind, opts, cmdArgs);
  const command = built.command;
  const binding = { ...built.binding, transport: 'tmux', runtime_session_id: id };

  let runtime;
  try { runtime = readRuntime(ctx); } catch (e) {
    if (e instanceof CliError && e.code === 'RUNTIME_NOT_RUNNING') {
      throw new CliError('RUNTIME_NOT_RUNNING',
        `No running web runtime found. Start ${CLI_NAME} web first, then ${CLI_NAME} peer start ${id}`);
    }
    throw e;
  }

  await runtimeRequest(ctx, 'GET', '/api/runtime', null, runtime);
  const db = connect(ctx);
  try {
    tx(db, () => {
      if (!opts.force) {
        const conflict = findProviderSessionBinding(db, binding);
        if (bindingHasRuntime(conflict)) {
          const providerSession = binding.provider_session_id || binding.provider_session_name || '';
          throw new CliError('PROVIDER_SESSION_IN_USE', `${binding.provider} session ${providerSession} is already bound to ${conflict.peer}`, {
            peer: conflict.peer,
            provider: conflict.provider,
            provider_session: providerSession
          });
        }
      }
      const previousOwner = db.prepare(`
        SELECT pid, pid_start_token, pid_command_hash
        FROM peers WHERE id = ?
      `).get(id) || null;
      upsertPeer(db, {
        id, kind, role,
        worktree: cwd,
        branch: detectBranch(cwd),
        pid: previousOwner?.pid || null,
        processIdentity: storedPeerIdentity(previousOwner),
        status: 'starting',
        capabilities: 'tmux'
      });
      addEvent(db, 'peer.start.requested', actor, null, auditPayload({
        actor,
        target: id,
        peer: id,
        source: 'cli',
        admin: actor !== id,
        kind,
        role,
        command,
        cwd
      }));
    });
  } finally {
    db.close();
  }
  const data = await runtimeRequest(ctx, 'POST', '/api/sessions', {
    id,
    kind,
    role,
    command,
    cwd,
    binding,
    env: childSessionEnv(),
    restartOnEnvChange: Boolean(opts['restart-env']),
    providerForce: Boolean(opts.force)
  }, runtime);
  printResult(ctx, data.session, (session) =>
    `started ${session.id} (${session.kind}, ${session.role})${session.pane ? ` pane=${session.pane}` : ` pid=${session.pid}`}`);
}

async function peerAttach(ctx, args) {
  const opts = parseOpts(args, { booleans: ['force'] });
  const actor = resolveCurrentPeer(ctx, {}, 'peer', 'shell').id;
  const id = opts.peer || opts._[0];
  if (!id) throw new CliError('BAD_ARGS', 'Missing peer');
  const pane = opts.pane || process.env.TMUX_PANE || null;
  const kind = opts.kind || null;
  const role = opts.role || 'peer';
  const cwd = opts.cwd ? path.resolve(opts.cwd) : null;

  let runtime;
  try { runtime = readRuntime(ctx); } catch (e) {
    if (e instanceof CliError && e.code === 'RUNTIME_NOT_RUNNING') {
      throw new CliError('RUNTIME_NOT_RUNNING',
        `No running web runtime found. Start ${CLI_NAME} web first, then ${CLI_NAME} peer attach ${id}`);
    }
    throw e;
  }
  await runtimeRequest(ctx, 'GET', '/api/runtime', null, runtime);
  const db = connect(ctx);
  try {
    addEvent(db, 'peer.attach.requested', actor, null, auditPayload({
      actor,
      target: id,
      peer: id,
      source: 'cli',
      admin: actor !== id,
      pane,
      kind,
      role,
      cwd
    }));
  } finally {
    db.close();
  }
  const data = await runtimeRequest(ctx, 'POST', '/api/sessions/attach', {
    id,
    kind,
    role,
    pane,
    cwd,
    force: Boolean(opts.force)
  }, runtime);
  printResult(ctx, data.session, (session) => `attached ${session.id} (${session.kind}, ${session.role}) pane=${session.pane}`);
}

async function peerStop(ctx, args) {
  const opts = parseOpts(args);
  const actor = resolveCurrentPeer(ctx, {}, 'peer', 'shell').id;
  const id = opts.peer || opts._[0];
  if (!id) throw new CliError('BAD_ARGS', 'Missing peer');
  let data;
  try {
    const db = connect(ctx);
    try {
      addEvent(db, 'peer.stop.requested', actor, null, auditPayload({
        actor,
        target: id,
        peer: id,
        source: 'cli',
        admin: actor !== id
      }));
    } finally {
      db.close();
    }
    data = await runtimeRequest(ctx, 'POST', `/api/sessions/${encodeURIComponent(id)}/stop`, {});
  } catch (err) {
    if (err instanceof CliError && err.code === 'RUNTIME_NOT_RUNNING') {
      // No server: just update the DB to mark the peer as exited
      const db = connect(ctx);
      try {
        db.prepare('UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ?').run('exited', now(), id);
        addEvent(db, 'peer.stopped', actor, null, auditPayload({
          actor,
          target: id,
          peer: id,
          admin: actor !== id
        }));
      } finally { db.close(); }
      printResult(ctx, { id, status: 'exited' }, (s) => `stopped ${s.id} (no server running — DB marked exited)`);
      return;
    }
    throw err;
  }
  printResult(ctx, data.session, (session) => `stopped ${session.id}`);
}

async function cmdLock(ctx, args) {
  const sub = args[0];
  if (!sub || wantsHelp(args)) return helpLock();
  if (sub === 'acquire') return lockAcquire(ctx, args.slice(1));
  if (sub === 'release') return lockRelease(ctx, args.slice(1));
  if (sub === 'renew') return lockRenew(ctx, args.slice(1));
  if (sub === 'list') return lockList(ctx, args.slice(1));
  throw new CliError('BAD_ARGS', `Unknown lock command: ${sub}`);
}

async function lockAcquire(ctx, args) {
  const opts = parseOpts(args);
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const requested = scopedLockResource(required(opts, 'resource'), opts.scope);
  const taskId = intOpt(opts, 'task', null);
  const ttl = positiveSafeIntOpt(opts, 'ttl', DEFAULT_LOCK_TTL);
  const reason = opts.reason || '';
  const acquisitionNow = now();
  leaseDeadline(acquisitionNow, ttl);
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, 'working', 'shell');
  let lock;
  try {
    const outcome = runOptimisticEvidenceMutation(db, {
      capture: (subjectDb) => {
        try {
          return captureLockAcquireSubject(subjectDb, {
            taskId,
            requested,
            now: acquisitionNow
          });
        } catch (err) {
          throw clockSafetyUnavailable(err);
        }
      },
      observe: (subject) => observeLockOwnerEvidence(subject, (row, binding) =>
        observePeerEvidence(ctx, row, binding)),
      same: sameLockAcquireSubject,
      beforeMutate: (subject, evidenceByOwner) =>
        prepareLockClockObservation(db, subject, evidenceByOwner),
      changedMessage: `Lock subjects changed while acquiring ${lockLabel(requested)}; retry`,
      mutate: (subject, evidenceByOwner, clockObservation) => {
      const t = subject.observedAt;
      if (taskId) {
        const task = subject.task;
        if (!task) throw new CliError('NOT_FOUND', `Task #${taskId} does not exist`);
        assertTaskOwnerForMutation(db, peer, task, 'lock-acquire');
      }
      // During clock grace, retained lock rows still conflict — but NOT
      // EXPIRED locks of verified-dead owners (CS-04): a dead owner's expired
      // lock must not block acquisition while the GC that would delete the row
      // is itself deferred by the same grace window.
      const graceActive = clockGraceSuppressed(t, clockObservation.graceUntil);
      const activeLocks = graceActive
        ? subject.locks.filter((row) =>
            !(Number(row.expires_at) <= t && evidenceByOwner.get(row.owner)?.state === 'dead'))
        : subject.locks.filter((row) =>
            Number(row.expires_at) > t ||
            evidenceByOwner.get(row.owner)?.state === 'live'
          );
      const conflict = activeLocks.find((row) => locksConflict(row, requested) && row.owner !== peer);
      if (conflict) {
        return { error: new CliError('LOCK_HELD', `Resource ${lockLabel(requested)} conflicts with lock ${lockLabel(conflict)} held by ${conflict.owner}`, {
          resource: requested.base_resource,
          scope: requested.scope,
          lock_resource: conflict.resource,
          lock_scope: lockScope(conflict),
          owner: conflict.owner,
          expires_at: iso(conflict.expires_at)
        }) };
      }
      const existing = subject.locks.find((row) => row.resource === requested.resource) || null;
      const expiresAt = leaseDeadline(t, ttl);
      db.prepare(`
        INSERT INTO locks(resource, base_resource, scope, owner, task_id, reason, expires_at, created_at, ttl_sec)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(resource) DO UPDATE SET
          base_resource = excluded.base_resource,
          scope = excluded.scope,
          owner = excluded.owner,
          task_id = excluded.task_id,
          reason = excluded.reason,
          expires_at = excluded.expires_at,
          created_at = excluded.created_at,
          ttl_sec = excluded.ttl_sec
      `).run(requested.resource, requested.base_resource, requested.scope, peer, taskId, reason, expiresAt, t, ttl);
      addEvent(db, 'lock.acquired', peer, taskId, { resource: requested.base_resource, lock_resource: requested.resource, scope: requested.scope, ttl, previous_owner: existing ? existing.owner : null });
      return { lock: db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource) };
      }
    });
    if (outcome.error) throw outcome.error;
    lock = outcome.lock;
  } catch (err) {
    notifyTaskOwnerConflict(ctx, err);
    throw err;
  }
  printResult(ctx, lock, (data) => `locked ${lockLabel(data)} by ${data.owner} until ${iso(data.expires_at)}`);
}

async function lockRelease(ctx, args) {
  const opts = parseOpts(args, { booleans: ['force'] });
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const requested = scopedLockResource(required(opts, 'resource'), opts.scope);
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, null, 'shell');
  const result = tx(db, () => {
    const existing = db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
    if (!existing) return { released: false, ...requested };
    if (existing.owner !== peer && !opts.force) {
      throw new CliError('LOCK_OWNED', `Lock is owned by ${existing.owner}`, { owner: existing.owner });
    }
    db.prepare('DELETE FROM locks WHERE resource = ?').run(requested.resource);
    addEvent(db, 'lock.released', peer, existing.task_id || null, { resource: requested.base_resource, lock_resource: requested.resource, scope: requested.scope, force: Boolean(opts.force) });
    return { released: true, ...requested };
  });
  printResult(ctx, result, (data) => data.released ? `released ${lockLabel(data)}` : `no lock for ${lockLabel(data)}`);
}

async function lockRenew(ctx, args) {
  const opts = parseOpts(args);
  const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const requested = scopedLockResource(required(opts, 'resource'), opts.scope);
  const ttl = positiveSafeIntOpt(opts, 'ttl', DEFAULT_LOCK_TTL);
  const renewalNow = now();
  const expiresAt = leaseDeadline(renewalNow, ttl);
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, 'working', 'shell');
  const lock = tx(db, () => {
    const existing = db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
    if (!existing) throw new CliError('NOT_FOUND', `No lock for ${lockLabel(requested)}`);
    if (existing.owner !== peer) throw new CliError('LOCK_OWNED', `Lock is owned by ${existing.owner}`, { owner: existing.owner });
    db.prepare('UPDATE locks SET expires_at = ?, ttl_sec = ? WHERE resource = ?').run(expiresAt, ttl, requested.resource);
    addEvent(db, 'lock.renewed', peer, existing.task_id || null, { resource: requested.base_resource, lock_resource: requested.resource, scope: requested.scope, ttl });
    return db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
  });
  printResult(ctx, lock, (data) => `renewed ${lockLabel(data)} until ${iso(data.expires_at)}`);
}

async function lockList(ctx, args) {
  const opts = parseOpts(args, { booleans: ['all'] });
  const db = connect(ctx);
  const t = now();
  const rows = opts.all || clockGraceSuppressed(t, readClockGraceUntil(db))
    ? db.prepare('SELECT * FROM locks ORDER BY resource ASC').all()
    : db.prepare('SELECT * FROM locks WHERE expires_at > ? ORDER BY resource ASC').all(t);
  printResult(ctx, rows, (data) => table(data, [
    { label: 'resource', value: (r) => lockBaseResource(r) },
    { label: 'scope', value: (r) => lockScope(r) },
    { label: 'owner', value: (r) => r.owner },
    { label: 'task', value: (r) => r.task_id ? `#${r.task_id}` : '' },
    { label: 'expires', value: (r) => iso(r.expires_at) },
    { label: 'reason', value: (r) => r.reason || '' }
  ]));
}

async function cmdHandoff(ctx, args) {
  const sub = args[0];
  if (!sub || wantsHelp(args)) return helpHandoff();
  if (sub === 'create') return handoffCreate(ctx, args.slice(1));
  if (sub === 'list') return handoffList(ctx, args.slice(1));
  throw new CliError('BAD_ARGS', `Unknown handoff command: ${sub}`);
}

async function handoffCreate(ctx, args) {
  const opts = parseOpts(args);
  const identity = resolveCurrentPeer(ctx, opts, 'from', 'shell');
  const from = identity.id;
  const taskId = intOpt(opts, 'task', null);
  const to = opts.to || null;
  const summary = required(opts, 'summary');
  const files = opts['changed-files']
    ? normalizeListText(opts['changed-files'])
    : JSON.stringify(changedFiles(ctx.cwd));
  const tests = normalizeListText(opts.tests, []);
  const risks = normalizeListText(opts.risks, []);
  const db = connect(ctx);
  touchCurrentPeer(db, ctx, identity, 'idle', 'shell');
  const id = tx(db, () => {
    const info = db.prepare(`
      INSERT INTO handoffs(task_id, from_peer, to_peer, summary, changed_files, tests, risks, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, from, to, summary, files, tests, risks, now());
    const handoffId = Number(info.lastInsertRowid);
    addEvent(db, 'handoff.created', from, taskId, { handoff_id: handoffId, to });
    if (to) sendMessage(db, from, to, taskId, 'handoff', `Handoff #${handoffId}: ${summary}`);
    return handoffId;
  });
  printResult(ctx, { id, task_id: taskId, from, to, summary, changed_files: files, tests, risks }, (data) => `created handoff #${data.id}${data.to ? ` -> ${data.to}` : ''}`);
}

async function handoffList(ctx, args) {
  const opts = parseOpts(args);
  const taskId = intOpt(opts, 'task', null);
  const limit = intOpt(opts, 'limit', 20);
  const db = connect(ctx);
  const rows = taskId
    ? db.prepare('SELECT * FROM handoffs WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(taskId, limit)
    : db.prepare('SELECT * FROM handoffs ORDER BY id DESC LIMIT ?').all(limit);
  printResult(ctx, rows, (data) => table(data, [
    { label: 'id', value: (r) => `#${r.id}` },
    { label: 'task', value: (r) => r.task_id ? `#${r.task_id}` : '' },
    { label: 'from', value: (r) => r.from_peer },
    { label: 'to', value: (r) => r.to_peer || '' },
    { label: 'time', value: (r) => iso(r.created_at) },
    { label: 'summary', value: (r) => r.summary }
  ]));
}

async function cmdEvent(ctx, args) {
  const sub = args[0];
  if (!sub || wantsHelp(args)) return helpEvent();
  if (sub === 'tail') return eventTail(ctx, args.slice(1));
  throw new CliError('BAD_ARGS', `Unknown event command: ${sub}`);
}

async function eventTail(ctx, args) {
  const opts = parseOpts(args);
  const limit = intOpt(opts, 'limit', 30);
  const db = connect(ctx);
  const rows = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit).reverse();
  printResult(ctx, rows, (data) => table(data, [
    { label: 'id', value: (r) => `#${r.id}` },
    { label: 'type', value: (r) => r.type },
    { label: 'actor', value: (r) => r.actor || '' },
    { label: 'task', value: (r) => r.task_id ? `#${r.task_id}` : '' },
    { label: 'time', value: (r) => iso(r.created_at) }
  ]));
}

async function cmdStatus(ctx, args) {
  const opts = parseOpts(args);
  const identity = resolveTargetPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const data = statusSummary(ctx, peer, identity);
  printResult(ctx, data, (s) => renderStatusSummary(s, peer));
}

async function cmdState(ctx, args) {
  if (wantsHelp(args)) return helpState();
  const opts = parseOpts(args, { arrays: ['resource'] });
  const identity = resolveTargetPeer(ctx, opts, 'peer', 'shell');
  const peer = identity.id;
  const resources = normalizeStateResources(opts.resource || opts.resources || []);
  const snapshot = statusSnapshot(ctx, peer, { resources, intent: opts.intent || null, scope: opts.scope || null });
  printResult(ctx, snapshot, (data) => renderStateSummary(data, peer));
}

async function cmdPrompt(ctx, args) {
  const opts = parseOpts(args);
  const peer = required(opts, 'peer', 'HCC_PEER');
  const kind = opts.kind || 'codex';
  const role = opts.role || 'peer';
  const cmd = `node ${commandPath()} --root ${JSON.stringify(ctx.root)}`;
  const text = `You are ${peer}, a ${kind} ${role} session working in this project.

Use hcc as the shared coordination bus for this terminal session. This
project uses a flat peer mesh: there is no required main/worker hierarchy.

Run these commands before changing files:

${cmd} register --peer ${peer} --kind ${kind} --role ${role}
${cmd} state --peer ${peer}
${cmd} msg inbox --peer ${peer}
${cmd} task next --peer ${peer}

Coordination rules:
- Claim exactly one task before editing.
- If state shows a current task for ${peer}, continue that task before claiming another pending task.
- Before editing a file, directory, module, or shared test resource, run:
  ${cmd} lock acquire --peer ${peer} --resource <path-or-module> [--scope <scope>] --task <task-id>
- If a lock is held by another peer, message that peer instead of editing:
  ${cmd} msg send --from ${peer} --to <peer-id> --body "<question>"
- Report progress or requests through msg send.
- Before stopping, run tests, create a handoff, and release locks:
  ${cmd} handoff create --from ${peer} --task <task-id> --summary "<what changed>" --tests "<commands/results>" --risks "<known risks>"
  ${cmd} task done --peer ${peer} --id <task-id> --summary "<done summary>"
  ${cmd} lock release --peer ${peer} --resource <path-or-module> [--scope <scope>]
`;
  printResult(ctx, { prompt: text }, () => text);
}

async function cmdUp(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpUp();
  const opts = parseOpts(args, { booleans: ['no-guidance', 'no-discover'] });
  validateOpts('up', opts, ['no-guidance', 'no-discover']);
  const result = await prepareLocalBus(ctx, opts);
  return printResult(ctx, result, (r) => {
    const lines = [
      `${PRODUCT_NAME} local coordination ready`,
      `project: ${r.root}`,
      `database: ${r.db}`
    ];
    if (r.guidance) lines.push(`guidance: ${r.guidance}`);
    if (r.hooks.claudeInstalled) lines.push('Claude Code hooks installed');
    if (r.hooks.codexInstalled) lines.push('Codex hooks installed');
    if (r.detected.length) lines.push(`detected: ${r.detected.map((s) => s.peerId).join(', ')}`);
    if (r.warnings?.length) lines.push(...r.warnings.map((warning) => `warning: ${warning}`));
    lines.push('web: run hcc web when you need browser terminal control');
    return lines.join('\n');
  });
}

async function prepareLocalBus(ctx, opts = {}) {
  let guidance = null;
  const db = connect(ctx);
  try {
    guidance = opts['no-guidance'] ? null : writeGuidance(ctx);
  } finally {
    db.close();
  }

  const hooks = { claudeInstalled: false, codexInstalled: false };
  const shims = { installed: [], skipped: [], pathUpdated: false, rcFile: null };
  const warnings = [];
  try {
    const setup = await loadSetup();
    try {
      if (!setup.verifyClaudeHooks()) {
        setup.installClaudeHooks(commandPath());
        hooks.claudeInstalled = true;
      }
    } catch (err) {
      warnings.push(`Claude Code hooks installation failed: ${err.message}`);
    }
    try {
      if (!setup.verifyCodexHooks()) {
        setup.installCodexHooks(commandPath());
        hooks.codexInstalled = true;
      }
    } catch (err) {
      warnings.push(`Codex hooks installation failed: ${err.message}`);
    }
    if (opts.installShims) {
      try {
        const result = setup.installShims(commandPath());
        shims.installed = result.installed;
        shims.skipped = result.skipped;
        if (result.installed.length) {
          const pathResult = setup.installPathEntry();
          shims.pathUpdated = !pathResult.alreadyPresent;
          shims.rcFile = pathResult.rcFile;
        }
      } catch (err) {
        warnings.push(`shim installation failed: ${err.message}`);
      }
    }
  } catch (err) {
    warnings.push(`local integration setup failed: ${err.message}`);
  }

  const detected = [];
  if (!opts['no-discover']) {
    try {
      const { scanClaudeSessions, scanCodexSessions, scanProcesses } = await loadDiscover();
      const found = [
        ...scanClaudeSessions(),
        ...scanCodexSessions(),
        ...scanProcesses(),
      ].filter((s) => sameResolvedPath(s.hccRoot, ctx.root));
      const byId = new Map();
      for (const s of found) {
        if (!byId.has(s.peerId)) byId.set(s.peerId, s);
      }
      if (byId.size > 0) {
        const db2 = connect(ctx);
        try {
          for (const s of byId.values()) {
            detected.push(s);
            upsertPeer(db2, {
              id: s.peerId, kind: s.kind, role: 'peer',
              worktree: s.cwd,
              branch: detectBranch(s.cwd),
              pid: s.pid,
              status: 'running',
              capabilities: 'detected'
            });
            upsertCanonicalPeerBinding(db2, bindingFromDetected(s, s.transport || 'detected'), true);
          }
        } finally {
          db2.close();
        }
      }
    } catch {}
  }

  return {
    root: ctx.root,
    db: ctx.dbPath,
    guidance,
    hooks,
    shims,
    detected,
    warnings
  };
}

function hccWebProcessMatches(line, ctx) {
  const args = splitProcessArgs(line);
  const hccIndex = args.findIndex((arg) => sameResolvedPath(arg, commandPath()) || arg.endsWith('/hcc.mjs'));
  if (hccIndex < 0) return false;
  const hccArgs = args.slice(hccIndex + 1);
  const { global, rest } = splitGlobalArgs(hccArgs);
  if (rest[0] !== 'web') return false;
  return sameResolvedPath(global.root, ctx.root) ||
    sameResolvedPath(global.db, ctx.dbPath);
}

function currentProcessAncestorPids(ppidByPid) {
  const ancestors = new Set();
  let pid = process.ppid;
  while (Number.isFinite(pid) && pid > 0 && !ancestors.has(pid)) {
    ancestors.add(pid);
    pid = ppidByPid.get(pid);
  }
  return ancestors;
}

async function stopOrphanWebRuntimes(ctx, keepPid = null) {
  if (process.platform === 'win32') return;
  let output = '';
  try {
    output = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).stdout || '';
  } catch {
    return;
  }

  const rows = [];
  const ppidByPid = new Map();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isFinite(pid)) continue;
    if (Number.isFinite(ppid)) ppidByPid.set(pid, ppid);
    rows.push({ pid, args: match[3] });
  }

  const ancestorPids = currentProcessAncestorPids(ppidByPid);
  const pids = [];
  for (const row of rows) {
    if (row.pid === process.pid || row.pid === keepPid || ancestorPids.has(row.pid)) continue;
    if (hccWebProcessMatches(row.args, ctx)) pids.push(row.pid);
  }
  if (!pids.length) return;

  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  await sleep(250);
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function assertWebTokenForHost(host, hasToken) {
  if (!isLoopbackHost(host) && !hasToken) {
    throw new CliError('WEB_EXPOSED_WITHOUT_TOKEN',
      `Refusing to expose the web console on ${host} without a token. A tokenless ` +
      `terminal on a non-loopback address lets anyone on the network run commands as you. ` +
      `Use --local to bind loopback only, or drop --no-token so a token is required.`);
  }
}

function webExposureWarning(host, port) {
  return `WARNING: hello-cc web is bound to ${host}:${port}, exposing a writable terminal ` +
    `(remote code execution surface) to your network. Anyone who reaches this port with the ` +
    `token can run commands as you. Prefer '--local' + 'ssh -L ${port}:127.0.0.1:${port}', ` +
    `or put it behind a TLS reverse proxy.`;
}

// Same-origin check for the WebSocket terminal upgrade. Browsers always send an
// Origin header on WebSocket handshakes, so a cross-site page attempting a
// cross-site WebSocket hijack (CSWSH) is rejected. Non-browser clients (the CLI,
// the `ws` library, regression tests) send no Origin and are allowed through to
// the token gate.
function webSocketOriginAllowed(req, options = {}) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return requestOriginMatches(req, options);
}

function proxyOriginForOpts(opts) {
  const trustProxy = Boolean(opts['trust-proxy']);
  const value = String(opts['proxy-origin'] || '');
  if (!trustProxy && value) throw new CliError('BAD_ARGS', '--proxy-origin requires --trust-proxy');
  if (!trustProxy) return '';
  if (!value) throw new CliError('BAD_ARGS', '--trust-proxy requires --proxy-origin');
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('invalid origin');
    return parsed.origin;
  } catch {
    throw new CliError('BAD_ARGS', '--proxy-origin must be an http(s) origin without a path, query, or credentials');
  }
}

async function startWebBackground(ctx, args) {
  const opts = parseOpts(args, { booleans: ['local', 'no-token', 'no-guidance', 'no-discover', 'tls', 'trust-proxy'] });
  validateOpts('web', opts, ['host', 'port', 'token', 'local', 'no-token', 'no-guidance', 'no-discover', 'tls', 'trust-proxy', 'proxy-origin']);
  const requestedProxyOrigin = proxyOriginForOpts(opts);
  if (requestedProxyOrigin) opts['proxy-origin'] = requestedProxyOrigin;
  validateWebTokenOpts(opts);
  const requestedHost = expectedWebHost(opts);
  assertWebTokenForHost(requestedHost, !opts['no-token']);
  if (!isLoopbackHost(requestedHost)) console.error(redactedLogText(webExposureWarning(requestedHost, intOpt(opts, 'port', 8787)) + (opts.tls ? '' : ' Consider --tls to encrypt this connection.')));
  ensureTmuxAvailable({ autoInstall: true });
  const setup = await prepareLocalBus(ctx, {
    ...opts,
    installShims: process.env.HCC_SKIP_SHIM_INSTALL === '1' ? false : true
  });
  registerProject(ctx);

  const existing = await readHealthyGlobalRuntime();
  if (existing) {
    if (webRuntimeMatchesRequest(existing, opts)) {
      await stopOrphanWebRuntimes(ctx, existing.pid || null);
      rememberRuntimeToken(existing, opts);
      try {
        await runtimeRequest(ctx, 'POST', '/api/projects', { root: ctx.root, db: ctx.dbPath }, existing);
      } catch {}
      writeRuntime(ctx, {
        ...existing,
        api_version: API_VERSION,
        root: ctx.root,
        db: ctx.dbPath,
        project_root: ctx.root,
        global_runtime: true
      });
      return printWebRuntime(ctx, existing, { already: true, logFile: webLogPath(ctx), setup });
    }
    // TLS-2: an idempotent `hcc web` must not silently stop a TLS runtime and
    // downgrade to plaintext (or vice versa) when only --tls/--trust-proxy
    // differ. Refuse loudly instead; host/port/token mismatches below still
    // take the normal stop-and-restart path (legitimate reconfiguration).
    const runtimeTls = existing.tls === undefined
      ? /^https:/i.test(String(existing.base_url || ''))
      : Boolean(existing.tls);
    if (runtimeTls !== Boolean(opts.tls) ||
        Boolean(existing.trust_proxy) !== Boolean(opts['trust-proxy']) ||
        (existing.proxy_origin || '') !== (opts['proxy-origin'] || '')) {
      throw new CliError('RUNTIME_CONFIG_CONFLICT',
        `A ${runtimeTls ? 'TLS' : 'plaintext'} web runtime is already running${existing.trust_proxy ? ' with --trust-proxy' : ''} on port ${existing.port}. ` +
        `Run ${CLI_NAME} down first, or re-run with matching flags (${opts.tls ? '--tls' : 'no --tls'}${opts['trust-proxy'] ? ', --trust-proxy' : ''}).`);
    }
    try { await runtimeRequest(ctx, 'POST', '/api/runtime/stop', {}, existing); } catch {}
    await sleep(250);
  }
  await stopOrphanWebRuntimes(ctx);

  try { fs.rmSync(runtimePath(ctx), { force: true }); } catch {}
  try { fs.rmSync(globalRuntimePath(), { force: true }); } catch {}

  const logFile = webLogPath(ctx);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // bg-05: rotate web.log once it grows past 5 MB (keep the previous .1).
  try {
    if (fs.statSync(logFile).size > 5 * 1024 * 1024) {
      try { fs.rmSync(`${logFile}.1`, { force: true }); } catch {}
      try { fs.renameSync(logFile, `${logFile}.1`); } catch {}
    }
  } catch {}
  const redactedStart = redactedLogText(`${CLI_NAME} web ${redactCliArgs(args).join(' ')}`);
  fs.appendFileSync(logFile, `\n[${new Date().toISOString()}] ${redactedStart}\n`, { mode: 0o600 });
  // The runtime echoes token-bearing URLs into web.log; keep it owner-only so a
  // co-tenant on the machine cannot read the token (net-02).
  try { fs.chmodSync(logFile, 0o600); } catch {}
  const logFd = fs.openSync(logFile, 'a');

  const childArgs = [
    commandPath(),
    '--root', ctx.root,
    '--db', ctx.dbPath,
    'web',
    ...args
  ];
  const childEnv = {
    ...process.env,
    [WEB_CHILD_ENV]: '1',
    HCC_ROOT: ctx.root,
    HCC_DB: ctx.dbPath
  };

  let child;
  try {
    child = spawn(process.execPath, childArgs, {
      cwd: ctx.cwd,
      env: childEnv,
      detached: true,
      stdio: ['ignore', logFd, logFd]
    });
  } finally {
    try { fs.closeSync(logFd); } catch {}
  }

  const runtime = await waitForStartedRuntime(ctx, child, logFile);
  child.unref();
  return printWebRuntime(ctx, runtime, { already: false, logFile, setup });
}

async function waitForStartedRuntime(ctx, child, logFile) {
  let exitInfo = null;
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const runtime = await readHealthyGlobalRuntime();
    if (runtime) return runtime;
    if (exitInfo) {
      const detail = redactedLogText(tailFile(logFile));
      throw new CliError('RUNTIME_START_FAILED',
        `${PRODUCT_NAME} runtime exited before it became healthy` +
        ` (code=${exitInfo.code ?? ''}${exitInfo.signal ? ` signal=${exitInfo.signal}` : ''}).` +
        `${detail ? `\n\nLast log lines:\n${detail}` : ''}`,
        { log: logFile });
    }
    await sleep(150);
  }

  try {
    if (process.platform === 'win32') process.kill(child.pid, 'SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {}
  const detail = redactedLogText(tailFile(logFile));
  throw new CliError('RUNTIME_START_TIMEOUT',
    `${PRODUCT_NAME} runtime did not become healthy within 15s.` +
    `${detail ? `\n\nLast log lines:\n${detail}` : ''}`,
    { log: logFile });
}

function printWebRuntime(ctx, runtime, opts = {}) {
  const logFile = opts.logFile || webLogPath(ctx);
  const data = {
    status: opts.already ? 'already_running' : 'started',
    pid: runtime.pid || null,
    root: ctx.root,
    db: ctx.dbPath,
    host: runtime.host || null,
    port: runtime.port || null,
    url: publicRuntimeUrl(runtime, ctx.root),
    local_url: localRuntimeUrl(runtime, ctx.root),
    runtime: runtimePath(ctx),
    log: logFile,
    stop: `${CLI_NAME} down`
  };
  return printResult(ctx, data, (r) => {
    const lines = [
      opts.already
        ? `${PRODUCT_NAME} web already running in background`
        : `${PRODUCT_NAME} web started in background`,
      `pid: ${r.pid}`,
      `project: ${r.root}`,
      `database: ${r.db}`,
      `runtime: ${r.runtime}`,
      `log: ${r.log}`,
      `open: ${r.url}`
    ];
    if (r.local_url !== r.url) lines.push(`local: ${r.local_url}`);
    if (opts.setup?.shims?.installed?.length) {
      lines.push(`shims: installed ${opts.setup.shims.installed.map((p) => path.basename(p)).join(', ')}`);
      if (opts.setup.shims.pathUpdated && opts.setup.shims.rcFile) {
        lines.push(`PATH updated in ${opts.setup.shims.rcFile}; open a new terminal or source it`);
      }
    }
    if (opts.setup?.warnings?.length) {
      lines.push(...opts.setup.warnings.map((warning) => `warning: ${warning}`));
    }
    lines.push(`stop: ${r.stop}`);
    return lines.join('\n');
  });
}

async function cmdDown(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpDown();
  const pointerFiles = [runtimePath(ctx), globalRuntimePath()];
  let runtime;
  try {
    runtime = readRuntime(ctx);
  } catch (err) {
    if (!(err instanceof CliError && err.code === 'RUNTIME_NOT_RUNNING') || process.env.HCC_RUNTIME_URL) throw err;
    const cleanup = reclaimRuntimePointerFiles(pointerFiles, { reclaimUnknown: false });
    if (cleanup.reclaimed < 1 || cleanup.blocked) throw err;
    printResult(ctx, { pointers: cleanup.reclaimed }, (result) =>
      `${PRODUCT_NAME} stale runtime pointer removed${result.pointers === 1 ? '' : 's'}`);
    return;
  }
  try {
    await runtimeRequest(ctx, 'POST', '/api/runtime/stop', {}, runtime);
  } catch (err) {
    if (!(err instanceof CliError && err.code === 'RUNTIME_UNREACHABLE')) throw err;
    if (runtime.source === 'env') throw err;
    const source = path.resolve(String(runtime.source || ''));
    const localSource = pointerFiles.find((file) => path.resolve(file) === source);
    if (!localSource) throw err;
    const cleanup = reclaimRuntimePointerFiles([localSource], { reclaimUnknown: false });
    if (cleanup.reclaimed !== 1 || cleanup.blocked) throw err;
    printResult(ctx, { runtime: localSource }, () => `${PRODUCT_NAME} stale runtime pointer removed`);
    return;
  }
  printResult(ctx, { runtime: runtime.source || runtime.base_url }, () => `${PRODUCT_NAME} runtime stopped`);
}

async function cmdWeb(ctx, args, startMeta = {}) {
  if (args[0] === '--help' || args[0] === '-h') return helpWeb();
  if (process.env[WEB_CHILD_ENV] !== '1') return startWebBackground(ctx, args);
  const runtimeIdentity = await waitForLiveProcessIdentity(process.pid, { timeoutMs: 1_000 });
  if (runtimeIdentity.state !== 'live' || !runtimeIdentity.identity) {
    throw new CliError(
      'RUNTIME_IDENTITY_UNAVAILABLE',
      'Unable to verify the web runtime process identity; no runtime pointer was published.'
    );
  }
  const processIdentity = runtimeIdentity.identity;
  const opts = parseOpts(args, { booleans: ['local', 'no-token', 'no-guidance', 'no-discover', 'tls', 'trust-proxy'] });
  validateOpts('web', opts, ['host', 'port', 'token', 'local', 'no-token', 'no-guidance', 'no-discover', 'tls', 'trust-proxy', 'proxy-origin']);
  validateWebTokenOpts(opts);
  const host = expectedWebHost(opts);
  const port = intOpt(opts, 'port', 8787);
  const token = makeWebToken(opts);
  assertWebTokenForHost(host, Boolean(token));
  if (!isLoopbackHost(host)) console.error(redactedLogText(webExposureWarning(host, port) + (opts.tls ? '' : ' Consider --tls to encrypt this connection.')));
  const useTls = Boolean(opts.tls);
  const trustProxy = Boolean(opts['trust-proxy']);
  const proxyOrigin = proxyOriginForOpts(opts);
  const tlsCredentials = useTls ? ensureSelfSignedCert([host]) : null;
  // Browser sessions: a token printed in the URL is exchanged once for an
  // HttpOnly cookie so the token stops travelling in every fetch/WS URL
  // (net-02). The cookie carries an opaque session id (not the token); it is
  // meaningless outside this runtime and is lost on restart.
  const DEFAULT_WEB_SESSION_TTL_SEC = 30 * 24 * 60 * 60;
  const regressionWebSessionTtlRaw = process.env.HCC_REGRESSION_WEB_SESSION_TTL_SEC || '';
  const regressionWebSessionTtl = /^\d+$/.test(regressionWebSessionTtlRaw)
    ? Number.parseInt(regressionWebSessionTtlRaw, 10)
    : 0;
  const WEB_SESSION_TTL_SEC = process.env.HCC_REGRESSION_TEST === '1' &&
    regressionWebSessionTtl >= 1 && regressionWebSessionTtl <= 60
    ? regressionWebSessionTtl
    : DEFAULT_WEB_SESSION_TTL_SEC;
  const MAX_WEB_SESSIONS = 256;
  const webSessions = new Map();
  const bufferGcPlanStore = createBufferGcPlanStore();
  const bufferUnknownTracker = new Map();
  const bufferDirectoriesByProject = new Map();
  function parseCookieSid(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === 'hcc_sid') {
        // xx-07: bound the value length so an attacker-controlled cookie cannot
        // cause unbounded decode/lookup work.
        const raw = rest.join('=');
        if (raw.length > 128) return '';
        try { return decodeURIComponent(raw); } catch { return ''; }
      }
    }
    return '';
  }
  function closeWebSession(sid, reason = 'session revoked') {
    const session = webSessions.get(sid);
    webSessions.delete(sid);
    for (const ws of session?.sockets || []) {
      try { ws.close(4001, reason); } catch {}
    }
    session?.sockets?.clear();
  }
  function pruneWebSessions(t = now()) {
    for (const [sid, session] of webSessions) {
      if (session.expiresAt <= t) closeWebSession(sid, 'session expired');
    }
  }
  function issueSession() {
    pruneWebSessions();
    while (webSessions.size >= MAX_WEB_SESSIONS) {
      const oldest = webSessions.keys().next().value;
      if (!oldest) break;
      closeWebSession(oldest, 'session limit reached');
    }
    const sid = randomBytes(24).toString('base64url');
    webSessions.set(sid, { expiresAt: now() + WEB_SESSION_TTL_SEC, sockets: new Set() });
    return sid;
  }
  function sessionCookieHeader(sid, req) {
    const parts = [`hcc_sid=${sid}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${WEB_SESSION_TTL_SEC}`];
    if (requestIsSecure(req, { trustProxy, proxyOrigin })) parts.push('Secure');
    return parts.join('; ');
  }
  function expiredSessionCookieHeader(req) {
    const parts = ['hcc_sid=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (requestIsSecure(req, { trustProxy, proxyOrigin })) parts.push('Secure');
    return parts.join('; ');
  }
  function cookieSessionRecord(req) {
    const sid = parseCookieSid(req);
    if (!sid) return null;
    const session = webSessions.get(sid);
    if (!session || session.expiresAt <= now()) {
      if (session) closeWebSession(sid, 'session expired');
      return null;
    }
    return { sid, session };
  }
  function cookieSessionOk(req) {
    return Boolean(cookieSessionRecord(req));
  }
  function cookieSocketValid(ws) {
    const auth = ws?.hccCookieAuth;
    if (!auth) return true;
    const current = webSessions.get(auth.sid);
    if (current === auth.session && current.expiresAt > now()) return true;

    const reason = current === auth.session ? 'session expired' : 'session revoked';
    if (current === auth.session) {
      closeWebSession(auth.sid, reason);
    } else {
      auth.session.sockets.delete(ws);
      try { ws.close(4001, reason); } catch {}
    }
    return false;
  }
  const webSessionPruner = setInterval(pruneWebSessions, 60000);
  webSessionPruner.unref?.();
  function webAuthMode(url, req) {
    if (authOk(url, req, token)) return 'token';
    return cookieSessionOk(req) ? 'cookie' : null;
  }
  ensureTmuxAvailable({ autoInstall: false });
  const ptyModule = await import('node-pty');
  const { WebSocketServer } = await import('ws');
  const pty = ptyModule.default || ptyModule;
  const sessions = new Map();
  const projectContexts = new Map();
  const prepared = await prepareLocalBus(ctx, opts);

  function newSessionActionToken() {
    return randomBytes(32).toString('base64url');
  }

  function rememberProject(projectCtx, { activity = false, register = false, nonblocking = false } = {}) {
    const normalized = contextForProject(projectCtx.root, projectCtx.dbPath, { cwd: projectCtx.cwd, json: ctx.json });
    const isNew = !projectContexts.has(normalized.root);
    // Activity refresh is already nonblocking and throttled before it tries the
    // registry lock. Calling it on each request keeps last_seen_at current
    // without putting the synchronous lock back on the HTTP hot path.
    if (activity) registerProjectActivity(normalized);
    else if (isNew || register) {
      try {
        registerProject(normalized, { nonblocking });
      } catch (error) {
        if (nonblocking && ['ERR_FILE_LOCK_BUSY', 'ERR_FILE_LOCK_TIMEOUT'].includes(error?.code)) {
          throw new CliError('REGISTRY_BUSY', 'Project registry is busy; retry the request');
        }
        throw error;
      }
    }
    projectContexts.set(normalized.root, normalized);
    return normalized;
  }

  function knownProjects() {
    const rows = readProjectRegistry();
    if (!rows.some((p) => sameResolvedPath(p.root, ctx.root))) rows.unshift(projectRecord(ctx));
    for (const project of rows) {
      if (!projectContexts.has(project.root)) {
        projectContexts.set(project.root, contextForProject(project.root, project.db, { json: ctx.json }));
      }
    }
    return rows;
  }

  function resolveWebProjectContext(root, db) {
    const first = resolveProjectDatabase({ root, db, createStateDir: true });
    // Re-read every filesystem identity immediately before the returned
    // context can reach connect(). A path rebound after the first pass fails
    // closed instead of carrying a stale lexical decision into SQLite.
    const final = resolveProjectDatabase({
      root: first.root,
      db: first.db,
      createStateDir: true
    });
    return contextForProject(final.root, final.db, { cwd: final.root, json: ctx.json });
  }

  function connectWebProject(projectCtx, options = {}) {
    const final = resolveProjectDatabase({
      root: projectCtx.root,
      db: projectCtx.dbPath,
      createStateDir: options.create !== false
    });
    return connect(contextForProject(final.root, final.db, {
      cwd: final.root,
      json: projectCtx.json
    }), options);
  }

  const {
    statusSnapshot: webStatusSnapshot,
    statusSummary: webStatusSummary
  } = createCoordinationState({
    activePeerTtl: ACTIVE_PEER_TTL,
    cliName: CLI_NAME,
    connect: connectWebProject,
    defaultLockTtl: DEFAULT_LOCK_TTL,
    now,
    queryInbox,
    queryOpenTasks,
    queryTimelineMessages,
    observePeerEvidence
  });
  const {
    webPeerAction: webPeerActionForProject
  } = createWebPeerActions({
    activePeerTtl: ACTIVE_PEER_TTL,
    addEvent,
    assertTaskOwnerForMutation,
    claimNextTasksForPeer,
    connect: connectWebProject,
    defaultLockTtl: DEFAULT_LOCK_TTL,
    detectBranch,
    now,
    observeClockSafetyInTransaction,
    observePeerEvidence,
    positiveIntOpt,
    peerEvidenceFromDb,
    queryInbox,
    statusSnapshot: webStatusSnapshot,
    statusSummary: webStatusSummary,
    takeOverTaskForPeer,
    touchPeer,
    tx,
    upsertPeer
  });

  function projectFromRequest(req, url) {
    const requestedRoot = url.searchParams.get('root') ||
      url.searchParams.get('project') ||
      req.headers['x-hcc-root'] ||
      ctx.root;
    const requestedDb = url.searchParams.get('db') ||
      req.headers['x-hcc-db'] ||
      path.join(requestedRoot, '.hello-cc', 'mesh.db');
    return rememberProject(
      resolveWebProjectContext(requestedRoot, requestedDb),
      { activity: true }
    );
  }

  function sessionKey(projectCtx, id) {
    return `${projectCtx.root}\u0000${id}`;
  }

  function sessionsForProject(projectCtx) {
    return [...sessions.values()].filter((session) => sameResolvedPath(session.root, projectCtx.root));
  }

  function getSession(projectCtx, id, db = null) {
    const direct = sessions.get(sessionKey(projectCtx, id));
    if (direct) return direct;
    for (const session of sessionsForProject(projectCtx)) {
      if (session.peerId === id) return session;
    }
    if (db) {
      for (const session of sessionsForProject(projectCtx)) {
        if (resolveSessionPeerId(db, session) === id) return session;
      }
    }
    return null;
  }

  function readActionToken(input, req) {
    const headerToken = req.headers['x-hcc-session-token'];
    return String(input.action_token || input.actionToken || headerToken || '').trim();
  }

  function resolveWebActionSession(projectCtx, peer, input, req) {
    const db = connectWebProject(projectCtx);
    let session;
    try {
      session = getSession(projectCtx, peer, db);
    } finally {
      db.close();
    }
    if (!session || session.status !== 'running') {
      throw new CliError('PEER_IDENTITY_REQUIRED', `Web peer action requires a running managed session for ${peer}`, { peer });
    }
    const actorPeer = session.peerId || peer;
    if (actorPeer !== peer && session.id !== peer) {
      throw new CliError('PEER_IDENTITY_MISMATCH', `Web peer action target ${peer} does not match managed session ${actorPeer}`, {
        peer,
        actor_peer: actorPeer,
        session_id: session.id
      });
    }
    const provided = readActionToken(input, req);
    const authorized = Boolean(provided) && [...(session.actionTokens || [])]
      .some((candidate) => tokenMatches(provided, candidate));
    if (!authorized) {
      throw new CliError('PEER_IDENTITY_REQUIRED', `Web peer action for ${peer} requires the managed session action token`, { peer });
    }
    return actorPeer;
  }

  function knownPeerIds(projectCtx) {
    const db = connectWebProject(projectCtx);
    try {
      return db.prepare('SELECT id FROM peers').all().map((row) => row.id);
    } finally {
      db.close();
    }
  }

  function nextProjectSessionId(projectCtx, kind) {
    return nextSessionId([
      ...sessionsForProject(projectCtx).map((session) => session.id),
      ...knownPeerIds(projectCtx)
    ], kind);
  }

  rememberProject(ctx);
  for (const project of readProjectRegistry()) {
    projectContexts.set(project.root, contextForProject(project.root, project.db, { json: ctx.json }));
  }

  // ── Optional external buffer-file session adoption ───────────────────────
  const bufsDir = path.join(ctx.root, '.hello-cc', BUFS_DIR_NAME);
  fs.mkdirSync(bufsDir, { recursive: true });

  function removeExternalBufferFiles(id, directory = bufsDir) {
    for (const suffix of ['out', 'in', 'resize', 'meta']) {
      fs.rmSync(path.join(directory, `${id}.${suffix}`), { force: true });
    }
  }

  function adoptExternalSession(id, pctx = ctx, directory = bufsDir) {
    const key = sessionKey(pctx, id);
    if (sessions.has(key)) return;
    const outFile  = path.join(directory, `${id}.out`);
    const inFile   = path.join(directory, `${id}.in`);
    const resizeFile = path.join(directory, `${id}.resize`);
    const metaFile = path.join(directory, `${id}.meta`);
    let adopted = null;
    try {
      adopted = withBufferDirectoryLease(directory, () => {
        if (!fs.existsSync(outFile) || !fs.existsSync(metaFile)) return null;
        let meta;
        try { meta = readExternalBufferMetadata(metaFile); } catch { return null; }
        // The producer publishes wrapper evidence before the PTY child identity
        // is complete. Do not cache that transitional snapshot as a session;
        // the next scan adopts the final metadata instead.
        if (meta.publishing === true) return null;
        const ownerKey = externalBufferOwnerKey(meta);
        if (!ownerKey) return null;
        const evidence = externalBufferEvidence(meta, inspectProcessIdentity);
        // Re-read and remove in one producer-coordinated lease. A new producer
        // with the same id cannot publish between this decision and deletion.
        if (evidence.state === 'dead') {
          removeExternalBufferFiles(id, directory);
          return null;
        }
        return { meta, ownerKey };
      });
    } catch { return; }
    if (!adopted) return;
    const { meta, ownerKey } = adopted;
    const wrapperOwnerPid = meta.wrapper_pid || meta.wrapperPid || null;
    const wrapperOwnerIdentity = meta.wrapper_identity || meta.wrapperIdentity || null;
    const dbOwnerPid = wrapperOwnerPid || meta.pid || null;
    const dbOwnerIdentity = wrapperOwnerPid
      ? wrapperOwnerIdentity
      : meta.child_identity || meta.childIdentity || null;

    const session = {
      id,
      peerId: id,
      actionTokens: new Set(),
      root: pctx.root,
      ctx: pctx,
      kind: meta.kind || 'external',
      role: meta.role || 'peer',
      command: meta.command || '(shim)',
      cwd: meta.cwd || pctx.root,
      pid: meta.pid || null,
      wrapperPid: meta.wrapper_pid || null,
      childIdentity: meta.child_identity || null,
      wrapperIdentity: meta.wrapper_identity || null,
      externalOwnerKey: ownerKey,
      externalDbOwner: Number.isInteger(Number(dbOwnerPid)) && dbOwnerIdentity?.startToken &&
        dbOwnerIdentity?.commandHash
        ? {
            pid: Number(dbOwnerPid),
            startToken: dbOwnerIdentity.startToken,
            commandHash: dbOwnerIdentity.commandHash
          }
        : null,
      type: 'external',
      outFile, inFile, resizeFile, metaFile,
      status: 'running',
      createdAt: now(),
      exitedAt: null,
      buffer: '',
      clients: new Set(),
      outputPoller: null,
      outputFd: null,
      exitPoller: null,
    };
    // Load existing output as initial snapshot
    try { session.buffer = fs.readFileSync(outFile, 'utf8'); } catch {}
    sessions.set(key, session);

    // Open a persistent fd for polling output; fstatSync is cheap.
    let outputOffset = 0;
    try {
      session.outputFd = fs.openSync(outFile, 'r');
      outputOffset = fs.fstatSync(session.outputFd).size;
    } catch {}
    session.outputPoller = setInterval(() => {
      try {
        if (session.outputFd === null) return;
        const stat = fs.fstatSync(session.outputFd);
        if (stat.size < outputOffset) outputOffset = 0;
        if (stat.size <= outputOffset) return;
        const buf = Buffer.alloc(stat.size - outputOffset);
        fs.readSync(session.outputFd, buf, 0, buf.length, outputOffset);
        outputOffset = stat.size;
        const data = buf.toString();
        session.buffer += data;
        if (session.buffer.length > 250000) session.buffer = session.buffer.slice(-200000);
        broadcast(session, { type: 'data', data });
        refreshPeerIoHeartbeat(session);
      } catch {
        // File removed or truncated — close and stop polling
        if (session.outputFd) { try { fs.closeSync(session.outputFd); } catch {} session.outputFd = null; }
      }
    }, 100);

    function finalizeExternalSession({ updateDatabase }) {
      session.status = 'exited';
      session.exitedAt = now();
      broadcast(session, { type: 'exit', event: {} });
      if (updateDatabase) {
        try {
          const exitDb = connectWebProject(session.ctx || ctx);
          try {
            const exitPeerId = session.peerId || session.id;
            if (session.externalDbOwner) {
              tx(exitDb, () => {
                const mutation = exitDb.prepare(`
                  UPDATE peers SET status = ?
                  WHERE id = ? AND pid = ? AND pid_start_token = ? AND pid_command_hash = ?
                `).run(
                  'exited',
                  exitPeerId,
                  session.externalDbOwner.pid,
                  session.externalDbOwner.startToken,
                  session.externalDbOwner.commandHash
                );
                if (Number(mutation.changes || 0) > 0) {
                  exitDb.prepare('UPDATE peer_bindings SET runtime_target = NULL, updated_at = ? WHERE peer = ?')
                    .run(now(), exitPeerId);
                }
              });
            }
          } finally { exitDb.close(); }
        } catch {}
      }
      if (session.outputFd) { try { fs.closeSync(session.outputFd); } catch {} session.outputFd = null; }
      if (session.outputPoller) clearInterval(session.outputPoller);
      if (session.exitPoller) clearInterval(session.exitPoller);
      sessions.delete(key);
    }

    // Reconcile and mutate the external group under the same lease used by its
    // producer. Owner changes detach only this stale in-memory view; they never
    // mark the replacement producer exited or remove its files.
    session.exitPoller = setInterval(() => {
      try {
        withBufferDirectoryLease(directory, () => {
          const outExists = fs.existsSync(outFile);
          let currentMeta;
          try {
            currentMeta = readExternalBufferMetadata(metaFile);
          } catch {
            // A producer removes the whole group in one lease. No out and no
            // metadata is therefore a clean exit; an unreadable metadata file
            // is unknown and must not mutate DB ownership.
            if (!outExists && !fs.existsSync(metaFile)) {
              finalizeExternalSession({ updateDatabase: true });
            }
            return;
          }
          const currentOwnerKey = externalBufferOwnerKey(currentMeta);
          if (!currentOwnerKey) return;
          if (currentOwnerKey !== session.externalOwnerKey) {
            finalizeExternalSession({ updateDatabase: false });
            return;
          }
          if (!outExists) {
            finalizeExternalSession({ updateDatabase: true });
            return;
          }
          if (externalBufferEvidence(currentMeta, inspectProcessIdentity).state !== 'dead') return;
          removeExternalBufferFiles(id, directory);
          finalizeExternalSession({ updateDatabase: true });
        });
      } catch {}
    }, 2000);
  }

  // Adopt any already-running external sessions
  function scanExternalSessions() {
    for (const projectCtx of runtimeProjectContexts()) {
      const directory = bufferDirectory(projectCtx);
      for (const id of externalBufferSessionIds(directory)) {
        adoptExternalSession(id, projectCtx, directory);
      }
    }
  }

  scanExternalSessions();

  const externalScanPoller = setInterval(scanExternalSessions, 1000);

  // Watch for new external sessions appearing
  let bufsWatcher = null;
  try {
    bufsWatcher = fs.watch(bufsDir, { persistent: false }, (event, filename) => {
      if (filename?.endsWith('.out')) {
        setTimeout(() => adoptExternalSession(path.basename(filename, '.out'), ctx, bufsDir), 300);
      }
    });
    // An FSWatcher with no 'error' listener re-throws async errors as an
    // uncaught exception (e.g. inotify limits, bufsDir removed) — keep it
    // contained so the shared runtime survives.
    bufsWatcher.on('error', (err) => {
      console.error(redactedLogText(`[${new Date().toISOString()}] bufs watcher error: ${err?.message || err}`));
    });
  } catch {}

  // ── Auto-attach detected peers that are in tmux panes ─────────────────────
  function listTmuxPanesOnce() {
    // Use '|' not '\t' as the field separator: older tmux (3.3a) replaces
    // whitespace in -F output with '_'. Path is last and rejoined so a '|'
    // inside a path is safe. tmux-8: session_name is NOT included here — a
    // user-created session name could contain '|', corrupting the parse. Callers
    // that need the session name use tmuxSessionNameForPane(pane.pane) which
    // queries a single field with no separator issue.
    const result = runTmux([
      'list-panes',
      '-a',
      '-F',
      '#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}'
    ]);
    return result.trim().split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('|');
        return {
          pane: parts[0],
          pid: Number.parseInt(parts[1] || '0', 10) || null,
          command: parts[2] || '',
          sessionName: '',
          cwd: parts.slice(3).join('|') || ''
        };
      })
      .filter((pane) => pane.pane && pane.pid);
  }

  function attachedTmuxState(projectCtx, db) {
    const peers = new Set();
    const panes = new Set();
    for (const session of sessionsForProject(projectCtx)) {
      if (session.status !== 'running') continue;
      peers.add(session.id);
      if (session.peerId) peers.add(session.peerId);
      const resolved = resolveSessionPeerId(db, session);
      if (resolved) peers.add(resolved);
      if (session.type === 'tmux' && session.pane) panes.add(session.pane);
    }
    return { peers, panes };
  }

  function reconcileRunningBindings(projectCtx = ctx, panes = null) {
    const db = connectWebProject(projectCtx);
    try {
      const tmuxPanes = Array.isArray(panes) ? panes : listTmuxPanesOnce();
      return reconcileRunningPeerBindings(db, projectCtx, {
        panes: tmuxPanes,
        inspectProcess: inspectProviderProcess,
        latestProviderSessionForPeer: (peer) => latestHookProviderSession(db, peer),
        addEvent,
        now
      });
    } catch {
      return null;
    } finally {
      db.close();
    }
  }

  let autoAttachScanInFlight = false;

  function scanAndAttachDetectedPeers() {
    if (autoAttachScanInFlight) return;
    autoAttachScanInFlight = true;
    let db = null;
    try {
      db = connectWebProject(ctx);

      // Always-on, TTL-independent hygiene: recover managed tmux sessions left
      // alive (default Stop = detach-without-kill, or across a restart) and reap
      // peers whose process is gone. Sweep first so its live set protects
      // still-alive sessions from being reaped.
      const liveManaged = reAdoptOrphanManagedTmuxSessions(ctx);
      reapDeadPeersForProject(ctx, liveManaged, db);

      const rows = db.prepare(`
        SELECT p.id, p.kind, p.role, p.worktree, p.pid,
               b.peer AS binding_peer, b.provider, b.provider_session_id,
               b.provider_session_name, b.resume_mode, b.resume_arg,
               b.command AS binding_command, b.runtime_session_id,
               b.runtime_target
        FROM peers p
        LEFT JOIN peer_bindings b ON b.peer = p.id
        WHERE p.status IN ('running', 'working', 'busy')
          AND p.pid IS NOT NULL
          AND p.last_seen_at >= ? - ?
        ORDER BY p.last_seen_at DESC
      `).all(now(), ACTIVE_PEER_TTL);
      if (!rows.length) return;

      let panes;
      try {
        panes = listTmuxPanesOnce();
      } catch {
        return;
      }
      if (!panes.length) return;
      const paneByPid = new Map();
      for (const pane of panes) {
        if (!paneByPid.has(pane.pid)) paneByPid.set(pane.pid, pane);
      }
      reconcileRunningPeerBindings(db, ctx, {
        panes,
        inspectProcess: inspectProviderProcess,
        latestProviderSessionForPeer: (peer) => latestHookProviderSession(db, peer),
        addEvent,
        now
      });
      const attached = attachedTmuxState(ctx, db);

      for (const row of rows) {
        if (attached.peers.has(row.id)) continue;
        if (row.binding_peer && attached.peers.has(row.binding_peer)) continue;
        if (row.runtime_session_id && attached.peers.has(row.runtime_session_id)) continue;

        const pane = paneByPid.get(Number(row.pid));
        if (!pane || attached.panes.has(pane.pane)) continue;

        const binding = row.binding_peer ? {
          provider: row.provider,
          provider_session_id: row.provider_session_id,
          provider_session_name: row.provider_session_name,
          resume_mode: row.resume_mode,
          resume_arg: row.resume_arg,
          command: row.binding_command,
          runtime_session_id: row.runtime_session_id || row.id,
          runtime_target: pane.pane
        } : null;
        try {
          const session = attachTmuxSession({
            id: row.id,
            pane: pane.pane,
            kind: row.kind || inferPeerKind(row.id, null, pane.command),
            role: row.role || 'peer',
            cwd: pane.cwd || row.worktree || ctx.root,
            command: row.binding_command || null,
            force: false,
            projectCtx: ctx,
            binding,
            autoAttach: true,
            auditActorPeer: 'web-runtime',
            auditSource: 'runtime'
          });
          attached.peers.add(row.id);
          if (session.peerId) attached.peers.add(session.peerId);
          attached.panes.add(pane.pane);
        } catch {}
      }
    } catch (err) {
      console.error(redactedLogText(`[${new Date().toISOString()}] auto-attach scan failed: ${err?.message || err}`));
    } finally {
      try { db?.close(); } catch {}
      autoAttachScanInFlight = false;
    }
  }

  scanAndAttachDetectedPeers();
  const autoAttachPoller = setInterval(scanAndAttachDetectedPeers, 5000);

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
            collectBufferEvidenceNow: () => collectRuntimeBufferEvidence([
              bufferDirectory(projectCtx)
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

  // ── Serialize + broadcast helpers ─────────────────────────────────────────
  function resolveSessionPeerId(db, session) {
    if (!session) return null;
    if (!db) return session.peerId || session.id || null;

    if (session.type === 'tmux' && session.pane) {
      const byTarget = db.prepare(`
        SELECT peer
        FROM peer_bindings
        WHERE runtime_target = ?
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `).get(session.pane);
      if (byTarget?.peer) {
        session.peerId = byTarget.peer;
        return byTarget.peer;
      }
    }

    if (session.id) {
      const byRuntime = db.prepare(`
        SELECT peer
        FROM peer_bindings
        WHERE runtime_session_id = ?
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `).get(session.id);
      if (byRuntime?.peer) {
        session.peerId = byRuntime.peer;
        return byRuntime.peer;
      }

      const byPeer = db.prepare(`
        SELECT peer
        FROM peer_bindings
        WHERE peer = ?
        LIMIT 1
      `).get(session.id);
      if (byPeer?.peer) {
        session.peerId = byPeer.peer;
        return byPeer.peer;
      }
    }

    session.peerId = session.peerId || session.id || null;
    return session.peerId;
  }

  function sessionBindingForSerialize(db, session, peerId) {
    if (!session) return null;
    if (!db) return session.binding || null;

    if (session.type === 'tmux' && session.pane) {
      const byTarget = db.prepare(`
        SELECT *
        FROM peer_bindings
        WHERE runtime_target = ?
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `).get(session.pane);
      if (byTarget) return byTarget;
    }

    for (const peer of [peerId, session.peerId, session.id]) {
      if (!peer) continue;
      const byPeer = db.prepare(`
        SELECT *
        FROM peer_bindings
        WHERE peer = ?
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `).get(peer);
      if (byPeer) return byPeer;
    }

    if (session.id) {
      const byRuntime = db.prepare(`
        SELECT *
        FROM peer_bindings
        WHERE runtime_session_id = ?
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `).get(session.id);
      if (byRuntime) return byRuntime;
    }

    return session.binding || null;
  }

  function serializeBindingSummary(binding, session) {
    if (!binding) return null;
    return {
      peer: binding.peer || session?.peerId || session?.id || null,
      provider: binding.provider || session?.kind || 'other',
      provider_session_id: binding.provider_session_id || null,
      provider_session_name: binding.provider_session_name || null,
      resume_mode: binding.resume_mode || null,
      resume_arg: binding.resume_arg || null,
      command: binding.command || null,
      transport: binding.transport || session?.type || null,
      runtime_session_id: binding.runtime_session_id || session?.id || null,
      runtime_target: binding.runtime_target || session?.pane || null,
      created_at: binding.created_at || null,
      updated_at: binding.updated_at || null
    };
  }

  function serializeSession(session, db = null) {
    const peerId = resolveSessionPeerId(db, session);
    const binding = serializeBindingSummary(sessionBindingForSerialize(db, session, peerId), session);
    const providerSessionLabel = binding?.provider_session_id || binding?.provider_session_name || null;
    return {
      id: session.id,
      peer_id: peerId,
      kind: session.kind,
      role: session.role,
      command: session.command,
      cwd: session.cwd,
      pid: session.pid,
      pane: session.pane || null,
      root: session.root || session.ctx?.root || ctx.root,
      status: session.status,
      type: session.type || 'pty',
      created_at: session.createdAt,
      exited_at: session.exitedAt || null,
      binding,
      provider_session_known: Boolean(providerSessionLabel),
      provider_session_label: providerSessionLabel,
      // action_token is intentionally NOT serialized here: it used to be leaked
      // to every client via GET /api/sessions. It is now delivered only to the
      // client that opens the session's terminal WebSocket (see the snapshot
      // frame), so only the controlling client can use it (net-05).
      warning: session.warning || null
    };
  }

  function broadcast(session, payload) {
    const text = JSON.stringify(payload);
    for (const client of [...session.clients]) {
      if (!cookieSocketValid(client)) {
        session.clients.delete(client);
        continue;
      }
      if (client.readyState === client.OPEN) client.send(text);
    }
  }

  function hasOpenClients(session) {
    if (!session?.clients?.size) return false;
    let open = false;
    for (const client of [...session.clients]) {
      if (!cookieSocketValid(client)) {
        session.clients.delete(client);
        continue;
      }
      if (client.readyState === client.OPEN || client.readyState === 1) {
        open = true;
      } else {
        session.clients.delete(client);
      }
    }
    return open;
  }

  function closeSessionClients(session) {
    if (!session) return;
    session.actionTokens?.clear();
    if (!session.clients?.size) return;
    for (const client of [...session.clients]) {
      try {
        if (client.readyState === client.OPEN || client.readyState === 1) client.close(1001, 'runtime stopping');
        else if (typeof client.terminate === 'function') client.terminate();
      } catch {
        try { if (typeof client.terminate === 'function') client.terminate(); } catch {}
      }
    }
  }

  function detachTmuxSession(session, status = 'detached') {
    stopTmuxStream(session);
    if (session.exitPoller) { clearInterval(session.exitPoller); session.exitPoller = null; }

    session.status = status;
    session.exitedAt = now();
    broadcast(session, { type: 'exit', event: { reason: status } });
    closeSessionClients(session);
    const pctx = session.ctx || contextForProject(session.root || ctx.root, null, { json: ctx.json });
    sessions.delete(sessionKey(pctx, session.id));
    const db = connectWebProject(pctx);
    try {
      const t = now();
      const peerId = resolveSessionPeerId(db, session) || session.id;
      // Do not bump last_seen_at on death: preserve the true last-seen time so a
      // just-detached owner is not misread as freshly active (hb-01).
      db.prepare('UPDATE peers SET status = ? WHERE id IN (?, ?)').run(status, session.id, peerId);
      db.prepare(`
        UPDATE peer_bindings
        SET runtime_target = NULL, updated_at = ?
        WHERE peer IN (?, ?)
           OR runtime_session_id = ?
           OR (? IS NOT NULL AND runtime_target = ?)
      `).run(t, session.id, peerId, session.id, session.pane || null, session.pane || null);
      addEvent(db, status === 'exited' ? 'tmux.session.exited' : 'tmux.session.detached', peerId, null, auditPayload({
        actor: peerId,
        target: peerId,
        source: session.auditSource || 'runtime',
        runtime_session_id: session.id,
        pane: session.pane
      }));
    } finally {
      db.close();
    }
  }

  // Build the escape that places + shows/hides the cursor at a viewport cell,
  // used only to seed the initial snapshot (live output carries its own cursor).
  function cursorEscape(payload) {
    if (!payload) return '';
    return '[' + (payload.row + 1) + ';' + (payload.col + 1) + 'H' +
      (payload.visible ? '[?25h' : '[?25l');
  }

  function tmuxSnapshot(session) {
    const captured = tmuxCapturePane(session.pane);
    return captured + cursorEscape(tmuxCursorPayload(captured, tmuxCursorInfo(session.pane)));
  }

  function refreshTmuxSnapshot(session) {
    if (session.type !== 'tmux' || !session.pane) return session.buffer || '';
    try {
      session.buffer = tmuxSnapshot(session);
    } catch {
      // Keep the previous buffer if the pane disappears during capture.
    }
    return session.buffer || '';
  }

  function scheduleTmuxReplace(session) {
    if (session.type !== 'tmux' || !session.pane) return;
    if (session.replaceTimer) clearTimeout(session.replaceTimer);
    session.replaceTimer = setTimeout(() => {
      session.replaceTimer = null;
      session.lastBroadcastTime = Date.now();
      broadcast(session, { type: 'replace', data: refreshTmuxSnapshot(session) });
    }, 80);
  }

  // Stream the tmux pane's RAW output (escape sequences and all) into the
  // browser via `tmux pipe-pane`, so xterm.js renders incrementally — no
  // screenshot-poll, no full-screen reset, no flicker — and the program's own
  // cursor sequences are mirrored verbatim (works for bash, codex, claude, vim).
  function startTmuxReplacePoller(session, warning = null) {
    if (session.replacePoller) clearInterval(session.replacePoller);
    if (warning) {
      session.warning = {
        code: 'TMUX_STREAM_FALLBACK',
        message: `Raw tmux streaming unavailable; using capture polling: ${warning}`
      };
    }
    session.lastBroadcastTime = Date.now();
    session.replacePoller = setInterval(() => {
      if (session.status !== 'running') return;
      if (Date.now() - (session.lastBroadcastTime || 0) > 4000) {
        session.lastBroadcastTime = Date.now();
        broadcast(session, { type: 'replace', data: refreshTmuxSnapshot(session) });
      }
    }, 1600);
  }

  function startTmuxStream(session) {
    const safePane = String(session.pane).replace(/[^A-Za-z0-9_-]/g, '');
    const safeId = String(session.id).replace(/[^A-Za-z0-9_.-]/g, '_');
    const streamDirectory = bufferDirectory(session.ctx || ctx);
    fs.mkdirSync(streamDirectory, { recursive: true });
    const pipeFile = path.join(streamDirectory, `tmux-${safePane}-${safeId}.pipe`);
    session.pipeFile = pipeFile;
    // Restored panes may still have pipe-pane writers from a previous runtime.
    // Disable first so tmux tears down the stale writer before this runtime
    // installs its own FIFO reader.
    try { runTmux(['pipe-pane', '-t', session.pane]); } catch {}
    // Capture the existing screen once for the initial paint; pipe-pane only
    // forwards output produced after it is enabled.
    try {
      session.buffer = tmuxSnapshot(session);
    } catch {}

    // Use a FIFO rather than an append-only regular file. The old file-backed
    // implementation capped session.buffer but let .hello-cc/bufs grow forever
    // for long-lived tmux panes.
    try {
      withBufferDirectoryLease(path.dirname(pipeFile), () => {
        fs.rmSync(pipeFile, { force: true });
        const mkfifo = spawnSync('mkfifo', [pipeFile], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        });
        if (mkfifo.status !== 0) {
          const message = (mkfifo.stderr || mkfifo.stdout || '').trim() || 'mkfifo failed';
          throw new CliError('TMUX_STREAM_ERROR', message);
        }
        try { fs.chmodSync(pipeFile, 0o600); } catch {}
        session.streamFd = fs.openSync(pipeFile, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      });
    } catch (err) {
      const message = err?.message || String(err);
      stopTmuxStream(session);
      startTmuxReplacePoller(session, message);
      return 'poll';
    }

    // Enable raw output piping after the read end is open. This avoids the
    // old "enable pipe, then seek to EOF" window that could skip early output.
    try {
      runTmux(['pipe-pane', '-t', session.pane, `cat > ${shellQuoteArg(pipeFile)}`]);
    } catch (err) {
      stopTmuxStream(session);
      startTmuxReplacePoller(session, err?.message || String(err));
      return 'poll';
    }
    session.streamPoller = setInterval(() => {
      try {
        if (session.streamFd === null || session.streamFd === undefined) return;
        const chunks = [];
        for (;;) {
          const buf = Buffer.alloc(65536);
          let bytes = 0;
          try {
            bytes = fs.readSync(session.streamFd, buf, 0, buf.length, null);
          } catch (err) {
            if (['EAGAIN', 'EWOULDBLOCK'].includes(err?.code)) break;
            throw err;
          }
          if (bytes <= 0) break;
          chunks.push(buf.subarray(0, bytes));
          if (bytes < buf.length) break;
        }
        if (!chunks.length) return;
        const data = Buffer.concat(chunks).toString();
        session.buffer += data;
        if (session.buffer.length > 250000) session.buffer = session.buffer.slice(-200000);
        session.lastBroadcastTime = Date.now();
        broadcast(session, { type: 'data', data });
        refreshPeerIoHeartbeat(session);
      } catch {
        if (session.streamFd !== null && session.streamFd !== undefined) {
          try { fs.closeSync(session.streamFd); } catch {}
          session.streamFd = null;
        }
      }
    }, 40);

    // Fallback replace poller: if the FIFO produces no data for N seconds
    // (e.g. pipe-pane output is fully buffered), send a fresh capture-pane
    // snapshot so the browser stays current. This also recovers from any
    // silent FIFO-read failures on restored panes.
    startTmuxReplacePoller(session);
    return 'stream';
  }

  function stopTmuxStream(session) {
    if (session.streamPoller) { clearInterval(session.streamPoller); session.streamPoller = null; }
    if (session.replacePoller) { clearInterval(session.replacePoller); session.replacePoller = null; }
    if (session.replaceTimer) { clearTimeout(session.replaceTimer); session.replaceTimer = null; }
    if (session.inputRefreshTimer) { clearTimeout(session.inputRefreshTimer); session.inputRefreshTimer = null; }
    // Turn piping back off for this pane (no command toggles it off).
    try { runTmux(['pipe-pane', '-t', session.pane]); } catch {}
    if (session.streamFd !== null && session.streamFd !== undefined) {
      try { fs.closeSync(session.streamFd); } catch {}
      session.streamFd = null;
    }
    if (session.pipeFile) {
      try {
        withBufferDirectoryLease(path.dirname(session.pipeFile), () => {
          fs.unlinkSync(session.pipeFile);
        });
      } catch {}
      session.pipeFile = null;
    }
  }

  function tmuxSessionNameForPane(pane) {
    if (!pane) return null;
    try {
      return runTmux(['display-message', '-p', '-t', pane, '#{session_name}']).trim() || null;
    } catch {
      return null;
    }
  }

  function detachRuntimeSessionForPane(projectCtx, pane, status = 'detached') {
    if (!pane) return;
    for (const session of [...sessionsForProject(projectCtx)]) {
      if (session.type === 'tmux' && session.pane === pane) {
        detachTmuxSession(session, status);
      }
    }
  }

  function openClientCountForPane(projectCtx, pane) {
    let count = 0;
    for (const session of [...sessionsForProject(projectCtx)]) {
      if (session.type === 'tmux' && session.pane === pane && hasOpenClients(session)) count += 1;
    }
    return count;
  }

  function tmuxClientObservation(sessionName) {
    return strictTmuxClientObservation(sessionName);
  }

  function observeTmuxDestructiveEvidence(projectCtx, runtimeTarget) {
    let paneInfo = null;
    try { paneInfo = tmuxPaneInfo(runtimeTarget); } catch {}
    const pane = paneInfo?.pane || tmuxPaneForTarget(runtimeTarget);
    const sessionName = tmuxSessionNameForPane(runtimeTarget);
    return {
      session: sessionName,
      session_created: tmuxSessionCreationToken(sessionName),
      session_id: tmuxSessionId(sessionName),
      root: canonicalRoot(tmuxSessionEnvironmentValue(sessionName, 'HCC_ROOT')),
      pane,
      process_identity: liveProcessIdentity(paneInfo?.pid),
      clients: tmuxClientObservation(sessionName),
      expected_root: canonicalRoot(projectCtx.root)
    };
  }

  function tmuxAttachmentEvidence(db, peerId, runtimeTarget) {
    return tmuxAttachmentAuthority(db, peerId, runtimeTarget);
  }

  function assertTmuxDestructiveEvidence(stored, observed, details = {}, options = {}) {
    const validation = validateTmuxDestructiveEvidence(stored, observed, options);
    if (validation.ok) return;
    throw new CliError('TMUX_DESTRUCTIVE_EVIDENCE_INVALID',
      `Refusing destructive tmux action: ${validation.reason}`,
      { ...details, reason: validation.reason });
  }

  function attachmentEvidenceForPane(projectCtx, paneInfo) {
    const expectedRoot = canonicalRoot(projectCtx.root);
    let observed = observeTmuxDestructiveEvidence(projectCtx, paneInfo.pane);
    if (observed.session && !observed.root) {
      runTmux(['set-environment', '-t', observed.session, 'HCC_ROOT', expectedRoot]);
      observed = observeTmuxDestructiveEvidence(projectCtx, paneInfo.pane);
    }
    if (!observed.session || !observed.session_created || !observed.session_id || observed.root !== expectedRoot ||
        observed.pane !== paneInfo.pane || !observed.process_identity) {
      throw new CliError('TMUX_ATTACH_EVIDENCE_INCOMPLETE',
        'Cannot attach tmux pane without complete immutable session evidence', {
          pane: paneInfo.pane,
          tmux_session: observed.session,
          hcc_root: observed.root,
          expected_root: expectedRoot
        });
    }
    return {
      session: observed.session,
      session_created: observed.session_created,
      session_id: observed.session_id,
      root: observed.root,
      pane: observed.pane,
      process_identity: observed.process_identity
    };
  }

  function oldTmuxEventEvidence(projectCtx, sessionName, runtimeTarget) {
    let paneInfo = null;
    try { paneInfo = tmuxPaneInfo(runtimeTarget); } catch {}
    const processIdentity = liveProcessIdentity(paneInfo?.pid);
    const hccRoot = canonicalRoot(tmuxSessionEnvironmentValue(sessionName, 'HCC_ROOT'));
    const sessionCreated = tmuxSessionCreationToken(sessionName);
    const sessionId = tmuxSessionId(sessionName);
    return {
      ...(paneInfo?.pane ? { old_pane: paneInfo.pane } : {}),
      ...(processIdentity ? { old_process_identity: processIdentity } : {}),
      ...(hccRoot ? { old_hcc_root: hccRoot } : {}),
      ...(sessionCreated ? { old_tmux_session_created: sessionCreated } : {}),
      ...(sessionId ? { old_tmux_session_id: sessionId } : {})
    };
  }

  function addRebindCleanupFailedEvent(projectCtx, db, actor, payload) {
    if (!db) return;
    const evidence = oldTmuxEventEvidence(
      projectCtx,
      payload.old_tmux_session,
      payload.old_runtime_target
    );
    addEvent(db, 'tmux.session.rebind_cleanup_failed', actor, null, auditPayload({
      actor,
      target: payload.old_peer || payload.target_peer || null,
      admin: true,
      ...evidence,
      ...payload
    }));
  }

  function oldTmuxRebindTarget(projectCtx, oldTarget, newTarget) {
    if (!oldTarget || oldTarget === newTarget) return false;
    const oldSessionName = tmuxSessionNameForPane(oldTarget);
    const oldSessionRoot = tmuxSessionEnvironmentValue(oldSessionName, 'HCC_ROOT');
    if (!isProjectManagedTmuxSession(projectCtx, oldSessionName, oldSessionRoot)) return false;
    const newSessionName = tmuxSessionNameForPane(newTarget);
    if (oldSessionName === newSessionName) return false;
    return { oldSessionName, newSessionName };
  }

  function tmuxSessionClientCountForStop(sessionName) {
    const clients = tmuxClientObservation(sessionName);
    if (clients.state !== 'known') {
      throw new CliError('TMUX_CLIENT_QUERY_FAILED',
        `Refusing destructive tmux action because clients for ${sessionName || 'unknown session'} could not be queried`);
    }
    return clients.count;
  }

  function safeTmuxKillPlan(projectCtx, db, peerId, expectedTarget) {
    if (!peerId) {
      throw new CliError('BAD_REQUEST', 'peer id required for tmux kill');
    }
    const binding = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(peerId);
    if (!binding || binding.transport !== 'tmux' || !binding.runtime_target) {
      throw new CliError('TMUX_KILL_NOT_MANAGED', `No DB-proven tmux runtime binding for ${peerId}`);
    }
    if (expectedTarget && binding.runtime_target !== expectedTarget) {
      throw new CliError('TMUX_KILL_TARGET_CHANGED', `tmux runtime target for ${peerId} changed`, {
        peer: peerId,
        expected_runtime_target: expectedTarget,
        runtime_target: binding.runtime_target
      });
    }

    const stored = tmuxAttachmentEvidence(db, peerId, binding.runtime_target);
    const observed = observeTmuxDestructiveEvidence(projectCtx, binding.runtime_target);
    const actualSession = observed.session;
    const actualPane = observed.pane;
    if (!actualSession || !actualPane) {
      throw new CliError('TMUX_KILL_TARGET_MISSING', `tmux runtime target for ${peerId} is not running`);
    }

    const expectedSession = tmuxManagedSessionName(projectCtx, peerId);
    const sessionRoot = tmuxSessionEnvironmentValue(actualSession, 'HCC_ROOT');
    if (!tmuxManagedSessionNameMatches(projectCtx, actualSession, peerId, sessionRoot)) {
      throw new CliError('TMUX_KILL_NOT_HCC_MANAGED', `Refusing to kill non-managed tmux session ${actualSession}`, {
        peer: peerId,
        expected_session: expectedSession,
        actual_session: actualSession,
        runtime_target: binding.runtime_target
      });
    }

    assertTmuxDestructiveEvidence(stored, observed, {
      peer: peerId,
      runtime_target: binding.runtime_target
    });

    return {
      binding,
      stored,
      session: actualSession,
      pane: actualPane,
      runtime_target: binding.runtime_target,
      hcc_root: observed.root
    };
  }

  function executeTmuxKillPlan(projectCtx, plan) {
    const observed = observeTmuxDestructiveEvidence(projectCtx, plan.runtime_target);
    assertTmuxDestructiveEvidence(plan.stored, observed, {
      peer: plan.binding?.peer || null,
      runtime_target: plan.runtime_target
    });
    conditionalTmuxKill(runTmux, plan.stored);
  }

  function killDbProvenTmuxSession(projectCtx, db, peerId, expectedTarget = null) {
    const plan = safeTmuxKillPlan(projectCtx, db, peerId, expectedTarget);
    executeTmuxKillPlan(projectCtx, plan);
    return plan;
  }

  function safeOldTmuxRebindPlan(projectCtx, db, oldPeer, oldTarget, newTarget, actor, opts = {}) {
    const target = oldTmuxRebindTarget(projectCtx, oldTarget, newTarget);
    if (!target) return null;
    const { oldSessionName, newSessionName } = target;
    const actualPane = tmuxPaneForTarget(oldTarget);
    if (!actualPane) return null;
    if (!oldPeer) {
      throw new CliError('TMUX_REBIND_OLD_PEER_REQUIRED', 'old peer id required for tmux rebind cleanup');
    }
    if (db) {
      const oldBinding = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(oldPeer);
      if (!oldBinding || oldBinding.transport !== 'tmux' || oldBinding.runtime_target !== oldTarget) {
        addRebindCleanupFailedEvent(projectCtx, db, actor, {
          reason: 'old_binding_runtime_target_changed',
          old_peer: oldPeer,
          old_runtime_target: oldTarget,
          new_runtime_target: newTarget,
          current_runtime_target: oldBinding?.runtime_target || null,
          old_tmux_session: oldSessionName,
          new_tmux_session: newSessionName || null
        });
        throw new CliError('TMUX_REBIND_OLD_TARGET_CHANGED', `tmux runtime target for ${oldPeer} changed before rebind cleanup`, {
          old_peer: oldPeer,
          expected_runtime_target: oldTarget,
          runtime_target: oldBinding?.runtime_target || null
        });
      }
    }
    const expectedSession = tmuxManagedSessionName(projectCtx, oldPeer);
    const allowedSession = opts.allowedSessionName || null;
    const oldSessionRoot = tmuxSessionEnvironmentValue(oldSessionName, 'HCC_ROOT');
    if (!tmuxManagedSessionNameMatches(projectCtx, oldSessionName, oldPeer, oldSessionRoot) &&
        oldSessionName !== allowedSession) {
      addRebindCleanupFailedEvent(projectCtx, db, actor, {
        reason: 'not_hcc_managed_peer_session',
        old_peer: oldPeer,
        old_runtime_target: oldTarget,
        new_runtime_target: newTarget,
        expected_tmux_session: expectedSession,
        allowed_tmux_session: allowedSession,
        old_tmux_session: oldSessionName,
        new_tmux_session: newSessionName || null
      });
      throw new CliError('TMUX_REBIND_NOT_HCC_MANAGED', `Refusing to rebind-cleanup non-managed tmux session ${oldSessionName}`, {
        old_peer: oldPeer,
        expected_session: expectedSession,
        allowed_session: allowedSession,
        actual_session: oldSessionName,
        runtime_target: oldTarget
      });
    }
    const attachedStored = tmuxAttachmentEvidence(db, oldPeer, oldTarget);
    const observed = observeTmuxDestructiveEvidence(projectCtx, oldTarget);
    const stored = allowedSession && observed.session === allowedSession &&
      attachedStored.session === expectedSession
      ? { ...attachedStored, session: allowedSession }
      : attachedStored;
    const webClientCount = openClientCountForPane(projectCtx, oldTarget);
    assertTmuxDestructiveEvidence(stored, observed, {
      old_peer: oldPeer,
      old_runtime_target: oldTarget,
      new_runtime_target: newTarget
    }, { allowClients: Boolean(opts.force) });
    const tmuxClientCount = observed.clients.count;
    if ((webClientCount > 0 || tmuxClientCount > 0) && !opts.force) {
      addRebindCleanupFailedEvent(projectCtx, db, actor, {
        reason: 'has_clients',
        old_peer: oldPeer,
        old_runtime_target: oldTarget,
        new_runtime_target: newTarget,
        old_tmux_session: oldSessionName,
        new_tmux_session: newSessionName || null,
        web_client_count: webClientCount,
        tmux_client_count: tmuxClientCount
      });
      throw new CliError('TMUX_REBIND_OLD_SESSION_IN_USE',
        `Old tmux session ${oldSessionName} still has clients; detach clients or run ${CLI_NAME} tmux gc later.`,
        {
          old_runtime_target: oldTarget,
          new_runtime_target: newTarget,
          old_tmux_session: oldSessionName,
          web_client_count: webClientCount,
          tmux_client_count: tmuxClientCount
        });
    }
    const eventEvidence = {
      old_pane: stored.pane,
      old_process_identity: stored.process_identity,
      old_hcc_root: stored.root,
      old_tmux_session_created: stored.session_created,
      old_tmux_session_id: stored.session_id
    };
    if (db) {
      addEvent(db, 'tmux.session.rebind_cleanup_pending', actor, null, auditPayload({
        actor,
        target: oldPeer,
        admin: true,
        old_peer: oldPeer,
        old_runtime_target: oldTarget,
        new_runtime_target: newTarget,
        old_tmux_session: oldSessionName,
        new_tmux_session: newSessionName || null,
        expected_tmux_session: expectedSession,
        allowed_tmux_session: allowedSession,
        hcc_root: stored.root,
        ...eventEvidence
      }));
    }
    return {
      oldPeer,
      oldTarget,
      newTarget,
      oldSessionName,
      newSessionName,
      oldPane: actualPane,
      expectedSession,
      allowedSession,
      hccRoot: stored.root,
      stored,
      webClientCount,
      tmuxClientCount,
      eventEvidence,
      force: Boolean(opts.force)
    };
  }

  function assertOldTmuxCanRebind(projectCtx, oldPeer, oldTarget, newTarget, actor, db = null, opts = {}) {
    return safeOldTmuxRebindPlan(projectCtx, db, oldPeer, oldTarget, newTarget, actor, opts);
  }

  function killOldTmuxForRebind(projectCtx, plan, actor, db = null) {
    if (!plan) return false;
    const {
      oldPeer,
      oldTarget,
      newTarget,
      oldSessionName,
      newSessionName,
      webClientCount,
      tmuxClientCount
    } = plan;
    const force = Boolean(plan.force);
    let latestWebClientCount = webClientCount;
    let latestTmuxClientCount = tmuxClientCount;

    try {
      latestWebClientCount = openClientCountForPane(projectCtx, oldTarget);
      let observed = observeTmuxDestructiveEvidence(projectCtx, oldTarget);
      assertTmuxDestructiveEvidence(plan.stored, observed, {
        old_peer: oldPeer,
        old_runtime_target: oldTarget,
        new_runtime_target: newTarget
      }, { allowClients: force });
      latestTmuxClientCount = observed.clients.count;
      if ((latestWebClientCount > 0 || latestTmuxClientCount > 0) && !force) {
        throw new CliError('TMUX_REBIND_OLD_SESSION_IN_USE',
          `Old tmux session ${oldSessionName} still has clients; detach clients or run ${CLI_NAME} tmux gc later.`,
          {
            old_runtime_target: oldTarget,
            new_runtime_target: newTarget,
            old_tmux_session: oldSessionName,
            web_client_count: latestWebClientCount,
            tmux_client_count: latestTmuxClientCount
          });
      }
      detachRuntimeSessionForPane(projectCtx, oldTarget, 'detached');
      observed = observeTmuxDestructiveEvidence(projectCtx, oldTarget);
      assertTmuxDestructiveEvidence(plan.stored, observed, {
        old_peer: oldPeer,
        old_runtime_target: oldTarget,
        new_runtime_target: newTarget
      }, { allowClients: force });
      conditionalTmuxKill(runTmux, plan.stored, { allowClients: force });
    } catch (err) {
      addRebindCleanupFailedEvent(projectCtx, db, actor, {
        reason: err?.code || 'cleanup_failed',
        error: err?.message || String(err),
        old_peer: oldPeer,
        old_runtime_target: oldTarget,
        new_runtime_target: newTarget,
        old_tmux_session: oldSessionName,
        new_tmux_session: newSessionName || null,
        web_client_count: latestWebClientCount,
        tmux_client_count: latestTmuxClientCount,
        ...(plan.eventEvidence || {})
      });
      throw err;
    }
    if (db) {
      addEvent(db, 'tmux.session.rebound', actor, null, auditPayload({
        actor,
        target: oldPeer,
        admin: true,
        old_peer: oldPeer,
        old_runtime_target: oldTarget,
        new_runtime_target: newTarget,
        old_tmux_session: oldSessionName,
        new_tmux_session: newSessionName || null
      }));
    }
    return true;
  }

  function providerSessionBindingMatches(a, b) {
    if (!a || !b || a.provider !== b.provider) return false;
    if (b.provider_session_id) return a.provider_session_id === b.provider_session_id;
    if (b.provider_session_name) return a.provider_session_name === b.provider_session_name;
    return false;
  }

  function attachTmuxSession(input) {
    const pctx = input.projectCtx || ctx;
    const id = input.id;
    if (!id) throw new CliError('BAD_REQUEST', 'id required');
    const actorPeer = requestActorPeer(input, id);
    const auditSource = requestSource(input, input.autoAttach ? 'runtime' : 'web');
    const info = tmuxPaneInfo(input.pane || null);
    if (info.dead) throw new CliError('TMUX_PANE_DEAD', `tmux pane is not running: ${info.pane}`);

    for (const existing of [...sessions.values()]) {
      if (existing.type === 'tmux' && existing.pane === info.pane && existing.id !== id) {
        if (!input.force) {
          throw new CliError('TMUX_PANE_IN_USE', `tmux pane ${info.pane} is already attached to ${existing.id}`, {
            pane: info.pane,
            peer: existing.id
          });
        }
        detachTmuxSession(existing, 'detached');
      }
    }

    const key = sessionKey(pctx, id);
    const existing = sessions.get(key);
    if (existing && existing.status === 'running') {
      if (existing.type === 'tmux' && existing.pane === info.pane) return existing;
      if (existing !== input.replaceSession) {
        throw new CliError('SESSION_EXISTS', `Session ${id} is already running`);
      }
    }

    const kind = inferPeerKind(id, input.kind || null, info.command);
    const role = input.role || 'peer';
    const cwd = path.resolve(input.cwd || info.cwd || pctx.root);
    const command = input.command || `tmux ${info.pane} (${info.command})`;
    const branch = detectBranch(cwd);
    const attachedEvidence = attachmentEvidenceForPane(pctx, info);
    const binding = input.binding || {};
    const nextBinding = {
      peer: id,
      provider: binding.provider || kind,
      provider_session_id: binding.provider_session_id || null,
      provider_session_name: binding.provider_session_name || null,
      resume_mode: binding.resume_mode || 'attached',
      resume_arg: binding.resume_arg || info.pane,
      command: binding.command || command,
      transport: 'tmux',
      runtime_session_id: id,
      runtime_target: info.pane
    };

    const captured = tmuxCapturePane(info.pane);
    const session = {
      id,
      peerId: id,
      actorPeer,
      auditSource,
      actionTokens: new Set(),
      root: pctx.root,
      ctx: pctx,
      kind,
      role,
      command,
      cwd,
      pid: info.pid,
      type: 'tmux',
      pane: info.pane,
      status: 'running',
      createdAt: now(),
      exitedAt: null,
      buffer: captured,
      clients: new Set(),
      streamPoller: null,
      streamFd: null,
      pipeFile: null,
      replacePoller: null,
      lastBroadcastTime: 0,
      exitPoller: null
    };
    sessions.set(key, session);
    try {
      startTmuxStream(session);
      if (!session.streamPoller && !session.replacePoller) {
        throw new CliError('TMUX_STREAM_ERROR', `Could not establish output tracking for ${info.pane}`);
      }
    } catch (err) {
      stopTmuxStream(session);
      if (sessions.get(key) === session) sessions.delete(key);
      throw err;
    }
    let rebindOldTarget = null;
    let rebindOldPeer = null;
    let rebindOldPlan = null;
    let rebindOldBindingSubject = null;

    // Detect pane death (retry 3 times before detaching — handles Ctrl+C transient states)
    let deadCount = 0;
    session.exitPoller = setInterval(() => {
      try {
        const fresh = tmuxPaneInfo(session.pane);
        if (fresh.dead) {
          deadCount++;
          if (deadCount >= 3) detachTmuxSession(session, 'exited');
        } else {
          deadCount = 0;
        }
      } catch (err) {
        // sess-03: only a definitive "pane/session is gone" error counts toward
        // detach; a transient tmux failure (busy server, momentary hiccup) must
        // not detach a live session after 3 attempts.
        const message = err?.code === 'TMUX_ERROR' ? String(err.message || '') : '';
        const definitivelyGone = /can't find pane|can't find session|no server running/i.test(message);
        if (definitivelyGone) {
          deadCount++;
          if (deadCount >= 3) detachTmuxSession(session, 'exited');
        }
      }
    }, 3000);

    let db = null;
    try {
      db = connectWebProject(pctx);
      if (input.rebindOldTmux && !input.skipProviderRebindCleanup &&
          (nextBinding.provider_session_id || nextBinding.provider_session_name)) {
        const existingPeerBinding = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(id);
        const conflictBinding = findProviderSessionBinding(db, nextBinding);
        const oldBinding = [existingPeerBinding, conflictBinding]
          .filter((row) => providerSessionBindingMatches(row, nextBinding))
          .find((row) => row?.transport === 'tmux' && row.runtime_target && row.runtime_target !== info.pane);
        if (oldBinding) {
          rebindOldTarget = oldBinding.runtime_target;
          rebindOldPeer = oldBinding.peer;
          rebindOldBindingSubject = { ...oldBinding };
          rebindOldPlan = assertOldTmuxCanRebind(pctx, rebindOldPeer, rebindOldTarget, info.pane, id, db, {
            force: Boolean(input.providerForce)
          });
        }
      }
      tx(db, () => {
        if (rebindOldBindingSubject) {
          const currentOldBinding = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(rebindOldPeer);
          if (JSON.stringify(currentOldBinding || null) !== JSON.stringify(rebindOldBindingSubject)) {
            throw new CliError('SUBJECT_CHANGED', 'tmux rebind binding changed during evidence validation', {
              retryable: true,
              old_peer: rebindOldPeer
            });
          }
        }
        upsertPeer(db, {
          id,
          kind,
          role,
          worktree: cwd,
          branch,
          pid: info.pid,
          processIdentity: attachedEvidence.process_identity,
          status: 'running',
          capabilities: 'tmux'
        });
        const providerForce = Boolean(input.providerForce);
        const canonical = upsertCanonicalPeerBinding(db, nextBinding, providerForce, {
          override: Boolean(input.rebindOldTmux && providerForce)
        });
        session.peerId = canonical.peer;
        session.binding = { ...canonical.binding };
        addEvent(db, 'tmux.session.attached', actorPeer, null, auditPayload({
          actor: actorPeer,
          target: session.peerId || id,
          source: auditSource,
          admin: actorPeer !== (session.peerId || id),
          pane: info.pane,
          command,
          cwd,
          pid: info.pid,
          tmux_session: attachedEvidence.session,
          tmux_session_created: attachedEvidence.session_created,
          tmux_session_id: attachedEvidence.session_id,
          hcc_root: attachedEvidence.root,
          process_identity: attachedEvidence.process_identity
        }));
      });
    } catch (err) {
      stopTmuxStream(session);
      if (session.exitPoller) { clearInterval(session.exitPoller); session.exitPoller = null; }
      if (sessions.get(key) === session) sessions.delete(key);
      throw err;
    } finally {
      try { db?.close(); } catch {}
    }
    if (rebindOldTarget) {
      try {
        const eventDb = connectWebProject(pctx);
        try {
          killOldTmuxForRebind(pctx, rebindOldPlan, session.peerId || id, eventDb);
          if (rebindOldPeer && rebindOldPeer !== id) {
            const actor = actorPeer || session.peerId || id;
            addEvent(eventDb, 'provider.session.rebound', actor, null, auditPayload({
              actor,
              target: rebindOldPeer,
              source: auditSource,
              admin: true,
              from_peer: rebindOldPeer,
              to_peer: id,
              old_runtime_target: rebindOldTarget,
              new_runtime_target: info.pane
            }));
          }
        } finally {
          eventDb.close();
        }
      } catch (err) {
        session.warning = {
          code: err?.code || 'TMUX_REBIND_CLEANUP_FAILED',
          message: err?.message || String(err),
          old_peer: rebindOldPeer,
          old_runtime_target: rebindOldTarget
        };
      }
    }
    return session;
  }

  // hb-04: real terminal I/O is a liveness signal. Throttle-refresh the peer's
  // last_seen_at (~30s) so an actively-used but hook-quiet terminal is not
  // judged stale/takeover-able. Never throws — I/O hot paths stay safe.
  function refreshPeerIoHeartbeat(session) {
    try {
      const t = now();
      if (session.lastIoRefreshAt && t - session.lastIoRefreshAt < 30) return;
      session.lastIoRefreshAt = t;
      const peerId = session.peerId || session.id;
      if (!peerId) return;
      const ioDb = connectWebProject(session.ctx || ctx);
      try {
        ioDb.prepare('UPDATE peers SET last_seen_at = ? WHERE id = ?').run(t, peerId);
      } finally {
        ioDb.close();
      }
    } catch {}
  }

  function writeSessionInput(session, data) {
    if (session.type === 'external') {
      try { fs.appendFileSync(session.inFile, data); } catch {}
    } else if (session.type === 'tmux') {
      tmuxSendLiteral(session.pane, data);
      scheduleTmuxInputRefresh(session);
    } else {
      session.pty.write(data);
    }
    refreshPeerIoHeartbeat(session);
  }

  function scheduleTmuxInputRefresh(session) {
    if (session.type !== 'tmux' || !session.pane) return;
    if (session.inputRefreshTimer) return;
    session.inputRefreshTimer = setTimeout(() => {
      session.inputRefreshTimer = null;
      if (session.status === 'running') broadcast(session, { type: 'replace', data: refreshTmuxSnapshot(session) });
    }, 80);
  }

  function resizeSession(session, cols, rows) {
    if (session.type === 'external') {
      try { fs.appendFileSync(session.resizeFile, JSON.stringify({ cols, rows }) + '\n'); } catch {}
    } else if (session.type === 'tmux') {
      // Resize the tmux window to match the browser terminal so the captured
      // mirror has identical geometry — a prerequisite for accurate cursor
      // placement. Older tmux without resize-window simply keeps native size.
      session.cols = cols;
      session.rows = rows;
      try {
        if (!session.windowSizeManual) {
          runTmux(['set-window-option', '-t', session.pane, 'window-size', 'manual']);
          session.windowSizeManual = true;
        }
        runTmux(['resize-window', '-t', session.pane, '-x', String(cols), '-y', String(rows)]);
      } catch {
        // tmux too old or pane gone; keep mirroring at the native pane size.
      }
    } else if (session.pty) {
      session.pty.resize(cols, rows);
    }
  }

  function startTmuxManagedSession(input) {
    ensureTmuxAvailable({ autoInstall: false });
    const pctx = input.projectCtx || ctx;
    const kind = input.kind || 'shell';
    const id = input.id || nextProjectSessionId(pctx, kind);
    const actorPeer = requestActorPeer(input, id);
    const auditSource = requestSource(input, 'web');
    const role = input.role || 'peer';
    const command = input.command || defaultSessionCommand(kind);
    const cwd = path.resolve(input.cwd || pctx.root);
    const sessionName = tmuxManagedSessionName(pctx, id);
    let paneTarget = `${sessionName}:0.0`;
    const callerEnv = input.env && typeof input.env === 'object' ? input.env : process.env;
    const env = childSessionEnv({
      HCC_PEER: id,
      HCC_ROOT: pctx.root,
      HCC_DB: pctx.dbPath,
      TERM: 'xterm-256color'
    }, callerEnv);
    env[LAUNCH_FINGERPRINT_ENV] = launchFingerprint({ command, cwd, env });
    let hasSession = tmuxHasSession(sessionName);
    const relaunchableProvider = isRelaunchableProviderSession(kind, command, input.binding || {});
    const oldTmuxTargetsForRebind = [];
    const parkedOldTmuxSessions = [];
    let createdTmuxSession = false;
    let pendingOldSession = null;
    let pendingRestartAudit = null;

    function restoreParkedOldTmuxSessions() {
      const failures = [];
      const quarantined = [];
      for (const parked of [...parkedOldTmuxSessions].reverse()) {
        if (!tmuxHasSession(parked.parkedName)) {
          failures.push(`parked session missing: ${parked.parkedName}`);
          continue;
        }
        let quarantineName = null;
        if (tmuxHasSession(parked.originalName)) {
          quarantineName = `hcc-rollback-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
          try {
            runTmux(['rename-session', '-t', parked.originalName, quarantineName]);
          } catch (err) {
            failures.push(`could not quarantine failed replacement ${parked.originalName}: ${err?.message || err}`);
            continue;
          }
        }
        try {
          runTmux(['rename-session', '-t', parked.parkedName, parked.originalName]);
        } catch (err) {
          failures.push(`could not restore ${parked.parkedName} to ${parked.originalName}: ${err?.message || err}`);
          if (quarantineName && !tmuxHasSession(parked.originalName)) {
            try { runTmux(['rename-session', '-t', quarantineName, parked.originalName]); } catch {}
          }
          continue;
        }
        if (quarantineName) {
          try { tmuxKillSession(quarantineName); } catch { quarantined.push(quarantineName); }
        }
      }
      return { failures, quarantined };
    }

    function restartExistingTmuxSession(reason) {
      const existing = getSession(pctx, id);
      const hasWebClients = hasOpenClients(existing);
      const hasTmuxClients = tmuxSessionHasClients(sessionName);
      if (hasWebClients || hasTmuxClients) {
        const isEnvChange = reason === 'launch_environment_changed';
        throw new CliError(
          isEnvChange ? 'SESSION_ENV_CHANGED' : 'SESSION_IN_USE',
          isEnvChange
            ? `Session ${id} is already running with a different launch environment. Detach/close existing clients or run ${CLI_NAME} peer stop ${id}, then start it again.`
            : `Session ${id} is still attached. Detach/close existing clients or run ${CLI_NAME} peer stop ${id}, then start it again.`,
          {
            peer: id,
            tmux_session: sessionName,
            reason
          });
      }
      let oldTarget = null;
      try {
        oldTarget = tmuxPaneInfo(paneTarget).pane;
      } catch {}
      if (!oldTarget) {
        throw new CliError('TMUX_DESTRUCTIVE_EVIDENCE_INVALID',
          'Refusing destructive tmux restart: pane target could not be resolved', {
            peer: id,
            tmux_session: sessionName,
            reason
          });
      }
      const authorityDb = connectWebProject(pctx);
      let storedAuthority;
      let bindingPreparation;
      try {
        storedAuthority = tmuxAttachmentEvidence(authorityDb, id, oldTarget);
        assertTmuxDestructiveEvidence(
          storedAuthority,
          observeTmuxDestructiveEvidence(pctx, oldTarget),
          { peer: id, tmux_session: sessionName, reason }
        );
        // The liveness reaper may have safely detached a dead provider while
        // leaving its fallback tmux shell alive. Restore only that null binding
        // after immutable tmux authority is verified so the rebind CAS can
        // distinguish recovery from a foreign target change.
        bindingPreparation = prepareTmuxRestartBinding(authorityDb, {
          peer: id,
          runtimeTarget: oldTarget,
          nowSec: now()
        });
        if (!bindingPreparation.ok) {
          throw new CliError('TMUX_REBIND_OLD_TARGET_CHANGED',
            `tmux runtime target for ${id} changed before provider restart`, {
              peer: id,
              expected_runtime_target: oldTarget,
              reason: bindingPreparation.reason
            });
        }
      } finally {
        authorityDb.close();
      }
      const parkedName = `${sessionName}-old-${Date.now().toString(36)}`.slice(0, 80);
      try {
        conditionalTmuxRename(runTmux, storedAuthority, parkedName);
      } catch (err) {
        let bindingRolledBack = true;
        if (bindingPreparation?.restored) {
          const rollbackDb = connectWebProject(pctx);
          try {
            bindingRolledBack = rollbackTmuxRestartBinding(rollbackDb, bindingPreparation);
          } finally {
            rollbackDb.close();
          }
        }
        if (err instanceof CliError && err.code === 'TMUX_CONDITIONAL_RENAME_MISMATCH' && bindingRolledBack) throw err;
        throw new CliError('TMUX_REBIND_PREPARE_FAILED', `Could not park old tmux session ${sessionName} before rebind: ${err.message}`, {
          peer: id,
          tmux_session: sessionName,
          reason,
          binding_rollback_failed: !bindingRolledBack
        });
      }
      parkedOldTmuxSessions.push({ oldTarget, originalName: sessionName, parkedName });
      if (oldTarget) oldTmuxTargetsForRebind.push({ oldPeer: id, oldTarget, allowedSessionName: parkedName });
      if (existing) {
        oldTarget = oldTarget || existing.pane || null;
        // sess-06: do NOT tear down the in-memory session yet — keep it fully
        // alive until the replacement tmux session exists, so a failed restart
        // leaves the old session (stream/pollers/clients) intact.
        pendingOldSession = existing;
      }
      hasSession = false;
      pendingRestartAudit = { reason, oldTarget, parkedName };
    }

    if (hasSession && input.restartOnEnvChange) {
      const existingFingerprint = tmuxLaunchFingerprint(sessionName);
      if (existingFingerprint !== env[LAUNCH_FINGERPRINT_ENV]) {
        restartExistingTmuxSession('launch_environment_changed');
      }
    }

    if (hasSession && relaunchableProvider) {
      // G4a: HCC_PROVIDER_STATE is a tmux-env hint that can be forged from
      // inside the session. Before a destructive park-and-replace, require
      // process evidence that the provider is really gone: the pane process
      // must be dead, or have no live non-shell child (the provider wrapper
      // leaves the pane as a bare shell after the provider exits). A session
      // with a live provider child is never torn down.
      const providerState = tmuxProviderState(sessionName);
      const info = tmuxPaneInfo(paneTarget);
      const ownerDb = connectWebProject(pctx);
      let ownerEvidence;
      try {
        ownerEvidence = providerOwnerEvidenceFromDb(ownerDb, id);
      } finally {
        ownerDb.close();
      }
      const reason = providerRestartReason({
        providerState,
        ownerEvidence,
        paneCommand: info.command
      });
      if (reason) restartExistingTmuxSession(reason);
    }

    let session;
    let pane = null;
    try {
      if (!hasSession) {
        const shell = callerEnv.SHELL || process.env.SHELL || 'bash';
        const launch = shellCommand([...isolatedEnvCommandArgs(env), shell, '-c', command]);
        const tmuxEnv = {
          HCC_ROOT: pctx.root,
          HCC_DB: pctx.dbPath,
          [LAUNCH_FINGERPRINT_ENV]: env[LAUNCH_FINGERPRINT_ENV]
        };
        if (relaunchableProvider) tmuxEnv[PROVIDER_STATE_ENV] = 'starting';
        runTmux(['new-session', '-d', '-s', sessionName, '-c', cwd, ...tmuxEnvironmentArgs(tmuxEnv), launch]);
        createdTmuxSession = true;
      }

      pane = tmuxPaneInfo(paneTarget).pane;
      for (const oldInfo of oldTmuxTargetsForRebind) {
        const eventDb = connectWebProject(pctx);
        try {
          oldInfo.plan = assertOldTmuxCanRebind(pctx, oldInfo.oldPeer, oldInfo.oldTarget, pane, id, eventDb, {
            force: Boolean(input.providerForce),
            allowedSessionName: oldInfo.allowedSessionName || null
          });
        } finally {
          eventDb.close();
        }
      }
      session = attachTmuxSession({
        ...input,
        id,
        kind,
        role,
        cwd,
        command,
        pane,
        projectCtx: pctx,
        binding: {
          ...(input.binding || {}),
          command: input.binding?.command || command,
          transport: 'tmux',
          runtime_session_id: id,
          runtime_target: pane
        },
        providerForce: Boolean(input.providerForce),
        rebindOldTmux: true,
        skipProviderRebindCleanup: oldTmuxTargetsForRebind.length > 0,
        replaceSession: pendingOldSession,
        force: true
      });
    } catch (err) {
      if (createdTmuxSession) {
        try { tmuxKillSession(sessionName); } catch {}
      }
      const rollback = restoreParkedOldTmuxSessions();
      // attachTmuxSession removes a failed candidate from the map. Restore the
      // parked session, whose stream/pollers/clients were deliberately kept
      // alive until the replacement completed its DB transaction.
      if (pendingOldSession && rollback.failures.length === 0) {
        sessions.set(sessionKey(pctx, pendingOldSession.id), pendingOldSession);
      }
      if (pendingRestartAudit) {
        try {
          const eventDb = connectWebProject(pctx);
          try {
            addEvent(eventDb, 'tmux.session.restart_failed', actorPeer, null, auditPayload({
              actor: actorPeer,
              target: id,
              source: auditSource,
              admin: true,
              reason: pendingRestartAudit.reason,
              old_runtime_target: pendingRestartAudit.oldTarget,
              old_tmux_session: pendingRestartAudit.parkedName,
              error: err?.message || String(err),
              rollback_failures: rollback.failures,
              quarantined_sessions: rollback.quarantined
            }));
          } finally {
            eventDb.close();
          }
        } catch {}
      }
      pendingOldSession = null;
      if (rollback.failures.length) {
        throw new CliError('TMUX_RESTART_ROLLBACK_FAILED', `Session ${id} restart failed and the previous tmux session could not be restored`, {
          peer: id,
          original_error: err?.message || String(err),
          rollback_failures: rollback.failures,
          quarantined_sessions: rollback.quarantined
        });
      }
      throw err;
    }
    if (pendingRestartAudit) {
      try {
        const eventDb = connectWebProject(pctx);
        try {
          addEvent(eventDb, 'tmux.session.restarted', actorPeer, null, auditPayload({
            actor: actorPeer,
            target: id,
            source: auditSource,
            admin: true,
            reason: pendingRestartAudit.reason,
            old_runtime_target: pendingRestartAudit.oldTarget,
            old_tmux_session: pendingRestartAudit.parkedName,
            new_runtime_target: pane
          }));
        } finally {
          eventDb.close();
        }
      } catch {}
    }
    if (pendingOldSession) {
      stopTmuxStream(pendingOldSession);
      if (pendingOldSession.exitPoller) { clearInterval(pendingOldSession.exitPoller); pendingOldSession.exitPoller = null; }
      pendingOldSession.status = 'detached';
      pendingOldSession.exitedAt = now();
      pendingOldSession = null;
    }
    for (const oldInfo of oldTmuxTargetsForRebind) {
      try {
        const eventDb = connectWebProject(pctx);
        try {
          killOldTmuxForRebind(pctx, oldInfo.plan, actorPeer, eventDb);
        } finally {
          eventDb.close();
        }
      } catch (err) {
        session.warning = {
          code: err?.code || 'TMUX_REBIND_CLEANUP_FAILED',
          message: err?.message || String(err),
          old_peer: oldInfo.oldPeer,
          old_runtime_target: oldInfo.oldTarget
        };
      }
    }
    return session;
  }

  function restoreTmuxManagedSessions(projectCtx = ctx) {
    const db = connectWebProject(projectCtx);
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT p.id, p.kind, p.role, p.status, p.worktree, p.pid,
               p.pid_start_token, p.pid_command_hash, b.command, b.runtime_target,
               b.provider, b.provider_session_id, b.provider_session_name,
               b.resume_mode, b.resume_arg
        FROM peers p
        JOIN peer_bindings b ON b.peer = p.id
        WHERE b.transport = 'tmux' AND b.runtime_target IS NOT NULL
        ORDER BY p.last_seen_at DESC
        LIMIT 100
      `).all();
    } finally {
      db.close();
    }
    for (const row of rows) {
      // Do not re-adopt a pane by its stored id without confirming it still
      // belongs to THIS peer's managed tmux session. tmux pane ids (%N) are
      // recycled across a tmux server restart, so a stale runtime_target can
      // point at an unrelated local pane (e.g. the user's editor) and stream its
      // content + inject keystrokes (sess-01). Apply the same ownership checks
      // the GC/kill paths already use.
      const evidence = observePeerEvidence(projectCtx, row, row);
      if (evidence.state !== 'live') {
        // Unknown evidence (including parser/permission/root mismatch) is kept
        // intact. Only jointly confirmed dead tmux/process evidence is stale.
        if (evidence.state !== 'dead') continue;
        try {
          const db2 = connectWebProject(projectCtx);
          try {
            db2.prepare('UPDATE peer_bindings SET runtime_target = NULL, updated_at = ? WHERE peer = ?').run(now(), row.id);
          } finally { db2.close(); }
        } catch {}
        continue;
      }
      try {
        attachTmuxSession({
          id: row.id,
          kind: row.kind,
          role: row.role || 'peer',
          cwd: row.worktree || projectCtx.root,
          command: row.command || null,
          pane: row.runtime_target,
          projectCtx,
          force: true,
          auditActorPeer: 'web-runtime',
          auditSource: 'runtime',
          binding: {
            provider: row.provider,
            provider_session_id: row.provider_session_id,
            provider_session_name: row.provider_session_name,
            resume_mode: row.resume_mode,
            resume_arg: row.resume_arg,
            command: row.command,
            transport: 'tmux',
            runtime_session_id: row.id,
            runtime_target: row.runtime_target
          }
        });
      } catch {}
    }
    // The fast path above only re-adopts bindings whose runtime_target is still
    // set. Also sweep by session name so sessions left alive with a cleared
    // runtime_target (default Stop = detach-without-kill) are recovered.
    reAdoptOrphanManagedTmuxSessions(projectCtx);
  }

  // tmux is the source of truth for managed sessions. Re-adopt any live
  // `hcc-<hash(root)>-*` session this runtime is not already tracking, so a
  // session left alive by a detach-without-kill or across a runtime restart
  // stays visible + re-enterable. Returns the set of peerIds that currently own
  // a live managed tmux session (used by the dead-peer reaper).
  function reAdoptOrphanManagedTmuxSessions(projectCtx = ctx) {
    const live = new Set();
    let names;
    try {
      names = tmuxListSessionNames().filter((name) => isProjectManagedTmuxSession(
        projectCtx,
        name,
        tmuxSessionEnvironmentValue(name, 'HCC_ROOT')
      ));
    } catch {
      return live;
    }
    if (!names.length) return live;

    // Capture known peers and their stored process evidence so a detached
    // session is only re-adopted after root, exact name, and identity agree.
    const bindingByPeer = new Map();
    try {
      const db = connectWebProject(projectCtx);
      try {
        for (const row of db.prepare(`
          SELECT p.id, p.status, p.pid, p.pid_start_token, p.pid_command_hash,
                 b.provider, b.provider_session_id, b.provider_session_name,
                 b.resume_mode, b.resume_arg, b.command, b.runtime_target
          FROM peers p
          LEFT JOIN peer_bindings b ON b.peer = p.id
        `).all()) {
          bindingByPeer.set(row.id, row);
        }
      } finally {
        db.close();
      }
    } catch {
      return live;
    }

    const tracked = new Set(
      sessionsForProject(projectCtx)
        .filter((session) => session.status === 'running' && session.type === 'tmux')
        .map((session) => session.id)
    );

    for (const name of names) {
      // Ownership: the session's HCC_ROOT env must match this project root.
      const hccRoot = tmuxSessionEnvironmentValue(name, 'HCC_ROOT');
      if (rootEvidence(projectCtx.root, hccRoot).state !== 'match') continue;

      let info;
      try { info = tmuxPaneInfo(`${name}:0.0`); } catch { continue; }
      if (!info || info.dead) continue;

      const candidates = [...bindingByPeer.entries()].filter(([peerId, binding]) => {
        if (!tmuxManagedSessionNameMatches(projectCtx, name, peerId, hccRoot)) return false;
        return observePeerEvidence(projectCtx, binding, {
          transport: 'tmux',
          runtime_target: info.pane
        }).state === 'live';
      });
      if (candidates.length !== 1) continue;
      const [[peerId, b]] = candidates;
      live.add(peerId);
      if (tracked.has(peerId)) continue;
      const binding = b ? {
        provider: b.provider,
        provider_session_id: b.provider_session_id,
        provider_session_name: b.provider_session_name,
        resume_mode: b.resume_mode,
        resume_arg: b.resume_arg,
        command: b.command,
        transport: 'tmux',
        runtime_session_id: peerId,
        runtime_target: info.pane
      } : null;

      try {
        attachTmuxSession({
          id: peerId,
          pane: info.pane,
          cwd: info.cwd || projectCtx.root,
          command: b?.command || null,
          projectCtx,
          force: false,
          autoAttach: true,
          auditActorPeer: 'web-runtime',
          auditSource: 'runtime',
          binding
        });
      } catch {}
    }
    return live;
  }

  // Mark dead or grace-expired unknown peers as exited so crashed/killed
  // sessions stop lingering as running. This path only detaches DB state.
  function reapDeadPeersForProject(projectCtx, liveManagedPeerIds, db) {
    let rows;
    try {
      rows = db.prepare(`
        SELECT p.id, p.status, p.pid, p.pid_start_token, p.pid_command_hash,
               p.last_seen_at,
               b.transport, b.runtime_target
        FROM peers p
        LEFT JOIN peer_bindings b ON b.peer = p.id
        WHERE p.status IN ('running', 'working', 'busy')
      `).all();
    } catch {
      return;
    }
    if (!rows.length) return;
    const observedAt = now();
    const evidenceByPeer = new Map(rows.map((row) => [
      row.id,
      observePeerEvidence(projectCtx, row, row)
    ]));
    let clockObservation;
    try {
      clockObservation = observeClockSafetyOrThrow(db, {
        operation: 'ownership',
        candidates: rows.map((row) => ({
          boundary: Math.max(0, Number(row.last_seen_at || 0) + UNKNOWN_EVIDENCE_GRACE_SEC),
          evidence: evidenceByPeer.get(row.id)?.state || 'unknown',
          owner: row.id
        })),
        nowSec: observedAt
      });
    } catch {
      return;
    }
    for (const row of rows) {
      if (liveManagedPeerIds.has(row.id)) continue;
      const evidence = evidenceByPeer.get(row.id) || { state: 'unknown' };
      if (!peerEvidenceAllowsReap(evidence, {
        nowSec: observedAt,
        lastSeenAt: Number(row.last_seen_at || 0),
        staleAfterSec: UNKNOWN_EVIDENCE_GRACE_SEC,
        graceUntil: clockObservation.graceUntil
      })) continue;
      try {
        mutatePeerWithEvidence(db, projectCtx, row.id, (subject, currentEvidence) => {
          // Preserve last_seen_at (see detachTmuxSession) — only flip status.
          db.prepare('UPDATE peers SET status = ? WHERE id = ?').run('exited', row.id);
          db.prepare('UPDATE peer_bindings SET runtime_target = NULL, updated_at = ? WHERE peer = ?').run(now(), row.id);
          addEvent(db, 'peer.reaped', 'web-runtime', null, auditPayload({
            actor: 'web-runtime',
            target: row.id,
            source: 'runtime',
            peer: row.id,
            pid: subject.peer.pid,
            reason: currentEvidence.reason
          }));
        }, {
          acceptEvidence: (currentEvidence, subject) => peerEvidenceAllowsReap(currentEvidence, {
            nowSec: now(),
            lastSeenAt: Number(subject.peer.last_seen_at || 0),
            staleAfterSec: UNKNOWN_EVIDENCE_GRACE_SEC,
            graceUntil: readClockGraceUntil(db)
          }),
          beforeMutate: ({ subject, evidence: currentEvidence }) => peerEvidenceAllowsReap(currentEvidence, {
            nowSec: now(),
            lastSeenAt: Number(subject.peer.last_seen_at || 0),
            staleAfterSec: UNKNOWN_EVIDENCE_GRACE_SEC,
            graceUntil: readClockGraceUntil(db)
          })
        });
      } catch {}
    }
  }

  function startPtySession(input) {
    const pctx = input.projectCtx || ctx;
    const kind = input.kind || 'shell';
    const id = input.id || nextProjectSessionId(pctx, kind);
    const actorPeer = requestActorPeer(input, id);
    const auditSource = requestSource(input, 'web');
    const key = sessionKey(pctx, id);
    if (sessions.has(key) && sessions.get(key).status === 'running') {
      return sessions.get(key);
    }
    const role = input.role || 'peer';
    const command = input.command || defaultSessionCommand(kind);
    const cwd = path.resolve(input.cwd || pctx.root);
    const callerEnv = input.env && typeof input.env === 'object' ? input.env : process.env;
    const shell = callerEnv.SHELL || process.env.SHELL || 'bash';
    const env = childSessionEnv({
      HCC_PEER: id,
      HCC_ROOT: pctx.root,
      HCC_DB: pctx.dbPath,
      TERM: 'xterm-256color'
    }, callerEnv);
    const size = input.size || { cols: 100, rows: 30 };
    const child = pty.spawn(shell, ['-c', command], {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd,
      env
    });
    const session = {
      id,
      peerId: id,
      actorPeer,
      auditSource,
      actionTokens: new Set(),
      root: pctx.root,
      ctx: pctx,
      kind,
      role,
      command,
      cwd,
      pid: child.pid,
      pty: child,
      status: 'running',
      createdAt: now(),
      exitedAt: null,
      buffer: '',
      clients: new Set()
    };
    sessions.set(key, session);
    const db = connectWebProject(pctx);
    try {
      upsertPeer(db, {
        id,
        kind,
        role,
        worktree: cwd,
        branch: detectBranch(cwd),
        pid: child.pid,
        status: 'running',
        capabilities: 'web-pty'
      });
      const canonical = upsertCanonicalPeerBinding(db, {
        peer: id,
        provider: input.binding?.provider || kind,
        provider_session_id: input.binding?.provider_session_id || null,
        provider_session_name: input.binding?.provider_session_name || null,
        resume_mode: input.binding?.resume_mode || 'new',
        resume_arg: input.binding?.resume_arg || null,
        command,
        transport: 'web-pty',
        runtime_session_id: id
      }, Boolean(input.force));
      session.peerId = canonical.peer;
      session.binding = { ...canonical.binding };
      addEvent(db, 'web.session.started', actorPeer, null, auditPayload({
        actor: actorPeer,
        target: session.peerId || id,
        source: auditSource,
        admin: actorPeer !== (session.peerId || id),
        command,
        cwd,
        pid: child.pid
      }));
    } finally {
      db.close();
    }
    child.onData((data) => {
      session.buffer += data;
      if (session.buffer.length > 250000) session.buffer = session.buffer.slice(-200000);
      broadcast(session, { type: 'data', data });
      refreshPeerIoHeartbeat(session);
    });
    child.onExit((event) => {
      session.status = 'exited';
      session.exitedAt = now();
      const db = connectWebProject(pctx);
      try {
        db.prepare('UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ?').run('exited', now(), id);
        addEvent(db, 'web.session.exited', session.actorPeer || id, null, auditPayload({
          actor: session.actorPeer || id,
          target: session.peerId || id,
          source: session.auditSource || 'web',
          ...event
        }));
      } finally {
        db.close();
      }
      broadcast(session, { type: 'exit', event });
      closeSessionClients(session);
    });
    return session;
  }

  function webSessionBuildOptions(input) {
    const mode = input.mode || 'new';
    if (mode === 'new') return {};
    if (mode === 'resume') {
      const resume = String(input.resume || '').trim();
      if (!resume) throw new CliError('BAD_REQUEST', 'resume session required');
      return { resume };
    }
    if (mode === 'last') return { last: true };
    if (mode === 'continue') return { continue: true };
    throw new CliError('BAD_REQUEST', `Unsupported session mode: ${mode}`);
  }

  function webSessionPeerId(projectCtx, kind, opts, input) {
    if (input.id) return input.id;
    if (opts.resume) return providerSessionPeerId(kind, opts.resume);
    return nextProjectSessionId(projectCtx, kind);
  }

  function normalizeWebSessionInput(input) {
    const pctx = input.projectCtx || ctx;
    const kind = input.kind || 'shell';
    if (!['claude', 'codex', 'shell'].includes(kind)) {
      throw new CliError('BAD_REQUEST', `Unsupported session kind: ${kind}`);
    }
    if (input.command || input.binding) return { ...input, kind, projectCtx: pctx };

    const opts = webSessionBuildOptions(input);
    if (kind === 'shell' && hasResumeOpts(opts)) {
      throw new CliError('BAD_REQUEST', 'Resume modes are only supported for codex and claude sessions');
    }
    if (kind !== 'claude' && opts.continue) {
      throw new CliError('BAD_REQUEST', 'continue is only supported for claude sessions');
    }
    if (kind !== 'codex' && opts.last) {
      throw new CliError('BAD_REQUEST', 'last is only supported for codex sessions');
    }

    const id = webSessionPeerId(pctx, kind, opts, input);
    const built = buildPeerCommand(id, kind, opts, []);
    return {
      ...input,
      id,
      kind,
      command: built.command,
      binding: built.binding,
      projectCtx: pctx
    };
  }

  function startSession(input) {
    const normalized = normalizeWebSessionInput(input);
    if (normalized.backend === 'pty') return startPtySession(normalized);
    return startTmuxManagedSession(normalized);
  }

  const restoredTmuxDbs = new Set();
  for (const projectCtx of runtimeProjectContexts()) {
    const dbKey = path.resolve(projectCtx.dbPath);
    if (restoredTmuxDbs.has(dbKey)) continue;
    restoredTmuxDbs.add(dbKey);
    restoreTmuxManagedSessions(projectCtx);
    reconcileRunningBindings(projectCtx);
  }
  runAutoGc();

  const handleWebRequest = async (req, res) => {
    const url = requestUrl(req);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        const accept = req.headers.accept || '';
        const isBrowserNav = req.headers['sec-fetch-mode'] === 'navigate' || accept.includes('text/html');
        const queryToken = url.searchParams.get('token') || '';
        const hasCookie = cookieSessionOk(req);
        // Browser navigation with a valid ?token → exchange it for a session
        // cookie and redirect to the bare URL (strips the token from the
        // address bar). API-style fetches (Accept: */*) still get the HTML
        // directly so existing CLI/test callers are unaffected.
        if (isBrowserNav && queryToken && token && tokenMatches(queryToken, token)) {
          if (trustProxy && !requestMatchesProxyOrigin(req, { trustProxy, proxyOrigin })) {
            sendJson(res, 403, { ok: false, error: { code: 'PROXY_ORIGIN_MISMATCH', message: 'Trusted proxy headers do not match --proxy-origin' } });
            return;
          }
          const sid = issueSession();
          const params = new URLSearchParams();
          for (const key of ['project', 'root']) {
            const value = url.searchParams.get(key);
            if (value) params.set(key, value);
          }
          const location = '/' + (params.toString() ? `?${params}` : '');
          res.writeHead(302, { Location: location, 'Set-Cookie': sessionCookieHeader(sid, req) });
          res.end();
          return;
        }
        // Browser navigation with no credential at all → login page (bare-URL
        // fallback, e.g. a bookmarked URL after the runtime restarted).
        if (isBrowserNav && !hasCookie && !queryToken && token) {
          sendWebHtml(res, renderWebLogin);
          return;
        }
        sendWebHtml(res, renderWebIndex);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/assets/xterm.js') {
        sendFile(res, path.join(packageRoot(), 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'), 'application/javascript; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/assets/xterm.css') {
        sendFile(res, path.join(packageRoot(), 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), 'text/css; charset=utf-8');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/login') {
        const input = await readJsonRequest(req);
        const loginToken = String(input.token || '');
        if (!token || !tokenMatches(loginToken, token)) {
          sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
          return;
        }
        if (trustProxy && !requestMatchesProxyOrigin(req, { trustProxy, proxyOrigin })) {
          sendJson(res, 403, { ok: false, error: { code: 'PROXY_ORIGIN_MISMATCH', message: 'Trusted proxy headers do not match --proxy-origin' } });
          return;
        }
        const sid = issueSession();
        res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookieHeader(sid, req) });
        res.end();
        return;
      }
      if (url.pathname.startsWith('/api/') && !readHttpApiVersion(req).ok) {
        sendJson(res, 426, apiVersionUnsupportedBody());
        return;
      }
      const authMode = webAuthMode(url, req);
      if (!authMode) {
        sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
        return;
      }
      const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method || '');
      // Cookie-authenticated writes require affirmative same-origin evidence;
      // a missing Origin is not sufficient. Token-authenticated CLI requests
      // without cookies remain origin-free, as do tokenless loopback CLI
      // requests; a supplied Origin on the tokenless runtime must still match.
      const cookieAuthenticated = authMode === 'cookie' || cookieSessionOk(req);
      const originRequired = cookieAuthenticated || (!token && Boolean(req.headers.origin));
      if (!safeMethod && originRequired && !requestOriginMatches(req, { trustProxy, proxyOrigin })) {
        sendJson(res, 403, { ok: false, error: { code: 'CSRF_ORIGIN', message: 'Cookie-authenticated writes require a same-origin request' } });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/logout') {
        const sid = parseCookieSid(req);
        if (sid) closeWebSession(sid, 'logged out');
        res.writeHead(204, { 'Set-Cookie': expiredSessionCookieHeader(req) });
        res.end();
        return;
      }
      const reqCtx = projectFromRequest(req, url);
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        sendJson(res, 200, { projects: knownProjects(), current: projectRecord(reqCtx) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const input = await readJsonRequest(req);
        const requestedRoot = input.root || reqCtx.root;
        const projectCtx = rememberProject(resolveWebProjectContext(
          requestedRoot,
          input.db || path.join(requestedRoot, '.hello-cc', 'mesh.db')
        ), { register: true, nonblocking: true });
        const db = connectWebProject(projectCtx);
        db.close();
        writeRuntime(projectCtx, {
          product: PRODUCT_NAME,
          version: VERSION,
          api_version: API_VERSION,
          pid: process.pid,
          ...(processIdentity ? { process_identity: processIdentity } : {}),
          root: projectCtx.root,
          db: projectCtx.dbPath,
          host,
          port: actualPort,
          base_url: runtimeBaseUrl(host, actualPort, useTls),
          token,
          tls: useTls,
          trust_proxy: trustProxy,
          proxy_origin: proxyOrigin,
          tls_cert: useTls ? tlsCredentials.cert : undefined,
          global_runtime: true,
          started_at: now()
        });
        sendJson(res, 200, { project: projectRecord(projectCtx), projects: knownProjects() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const resources = normalizeStateResources([
          ...url.searchParams.getAll('resource'),
          url.searchParams.get('resources') || ''
        ]);
        sendJson(res, 200, webStatusSnapshot(reqCtx, url.searchParams.get('peer'), {
          resources,
          intent: url.searchParams.get('intent') || null,
          scope: url.searchParams.get('scope') || null
        }));
        return;
      }
      const peerActionMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/actions\/([^/]+)$/);
      if (peerActionMatch) {
        const peer = decodeURIComponent(peerActionMatch[1]);
        const action = decodeURIComponent(peerActionMatch[2]);
        const readOnly = ['status', 'state', 'inbox'].includes(action);
        if (readOnly && req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for read-only peer actions' } });
          return;
        }
        if (!readOnly && req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for mutating peer actions' } });
          return;
        }
        const input = readOnly
          ? {
              ...Object.fromEntries(url.searchParams.entries()),
              resource: url.searchParams.getAll('resource')
            }
          : await readJsonRequest(req);
        const actionInput = readOnly
          ? input
          : { ...input, actorPeer: resolveWebActionSession(reqCtx, peer, input, req) };
        sendJson(res, 200, webPeerActionForProject(reqCtx, peer, action, actionInput));
        return;
      }
      // Detected sessions: peers registered via hooks/watcher but without PTY
      if (req.method === 'GET' && url.pathname === '/api/detected') {
        const db = connectWebProject(reqCtx);
        let detected = [];
        const managedIds = new Set();
        const t = now();
        try {
          detected = db.prepare(`
            SELECT id, kind, role, status, worktree, branch, pid, capabilities,
                   created_at, last_seen_at, (? - last_seen_at) AS age_sec
            FROM peers
            WHERE status != 'exited' AND last_seen_at >= ?
            ORDER BY last_seen_at DESC, id ASC
            LIMIT 100
          `).all(t, t - DETECTED_PEER_MAX_AGE);
          for (const session of sessionsForProject(reqCtx)) {
            managedIds.add(session.id);
            const peerId = resolveSessionPeerId(db, session);
            if (peerId) managedIds.add(peerId);
          }
        } finally {
          db.close();
        }
        // Exclude peers that are already in the managed sessions Map
        sendJson(res, 200, {
          now: t,
          active_peer_ttl: ACTIVE_PEER_TTL,
          detected: detected.filter(p => !managedIds.has(p.id))
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/resumable') {
        // Provider sessions hcc has seen (via hooks/detection) that carry a real
        // provider session id or resumable provider session name.
        const db = connectWebProject(reqCtx);
        let rows = [];
        try {
          rows = db.prepare(`
            SELECT b.provider, b.provider_session_id, b.provider_session_name, b.peer,
                   p.last_seen_at
            FROM peer_bindings b
            LEFT JOIN peers p ON p.id = b.peer
            WHERE (b.provider_session_id IS NOT NULL AND b.provider_session_id != '')
               OR (b.provider_session_name IS NOT NULL AND b.provider_session_name != '')
            ORDER BY p.last_seen_at DESC, b.updated_at DESC
          `).all();
        } finally {
          db.close();
        }
        const seen = new Set();
        const resumable = [];
        for (const r of rows) {
          const resumeValue = r.provider_session_id || r.provider_session_name || '';
          if (!resumeValue) continue;
          const key = `${r.provider}:${resumeValue}`;
          if (seen.has(key)) continue;
          seen.add(key);
          resumable.push({
            provider: r.provider,
            session_id: r.provider_session_id,
            session_name: r.provider_session_name || null,
            resume: resumeValue,
            name: r.provider_session_name || null,
            peer: r.peer
          });
        }
        sendJson(res, 200, { resumable });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/runtime') {
        sendJson(res, 200, {
          product: PRODUCT_NAME,
          version: VERSION,
          api_version: API_VERSION,
          pid: process.pid,
          ...(processIdentity ? { process_identity: processIdentity } : {}),
          root: reqCtx.root,
          db: reqCtx.dbPath,
          projects: knownProjects(),
          sessions: sessionsForProject(reqCtx).length
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/runtime/gc-buffers') {
        const input = await readJsonRequest(req);
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw new CliError('BAD_REQUEST', 'buffer GC request must be an object');
        }
        if (input.phase === 'prepare') {
          const allowed = new Set(['phase', 'retentionSec', 'dryRun']);
          if (Object.keys(input).some((key) => !allowed.has(key))) {
            throw new CliError('BAD_REQUEST', 'buffer GC prepare contains unsupported fields');
          }
          if (typeof input.dryRun !== 'boolean') {
            throw new CliError('BAD_REQUEST', 'dryRun must be a boolean');
          }
          if (!Number.isSafeInteger(input.retentionSec) || input.retentionSec < 0 ||
              Object.is(input.retentionSec, -0) ||
              !Number.isSafeInteger(input.retentionSec * 1000)) {
            throw new CliError('BAD_REQUEST', 'retentionSec must be a canonical non-negative safe integer');
          }
          sendJson(res, 200, prepareRuntimeBufferGc(reqCtx, input));
          return;
        }
        if (input.phase === 'apply') {
          const allowed = new Set(['phase', 'token']);
          if (Object.keys(input).some((key) => !allowed.has(key)) ||
              typeof input.token !== 'string' || input.token.length === 0) {
            throw new CliError('BAD_REQUEST', 'buffer GC apply requires only its token');
          }
          sendJson(res, 200, applyPreparedRuntimeBufferGc(reqCtx, input.token));
          return;
        }
        throw new CliError('BAD_REQUEST', 'buffer GC phase must be prepare or apply');
      }
      if (req.method === 'POST' && url.pathname === '/api/runtime/stop') {
        sendJson(res, 200, { ok: true, pid: process.pid });
        setTimeout(shutdown, 10);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const db = connectWebProject(reqCtx);
        try {
          sendJson(res, 200, {
            sessions: sessionsForProject(reqCtx).map((session) => serializeSession(session, db))
          });
        } finally {
          db.close();
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const input = await readJsonRequest(req);
        const session = startSession({ ...input, projectCtx: reqCtx, auditActorPeer: 'web', auditSource: 'web' });
        sendJson(res, 200, { session: serializeSession(session) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions/attach') {
        const input = await readJsonRequest(req);
        const session = attachTmuxSession({ ...input, projectCtx: reqCtx, auditActorPeer: 'web', auditSource: 'web' });
        sendJson(res, 200, { session: serializeSession(session) });
        return;
      }
      const inputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/input$/);
      if (req.method === 'POST' && inputMatch) {
        // This HTTP input route is the admin injection path used by the CLI
        // (hcc inject / ask / broadcast). It is gated by the runtime token
        // (authOk above) and intentionally does NOT require the per-session
        // action token — the browser types via the WebSocket input frame
        // (which DOES require it), and the CLI cannot obtain the action token.
        const id = decodeURIComponent(inputMatch[1]);
        const lookupDb = connectWebProject(reqCtx);
        let session;
        try {
          session = getSession(reqCtx, id, lookupDb);
        } finally {
          lookupDb.close();
        }
        if (!session) {
          sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
          return;
        }
        if (session.status !== 'running') {
          sendJson(res, 409, { ok: false, error: { code: 'SESSION_NOT_RUNNING', message: 'Session is not running' } });
          return;
        }
        const input = await readJsonRequest(req);
        const text = String(input.text ?? input.data ?? '');
        const data = input.data !== undefined ? String(input.data) : `${text}${input.enter === false ? '' : '\r'}`;
        writeSessionInput(session, data);
        const db = connectWebProject(session.ctx || reqCtx);
        try {
          addEvent(db, 'web.session.input', 'web', null, auditPayload({
            actor: 'web',
            target: session.peerId || id,
            source: 'web',
            admin: true,
            peer: session.peerId || id,
            runtime_session_id: session.id,
            bytes: data.length,
            enter: input.enter !== false
          }));
        } finally {
          db.close();
        }
        sendJson(res, 200, { session: serializeSession(session), bytes: data.length });
        return;
      }
      const stopMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
      if (req.method === 'POST' && stopMatch) {
        const id = decodeURIComponent(stopMatch[1]);
        let stopInput = {};
        try { stopInput = await readJsonRequest(req); } catch {}
        const lookupDb = connectWebProject(reqCtx);
        let session;
        try {
          session = getSession(reqCtx, id, lookupDb);
        } finally {
          lookupDb.close();
        }
        if (!session) {
          sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
          return;
        }
        if (session.status === 'running') {
          if (session.type === 'external') {
            // Stop the hcc run wrapper first so it can kill the PTY and clean
            // buffer files; fall back to the child pid for older metadata.
            if (session.wrapperPid) { try { process.kill(session.wrapperPid, 'SIGTERM'); } catch {} }
            if (session.pid && session.pid !== session.wrapperPid) { try { process.kill(session.pid, 'SIGTERM'); } catch {} }
          } else if (session.type === 'tmux') {
            let killPlan = null;
            const stopDb = connectWebProject(reqCtx);
            try {
              const peerId = resolveSessionPeerId(stopDb, session) || session.peerId || session.id;
              if (stopInput.kill_tmux) {
                killPlan = safeTmuxKillPlan(reqCtx, stopDb, peerId, session.pane || null);
              }
            } finally {
              stopDb.close();
            }
            if (killPlan) executeTmuxKillPlan(reqCtx, killPlan);
            detachTmuxSession(session, 'detached');
          } else {
            session.pty.kill();
          }
        }
        const eventDb = connectWebProject(reqCtx);
        try {
          const peerId = resolveSessionPeerId(eventDb, session) || session.peerId || id;
          addEvent(eventDb, 'web.session.stop_requested', 'web', null, auditPayload({
            actor: 'web',
            target: peerId,
            source: 'web',
            admin: true,
            peer: peerId,
            runtime_session_id: session.id,
            kill_tmux: Boolean(stopInput.kill_tmux)
          }));
        } finally {
          eventDb.close();
        }
        sendJson(res, 200, { session: serializeSession(session) });
        return;
      }
      // Send a message to a detected (non-managed) peer's inbox
      const detectedMsgMatch = url.pathname.match(/^\/api\/detected\/([^/]+)\/msg$/);
      if (req.method === 'POST' && detectedMsgMatch) {
        const peerId = decodeURIComponent(detectedMsgMatch[1]);
        const input = await readJsonRequest(req);
        const body = String(input.body || '');
        const sender = 'web';
        const taskId = input.task ? Number(input.task) : null;
        if (!body) { sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'body required' } }); return; }
        const db = connectWebProject(reqCtx);
        let msgId;
        try {
          msgId = sendMessage(db, sender, peerId, taskId, 'note', body);
        } finally {
          db.close();
        }
        sendJson(res, 200, { ok: true, id: msgId });
        return;
      }
      const detectedStopMatch = url.pathname.match(/^\/api\/detected\/([^/]+)\/stop$/);
      if (req.method === 'POST' && detectedStopMatch) {
        const peerId = decodeURIComponent(detectedStopMatch[1]);
        let input = {};
        try { input = await readJsonRequest(req); } catch {}
        const db = connectWebProject(reqCtx);
        try {
          const now_ = now();
          let killPlan = null;
          if (input.kill_tmux) {
            killPlan = killDbProvenTmuxSession(reqCtx, db, peerId);
          }
          // Preserve last_seen_at on death so the just-stopped owner is not
          // misread as freshly active (hb-01); status='exited' drives liveness.
          db.prepare('UPDATE peers SET status = ? WHERE id = ?').run('exited', peerId);
          db.prepare('UPDATE peer_bindings SET runtime_target = NULL, updated_at = ? WHERE peer = ?').run(now_, peerId);
          addEvent(db, 'peer.stopped', 'web', null, auditPayload({
            actor: 'web',
            target: peerId,
            source: 'web',
            admin: true,
            peer: peerId,
            kill_tmux: Boolean(killPlan),
            tmux_session: killPlan?.session || null,
            runtime_target: killPlan?.runtime_target || null
          }));
        } finally {
          db.close();
        }
        sendJson(res, 200, { ok: true, peer: peerId, status: 'exited' });
        return;
      }
      const detectedRestartMatch = url.pathname.match(/^\/api\/detected\/([^/]+)\/restart$/);
      if (req.method === 'POST' && detectedRestartMatch) {
        const peerId = decodeURIComponent(detectedRestartMatch[1]);
        const db = connectWebProject(reqCtx);
        try {
          // v1-detected-restart: only flip a real detected peer that has a live
          // process or is not explicitly exited. Do not bump last_seen_at
          // (the peer did not actually heartbeat) so the reaper's age filter
          // still applies and a phantom cannot persist indefinitely.
          const peer = db.prepare('SELECT id, pid, status FROM peers WHERE id = ?').get(peerId);
          if (!peer || peer.status === 'exited') {
            sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `No live detected peer for ${peerId}` } });
            return;
          }
          db.prepare('UPDATE peers SET status = ? WHERE id = ?').run('running', peerId);
          addEvent(db, 'peer.restarted', 'web', null, auditPayload({
            actor: 'web',
            target: peerId,
            source: 'web',
            admin: true,
            peer: peerId
          }));
        } finally {
          db.close();
        }
        sendJson(res, 200, { ok: true, peer: peerId, status: 'running' });
        return;
      }
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
    } catch (err) {
      const publicFailure = publicCliFailure(err);
      const publicError = publicFailure?.error || err;
      const detail = publicFailure || process.env.HCC_DEBUG
        ? publicError.message
        : 'internal server error';
      sendJson(res, webErrorStatus(publicError), {
        ok: false,
        error: {
          code: publicError.code || 'SERVER_ERROR',
          message: detail,
          ...(publicFailure?.cleanupFailed ? { cleanup_failed: true } : {})
        }
      });
    }
  };
  const server = useTls
    ? https.createServer({ key: tlsCredentials.key, cert: tlsCredentials.cert }, handleWebRequest)
    : http.createServer(handleWebRequest);

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    try {
    const url = requestUrl(req);
    if (!readWebSocketApiVersion(url).ok) {
      const body = JSON.stringify(apiVersionUnsupportedBody());
      socket.end([
        'HTTP/1.1 426 Upgrade Required',
        'Content-Type: application/json; charset=utf-8',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body
      ].join('\r\n'));
      return;
    }
    const upgradeAuthMode = webAuthMode(url, req);
    if (!upgradeAuthMode) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const cookieAuth = upgradeAuthMode === 'cookie' ? cookieSessionRecord(req) : null;
    if (upgradeAuthMode === 'cookie' && !cookieAuth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!webSocketOriginAllowed(req, { trustProxy, proxyOrigin })) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const match = url.pathname.match(/^\/ws\/terminal\/([^/]+)$/);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const reqCtx = projectFromRequest(req, url);
    const id = decodeURIComponent(match[1]);
    const lookupDb = connectWebProject(reqCtx);
    let session;
    try {
      session = getSession(reqCtx, id, lookupDb);
    } finally {
      lookupDb.close();
    }
    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    // ws-5: cap concurrent WS clients per session so the action_token (delivered
    // via the snapshot frame) cannot be harvested by unlimited connections.
    if (session.clients.size >= 4) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connectionActionToken = newSessionActionToken();
      ws.hccCookieAuth = cookieAuth;
      session.clients.add(ws);
      if (cookieAuth) cookieAuth.session.sockets.add(ws);
      if (!cookieSocketValid(ws)) {
        session.clients.delete(ws);
        return;
      }
      session.actionTokens ||= new Set();
      session.actionTokens.add(connectionActionToken);
      ws.send(JSON.stringify({ type: 'snapshot', data: refreshTmuxSnapshot(session), action_token: connectionActionToken }));
      ws.on('message', (raw) => {
        try {
          if (!cookieSocketValid(ws)) return;
          const msg = JSON.parse(String(raw));
          if (msg.type === 'input' && session.status === 'running') {
            if (!tokenMatches(msg.action_token, connectionActionToken)) return;
            const data = String(msg.data || '');
            writeSessionInput(session, data);
          } else if (msg.type === 'resize' && session.status === 'running') {
            if (!tokenMatches(msg.action_token, connectionActionToken)) return;
            const cols = Math.max(20, Number.parseInt(msg.cols || 100, 10));
            const rows = Math.max(8, Number.parseInt(msg.rows || 30, 10));
            resizeSession(session, cols, rows);
            scheduleTmuxReplace(session);
          }
        } catch {
          // Ignore malformed terminal frames.
        }
      });
      ws.on('close', () => {
        session.clients.delete(ws);
        session.actionTokens.delete(connectionActionToken);
        if (cookieAuth) cookieAuth.session.sockets.delete(ws);
      });
    });
    } catch (err) {
      console.error(redactedLogText(`[${new Date().toISOString()}] ws upgrade failed: ${err?.message || err}`));
      try { socket.destroy(); } catch {}
    }
  });

  let cleanupPromise = null;
  let shutdownExitCode = 0;
  async function performRuntimeCleanup() {
    clearRuntime(ctx);
    // rob-07: clear this runtime's per-project pointers for every registered
    // project, not just the primary ctx, so sibling projects don't keep
    // pointing at a now-dead runtime.
    try {
      for (const project of readProjectRegistry()) {
        clearRuntime({ root: project.root }, process.pid);
      }
    } catch {}
    // sess-02: mark managed (tmux/pty) sessions detached in their own project
    // DB and clear their runtime_target, so a restart does not consume stale
    // bindings. Best-effort; never block shutdown.
    try {
      const byRoot = new Map();
      for (const s of sessions.values()) {
        if (s.status !== 'running' || (s.type !== 'tmux' && s.type !== 'pty')) continue;
        const peerId = s.peerId || s.id;
        if (!peerId) continue;
        const root = path.resolve(s.ctx?.root || s.root || ctx.root);
        if (!byRoot.has(root)) byRoot.set(root, new Set());
        byRoot.get(root).add(peerId);
      }
      const detachedAt = now();
      for (const [root, idSet] of byRoot) {
        const peerIds = [...idSet];
        if (!peerIds.length) continue;
        const placeholders = peerIds.map(() => '?').join(',');
        const cleanupDb = connectWebProject(contextForProject(root, null, { json: ctx.json }));
        try {
          cleanupDb.prepare(`UPDATE peers SET status = 'detached' WHERE id IN (${placeholders}) AND status IN ('running','working','busy')`).run(...peerIds);
          cleanupDb.prepare(`UPDATE peer_bindings SET runtime_target = NULL, updated_at = ? WHERE peer IN (${placeholders})`).run(detachedAt, ...peerIds);
        } finally {
          cleanupDb.close();
        }
      }
    } catch {}
    clearInterval(externalScanPoller);
    clearInterval(autoAttachPoller);
    clearInterval(reaperPoller);
    clearInterval(gcPoller);
    clearInterval(webSessionPruner);
    try { bufsWatcher?.close(); } catch {}
    for (const session of sessions.values()) {
      closeSessionClients(session);
      if (session.status !== 'running') continue;
      if (session.type === 'external') {
        try { if (session.outputFd) fs.closeSync(session.outputFd); } catch {}
        try { if (session.outputPoller) clearInterval(session.outputPoller); } catch {}
        try { if (session.exitPoller) clearInterval(session.exitPoller); } catch {}
      } else if (session.type === 'tmux') {
        try { stopTmuxStream(session); } catch {}
        try { if (session.exitPoller) clearInterval(session.exitPoller); } catch {}
      } else {
        try { session.pty.kill(); } catch {}
      }
    }
    try { wss.close(); } catch {}
    await new Promise((resolve) => {
      const terminateClients = setTimeout(() => {
        for (const session of sessions.values()) {
          for (const client of [...(session.clients || [])]) {
            try { if (typeof client.terminate === 'function') client.terminate(); } catch {}
          }
        }
        try { server.closeAllConnections?.(); } catch {}
      }, 250);
      const forceClose = setTimeout(() => {
        try { server.closeAllConnections?.(); } catch {}
        resolve();
      }, 1500);
      try {
        server.close(() => {
          clearTimeout(terminateClients);
          clearTimeout(forceClose);
          resolve();
        });
        try { server.closeIdleConnections?.(); } catch {}
      } catch {
        clearTimeout(terminateClients);
        clearTimeout(forceClose);
        resolve();
      }
    });
  }
  function cleanupRuntime() {
    if (!cleanupPromise) cleanupPromise = performRuntimeCleanup();
    return cleanupPromise;
  }
  function shutdown() {
    void cleanupRuntime().then(
      () => process.exit(shutdownExitCode),
      (error) => {
        console.error(redactedLogText(`[${new Date().toISOString()}] runtime cleanup failed: ${error?.stack || error}`));
        process.exit(1);
      }
    );
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // Best-effort backstop for exit paths that bypass shutdown() (process.exit,
  // uncaught exceptions): synchronously kill pty-backed children so they are not
  // orphaned. Cannot run on SIGKILL — the dead-peer reaper repairs DB state on
  // the next start. tmux sessions are intentionally left alive.
  process.on('exit', () => {
    for (const session of sessions.values()) {
      if (session.type !== 'tmux' && session.type !== 'external' && session.pty) {
        try { session.pty.kill(); } catch {}
      }
    }
  });

  const fatalController = createFatalShutdownController({
    cleanup: () => {
      shutdownExitCode = 1;
      return cleanupRuntime();
    },
    exit: (code) => process.exit(code),
    forceExit: (code) => process.exit(code),
    log: (entry) => console.error(redactedLogText({
      timestamp: new Date().toISOString(),
      ...entry
    }))
  });
  process.on('uncaughtException', (err) => {
    void fatalController.fatal(err);
  });
  process.on('unhandledRejection', (reason) => {
    void fatalController.fatal(reason);
  });

  const actualPort = await listenServer(server, host, port, opts.port === undefined);
  const runtime = {
    product: PRODUCT_NAME,
    version: VERSION,
    api_version: API_VERSION,
    pid: process.pid,
    ...(processIdentity ? { process_identity: processIdentity } : {}),
    root: ctx.root,
    db: ctx.dbPath,
    host,
    port: actualPort,
    base_url: runtimeBaseUrl(host, actualPort, useTls),
    token,
    tls: useTls,
    trust_proxy: trustProxy,
    proxy_origin: proxyOrigin,
    tls_cert: useTls ? tlsCredentials.cert : undefined,
    started_at: now()
  };
  const runtimeFile = writeRuntime(ctx, runtime);
  writeGlobalRuntime(runtime);
  registerProject(ctx);
  const db = connectWebProject(ctx);
  try {
    addEvent(db, startMeta.eventType || 'web.started', 'human', null, auditPayload({
      actor: 'human',
      source: 'cli',
      root: ctx.root,
      db: ctx.dbPath,
      host,
      port: actualPort,
      requested_port: port,
      guidance: startMeta.guidance || prepared.guidance || null,
      runtime: runtimeFile
    }));
  } finally {
    db.close();
  }
  console.log(redactedLogText(`${PRODUCT_NAME} web listening on ${host}:${actualPort}`));
  console.log(redactedLogText(`project: ${ctx.root}`));
  console.log(redactedLogText(`database: ${ctx.dbPath}`));
  console.log(redactedLogText(`open: ${publicRuntimeUrl(runtime, ctx.root)}`));
}

async function cmdRun(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpRun();
  registerProjectActivity(ctx);
  const sep = args.indexOf('--');
  const optArgs = sep >= 0 ? args.slice(0, sep) : args;
  const cmdArgs = sep >= 0 ? args.slice(sep + 1) : [];
  const opts = parseOpts(optArgs, { booleans: ['force', 'web-managed'] });
  validateOpts('run', opts, ['peer', 'kind', 'role', 'cwd', 'force']);
  const kind = opts.kind || 'other';
  const identity = resolveCurrentPeer(ctx, opts, 'peer', kind);
  const id = identity.id;
  const role = opts.role || 'peer';
  const cwd = path.resolve(opts.cwd || ctx.cwd);
  const command = cmdArgs.length ? cmdArgs[0] : defaultSessionCommand(kind);
  const commandArgs = cmdArgs.length ? cmdArgs.slice(1) : [];
  const binding = bindingFromRun(id, kind, command, commandArgs, 'hcc-run');

  if (process.env.HCC_INTERNAL_WEB_MANAGED_RUN === '1') {
    return cmdRunWebManaged(ctx, {
      id,
      kind,
      role,
      cwd,
      command,
      commandArgs,
      binding,
      force: Boolean(opts.force)
    });
  }

  const db = connect(ctx);
  try {
    upsertPeer(db, {
      id, kind, role,
      worktree: cwd,
      branch: detectBranch(cwd),
      pid: process.pid,
      status: 'running',
      capabilities: 'run-wrapper'
    });
    upsertCanonicalPeerBinding(db, binding, Boolean(opts.force));
    addEvent(db, 'run.session.started', id, null, auditPayload({
      actor: id,
      target: id,
      command: [command, ...commandArgs].join(' '),
      cwd
    }));
  } finally {
    db.close();
  }
  console.error(redactedLogText(`${CLI_NAME}: running ${id} (${kind}, ${role}) -> ${command} ${commandArgs.join(' ')}`.trim()));
  const child = spawn(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    env: childSessionEnv({ HCC_PEER: id, HCC_ROOT: ctx.root, HCC_DB: ctx.dbPath })
  });
  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', (err) => {
      console.error(redactedLogText(`${CLI_NAME}: failed to start ${command}: ${err.message}`));
      resolve({ code: 127, signal: null });
    });
  });
  const db2 = connect(ctx);
  try {
    db2.prepare('UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ?').run('exited', now(), id);
    addEvent(db2, 'run.session.exited', id, null, auditPayload({
      actor: id,
      target: id,
      ...exitCode
    }));
  } finally {
    db2.close();
  }
  if (exitCode.signal) {
    process.kill(process.pid, exitCode.signal);
  } else {
    process.exitCode = exitCode.code ?? 0;
  }
}

/**
 * Internal external PTY bridge: start a child in a PTY, forward output to both
 * the local terminal and a shared buffer file so hcc web can stream it to
 * browsers. Input from the browser is written to a .in file that we relay.
 */
async function cmdRunWebManaged(ctx, { id, kind, role, cwd, command, commandArgs, binding, force = false }) {
  registerProjectActivity(ctx);
  const ptyModule = await import('node-pty');
  const pty = ptyModule.default || ptyModule;

  const bufsDir = path.join(ctx.root, '.hello-cc', BUFS_DIR_NAME);
  fs.mkdirSync(bufsDir, { recursive: true });
  const outFile = path.join(bufsDir, `${id}.out`);
  const inFile  = path.join(bufsDir, `${id}.in`);
  const resizeFile = path.join(bufsDir, `${id}.resize`);
  const metaFile = path.join(bufsDir, `${id}.meta`);
  const bufferFiles = [outFile, inFile, resizeFile, metaFile];
  const bufferGeneration = randomBytes(18).toString('base64url');

  const ownsExternalBufferGroup = () => {
    try {
      return externalBufferOwnerKey(readExternalBufferMetadata(metaFile)) ===
        `generation:${bufferGeneration}`;
    } catch {
      return false;
    }
  };

  const removeOwnedExternalBufferGroup = () => withBufferDirectoryLease(bufsDir, () => {
    if (!ownsExternalBufferGroup()) return false;
    for (const file of bufferFiles) {
      fs.rmSync(file, { force: true });
    }
    return true;
  });

  // Publish live wrapper evidence in the same lease that creates the group.
  // This closes the pre-.meta window even for `gc --older-than 0`.
  const publishingWrapperIdentity = runtimeProcessIdentity();
  withBufferDirectoryLease(bufsDir, () => {
    const existingFiles = bufferFiles.filter((file) => fs.existsSync(file));
    if (existingFiles.length > 0) {
      let existingMeta;
      try { existingMeta = readExternalBufferMetadata(metaFile); } catch {
        throw new CliError('EXTERNAL_SESSION_EXISTS', `External session ${id} has unresolved buffer ownership`);
      }
      if (externalBufferEvidence(existingMeta, inspectProcessIdentity).state !== 'dead') {
        throw new CliError('EXTERNAL_SESSION_EXISTS', `External session ${id} already has a live or unknown owner`);
      }
      for (const file of bufferFiles) fs.rmSync(file, { force: true });
    }
    fs.writeFileSync(inFile, '');
    fs.writeFileSync(resizeFile, '');
    fs.writeFileSync(metaFile, JSON.stringify({
      id,
      generation: bufferGeneration,
      kind,
      role,
      command: [command, ...commandArgs].join(' '),
      cwd,
      wrapper_pid: process.pid,
      ...(publishingWrapperIdentity ? { wrapper_identity: publishingWrapperIdentity } : {}),
      publishing: true
    }));

    const db = connect(ctx);
    try {
      tx(db, () => {
        upsertPeer(db, {
          id, kind, role,
          worktree: cwd,
          branch: detectBranch(cwd),
          pid: process.pid,
          status: 'running',
          capabilities: 'run-pty'
        });
        upsertCanonicalPeerBinding(db, binding, force);
        addEvent(db, 'run.session.started', id, null, auditPayload({
          actor: id,
          target: id,
          command: [command, ...commandArgs].join(' '),
          cwd,
          webManaged: true
        }));
      });
    } catch (error) {
      for (const file of bufferFiles) fs.rmSync(file, { force: true });
      throw error;
    } finally {
      db.close();
    }
  });

  // Estimate terminal size from current process
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;

  const child = pty.spawn(command, commandArgs, {
    name: 'xterm-256color', cols, rows, cwd,
    env: childSessionEnv({ HCC_PEER: id, HCC_ROOT: ctx.root, HCC_DB: ctx.dbPath, TERM: 'xterm-256color' })
  });
  const childExit = trackPtyExit(child);
  const wrapperTermination = installPtyTerminationHandlers(child);
  let outFd;

  const failStartup = async (reason, childIdentity = null) => {
    const termination = await stopPtyAfterStartupFailure(child, childExit);
    const disposition = ptyStartupFailureDisposition({
      termination,
      childPid: child.pid,
      childIdentity
    });
    try { fs.closeSync(outFd); } catch {}
    outFd = null;
    let metadataPreserved = false;
    let ownedFailureRecord = false;
    if (disposition.preserveEvidence) {
      try {
        metadataPreserved = withBufferDirectoryLease(bufsDir, () => {
          if (!ownsExternalBufferGroup()) return false;
          fs.writeFileSync(metaFile, JSON.stringify({
            id,
            generation: bufferGeneration,
            kind,
            role,
            command: [command, ...commandArgs].join(' '),
            cwd,
            pid: child.pid,
            ...(childIdentity ? { child_identity: childIdentity } : {}),
            startup_failed: true,
            termination_unconfirmed: true,
            error: reason,
            cols,
            rows
          }));
          return true;
        });
        ownedFailureRecord = metadataPreserved;
      } catch {}
    } else {
      try {
        ownedFailureRecord = removeOwnedExternalBufferGroup();
      } catch {}
    }
    if (ownedFailureRecord) {
      const failedDb = connect(ctx);
      try {
        const mutation = disposition.preserveEvidence
          ? failedDb.prepare(`
              UPDATE peers
              SET status = ?, last_seen_at = ?, pid = ?, pid_start_token = ?, pid_command_hash = ?
              WHERE id = ? AND pid = ?
            `).run(
              disposition.status,
              now(),
              child.pid,
              childIdentity?.startToken || null,
              childIdentity?.commandHash || null,
              id,
              process.pid
            )
          : failedDb.prepare('UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ? AND pid = ?')
            .run(disposition.status, now(), id, process.pid);
        if (Number(mutation.changes || 0) > 0) {
          addEvent(failedDb, disposition.eventType, id, null, auditPayload({
            actor: id,
            target: id,
            startup: true,
            error: reason,
            childTerminationConfirmed: termination.exited,
            childPid: child.pid,
            childIdentity,
            metadataPreserved,
            ...(termination.event || {})
          }));
        }
      } finally {
        failedDb.close();
      }
    }
    const signal = ptyTerminationSignal(wrapperTermination.signal, null);
    wrapperTermination.dispose();
    if (signal) process.kill(process.pid, signal);
    throw new CliError('PROCESS_START_FAILED', `Process identity could not be recorded (${reason}): ${command}`);
  };

  try {
    withBufferDirectoryLease(bufsDir, () => {
      if (!ownsExternalBufferGroup()) {
        throw new CliError('EXTERNAL_SESSION_SUPERSEDED', `External session ${id} was replaced during startup`);
      }
      outFd = fs.openSync(outFile, 'w');
    });
  } catch (error) {
    await failStartup(error?.code || 'external_buffer_open_failed');
  }
  child.onData((data) => {
    process.stdout.write(data);
    try { fs.write(outFd, data, () => {}); } catch {}
  });

  // Capture immutable process evidence before publishing the session. The
  // exit listener above is installed synchronously so a short-lived PTY cannot
  // disappear while identity collection is polling under load.
  const startupEvidence = await capturePtyStartupEvidence({
    childPid: child.pid,
    wrapperPid: process.pid,
    exit: childExit,
    timeoutMs: 2000
  });
  if (startupEvidence.state === 'failed') {
    await failStartup(startupEvidence.reason, startupEvidence.childIdentity || null);
  }
  const { wrapperIdentity, childIdentity } = startupEvidence;
  if (childExit.event !== null) {
    await failStartup('child_exited_before_identity', childIdentity);
  }
  const writeExternalMeta = (metaCols, metaRows) => withBufferDirectoryLease(bufsDir, () => {
    if (!ownsExternalBufferGroup()) return false;
    fs.writeFileSync(metaFile, JSON.stringify({
      id,
      generation: bufferGeneration,
      kind,
      role,
      command: [command, ...commandArgs].join(' '),
      cwd,
      pid: child.pid,
      wrapper_pid: process.pid,
      ...(childIdentity ? { child_identity: childIdentity } : {}),
      wrapper_identity: wrapperIdentity,
      cols: metaCols,
      rows: metaRows
    }));
    return true;
  });
  // Write metadata so hcc web can discover this session
  if (!writeExternalMeta(cols, rows)) {
    await failStartup('external_buffer_owner_changed', childIdentity);
  }

  // Poll for browser input (written to .in file by hcc web)
  let inOffset = 0;
  const inputPoller = setInterval(() => {
    try {
      const stat = fs.statSync(inFile);
      if (stat.size > inOffset) {
        const buf = Buffer.alloc(stat.size - inOffset);
        const fd = fs.openSync(inFile, 'r');
        fs.readSync(fd, buf, 0, buf.length, inOffset);
        fs.closeSync(fd);
        inOffset = stat.size;
        if (buf.length) child.write(buf.toString());
      }
    } catch {}
  }, 100);

  let resizeOffset = 0;
  const resizePoller = setInterval(() => {
    try {
      const stat = fs.statSync(resizeFile);
      if (stat.size <= resizeOffset) return;
      const buf = Buffer.alloc(stat.size - resizeOffset);
      const fd = fs.openSync(resizeFile, 'r');
      fs.readSync(fd, buf, 0, buf.length, resizeOffset);
      fs.closeSync(fd);
      resizeOffset = stat.size;
      const lines = buf.toString().trim().split('\n').filter(Boolean);
      const last = lines.at(-1);
      if (!last) return;
      const size = JSON.parse(last);
      const c = Math.max(20, Number.parseInt(size.cols || 120, 10));
      const r = Math.max(8, Number.parseInt(size.rows || 40, 10));
      child.resize(c, r);
      try { writeExternalMeta(c, r); } catch {}
    } catch {}
  }, 250);

  // Handle SIGWINCH for local terminal resize
  const onStdoutResize = () => {
    const c = process.stdout.columns || 120;
    const r = process.stdout.rows || 40;
    child.resize(c, r);
    try { writeExternalMeta(c, r); } catch {}
  };
  process.stdout.on('resize', onStdoutResize);

  // Forward local stdin to PTY
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => child.write(data));
  }

  const exitCode = await childExit.promise;

  clearInterval(inputPoller);
  clearInterval(resizePoller);
  wrapperTermination.dispose();
  process.stdout.off('resize', onStdoutResize);
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch {}
  }
  try { fs.closeSync(outFd); } catch {}
  // Clean up only the generation this producer published. A replacement with
  // the same peer id owns its own files and DB status.
  let removedOwnedBufferGroup = false;
  try {
    removedOwnedBufferGroup = removeOwnedExternalBufferGroup();
  } catch {}

  if (removedOwnedBufferGroup) {
    const db2 = connect(ctx);
    try {
      const mutation = db2.prepare(
        'UPDATE peers SET status = ?, last_seen_at = ? WHERE id = ? AND pid = ?'
      ).run('exited', now(), id, process.pid);
      if (Number(mutation.changes || 0) > 0) {
        addEvent(db2, 'run.session.exited', id, null, auditPayload({
          actor: id,
          target: id,
          ...exitCode
        }));
      }
    } finally {
      db2.close();
    }
  }

  const signal = ptyTerminationSignal(wrapperTermination.signal, exitCode.signal);
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = exitCode.exitCode ?? 0;
  }
}

/**
 * Read /proc/<ppid>/cmdline and extract --resume / -r / resume subcommand arg.
 * Returns the resume ID string or null.
 */
function readParentResumeId(kind) {
  if (process.platform !== 'linux') return null;
  try {
    const raw = fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8');
    const args = raw.split('\0').filter(Boolean);
    return resumeIdFromArgs(kind, args);
  } catch {}
  return null;
}

// ─── hcc hook ────────────────────────────────────────────────────────────────
// Called by Claude Code / Codex hooks. Reads JSON from stdin, registers the
// peer in the current HCC project, and injects a bounded coordination snapshot
// into model context on prompt/session/turn events.

async function cmdHook(ctx, args) {
  let hookType = args[0] || 'unknown';

  // Read stdin with a short timeout (hooks must complete quickly)
  const raw = await new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(buf), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(buf); });
  });

  let payload = {};
  try { payload = JSON.parse(raw); } catch {}
  hookType = payload.hook_event_name || payload.hookEventName || hookType;
  const hookEventName = formatHookEventName(hookType);
  const hookKey = hookEventName.replace(/[^a-z]/gi, '').toLowerCase();

  // Extract session identity (Claude Code sets these in its hook JSON)
  const kind = autoPeerKind('other');
  const providerSession = autoPeerProviderSession(kind);
  const sessionId  = payload.session_id || payload.sessionId || payload.conversation_id || payload.conversationId ||
    providerSession.sessionId || '';
  const hookCwd    = payload.cwd         || payload.workingDirectory || process.cwd();

  // Hooks auto-join the exact current project path, creating its mesh.db on
  // first use. Cross-path sharing is explicit via HCC_ROOT/HCC_DB.
  const hccRoot = process.env.HCC_ROOT
    ? path.resolve(process.env.HCC_ROOT)
    : path.resolve(hookCwd);

  const hookCtx = {
    ...ctx,
    root: hccRoot,
    dbPath: path.join(hccRoot, '.hello-cc', 'mesh.db')
  };
  registerProjectActivity(hookCtx);

  // Derive peer ID: HCC_PEER > resume ID from parent cmdline > session ID > terminal
  let peerId = process.env.HCC_PEER;
  let resumeId = null;
  if (!peerId) {
    resumeId = providerSession.resumeId || readParentResumeId(kind);
    if (resumeId) {
      peerId = providerSessionPeerId(kind, resumeId);
    }
  }
  if (!peerId) {
    peerId = sessionId
      ? `${kind}-${shortHash(sessionId)}`
      : `${kind}-${shortHash(`${hookCtx.root}:${autoPeerBasis(kind)}`)}`;
  }

  const db = connect(hookCtx);
  try {
    const status = hookKey === 'stop' ? 'idle' : 'working';
    const providerAncestor = readAncestorCliInfo();
    const providerPid = providerAncestor?.kind === kind ? Number(providerAncestor.pid) : null;
    const providerIdentity = providerPid ? liveProcessIdentity(providerPid) : null;
    const existing = db.prepare('SELECT id FROM peers WHERE id = ?').get(peerId);
    if (!existing) {
      upsertPeer(db, {
        id: peerId, kind, role: 'peer',
        worktree: hookCwd,
        branch: detectBranch(hookCwd),
        pid: providerIdentity?.pid || null,
        processIdentity: providerIdentity,
        status,
        capabilities: `hook-${hookKey}`
      });
    } else {
      refreshHookOwnerIdentity(db, {
        peerId,
        status,
        observedAt: now(),
        processIdentity: providerIdentity
      });
    }
    const hookBinding = {
      peer: peerId,
      provider: kind,
      ...providerSessionParts(resumeId || sessionId),
      resume_mode: resumeId ? 'resume' : (sessionId ? 'detected' : 'unknown'),
      resume_arg: resumeId || null,
      command: null,
      transport: 'hook',
      runtime_session_id: peerId
    };
    const canonical = upsertCanonicalPeerBinding(db, hookBinding, true);
    if (canonical.peer !== peerId) {
      const previousPeer = peerId;
      peerId = canonical.peer;
      refreshHookOwnerIdentity(db, {
        peerId,
        status,
        observedAt: now(),
        processIdentity: providerIdentity
      });
      addEvent(db, 'provider.session.merged', peerId, null, auditPayload({
        actor: peerId,
        target: peerId,
        source: 'hook',
        from_peer: previousPeer,
        provider: kind,
        session_id: sessionId || resumeId || null
      }));
    }
    addEvent(db, `hook.${hookKey}`, peerId, null, auditPayload({
      actor: peerId,
      target: peerId,
      source: 'hook',
      session_id: sessionId,
      cwd: hookCwd
    }));
    // hb-06: an active hook is proof the peer is working. During clock grace,
    // renew retained locks even when the wall-clock jump made them look expired.
    const hookNow = now();
    const hookClockObservation = observeLockClockSafety(db, hookCtx, {
      owner: peerId,
      observedAt: hookNow
    });
    const hookLockRenewals = hookClockObservation.renewed > 0
      ? hookClockObservation.renewed
      : renewOwnedLocks(db, {
          owner: peerId,
          nowSec: hookNow,
          ttlCap: 3600,
          // Receiving the hook is direct lease-heartbeat evidence. It does not
          // grant provider-restart or tmux-destructive authority.
          includeExpired: true
        });
    if (hookLockRenewals > 0) {
      addEvent(db, 'lock.renewed_by_hook', peerId, null, { renewed: hookLockRenewals });
    }
    try {
      reconcileRunningPeerBindings(db, hookCtx, {
        inspectProcess: inspectProviderProcess,
        latestProviderSessionForPeer: (peer) => latestHookProviderSession(db, peer),
        addEvent,
        now
      });
    } catch {}

    if (['sessionstart', 'userpromptsubmit'].includes(hookKey)) {
      const snapshot = buildHookCoordinationContext(db, hookCtx, peerId);
      ackMessages(db, peerId, snapshot.messages);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName,
          additionalContext: snapshot.text
        }
      }) + '\n');
    } else if (['posttooluse', 'stop'].includes(hookKey)) {
      const snapshot = buildHookCoordinationContext(db, hookCtx, peerId);
      if (snapshot.messages.length > 0) {
        ackMessages(db, peerId, snapshot.messages);
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName,
            additionalContext: snapshot.text
          }
        }) + '\n');
      }
    }
  } finally {
    try { db.close(); } catch {}
  }
  process.exit(0);
}

// ─── hcc install-hooks ───────────────────────────────────────────────────────

async function cmdInstallHooks(ctx, args) {
  if (wantsHelp(args)) return helpInstallHooks();
  const opts = parseOpts(args, { booleans: ['uninstall', 'status'] });
  const { installClaudeHooks, uninstallClaudeHooks, verifyClaudeHooks,
          installCodexHooks, uninstallCodexHooks, verifyCodexHooks } = await loadSetup();
  const hccBin = commandPath();

  if (opts.uninstall) {
    const claude = uninstallClaudeHooks();
    const codex  = uninstallCodexHooks();
    const parts = [];
    if (claude) parts.push('~/.claude/settings.json');
    if (codex)  parts.push('~/.codex/hooks.json');
    printResult(ctx, { claude, codex }, () =>
      parts.length ? 'hooks removed from ' + parts.join(', ') : 'no hooks found to remove');
    return;
  }
  if (opts.status) {
    const claudeOk = verifyClaudeHooks();
    const codexOk  = verifyCodexHooks();
    printResult(ctx, { claude: claudeOk, codex: codexOk }, () =>
      `hooks: claude=${claudeOk ? 'yes' : 'no'} codex=${codexOk ? 'yes' : 'no'}`);
    return;
  }
  const cp = installClaudeHooks(hccBin);
  let cxp = null;
  try { cxp = installCodexHooks(hccBin); } catch {}
  printResult(ctx, { claude: cp, codex: cxp }, () =>
    `hooks installed: claude → ${cp}${cxp ? `, codex → ${cxp}` : ''}`);
}

function pathEntryRemovalMessage(pathEntry) {
  if (pathEntry.error) return `PATH entry not removed: ${pathEntry.error}`;
  if (pathEntry.missing) return `PATH entry not present (${pathEntry.rcFile} not found)`;
  if (pathEntry.removed === false) return `PATH entry not present in ${pathEntry.rcFile}`;
  return `PATH entry removed from ${pathEntry.rcFile}`;
}

// ─── hcc shim ────────────────────────────────────────────────────────────────

async function cmdShim(ctx, args) {
  const sub = args[0];
  const { installShims, uninstallShims, shimStatus, installPathEntry, uninstallPathEntry, SHIM_DIR } = await loadSetup();

  if (wantsHelp(args)) return helpShim();

  if (sub === 'ensure') {
    const name = args[1];
    const target = args[2] ? path.resolve(args[2]) : (name ? path.join(SHIM_DIR, name) : null);
    if (!['claude', 'codex'].includes(name) || !target) {
      throw new CliError('BAD_ARGS', 'Usage: hcc shim ensure claude|codex PATH');
    }
    const realBin = args[3] || null;
    const result = installShims(commandPath(), realBin ? { realBins: { [name]: realBin } } : {});
    const changed = (result.changed || []).map((p) => path.resolve(p));
    if (changed.some((p) => sameResolvedPath(p, target))) {
      process.exitCode = 75;
      return;
    }
    return;
  }

  if (!sub || sub === 'install') {
    const hccBin = commandPath();
    const result = installShims(hccBin);
    const lines = [
      result.installed.length
        ? `shims installed:\n${result.installed.map((p) => `  ${p}`).join('\n')}`
        : 'no shims installed (claude/codex not found on PATH)',
    ];
    if (result.skipped.length) lines.push(`skipped: ${result.skipped.join(', ')}`);
    if (result.installed.length) {
      const { alreadyPresent, rcFile } = installPathEntry();
      if (!alreadyPresent) {
        lines.push(`PATH updated in ${rcFile}`);
        lines.push(`run: source ${rcFile}  (or open a new terminal)`);
      } else {
        lines.push(`PATH entry already present in ${rcFile}`);
      }
    }
    printResult(ctx, result, () => lines.join('\n'));
    return;
  }
  if (sub === 'uninstall') {
    const removed = uninstallShims();
    const pathEntry = uninstallPathEntry();
    printResult(ctx, { removed, path_entry: pathEntry }, () => [
      removed.length ? `removed: ${removed.join(', ')}` : 'no shims to remove',
      pathEntryRemovalMessage(pathEntry)
    ].join('\n'));
    return;
  }
  if (sub === 'status') {
    const status = shimStatus();
    printResult(ctx, status, (r) => [
      `shim dir: ${r.shimDir}`,
      `claude: ${r.tools.claude.installed ? 'installed' : 'missing'} (${r.tools.claude.path})`,
      `codex: ${r.tools.codex.installed ? 'installed' : 'missing'} (${r.tools.codex.path})`,
      r.complete
        ? 'status: complete'
        : r.installed
          ? 'status: partial (run: hcc shim install)'
          : 'status: not installed (run: hcc shim install)'
    ].join('\n'));
    return;
  }
  throw new CliError('BAD_ARGS', `Unknown shim subcommand: ${sub}`);
}

// ─── hcc setup (maintenance bootstrap) ───────────────────────────────────────

async function cmdSetup(ctx, args) {
  const opts = parseOpts(args, { booleans: ['quiet'] });
  const log = opts.quiet ? () => {} : console.log;

  log('hello-cc setup\n');

  // 1. Init project if needed
  if (!fs.existsSync(ctx.dbPath)) {
    const db = connect(ctx);
    db.close();
    writeGuidance(ctx);
    log(`✓  project initialized: ${ctx.root}`);
  } else {
    log(`✓  project already initialized`);
  }

  // 2. Install Claude Code + Codex hooks
  const { installClaudeHooks, verifyClaudeHooks, installCodexHooks, verifyCodexHooks,
          installShims, installPathEntry } = await loadSetup();
  const hccBin = commandPath();

  if (!verifyClaudeHooks()) {
    installClaudeHooks(hccBin);
    log('✓  Claude Code hooks installed → ~/.claude/settings.json');
  } else {
    log('✓  Claude Code hooks already installed');
  }

  if (!verifyCodexHooks()) {
    try { installCodexHooks(hccBin); log('✓  Codex hooks installed → ~/.codex/hooks.json'); }
    catch { log('⚠  Codex hooks installation failed (ignored)'); }
  } else {
    log('✓  Codex hooks already installed');
  }

  // 3. Install shims
  const result = installShims(hccBin);
  if (result.installed.length) {
    if (result.changed.length) {
      log(`✓  shims installed → ${result.changed.join(', ')}`);
    } else {
      log(`✓  shims already installed → ${result.installed.join(', ')}`);
    }
    if (result.skipped.length) log(`⚠  shims skipped: ${result.skipped.join(', ')}`);
    const { alreadyPresent, rcFile } = installPathEntry();
    if (!alreadyPresent) {
      log(`✓  PATH updated in ${rcFile}`);
      log(`   run: source ${rcFile}  (or open a new terminal)`);
    } else {
      log(`✓  PATH entry already present in ${rcFile}`);
    }
  } else {
    log('⚠  shims: claude/codex not found on PATH — skipped');
  }

  log('\nDone. Run `hcc web` for the default coordinated terminal experience.');
}

// ─── hcc update ──────────────────────────────────────────────────────────────

async function cmdUpdate(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpUpdate();

  const opts = parseOpts(args, { booleans: ['dry-run'] });
  validateOpts('update', opts, ['tag', 'registry', 'dry-run']);
  const tag = opts.tag || 'latest';
  if (!/^[A-Za-z0-9._+-]+$/.test(tag)) {
    throw new CliError('BAD_ARGS', '--tag must be an npm dist-tag or version');
  }

  const packageSpec = `${NPM_PACKAGE_NAME}@${tag}`;
  const npmArgs = ['install', '-g', packageSpec];
  if (opts.registry) npmArgs.push('--registry', opts.registry);
  const command = shellCommand(['npm', ...npmArgs]);
  const data = { package: NPM_PACKAGE_NAME, tag, registry: opts.registry || null, command, dry_run: Boolean(opts['dry-run']) };

  if (opts['dry-run']) {
    printResult(ctx, data, () => `would run: ${command}`);
    return;
  }

  const result = spawnSync('npm', npmArgs, {
    encoding: ctx.json ? 'utf8' : undefined,
    stdio: ctx.json ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
  if (result.error) {
    throw new CliError('UPDATE_FAILED', `npm update command failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = ctx.json
      ? [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      : '';
    throw new CliError('UPDATE_FAILED', output || `npm exited with status ${result.status}`);
  }

  printResult(ctx, data, () => `updated ${packageSpec}`);
}

// ─── hcc uninstall ───────────────────────────────────────────────────────────

async function cmdUninstall(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') {
    helpUninstall();
    return;
  }

  const opts = parseOpts(args, { booleans: ['purge', 'yes'] });
  if (opts.purge && !opts.yes) {
    throw new CliError('CONFIRM_REQUIRED', 'Refusing to purge project data without --yes');
  }

  const lines = [];

  let runtime = null;
  try {
    runtime = readRuntime(ctx);
  } catch (err) {
    if (!(err instanceof CliError && err.code === 'RUNTIME_NOT_RUNNING')) throw err;
  }
  if (runtime) {
    try {
      await runtimeRequest(ctx, 'POST', '/api/runtime/stop', {}, runtime);
      lines.push('runtime stopped');
    } catch (err) {
      if (!(err instanceof CliError && err.code === 'RUNTIME_UNREACHABLE')) throw err;
      try { fs.rmSync(runtimePath(ctx), { force: true }); } catch {}
      lines.push('stale runtime file removed');
    }
  } else {
    lines.push('runtime not running');
  }

  const { uninstallClaudeHooks, uninstallCodexHooks, uninstallShims, uninstallPathEntry } = await loadSetup();
  const claude = uninstallClaudeHooks();
  const codex = uninstallCodexHooks();
  const shims = uninstallShims();
  const pathEntry = uninstallPathEntry();
  lines.push(claude ? 'Claude Code hooks removed' : 'Claude Code hooks not found');
  lines.push(codex ? 'Codex hooks removed' : 'Codex hooks not found');
  lines.push(shims.length ? `shims removed: ${shims.join(', ')}` : 'shims not found');
  lines.push(pathEntryRemovalMessage(pathEntry));

  let guidance = [];
  let purged = false;
  if (opts.purge) {
    guidance = removeGuidanceBlocks(ctx);
    try {
      fs.rmSync(path.join(ctx.root, '.hello-cc'), { recursive: true, force: true });
      purged = true;
      lines.push(`project data removed: ${path.join(ctx.root, '.hello-cc')}`);
    } catch (err) {
      throw new CliError('PURGE_FAILED', `Could not remove .hello-cc: ${err.message}`);
    }
    if (guidance.length) lines.push(`guidance blocks removed: ${guidance.join(', ')}`);
  } else {
    lines.push('project data kept; run hcc uninstall --purge --yes to remove .hello-cc and guidance blocks');
  }

  printResult(ctx, { runtime: Boolean(runtime), claude, codex, shims, path_entry: pathEntry, purge: purged, guidance }, () => lines.join('\n'));
}

// ─── hcc scan ────────────────────────────────────────────────────────────────

async function cmdScan(ctx, args) {
  const opts = parseOpts(args, { booleans: ['register'] });
  const { scanClaudeSessions, scanCodexSessions, scanProcesses } = await loadDiscover();

  const found = [
    ...scanClaudeSessions(),
    ...scanCodexSessions(),
    ...scanProcesses(),
  ].filter((s) => sameResolvedPath(s.hccRoot, ctx.root));

  // Deduplicate by peerId
  const byId = new Map();
  for (const s of found) {
    if (!byId.has(s.peerId)) byId.set(s.peerId, s);
  }
  const results = [...byId.values()];

  if (opts.register && results.length) {
    registerProjectActivity(ctx);
    const db = connect(ctx);
    try {
      for (const s of results) {
        upsertPeer(db, {
          id: s.peerId, kind: s.kind, role: 'peer',
          worktree: s.cwd,
          branch: detectBranch(s.cwd),
          pid: s.pid,
          status: s.status || 'running',
          capabilities: 'detected'
        });
        upsertCanonicalPeerBinding(db, bindingFromDetected(s, s.transport || 'detected'), true);
      }
    } finally {
      db.close();
    }
  }

  printResult(ctx, results, (rows) => {
    if (!rows.length) return 'no active sessions found in this project';
    return table(rows, [
      { label: 'peer',      value: (r) => r.peerId },
      { label: 'kind',      value: (r) => r.kind },
      { label: 'pid',       value: (r) => r.pid || '' },
      { label: 'cwd',       value: (r) => r.cwd },
      { label: 'session',   value: (r) => (r.sessionId || '').slice(0, 16) },
      { label: 'transport', value: (r) => r.transport },
    ]);
  });
}

// ─── hcc tmux ────────────────────────────────────────────────────────────────

function tmuxSessionNameForTarget(target) {
  if (!target) return null;
  try {
    return runTmux(['display-message', '-p', '-t', target, '#{session_name}']).trim() || null;
  } catch {
    return null;
  }
}

function tmuxSessionCreationToken(target) {
  if (!target) return null;
  try {
    return runTmux(['display-message', '-p', '-t', target, '#{session_created}']).trim() || null;
  } catch {
    return null;
  }
}

function tmuxSessionId(target) {
  if (!target) return null;
  try {
    return runTmux(['display-message', '-p', '-t', target, '#{session_id}']).trim() || null;
  } catch {
    return null;
  }
}

function tmuxPaneForTarget(target) {
  if (!target) return null;
  try {
    return runTmux(['display-message', '-p', '-t', target, '#{pane_id}']).trim() || null;
  } catch {
    return null;
  }
}

async function managedRuntimeSessions(ctx) {
  try {
    const runtime = readRuntime(ctx);
    const data = await runtimeRequest(ctx, 'GET', '/api/sessions', null, runtime);
    return data.sessions || [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function strictTmuxClientObservation(sessionName) {
  if (!sessionName) return { state: 'unknown', count: null };
  try {
    const output = runTmux(['list-clients', '-t', sessionName, '-F', '#{client_tty}']);
    return { state: 'known', count: output.trim().split('\n').filter(Boolean).length };
  } catch (error) {
    return { state: 'unknown', count: null, error: error?.message || String(error) };
  }
}

function tmuxAttachmentAuthority(db, peerId, runtimeTarget) {
  const row = db.prepare(`
    SELECT payload
    FROM events
    WHERE type = 'tmux.session.attached'
      AND json_extract(payload, '$.target_peer') = ?
      AND json_extract(payload, '$.pane') = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(peerId, runtimeTarget);
  const payload = parseJsonObject(row?.payload) || {};
  return {
    session: payload.tmux_session || null,
    session_created: payload.tmux_session_created || null,
    session_id: payload.tmux_session_id || null,
    root: payload.hcc_root || null,
    pane: payload.pane || null,
    process_identity: payload.process_identity || null
  };
}

function tmuxGcBindingSubject(ctx, row) {
  const authority = row.authority || {};
  return {
    peer: row.peer || row.id || null,
    status: row.status || null,
    pid: row.pid || null,
    pid_start_token: row.pid_start_token || null,
    pid_command_hash: row.pid_command_hash || null,
    last_seen_at: row.last_seen_at || null,
    transport: row.transport || null,
    runtime_target: row.runtime_target || null,
    runtime_session_id: row.runtime_session_id || null,
    updated_at: row.updated_at || null,
    expected_session: tmuxManagedSessionName(ctx, row.peer || row.id),
    expected_root: ctx.root || null,
    authority: {
      session: authority.session || null,
      session_created: authority.session_created || null,
      session_id: authority.session_id || null,
      root: authority.root || null,
      pane: authority.pane || null,
      process_identity: authority.process_identity || null
    }
  };
}

function tmuxGcBindingSubjectFromDb(db, ctx, peerId) {
  const row = db.prepare(`
    SELECT p.id AS peer, p.status, p.pid, p.pid_start_token,
           p.pid_command_hash, p.last_seen_at,
           b.transport, b.runtime_target, b.runtime_session_id, b.updated_at
    FROM peers p
    JOIN peer_bindings b ON b.peer = p.id
    WHERE p.id = ?
  `).get(peerId);
  if (!row) return null;
  return tmuxGcBindingSubject(ctx, {
    ...row,
    authority: tmuxAttachmentAuthority(db, peerId, row.runtime_target)
  });
}

function sameTmuxGcBindingSubject(planned, current) {
  return Boolean(planned && current) && JSON.stringify(planned) === JSON.stringify(current);
}

const TMUX_GC_CONDITIONAL_TIMEOUT_MS = 5000;

function runBoundedTmuxGcCommand(args) {
  const result = spawnSync('tmux', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input: '',
    timeout: TMUX_GC_CONDITIONAL_TIMEOUT_MS,
    killSignal: 'SIGKILL'
  });
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    throw new CliError(
      timedOut ? 'TMUX_CONDITIONAL_KILL_TIMEOUT' : 'TMUX_ERROR',
      timedOut
        ? `tmux conditional kill exceeded ${TMUX_GC_CONDITIONAL_TIMEOUT_MS}ms`
        : `tmux failed: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim() || `tmux ${args.join(' ')} failed`;
    throw new CliError('TMUX_ERROR', message);
  }
  return result.stdout || '';
}

function casDetachTmuxGcBinding(db, subject, timestamp) {
  return db.prepare(`
    UPDATE peer_bindings
    SET transport = 'detached',
        runtime_target = NULL,
        updated_at = ?
    WHERE peer = ?
      AND transport = 'tmux'
      AND runtime_target = ?
      AND runtime_session_id IS ?
      AND updated_at IS ?
  `).run(
    timestamp,
    subject.peer,
    subject.runtime_target,
    subject.runtime_session_id,
    subject.updated_at
  );
}

function casDetachTmuxGcPeer(db, subject, timestamp) {
  const result = db.prepare(`
    UPDATE peers
    SET status = 'detached',
        last_seen_at = ?
    WHERE id = ?
      AND status IS ?
      AND pid IS ?
      AND pid_start_token IS ?
      AND pid_command_hash IS ?
      AND last_seen_at IS ?
  `).run(
    timestamp,
    subject.peer,
    subject.status,
    subject.pid,
    subject.pid_start_token,
    subject.pid_command_hash,
    subject.last_seen_at
  );
  if (Number(result.changes) !== 1) {
    throw new CliError('TMUX_GC_PEER_CAS_FAILED',
      'tmux GC peer compare-and-swap did not update exactly one row');
  }
  return result;
}

function observeTmuxConditionalTarget(runtimeTarget) {
  let paneInfo = null;
  try { paneInfo = tmuxPaneInfo(runtimeTarget); } catch {}
  const pane = paneInfo?.pane || tmuxPaneForTarget(runtimeTarget);
  const session = tmuxSessionNameForTarget(runtimeTarget);
  const processInspection = inspectProcessIdentity(paneInfo?.pid);
  return {
    session,
    session_created: tmuxSessionCreationToken(session),
    session_id: tmuxSessionId(session),
    root: canonicalRoot(tmuxSessionEnvironmentValue(session, 'HCC_ROOT')),
    pane,
    pane_pid: paneInfo?.pid || null,
    pane_dead: paneInfo?.dead === true,
    process_identity: processInspection.state === 'live' ? processInspection.identity : null,
    process_inspection: processInspection,
    clients: strictTmuxClientObservation(session)
  };
}

function rebindCandidateAuthority(candidate) {
  return {
    session: candidate.expected_session || candidate.session || null,
    session_created: candidate.old_tmux_session_created || null,
    session_id: candidate.old_tmux_session_id || null,
    root: canonicalRoot(candidate.old_hcc_root),
    pane: candidate.old_pane || null,
    process_identity: parseJsonObject(candidate.old_process_identity)
  };
}

function validateTmuxGcDeadRebindEvidence(candidate) {
  const stored = rebindCandidateAuthority(candidate);
  const observed = observeTmuxConditionalTarget(candidate.runtime_target || candidate.session || '');
  return {
    ...validateTmuxGcDeadProcessEvidence(stored, observed),
    stored,
    observed
  };
}

function validateTmuxGcBindingCandidate(subject) {
  const observed = observeTmuxConditionalTarget(subject?.runtime_target || '');
  const ownerEvidence = subject
    ? resolvePeerEvidence({
        peer: subject,
        processes: [processEvidenceFromRow(subject, 'owner')]
      })
    : { state: 'unknown', reason: 'peer_missing' };
  const validationSubject = subject ? {
    ...subject,
    owner_evidence: ownerEvidence,
    expected_root: canonicalRoot(subject.expected_root),
    authority: subject.authority ? {
      ...subject.authority,
      root: canonicalRoot(subject.authority.root)
    } : null
  } : subject;
  return {
    ...validateTmuxGcBindingEvidence(validationSubject, observed),
    stored: subject?.authority || null,
    observed,
    subject
  };
}

function observeRebindEventEvidence(ctx, candidate) {
  const sessionName = candidate.expected_session || candidate.session || null;
  const storedIdentity = parseJsonObject(candidate.old_process_identity);
  const storedRoot = canonicalRoot(candidate.old_hcc_root);
  const storedSessionCreated = candidate.old_tmux_session_created
    ? String(candidate.old_tmux_session_created)
    : null;
  const storedSessionId = candidate.old_tmux_session_id || null;
  const storedPane = candidate.old_pane || null;
  if (!sessionName || !candidate.runtime_target || !storedIdentity || !storedRoot ||
      !storedSessionCreated || !storedSessionId || !storedPane) {
    return { state: 'unknown', reason: 'tmux_event_evidence_incomplete' };
  }

  const target = inspectTmuxTarget(sessionName, candidate.runtime_target);
  const currentSessionCreated = target.session.actual
    ? tmuxSessionCreationToken(target.session.actual)
    : null;
  const currentSessionId = target.session.actual
    ? tmuxSessionId(target.session.actual)
    : null;
  const exactSession = target.session.state === 'live' &&
    target.session.actual === sessionName &&
    currentSessionCreated === storedSessionCreated &&
    currentSessionId === storedSessionId;
  const session = target.session.state === 'dead'
    ? { state: 'dead', expected: `${sessionName}:${storedSessionCreated}`, actual: null }
    : {
        state: exactSession ? 'live' : 'unknown',
        expected: `${sessionName}:${storedSessionCreated}`,
        actual: target.session.actual && currentSessionCreated
          ? `${target.session.actual}:${currentSessionCreated}`
          : null
      };
  const pane = target.pane.actual && target.pane.actual !== storedPane
    ? { state: 'unknown', expected: storedPane, actual: target.pane.actual }
    : { ...target.pane, expected: storedPane };
  const actualRoot = target.session.actual
    ? canonicalRoot(tmuxSessionEnvironmentValue(target.session.actual, 'HCC_ROOT'))
    : null;
  const expectedRoot = canonicalRoot(ctx.root);
  const root = !expectedRoot || !actualRoot
    ? { state: 'unknown', expected: expectedRoot, actual: actualRoot }
    : {
        state: storedRoot === expectedRoot && actualRoot === storedRoot ? 'match' : 'mismatch',
        expected: storedRoot,
        actual: actualRoot
      };
  return resolvePeerEvidence({
    peer: { status: 'working' },
    tmux: {
      managed: true,
      session,
      pane,
      root,
      process: {
        name: 'old-pane',
        storedIdentity,
        current: inspectProcessIdentity(target.paneInfo?.pid || storedIdentity.pid)
      }
    }
  });
}

async function planTmuxGc(ctx, opts) {
  ensureTmuxAvailable({ autoInstall: false });
  const olderThanDays = intOpt(opts, 'older-than', 14);
  if (olderThanDays < 0) throw new CliError('BAD_ARGS', '--older-than must be zero or greater');
  const targetPeer = opts.peer || null;
  const cutoff = now() - olderThanDays * 86400;
  const runtimeSessions = await managedRuntimeSessions(ctx);
  const managedPanes = new Set(runtimeSessions.map((s) => s.pane).filter(Boolean));
  const managedPeers = new Set();
  for (const session of runtimeSessions) {
    if (session.id) managedPeers.add(session.id);
    if (session.peer_id) managedPeers.add(session.peer_id);
  }

  const db = connect(ctx);
  let rows = [];
  let cleanupFailureRows = [];
  try {
    rows = db.prepare(`
      SELECT p.id AS peer, p.kind, p.status, p.pid,
             p.pid_start_token, p.pid_command_hash, p.last_seen_at,
             b.provider, b.provider_session_id, b.provider_session_name,
             b.resume_mode, b.resume_arg, b.command, b.transport,
             b.runtime_session_id, b.runtime_target, b.updated_at
      FROM peer_bindings b
      JOIN peers p ON p.id = b.peer
      WHERE b.transport = 'tmux'
        AND b.runtime_target IS NOT NULL
      ORDER BY b.updated_at ASC, p.last_seen_at ASC, p.id ASC
    `).all();
    rows = rows.map((row) => ({
      ...row,
      authority: tmuxAttachmentAuthority(db, row.peer, row.runtime_target)
    }));
    cleanupFailureRows = db.prepare(`
      SELECT actor AS peer, type, created_at,
             json_extract(payload, '$.old_peer') AS old_peer,
             json_extract(payload, '$.old_tmux_session') AS old_tmux_session,
             json_extract(payload, '$.old_runtime_target') AS old_runtime_target,
             json_extract(payload, '$.new_runtime_target') AS new_runtime_target,
             json_extract(payload, '$.old_pane') AS old_pane,
             json_extract(payload, '$.old_process_identity') AS old_process_identity,
             json_extract(payload, '$.old_hcc_root') AS old_hcc_root,
             json_extract(payload, '$.old_tmux_session_created') AS old_tmux_session_created,
             json_extract(payload, '$.old_tmux_session_id') AS old_tmux_session_id,
             json_extract(payload, '$.reason') AS cleanup_reason
      FROM events
      WHERE type IN ('tmux.session.rebind_cleanup_failed', 'tmux.session.rebind_cleanup_pending')
        AND created_at < ?
      ORDER BY created_at ASC, id ASC
    `).all(cutoff);
  } finally {
    db.close();
  }

  const seenSessions = new Set();
  const candidates = [];
  const skipped = [];
  for (const row of rows) {
    if (targetPeer && row.peer !== targetPeer) continue;
    const bindingSubject = tmuxGcBindingSubject(ctx, row);
    const strictBinding = validateTmuxGcBindingCandidate(bindingSubject);
    const expectedSession = tmuxManagedSessionName(ctx, row.peer);
    const actualSession = tmuxSessionNameForTarget(row.runtime_target);
    const actualPane = tmuxPaneForTarget(row.runtime_target);
    const ageSeconds = Math.max(0, now() - Math.max(Number(row.last_seen_at || 0), Number(row.updated_at || 0)));
    const base = {
      peer: row.peer,
      kind: row.kind || '',
      provider: row.provider,
      session: actualSession || expectedSession,
      expected_session: expectedSession,
      pane: actualPane || row.runtime_target,
      runtime_target: row.runtime_target,
      runtime_session_id: row.runtime_session_id || null,
      last_seen_at: row.last_seen_at || null,
      updated_at: row.updated_at || null,
      age_days: Math.floor(ageSeconds / 86400),
      authority: row.authority
    };
    const skip = (reason, extra = {}) => skipped.push({ ...base, reason, ...extra });

    if (!strictBinding.ok) {
      skip(strictBinding.reason, { evidence_state: 'unknown' });
      continue;
    }

    if (!actualSession || !actualPane) {
      skip('tmux_target_missing');
      continue;
    }
    if (actualSession !== expectedSession) {
      skip('not_hcc_managed_name');
      continue;
    }
    const hccRoot = tmuxSessionEnvironmentValue(actualSession, 'HCC_ROOT');
    if (hccRoot && path.resolve(hccRoot) !== path.resolve(ctx.root)) {
      skip('hcc_root_mismatch', { hcc_root: hccRoot });
      continue;
    }
    if (seenSessions.has(actualSession)) {
      skip('duplicate_db_binding');
      continue;
    }
    seenSessions.add(actualSession);
    if (managedPanes.has(actualPane) || managedPanes.has(row.runtime_target) || managedPeers.has(row.peer) || managedPeers.has(row.runtime_session_id)) {
      skip('runtime_managed');
      continue;
    }
    const clientCount = strictBinding.observed.clients.count;
    if (Math.max(Number(row.last_seen_at || 0), Number(row.updated_at || 0)) >= cutoff) {
      skip('not_old_enough');
      continue;
    }
    candidates.push({
      ...base,
      source: 'binding',
      reason: 'stale_hcc_managed_session',
      hcc_root: hccRoot || null,
      client_count: clientCount,
      evidence_state: 'dead',
      evidence_reason: strictBinding.mode === 'dead_process'
        ? 'tmux_process_confirmed_dead'
        : 'explicit_exited',
      gc_validation_mode: strictBinding.mode,
      gc_validation_subject: bindingSubject
    });
  }
  for (const row of cleanupFailureRows) {
    const rowPeer = row.old_peer || row.peer || '';
    if (targetPeer && rowPeer !== targetPeer) continue;
    const expectedSession = row.old_tmux_session || null;
    const actualSession = tmuxSessionNameForTarget(row.old_runtime_target);
    const actualPane = tmuxPaneForTarget(row.old_runtime_target);
    const ageSeconds = Math.max(0, now() - Number(row.created_at || 0));
    const base = {
      peer: rowPeer,
      kind: '',
      provider: '',
      session: actualSession || expectedSession || '',
      expected_session: expectedSession || '',
      pane: actualPane || row.old_runtime_target || '',
      runtime_target: row.old_runtime_target || null,
      last_seen_at: null,
      updated_at: row.created_at || null,
      age_days: Math.floor(ageSeconds / 86400),
      cleanup_reason: row.cleanup_reason || null,
      old_pane: row.old_pane || null,
      old_process_identity: row.old_process_identity || null,
      old_hcc_root: row.old_hcc_root || null,
      old_tmux_session_created: row.old_tmux_session_created || null,
      old_tmux_session_id: row.old_tmux_session_id || null
    };
    const skip = (reason, extra = {}) => skipped.push({ ...base, reason, ...extra });

    const strictDead = validateTmuxGcDeadRebindEvidence(base);
    if (!strictDead.ok) {
      skip(strictDead.reason, { evidence_state: 'unknown' });
      continue;
    }

    if (!expectedSession || !actualSession || !actualPane) {
      skip('tmux_target_missing');
      continue;
    }
    if (actualSession !== expectedSession) {
      skip('old_runtime_target_changed', { actual_session: actualSession });
      continue;
    }
    const hccRoot = tmuxSessionEnvironmentValue(expectedSession, 'HCC_ROOT');
    if (!isProjectManagedTmuxSession(ctx, expectedSession, hccRoot)) {
      skip('not_hcc_managed_name');
      continue;
    }
    if (rootEvidence(ctx.root, hccRoot).state !== 'match') {
      skip('hcc_root_mismatch', { hcc_root: hccRoot });
      continue;
    }
    if (seenSessions.has(expectedSession)) {
      skip('duplicate_db_binding');
      continue;
    }
    seenSessions.add(expectedSession);
    if (managedPanes.has(actualPane) || managedPanes.has(row.old_runtime_target)) {
      skip('runtime_managed');
      continue;
    }
    const clientCount = strictDead.observed.clients.count;
    candidates.push({
      ...base,
      source: row.type === 'tmux.session.rebind_cleanup_pending' ? 'rebind_cleanup_pending' : 'rebind_cleanup_failed',
      reason: row.type === 'tmux.session.rebind_cleanup_pending'
        ? 'stale_rebind_cleanup_pending_session'
        : 'stale_rebind_cleanup_failed_session',
      session: expectedSession,
      hcc_root: hccRoot || null,
      evidence_state: 'dead',
      evidence_reason: 'tmux_process_confirmed_dead',
      client_count: clientCount
    });
  }
  return { older_than_days: olderThanDays, cutoff, peer: targetPeer, candidates, skipped };
}

function validateTmuxGcCandidate(ctx, candidate, runtimeSessions = [], options = {}) {
  const target = candidate.runtime_target || candidate.session || '';
  const actualSession = tmuxSessionNameForTarget(target);
  const actualPane = tmuxPaneForTarget(target);
  const skip = (reason, extra = {}) => ({ ok: false, reason, ...extra });
  if (!candidate.session || !actualSession || !actualPane) return skip('tmux_target_missing');
  if (actualSession !== candidate.session) {
    return skip('tmux_target_changed', { session: actualSession, pane: actualPane });
  }
  if (candidate.source !== 'binding' && candidate.old_pane !== actualPane) {
    return skip('tmux_pane_changed', { pane: actualPane });
  }
  const hccRoot = tmuxSessionEnvironmentValue(actualSession, 'HCC_ROOT');
  if (!isProjectManagedTmuxSession(ctx, actualSession, hccRoot)) return skip('not_hcc_managed_name');
  if (rootEvidence(ctx.root, hccRoot).state !== 'match') {
    return skip('hcc_root_mismatch', { hcc_root: hccRoot });
  }

  const managedPanes = new Set(runtimeSessions.map((s) => s.pane).filter(Boolean));
  const managedPeers = new Set();
  for (const session of runtimeSessions) {
    if (session.id) managedPeers.add(session.id);
    if (session.peer_id) managedPeers.add(session.peer_id);
  }
  if (managedPanes.has(actualPane) || managedPanes.has(candidate.runtime_target)) {
    return skip('runtime_managed');
  }
  if (candidate.source === 'binding' && (managedPeers.has(candidate.peer) || managedPeers.has(candidate.runtime_session_id))) {
    return skip('runtime_managed');
  }
  const stored = candidate.source === 'binding'
    ? candidate.authority
    : rebindCandidateAuthority(candidate);
  const bindingValidation = candidate.source === 'binding'
    ? options.bindingValidation
    : null;
  const deadValidation = candidate.source !== 'binding' && options.freshEvidence?.state === 'dead'
    ? validateTmuxGcDeadRebindEvidence(candidate)
    : null;
  const validation = bindingValidation || deadValidation || validateTmuxDestructiveEvidence(
    stored, observeTmuxConditionalTarget(target)
  );
  if (!validation.ok) return skip(validation.reason);
  const validationMode = bindingValidation?.mode || (deadValidation ? 'dead_process' : 'live_process');
  const clientCount = validation.observed?.clients?.count;
  return {
    ok: true,
    session: actualSession,
    pane: actualPane,
    hcc_root: hccRoot || null,
    client_count: clientCount,
    stored: validation.stored || stored,
    gc_validation_mode: validationMode,
    dead_process_mode: validationMode === 'dead_process'
  };
}

async function cmdTmux(ctx, args) {
  const sub = args[0];
  if (!sub || wantsHelp(args)) return helpTmux();
  if (sub !== 'gc') throw new CliError('BAD_ARGS', `Unknown tmux command: ${sub}`);

  const opts = parseOpts(args.slice(1), { booleans: ['yes', 'dry-run'] });
  validateOpts('tmux gc', opts, ['peer', 'older-than', 'yes', 'dry-run']);
  if (opts.yes && opts['dry-run']) throw new CliError('BAD_ARGS', 'Use either --yes or --dry-run, not both');

  const dryRun = !opts.yes;
  const actor = resolveCurrentPeer(ctx, {}, 'peer', 'shell').id;
  const plan = await planTmuxGc(ctx, opts);
  const removed = [];
  if (!dryRun) {
    const runtimeSessions = await managedRuntimeSessions(ctx);
    const db = connect(ctx);
    try {
      for (const candidate of plan.candidates) {
        let currentEvidence = null;
        let bindingValidation = null;
        if (candidate.source === 'binding') {
          const currentSubject = tmuxGcBindingSubjectFromDb(db, ctx, candidate.peer);
          if (!sameTmuxGcBindingSubject(candidate.gc_validation_subject, currentSubject)) {
            plan.skipped.push({ ...candidate, reason: 'tmux_binding_subject_changed', revalidated: true });
            continue;
          }
          bindingValidation = validateTmuxGcBindingCandidate(currentSubject);
          if (!bindingValidation.ok || bindingValidation.mode !== candidate.gc_validation_mode) {
            plan.skipped.push({
              ...candidate,
              reason: bindingValidation.ok ? 'tmux_binding_validation_mode_changed' : bindingValidation.reason,
              revalidated: true
            });
            continue;
          }
        } else {
          currentEvidence = observeRebindEventEvidence(ctx, candidate);
        }
        if (candidate.source !== 'binding' && currentEvidence.state !== 'dead') {
          plan.skipped.push({
            ...candidate,
            reason: currentEvidence.state === 'live' ? 'peer_live' : currentEvidence.reason,
            evidence_state: currentEvidence.state,
            revalidated: true
          });
          continue;
        }
        const valid = validateTmuxGcCandidate(ctx, candidate, runtimeSessions, {
          freshEvidence: currentEvidence,
          bindingValidation
        });
        if (!valid.ok) {
          plan.skipped.push({ ...candidate, reason: valid.reason, revalidated: true });
          continue;
        }
        const eventPayload = auditPayload({
          actor,
          target: candidate.peer,
          admin: true,
          peer: candidate.peer,
          tmux_session: candidate.session,
          runtime_target: candidate.runtime_target,
          reason: candidate.reason,
          older_than_days: plan.older_than_days
        });
        if (candidate.source === 'binding') {
          try {
            const t = now();
            finalizeTmuxGcBindingMutation({
              db,
              plannedSubject: candidate.gc_validation_subject,
              readSubject: () => tmuxGcBindingSubjectFromDb(db, ctx, candidate.peer),
              sameSubject: sameTmuxGcBindingSubject,
              conditionalKill: () => conditionalTmuxKill(runBoundedTmuxGcCommand, valid.stored, {
                requireDeadPane: valid.dead_process_mode
              }),
              casBinding: (subject) => casDetachTmuxGcBinding(db, subject, t),
              updatePeer: (subject) => casDetachTmuxGcPeer(db, subject, t)
            });
          } catch (error) {
            plan.skipped.push({
              ...candidate,
              reason: error?.code || 'tmux_gc_binding_finalization_failed',
              error: error?.message || String(error),
              revalidated: true
            });
            continue;
          }
          addEvent(db, 'tmux.session.gc', actor, null, eventPayload);
          removed.push(candidate);
          continue;
        }
        try {
          conditionalTmuxKill(runTmux, valid.stored, {
            requireDeadPane: valid.dead_process_mode
          });
        } catch (error) {
          plan.skipped.push({
            ...candidate,
            reason: error?.code || 'tmux_conditional_kill_failed',
            error: error?.message || String(error),
            revalidated: true
          });
          continue;
        }
        tx(db, () => {
          addEvent(db, 'tmux.session.gc', actor, null, eventPayload);
          removed.push(candidate);
        });
      }
    } finally {
      db.close();
    }
  }

  const data = { dry_run: dryRun, older_than_days: plan.older_than_days, peer: plan.peer, candidates: plan.candidates, skipped: plan.skipped, removed };
  printResult(ctx, data, (r) => {
    const rows = dryRun ? r.candidates : r.removed;
    const title = dryRun
      ? `tmux gc dry-run: ${rows.length} removable hcc-managed session${rows.length === 1 ? '' : 's'}`
      : `tmux gc removed ${rows.length} hcc-managed session${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) return `${title}\n  nothing to clean`;
    return [
      title,
      table(rows, [
        { label: 'peer', value: (row) => row.peer },
        { label: 'session', value: (row) => row.session },
        { label: 'pane', value: (row) => row.pane },
        { label: 'age', value: (row) => `${row.age_days}d` },
        { label: 'reason', value: (row) => row.reason }
      ]),
      dryRun ? 'run again with --yes to delete only these DB-proven hcc-managed tmux sessions' : ''
    ].filter(Boolean).join('\n');
  });
}

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
  const bufsDir = path.join(ctx.root, '.hello-cc', BUFS_DIR_NAME);
  if (!graceActive && !skipBufferFiles) {
    const bufferResult = withBufferDirectoryLease(bufsDir, () => {
      const currentEvidence = collectBufferEvidenceNow
        ? collectBufferEvidenceNow()
        : preparedBufferEvidence || { protectedPaths: protectedBuffers, unknownPaths: new Set(), gcCutoffs: [] };
      const currentPlan = planBufferFiles({
        directories: [bufsDir],
        cutoffMs: bufCutoffMs,
        protectedPaths: currentEvidence.protectedPaths,
        unknownPaths: currentEvidence.unknownPaths,
        evidenceGcCutoffs: [
          ...(preparedBufferEvidence?.gcCutoffs || []),
          ...(currentEvidence.gcCutoffs || [])
        ]
      });
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
    results.buf_files = bufferResult.deleted;
    results.protected_buf_files = bufferResult.protected;
    results.deferred_buf_files = bufferResult.deferred;
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
      }, runtime, { timeoutMs: 5000 });
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
    }, prepared.runtime, { timeoutMs: 5000 });
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

// ─── hcc doctor ─────────────────────────────────────────────────────────────
// Health self-check: SQLite integrity, schema version, WAL/DB size, row counts.
async function cmdDoctor(ctx, args) {
  if (wantsHelp(args)) {
    console.log(`${CLI_NAME} doctor [--json]

Runs a read-only health check on the project database: PRAGMA integrity_check,
schema compatibility, persistent journal mode, DB and WAL file sizes, and
per-table row counts. Exits non-zero for corruption or an unsupported schema.
`);
    return;
  }
  const db = connectReadOnly(ctx);
  let report;
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const quick = db.prepare('PRAGMA quick_check').get();
    const schemaVersion = readSchemaVersion(db);
    const journalMode = db.prepare('PRAGMA journal_mode').get();
    const synchronous = db.prepare('PRAGMA synchronous').get();
    const walAutocheckpoint = db.prepare('PRAGMA wal_autocheckpoint').get();
    const userVersion = db.prepare('PRAGMA user_version').get();
    const fk = db.prepare('PRAGMA foreign_keys').get();
    const counts = {};
    for (const table of ['peers', 'peer_bindings', 'tasks', 'messages', 'message_reads', 'locks', 'handoffs', 'events']) {
      try { counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } catch { counts[table] = null; }
    }
    report = {
      root: ctx.root,
      db: ctx.dbPath,
      integrity_check: integrity ? Object.values(integrity)[0] : null,
      quick_check: quick ? Object.values(quick)[0] : null,
      schema_version: schemaVersion,
      supported_schema_version: DB_SCHEMA_VERSION,
      schema_compatible: schemaVersion > 0 && schemaVersion <= DB_SCHEMA_VERSION,
      migration_required: schemaVersion > 0 && schemaVersion < DB_SCHEMA_VERSION,
      user_version: userVersion ? Object.values(userVersion)[0] : 0,
      journal_mode: journalMode ? Object.values(journalMode)[0] : null,
      diagnostic_connection: {
        synchronous: synchronous ? Object.values(synchronous)[0] : null,
        wal_autocheckpoint: walAutocheckpoint ? Object.values(walAutocheckpoint)[0] : null,
        foreign_keys: fk ? Object.values(fk)[0] : null
      },
      runtime_connection_defaults: {
        synchronous: 'NORMAL',
        wal_autocheckpoint: 1000,
        foreign_keys: true
      },
      row_counts: counts
    };
  } finally {
    db.close();
  }
  // File sizes (best-effort).
  try {
    report.db_size_bytes = fs.statSync(ctx.dbPath).size;
    const walPath = `${ctx.dbPath}-wal`;
    report.wal_size_bytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  } catch {}

  const healthy = report.integrity_check === 'ok' &&
    report.quick_check === 'ok' &&
    report.schema_compatible;
  printResult(ctx, report, (r) => {
    const lines = [
      `doctor (${r.root}):`,
      `  integrity_check: ${r.integrity_check}`,
      `  quick_check:     ${r.quick_check}`,
      `  schema:          ${r.schema_version} (supported ${r.supported_schema_version}; ${r.schema_compatible ? (r.migration_required ? 'migration available' : 'compatible') : 'unsupported'})`,
      `  journal_mode:    ${r.journal_mode}`,
      `  diagnostic connection: synchronous=${r.diagnostic_connection.synchronous}  wal_autocheckpoint=${r.diagnostic_connection.wal_autocheckpoint}  foreign_keys=${r.diagnostic_connection.foreign_keys}`,
      `  db size:         ${r.db_size_bytes ?? '?'} bytes${r.wal_size_bytes ? `  (wal ${r.wal_size_bytes})` : ''}`,
      `  rows:            ` + Object.entries(r.row_counts).map(([k, v]) => `${k}=${v}`).join('  ')
    ];
    return lines.join('\n');
  });
  if (!healthy) process.exitCode = 1;
}

// ─── hcc find-root ───────────────────────────────────────────────────────────
// Used by shim scripts: prints the current hcc project path.

async function cmdFindRoot(ctx, args) {
  const opts = parseOpts(args);
  if (process.env.HCC_ROOT) {
    process.stdout.write(path.resolve(process.env.HCC_ROOT) + '\n');
    return;
  }
  const root = ctx.explicitRoot ? ctx.root : path.resolve(opts.cwd || process.cwd());
  process.stdout.write(root + '\n');
}

// ─── hcc which-real ─────────────────────────────────────────────────────────
// Used by shim scripts: prints the real (non-shim) path for a binary.

async function cmdWhichReal(ctx, args) {
  const name = args[0];
  if (!name) throw new CliError('BAD_ARGS', 'Usage: hcc which-real <binary>');
  const { findRealBinary } = await loadSetup();
  const p = findRealBinary(name);
  if (!p) { process.exitCode = 1; return; }
  process.stdout.write(p + '\n');
}

async function dispatch(ctx, rest) {
  const command = rest[0];
  const args = rest.slice(1);
  if (!command || command === '--help' || command === '-h' || command === 'help') return helpMain();
  if (command === '--version' || command === 'version') return console.log(VERSION);
  if (command === 'up') return cmdUp(ctx, args);
  if (command === 'down') return cmdDown(ctx, args);
  if (command === 'update') return cmdUpdate(ctx, args);
  if (command === 'uninstall') return cmdUninstall(ctx, args);
  if (command === 'init') return cmdInit(ctx, args);
  if (command === 'register') return cmdRegister(ctx, args);
  if (command === 'join') return cmdJoin(ctx, args);
  if (command === 'env') return cmdEnv(ctx, args);
  if (command === 'heartbeat') return cmdHeartbeat(ctx, args);
  if (command === 'peers') return cmdPeers(ctx, args);
  if (command === 'status') return cmdStatus(ctx, args);
  if (command === 'state') return cmdState(ctx, args);
  if (command === 'prompt') return cmdPrompt(ctx, args);
  if (command === 'run') return cmdRun(ctx, args);
  if (command === 'peer') return cmdPeer(ctx, args);
  if (command === 'tmux') return cmdTmux(ctx, args);
  if (command === 'inject') return cmdInject(ctx, args);
  if (command === 'ask') return cmdAsk(ctx, args);
  if (command === 'broadcast') return cmdBroadcast(ctx, args);
  if (command === 'task') return cmdTask(ctx, args);
  if (command === 'team') return cmdTeam(ctx, args);
  if (command === 'msg') return cmdMsg(ctx, args);
  if (command === 'lock') return cmdLock(ctx, args);
  if (command === 'handoff') return cmdHandoff(ctx, args);
  if (command === 'event') return cmdEvent(ctx, args);
  if (command === 'web') return cmdWeb(ctx, args);
  if (command === 'hook') return cmdHook(ctx, args);
  if (command === 'install-hooks') return cmdInstallHooks(ctx, args);
  if (command === 'shim') return cmdShim(ctx, args);
  if (command === 'setup') return cmdSetup(ctx, args);
  if (command === 'scan') return cmdScan(ctx, args);
  if (command === 'doctor') return cmdDoctor(ctx, args);
  if (command === 'gc') return cmdGc(ctx, args);
  if (command === 'find-root') return cmdFindRoot(ctx, args);
  if (command === 'which-real') return cmdWhichReal(ctx, args);
  throw new CliError('BAD_ARGS', `Unknown command: ${command}`);
}

async function main() {
  const { global, rest } = splitGlobalArgs(process.argv.slice(2));
  const ctx = createCliContext(global, { detectRoot });
  try {
    await dispatch(ctx, rest);
  } catch (err) {
    const publicFailure = publicCliFailure(err);
    if (publicFailure) {
      const publicError = publicFailure.error;
      if (ctx.json) {
        console.error(formatJson(false, redactSecrets({
          code: publicError.code,
          message: publicError.message,
          ...publicError.extra,
          ...(publicFailure.cleanupFailed ? { cleanup_failed: true } : {})
        })));
      } else {
        console.error(redactedLogText(`${CLI_NAME}: ${publicError.message}`));
        if (Object.keys(publicError.extra).length) console.error(redactedLogText(publicError.extra));
        if (publicFailure.cleanupFailed) {
          console.error(`${CLI_NAME}: an additional internal cleanup failed`);
        }
      }
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main();
