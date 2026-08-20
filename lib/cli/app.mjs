// CLI application composition, extracted from bin/hcc.mjs.
// This module owns the dependency graph: constants, lazy loaders, shared
// helpers, every command factory, dispatch, and main().


import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';

import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { CliError } from '../shared/errors.mjs';
import { publicCliFailure } from '../shared/errors.mjs';
import { redactSecrets } from '../shared/redact.mjs';
import { clockGraceSuppressed, readClockGraceUntil } from '../shared/clock-grace.mjs';
import { clockSafetyUnavailable, observeClockSafety, observeClockSafetyInTransaction } from '../core/coordination/clock-safety.mjs';
import { DB_SCHEMA_VERSION, readSchemaVersion, tx } from '../db/schema.mjs';

import { createEventHelpers } from '../db/events.mjs';
import { createConnectionHelpers } from '../db/connection.mjs';
import { createPeerHelpers } from '../core/peers/peer-helpers.mjs';

import { createMsgCommands } from '../cli/commands/msg.mjs';
import { createCoordinationCommands } from '../cli/commands/coordination.mjs';
import { createLockCommands } from '../cli/commands/lock.mjs';
import { createTaskCommands } from '../cli/commands/task.mjs';
import { createDoctorCommand } from '../cli/commands/doctor.mjs';
import { createQueryCommands } from '../cli/commands/query.mjs';
import { createLifecycleCommands } from '../cli/commands/lifecycle.mjs';
import { createTeamCommands } from '../cli/commands/team.mjs';
import { createMiscCommands } from '../cli/commands/misc.mjs';
import { createInstallCommands } from '../cli/commands/install.mjs';
import { createHookCommand } from '../cli/commands/hook.mjs';
import { createPeerCommands } from '../cli/commands/peer.mjs';
import { createRunCommands } from '../cli/commands/run.mjs';
import { createTmuxCommands } from '../cli/commands/tmux.mjs';
import { createGcCommands } from '../cli/commands/gc.mjs';
import { createUpCommand } from '../cli/commands/up.mjs';
import { createEvidenceRuntime } from '../core/peers/evidence-runtime.mjs';
import { createWebStartup } from '../web/startup.mjs';
import { createWebRuntime } from '../web/runtime-main.mjs';

import { intOpt, parseOpts, positiveSafeIntOpt, required, splitGlobalArgs, validateOpts, wantsHelp } from '../cli-args.mjs';
import { leaseDeadline, renewOwnedLocks } from '../core/coordination/lease-renewal.mjs';
import { commandPath, createContext as createCliContext, shellCommand as shellCommandWithQuote } from '../cli-runtime.mjs';
import { createCoordinationState } from '../coordination-state.mjs';
import { formatJson, printResult, shellExports, shellQuoteArg, table } from '../format.mjs';
import { readPackageMeta } from '../package-meta.mjs';
import { removeGuidanceBlocks as removeGuidanceBlocksForRoot, writeGuidance as writeGuidanceForRoot } from '../guidance.mjs';
import { globalRuntimePath, runtimePath } from '../runtime/paths.mjs';
import { readRuntime, reclaimRuntimePointerFiles } from '../runtime/state.mjs';
import { waitForProcessIdentityExit } from '../process/identity.mjs';

import { runtimeRequest } from '../runtime/client.mjs';

import { detectBranch, detectRoot } from '../project-context.mjs';
import { changedFiles, normalizeListText } from '../handoff.mjs';
import { annotateTasksWithLiveness, taskOwnerStateText } from '../core/peers/liveness.mjs';
import { normalizeStateResources, renderStateSummary, renderStatusSummary } from '../ui/state-render.mjs';
import { createHelpFunctions } from '../ui/help.mjs';
import { createMessageStore } from '../core/coordination/messages.mjs';
import { createTaskStore } from '../core/coordination/tasks.mjs';
import { classifyPeerActivity } from '../core/peers/evidence.mjs';
import { refreshHookOwnerIdentity } from '../core/peers/hook-owner.mjs';

import { parseTaskIds, positiveIntOpt, taskRowsText } from '../task-cli.mjs';
import { childSessionEnv } from '../core/sessions/launch.mjs';

import { sendHttp } from '../web/http.mjs';
import { createWebPeerActions } from '../web/peer-actions.mjs';

import * as webUiTemplate from '../web/ui-template.mjs';
import { buildPeerCommand, inferPeerKind } from '../integrations/providers.mjs';
import { providerSessionParts, providerSessionPeerId } from '../core/peers/session.mjs';
import { bindingHasRuntime } from '../core/peers/bindings.mjs';
import { reconcileRunningPeerBindings } from '../core/peers/reconcile.mjs';
import { createPeerBindingStore } from '../db/stores/peers.mjs';

