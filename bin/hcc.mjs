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
import { createEventHelpers } from '../lib/db/events.mjs';
import { createConnectionHelpers } from '../lib/db/connection.mjs';
import { createPeerHelpers } from '../lib/core/peers/peer-helpers.mjs';
import { createCookieAuth } from '../lib/web/cookie-auth.mjs';
import { createSessionSerialize } from '../lib/web/session-serialize.mjs';
import { createTmuxStream } from '../lib/web/tmux-stream.mjs';
import { createMsgCommands } from '../lib/cli/commands/msg.mjs';
import { createCoordinationCommands } from '../lib/cli/commands/coordination.mjs';
import { createLockCommands } from '../lib/cli/commands/lock.mjs';
import { createTaskCommands } from '../lib/cli/commands/task.mjs';
import { createDoctorCommand } from '../lib/cli/commands/doctor.mjs';
import { createQueryCommands } from '../lib/cli/commands/query.mjs';
import { createLifecycleCommands } from '../lib/cli/commands/lifecycle.mjs';
import { createTeamCommands } from '../lib/cli/commands/team.mjs';
import { createMiscCommands } from '../lib/cli/commands/misc.mjs';
import { createInstallCommands } from '../lib/cli/commands/install.mjs';
import { createHookCommand } from '../lib/cli/commands/hook.mjs';
import { createPeerCommands } from '../lib/cli/commands/peer.mjs';
import { createRunCommands } from '../lib/cli/commands/run.mjs';
import { createTmuxCommands } from '../lib/cli/commands/tmux.mjs';
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

const { addEvent, auditPayload, requestActorPeer, requestSource } = createEventHelpers({ now });
const {
  dedupePeerBindings,
  findProviderSessionBinding,
  upsertCanonicalPeerBinding
} = createPeerBindingStore({ now, addEvent });

const { connect, connectReadOnly, migrateRegisteredProjectDbs } = createConnectionHelpers({ now, dedupePeerBindings, redactedLogText });
const { upsertPeer, touchPeer, touchCurrentPeer } = createPeerHelpers({ now, addEvent, liveProcessIdentity, detectBranch, registerProjectActivity, upsertCanonicalPeerBinding, autoPeerKind, autoPeerSessionId, autoPeerResumeId, autoPeerDefaults, autoPeerBasis, providerSessionParts });