import { lockBaseResource, lockLabel, lockScope, locksConflict, scopedLockResource } from '../core/coordination/locks.mjs';
import { captureLockAcquireSubject, observeLockOwnerEvidence, sameLockAcquireSubject } from '../core/coordination/lock-evidence.mjs';
import { runOptimisticEvidenceMutation } from '../core/coordination/optimistic-evidence.mjs';

import { assignTeamWorkers, expandTeamWorkers, inferTeamItems } from '../core/coordination/teams.mjs';
import { autoPeerBasis, autoPeerKind, autoPeerProviderSession, autoPeerResumeId, autoPeerSessionId, readAncestorCliInfo, resolveCurrentPeer, resumeIdFromArgs, shortHash } from '../integrations/peers/identity.mjs';
import { inspectProviderProcess } from '../integrations/peers/processes.mjs';
import { registerProjectActivity } from '../runtime/projects.mjs';

// Lazy-load lib modules (they may import node-pty which needs to be optional)
const _libDir = path.resolve(fileURLToPath(import.meta.url), '..', '..');
async function loadDiscover() { return import(path.join(_libDir, 'discover.mjs')); }
async function loadSetup()    { return import(path.join(_libDir, 'setup.mjs')); }

const PACKAGE_META = readPackageMeta(path.resolve(fileURLToPath(import.meta.url), '..', '..', '..'));
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
  isProjectManagedTmuxSession, liveProcessIdentity, storedPeerIdentity,
  processEvidenceFromRow, canonicalRoot, rootEvidence, tmuxTargetMissing,
  inspectTmuxTarget, observePeerEvidence, peerEvidenceFromDb,
  providerOwnerEvidenceFromDb, peerMutationSubject, mutatePeerWithEvidence,
  mutateConfirmedDeadPeer, observeClockSafetyOrThrow,
  observeClockSafetyInTransactionOrThrow, prepareLockClockObservation,
  observeLockClockSafety, observeTaskTakeoverClockSafety
} = createEvidenceRuntime({ now });

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
  waitForProcessIdentityExit,
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
  resolveCurrentPeer, helpPeer, wantsHelp, CLI_NAME, cmdPeers,
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

const {
  cmdGc, runGc, bufferDirectory,
  observeGcClockSafety, previewGcClockSafety, runManualGc
} = createGcCommands({
  connect, now, helpGc,
  UNKNOWN_EVIDENCE_GRACE_SEC, BUFS_DIR_NAME,
  peerMutationSubject, mutatePeerWithEvidence,
  observeClockSafetyInTransactionOrThrow, observePeerEvidence
});

const { cmdUp, prepareLocalBus } = createUpCommand({
  connect, helpUp, PRODUCT_NAME,
  loadSetup, loadDiscover,
  writeGuidance, sameResolvedPath,
  upsertPeer, upsertCanonicalPeerBinding
});

const {
  startWebBackground, assertWebTokenForHost, webExposureWarning,
  webSocketOriginAllowed, proxyOriginForOpts
} = createWebStartup({
  splitProcessArgs, sameResolvedPath,
  redactedLogText, CLI_NAME, PRODUCT_NAME, now,
  prepareLocalBus
});

const { cmdWeb } = createWebRuntime({
  // constants
  ACTIVE_PEER_TTL, BUFS_DIR_NAME, CLI_NAME, DEFAULT_LOCK_TTL,
  DETECTED_PEER_MAX_AGE, PRODUCT_NAME, UNKNOWN_EVIDENCE_GRACE_SEC, VERSION,
  // db helpers
  connect, addEvent, auditPayload,
  // peer helpers
  touchPeer, upsertPeer, upsertCanonicalPeerBinding,
  // coordination state
  assertTaskOwnerForMutation, claimNextTasksForPeer,
  queryInbox, queryOpenTasks, queryTimelineMessages,
  requestActorPeer, requestSource, sendMessage,
  statusSnapshot, statusSummary, takeOverTaskForPeer,
  webPeerAction,
  // evidence runtime
  canonicalRoot, isProjectManagedTmuxSession, liveProcessIdentity,
  mutatePeerWithEvidence, observeClockSafetyOrThrow, observePeerEvidence,
  peerEvidenceFromDb, providerOwnerEvidenceFromDb, rootEvidence,
  // tmux evidence helpers
  strictTmuxClientObservation, tmuxAttachmentAuthority,
  tmuxPaneForTarget, tmuxSessionCreationToken, tmuxSessionId,
  // gc helpers
  bufferDirectory, runGc,
  // web startup helpers
  assertWebTokenForHost, proxyOriginForOpts, startWebBackground,
  webExposureWarning, webSocketOriginAllowed,
  // local bus
  prepareLocalBus,
  // misc bin-local helpers
  findProviderSessionBinding, helpWeb, latestHookProviderSession,
  now, redactedLogText, renderWebIndex, renderWebLogin,
  sameResolvedPath, sendWebHtml, shellCommand, webErrorStatus
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

export async function runCli() {
  await main();
}