const {
  ackMessage,
  getMessage,
  queryInbox,
  queryMessageThread,
  queryTimelineMessages,
  sendMessage
} = createMessageStore({ now, addEvent });
const { cmdMsg } = createMsgCommands({
  connect, now, tx, iso, touchCurrentPeer, resolveCurrentPeer, registerProjectActivity,
  parseOpts, intOpt, required, wantsHelp, helpMsg, printResult, table, sleep, CliError,
  ackMessage, getMessage, queryInbox, queryMessageThread, sendMessage
});
const { cmdHandoff, cmdEvent, cmdHeartbeat, cmdAsk, cmdBroadcast, cmdInject, injectPeer } = createCoordinationCommands({
  connect, now, tx, iso, tx, addEvent, auditPayload, touchCurrentPeer, resolveCurrentPeer, registerProjectActivity,
  parseOpts, intOpt, required, positiveSafeIntOpt, wantsHelp,
  helpHandoff, helpEvent, helpAsk, helpBroadcast, helpInject,
  printResult, table, CliError, DEFAULT_LOCK_TTL, leaseDeadline,
  sendMessage, readRuntime, runtimeRequest,
  observeLockClockSafety, peerEvidenceFromDb, renewOwnedLocks,
  normalizeListText, changedFiles
});
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
const { cmdTask, notifyTaskOwnerConflict } = createTaskCommands({
  connect, now, tx, tx, addEvent, auditPayload, touchCurrentPeer, resolveCurrentPeer,
  parseOpts, intOpt, required, positiveIntOpt, parseTaskIds, wantsHelp, helpTask,
  printResult, table, CliError, ACTIVE_PEER_TTL,
  sendMessage, readRuntime, runtimeRequest, injectPeer,
  queryOpenTasks, claimNextTasksForPeer, claimTaskRowsForPeer,
  takeOverTaskForPeer, assertTaskOwnerForMutation,
  annotateTasksWithLiveness, taskOwnerStateText, taskRowsText,
  observePeerEvidence, clockGraceSuppressed, readClockGraceUntil
});
const { cmdDoctor } = createDoctorCommand({ connectReadOnly, readSchemaVersion, DB_SCHEMA_VERSION, CLI_NAME });
const { cmdLock } = createLockCommands({
  connect, now, tx, iso, tx, addEvent, touchCurrentPeer, resolveCurrentPeer,
  parseOpts, intOpt, required, positiveSafeIntOpt, wantsHelp, helpLock,
  printResult, table, CliError, DEFAULT_LOCK_TTL, leaseDeadline,
  scopedLockResource, lockLabel, lockScope, lockBaseResource, locksConflict,
  clockGraceSuppressed, readClockGraceUntil, clockSafetyUnavailable,
  captureLockAcquireSubject, sameLockAcquireSubject,
  observeLockOwnerEvidence, observePeerEvidence,
  prepareLockClockObservation, runOptimisticEvidenceMutation,
  assertTaskOwnerForMutation, notifyTaskOwnerConflict
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

const { cmdPeers, cmdStatus, cmdState, cmdPrompt } = createQueryCommands({
  connect, now, tx, printResult, table, CliError, ACTIVE_PEER_TTL,
  parseOpts, required, wantsHelp, helpState,
  resolveTargetPeer, resolveCurrentPeer,
  statusSummary, statusSnapshot, normalizeStateResources,
  renderStatusSummary, renderStateSummary,
  observePeerEvidence, classifyPeerActivity,
  clockGraceSuppressed, readClockGraceUntil, commandPath
});

const { cmdInit, cmdRegister, cmdEnv, cmdJoin } = createLifecycleCommands({
  connect, now, tx, addEvent, printResult, CliError, parseOpts, intOpt,
  registerProjectActivity, resolveCurrentPeer, resolveTargetPeer,
  upsertPeer, upsertCanonicalPeerBinding, storedPeerIdentity, detectBranch,
  writeGuidance, helpEnv, helpJoin, shellExports, path, process
});

const { cmdTeam } = createTeamCommands({
  connect, now, tx, tx, addEvent, touchCurrentPeer, resolveCurrentPeer,
  parseOpts, intOpt, wantsHelp, helpTeam, printResult, CliError,
  CLI_NAME, sendMessage,
  taskById, teamChildren, teamSummary,
  inferTeamItems, assignTeamWorkers, expandTeamWorkers,
  shellQuoteArg
});

const { cmdDown, cmdFindRoot, cmdWhichReal } = createMiscCommands({
  path, fs, process, CliError, parseOpts, printResult,
  readRuntime, runtimeRequest, runtimePath, globalRuntimePath,
  reclaimRuntimePointerFiles, helpDown, loadSetup,
  PRODUCT_NAME
});

const { cmdInstallHooks, cmdShim, cmdSetup, cmdUpdate, cmdUninstall } = createInstallCommands({
  path, fs, process, CliError, parseOpts, validateOpts, wantsHelp,
  printResult, commandPath, connect, readRuntime, runtimeRequest,
  runtimePath, globalRuntimePath, PRODUCT_NAME, VERSION, NPM_PACKAGE_NAME,
  helpInstallHooks, helpShim, helpUninstall, helpUpdate,
  loadSetup, shellCommand,

  sameResolvedPath, writeGuidance, removeGuidanceBlocks,

});

const { cmdHook } = createHookCommand({
  connect, now, tx, addEvent, auditPayload,
  registerProjectActivity, touchCurrentPeer,
  liveProcessIdentity, detectBranch,
  resolveCurrentPeer, providerSessionPeerId, providerSessionParts,
  readAncestorCliInfo, latestHookProviderSession, formatHookEventName,
  upsertPeer, upsertCanonicalPeerBinding, storedPeerIdentity,
  autoPeerKind, autoPeerBasis, autoPeerProviderSession,
  observeLockClockSafety, observePeerEvidence,
  buildHookCoordinationContext, ackMessages,
  reconcileRunningPeerBindings, inspectProviderProcess,
  resumeIdFromArgs, shortHash, renewOwnedLocks, refreshHookOwnerIdentity,
  path, fs, process, CliError
});

const { cmdPeer } = createPeerCommands({
  connect, now, tx, addEvent, auditPayload, printResult, CliError, parseOpts,
  detectBranch, buildPeerCommand, childSessionEnv, inferPeerKind,
  findProviderSessionBinding, bindingHasRuntime,
  resolveCurrentPeer, helpPeer, wantsHelp,
  runtimeRequest, readRuntime,
  upsertPeer, upsertCanonicalPeerBinding, storedPeerIdentity,
  path, process, Map, table
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

const { cmdRun } = createRunCommands({
  connect, now, addEvent, auditPayload,
  upsertPeer, upsertCanonicalPeerBinding,
  helpRun, redactedLogText, CLI_NAME, BUFS_DIR_NAME
});

const {
  cmdScan, cmdTmux,
  tmuxSessionCreationToken, tmuxSessionId, tmuxPaneForTarget,
  strictTmuxClientObservation, tmuxAttachmentAuthority
} = createTmuxCommands({
  connect, now, addEvent, auditPayload,
  upsertPeer, upsertCanonicalPeerBinding,
  loadDiscover, sameResolvedPath,
  helpTmux,
  canonicalRoot, rootEvidence, processEvidenceFromRow,
  inspectTmuxTarget, isProjectManagedTmuxSession
});

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
  const bufferGcPlanStore = createBufferGcPlanStore();
  const bufferUnknownTracker = new Map();
  const bufferDirectoriesByProject = new Map();
  const {
    webSessions,
    parseCookieSid, closeWebSession, pruneWebSessions,
    issueSession, sessionCookieHeader, expiredSessionCookieHeader,
    cookieSessionRecord, cookieSessionOk, cookieSocketValid, webAuthMode
  } = createCookieAuth({
    now, ttlSec: WEB_SESSION_TTL_SEC, maxSessions: MAX_WEB_SESSIONS,
    requestIsSecure, trustProxy, proxyOrigin, authOk, token
  });
  const webSessionPruner = setInterval(pruneWebSessions, 60000);
  webSessionPruner.unref?.();
  ensureTmuxAvailable({ autoInstall: false });
  const ptyModule = await import('node-pty');
  const { WebSocketServer } = await import('ws');
  const pty = ptyModule.default || ptyModule;
  const sessions = new Map();

  const {
    sessionKey, sessionsForProject,
    resolveSessionPeerId, sessionBindingForSerialize,
    serializeBindingSummary, serializeSession,
    broadcast, hasOpenClients, closeSessionClients
  } = createSessionSerialize({ sessions, cookieSocketValid, ctx, sameResolvedPath });
  const { cursorEscape, tmuxSnapshot, refreshTmuxSnapshot, scheduleTmuxReplace, startTmuxReplacePoller, startTmuxStream, stopTmuxStream } = createTmuxStream({ broadcast, now, refreshPeerIoHeartbeat, bufferDirectory, withBufferDirectoryLease, shellQuoteArg, ctx });
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
    const headerToken = req.headers["x-hcc-session-token"];
    return String(input.action_token || input.actionToken || headerToken || "").trim();
  }

  function resolveWebActionSession(projectCtx, peer, input, req) {
    const db = connectWebProject(projectCtx);
    let session;
    try {
      session = getSession(projectCtx, peer, db);
    } finally {
      db.close();
    }
    if (!session || session.status !== "running") {
      throw new CliError("PEER_IDENTITY_REQUIRED", "Web peer action requires a running managed session for " + peer, { peer });
    }
    const actorPeer = session.peerId || peer;
    if (actorPeer !== peer && session.id !== peer) {
      throw new CliError("PEER_IDENTITY_MISMATCH", "Web peer action target " + peer + " does not match managed session " + actorPeer, {
        peer, actor_peer: actorPeer, session_id: session.id
      });
    }
    const provided = readActionToken(input, req);
    const authorized = Boolean(provided) && [...(session.actionTokens || [])]
      .some((candidate) => tokenMatches(provided, candidate));
    if (!authorized) {
      throw new CliError("PEER_IDENTITY_REQUIRED", "Web peer action for " + peer + " requires the managed session action token", { peer });
    }
    return actorPeer;
  }

  function knownPeerIds(projectCtx) {
    const db = connectWebProject(projectCtx);
    try {
      return db.prepare("SELECT id FROM peers").all().map((row) => row.id);
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

  // bg-04: watch for new external sessions appearing in EVERY registered
  // project's bufsDir, not just the primary. New projects discovered by
  // scanExternalSessions get their own watcher on the next scan tick.
  const bufsWatchers = new Map();
  function ensureBufsWatchers() {
    for (const projectCtx of runtimeProjectContexts()) {
      const root = path.resolve(projectCtx.root);
      if (bufsWatchers.has(root)) continue;
      const directory = bufferDirectory(projectCtx);
      try {
        const watcher = fs.watch(directory, { persistent: false }, (event, filename) => {
          if (filename?.endsWith('.out')) {
            setTimeout(() => adoptExternalSession(path.basename(filename, '.out'), projectCtx, directory), 300);
          }
        });
        watcher.on('error', (err) => {
          console.error(redactedLogText(`[${new Date().toISOString()}] bufs watcher error for ${root}: ${err?.message || err}`));
        });
        bufsWatchers.set(root, watcher);
      } catch {}
    }
  }
  ensureBufsWatchers();
  const bufsWatcherSyncPoller = setInterval(ensureBufsWatchers, 5000);

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
    try { for (const w of bufsWatchers.values()) w.close(); } catch {}
    clearInterval(bufsWatcherSyncPoller);
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
