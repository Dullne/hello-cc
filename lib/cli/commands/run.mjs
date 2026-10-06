// Run command extracted from bin/hcc.mjs.
// hcc run: wrap a child process as a tracked peer; the web-managed variant
// bridges an external PTY into shared buffer files for hcc web streaming.

import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CliError } from '../../shared/errors.mjs';
import { assertPinnedSessionLaunchAllowed, preparePinnedCwdLaunch } from '../../process/pinned-cwd.mjs';
import { assertSelectedCwdSnapshot, captureSelectedCwdSnapshot } from '../../process/selected-cwd-identity.mjs';
import { tx } from '../../db/schema.mjs';
import { parseOpts, validateOpts } from '../../cli-args.mjs';
import { runtimeProcessIdentity } from '../../runtime/state.mjs';
import { ensurePrivateProjectBufferDirectory } from '../../runtime/project-path.mjs';
import { withBufferDirectoryLease } from '../../runtime/buffer-directory-lease.mjs';
import {
  externalBufferEvidence,
  externalBufferOwnerKey,
  readExternalBufferMetadata
} from '../../runtime/buffer-evidence.mjs';
import { inspectProcessIdentity } from '../../process/identity.mjs';
import { resolvePeerEvidence } from '../../core/peers/evidence.mjs';
import {
  capturePtyStartupEvidence,
  installPtyTerminationHandlers,
  ptyStartupFailureDisposition,
  ptyTerminationSignal,
  stopPtyAfterStartupFailure,
  trackPtyExit
} from '../../process/pty-lifecycle.mjs';
import { detectBranch } from '../../project-context.mjs';
import { childSessionEnv } from '../../core/sessions/launch.mjs';
import { assertCodexTerminalLaunch, CODEX_SESSION_ORIGIN_ENV } from '../../core/sessions/codex-thread-root.mjs';
import {
  bindingFromRun,
  defaultSessionCommand
} from '../../integrations/providers.mjs';
import { registerProjectActivity } from '../../runtime/projects.mjs';
import { resolveCurrentPeer } from '../../integrations/peers/identity.mjs';

export function createRunCommands(deps) {
  const {
    connect, now, addEvent, auditPayload,
    upsertPeer, upsertCanonicalPeerBinding,
    helpRun, redactedLogText, CLI_NAME, BUFS_DIR_NAME,
    spawnProcess = spawn,
    loadPty = () => import('node-pty')
  } = deps;

  const assertRunDirectories = (ctx, cwdIdentity = null) => {
    if (ctx.initialRootIdentity) assertSelectedCwdSnapshot(ctx.initialRootIdentity);
    if (cwdIdentity && cwdIdentity !== ctx.initialRootIdentity) assertSelectedCwdSnapshot(cwdIdentity);
  };

async function cmdRun(ctx, args) {
  if (args[0] === '--help' || args[0] === '-h') return helpRun();
  // A rollout hold must not publish a running peer before the launch is
  // refused. Existing sessions remain untouched.
  assertPinnedSessionLaunchAllowed();
  assertRunDirectories(ctx);
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
  const expectedCwdIdentity = ctx.initialRootIdentity && cwd === path.resolve(ctx.root)
    ? ctx.initialRootIdentity : captureSelectedCwdSnapshot(cwd);
  assertRunDirectories(ctx, expectedCwdIdentity);
  const command = cmdArgs.length ? cmdArgs[0] : defaultSessionCommand(kind);
  const commandArgs = cmdArgs.length ? cmdArgs.slice(1) : [];
  const binding = bindingFromRun(id, kind, command, commandArgs, 'hcc-run');
  const originBinding = kind === 'codex' && binding.resume_mode === 'command' &&
    path.basename(command) === 'codex' && commandArgs.length === 0
    ? { ...binding, resume_mode: 'new' } : binding;
  const validationDb = connect(ctx);
  let codexOrigin;
  try {
    codexOrigin = assertCodexTerminalLaunch(validationDb, originBinding, {
      command: binding.command, argv: [command, ...commandArgs], root: ctx.root,
      rootIdentity: ctx.initialRootIdentity, cwd, cwdIdentity: expectedCwdIdentity });
  } finally { validationDb.close(); }

  if (process.env.HCC_INTERNAL_WEB_MANAGED_RUN === '1') {
    return cmdRunWebManaged(ctx, {
      id,
      kind,
      role,
      cwd,
      expectedCwdIdentity,
      command,
      commandArgs,
      binding,
      codexOrigin,
      force: Boolean(opts.force)
    });
  }

  const launch = preparePinnedCwdLaunch(cwd, command, commandArgs, {
    expectedIdentity: expectedCwdIdentity,
    env: childSessionEnv({ HCC_PEER: id, HCC_ROOT: ctx.root, HCC_DB: ctx.dbPath,
      ...(codexOrigin ? { [CODEX_SESSION_ORIGIN_ENV]: codexOrigin } : {}) },
    process.env, { rootIdentity: ctx.initialRootIdentity })
  });
  try {
    assertRunDirectories(ctx, expectedCwdIdentity);
    registerProjectActivity(ctx);
  const db = connect(ctx);
  const wrapperIdentity = runtimeProcessIdentity();
  try {
    let registered = false;
    for (let attempt = 0; attempt < 2 && !registered; attempt += 1) {
      const previous = db.prepare('SELECT * FROM peers WHERE id = ?').get(id) || null;
      const evidence = previous ? resolvePeerEvidence({
        peer: previous,
        processes: [{
          storedIdentity: {
            pid: Number(previous.pid),
            startToken: previous.pid_start_token,
            commandHash: previous.pid_command_hash
          },
          current: inspectProcessIdentity(previous.pid)
        }]
      }) : null;
      registered = tx(db, () => {
        assertRunDirectories(ctx, expectedCwdIdentity);
        const current = db.prepare('SELECT * FROM peers WHERE id = ?').get(id) || null;
        if (JSON.stringify(current) !== JSON.stringify(previous)) return false;
        if (previous && evidence.state !== 'dead' && (
          previous.pid || ['running', 'working', 'busy', 'starting', 'blocked', 'detached'].includes(previous.status)
        )) {
          throw new CliError('PEER_SESSION_EXISTS', `Peer ${id} already has a live or unresolved owner`, {
            peer: id,
            evidence_state: evidence.state
          });
        }
        upsertPeer(db, {
          id, kind, role,
          worktree: cwd,
          branch: detectBranch(cwd),
          pid: process.pid,
          processIdentity: wrapperIdentity,
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
        return true;
      });
    }
    if (!registered) {
      throw new CliError('SUBJECT_CHANGED', `Peer ${id} changed while its owner was being observed; retry`, {
        peer: id,
        retryable: true
      });
    }
  } finally {
    db.close();
  }
  console.error(redactedLogText(`${CLI_NAME}: running ${id} (${kind}, ${role}) -> ${command} ${commandArgs.join(' ')}`.trim()));
  let exitCode;
  let child;
  try {
    child = spawnProcess(launch.command, launch.args, {
      cwd: launch.cwd, env: launch.env, stdio: 'inherit'
    });
  } catch (err) {
    // A synchronous spawn rejection did not create a child. Retain the audit
    // trail, but close this wrapper's owned peer below instead of leaving it
    // falsely running. Never roll back a possibly superseded binding/event.
    exitCode = { code: 127, signal: null, startup: true,
      error: err?.code || err?.message || 'spawn_failed' };
    console.error(redactedLogText(`${CLI_NAME}: failed to start ${command}: ${err.message}`));
  }
  if (child) {
    child.once('exit', launch.release);
    child.once('error', launch.release);
    exitCode = await new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
      child.on('error', (err) => {
        console.error(redactedLogText(`${CLI_NAME}: failed to start ${command}: ${err.message}`));
        resolve({ code: 127, signal: null, startup: true,
          error: err?.code || err?.message || 'spawn_failed' });
      });
    });
  }
  const db2 = connect(ctx);
  try {
    tx(db2, () => {
      const mutation = db2.prepare(`
        UPDATE peers SET status = ?, last_seen_at = ?
        WHERE id = ? AND pid IS ? AND pid_start_token IS ? AND pid_command_hash IS ?
      `).run('exited', now(), id, process.pid, wrapperIdentity?.startToken || null,
        wrapperIdentity?.commandHash || null);
      if (Number(mutation.changes) > 0) {
        addEvent(db2, 'run.session.exited', id, null, auditPayload({
          actor: id,
          target: id,
          ...exitCode
        }));
      }
    });
  } finally {
    db2.close();
  }
  if (exitCode.signal) {
    process.kill(process.pid, exitCode.signal);
  } else {
    process.exitCode = exitCode.code ?? 0;
  }
  } finally {
    launch.release();
  }
}

/**
 * Internal external PTY bridge: start a child in a PTY, forward output to both
 * the local terminal and a shared buffer file so hcc web can stream it to
 * browsers. Input from the browser is written to a .in file that we relay.
 */
async function cmdRunWebManaged(ctx, { id, kind, role, cwd, expectedCwdIdentity, command, commandArgs, binding,
  codexOrigin = null, force = false }) {
  assertPinnedSessionLaunchAllowed();
  const cwdIdentity = expectedCwdIdentity || (ctx.initialRootIdentity && cwd === path.resolve(ctx.root)
    ? ctx.initialRootIdentity : captureSelectedCwdSnapshot(cwd));
  assertRunDirectories(ctx, cwdIdentity);
  const ptyModule = await loadPty();
  const pty = ptyModule.default || ptyModule;

  const launch = preparePinnedCwdLaunch(cwd, command, commandArgs, {
    expectedIdentity: cwdIdentity,
    env: childSessionEnv({ HCC_PEER: id, HCC_ROOT: ctx.root, HCC_DB: ctx.dbPath, TERM: 'xterm-256color',
      ...(codexOrigin ? { [CODEX_SESSION_ORIGIN_ENV]: codexOrigin } : {}) },
    process.env, { rootIdentity: ctx.initialRootIdentity })
  });
  try {
    assertRunDirectories(ctx, cwdIdentity);
    registerProjectActivity(ctx);

  assertRunDirectories(ctx, cwdIdentity);
  const bufsDir = ensurePrivateProjectBufferDirectory(ctx.root, BUFS_DIR_NAME);
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
  const createdBufferFiles = [];
  const removeCreatedBufferFiles = () => {
    for (const { file, dev, ino, birthtimeNs } of createdBufferFiles) {
      try {
        const stat = fs.lstatSync(file, { bigint: true });
        if (stat.isFile() && stat.dev === dev && stat.ino === ino &&
            stat.birthtimeNs === birthtimeNs) fs.unlinkSync(file);
      } catch {}
    }
  };

  // Publish live wrapper evidence in the same lease that creates the group.
  // This closes the pre-.meta window even for `gc --older-than 0`.
  const publishingWrapperIdentity = runtimeProcessIdentity();
  withBufferDirectoryLease(bufsDir, () => {
    assertRunDirectories(ctx, cwdIdentity);
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
    const createOwnedFile = (file, contents) => {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT |
        fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try {
        const stat = fs.fstatSync(fd, { bigint: true });
        createdBufferFiles.push({ file, dev: stat.dev, ino: stat.ino,
          birthtimeNs: stat.birthtimeNs });
        fs.writeFileSync(fd, contents);
      } finally { fs.closeSync(fd); }
    };
    try {
      createOwnedFile(inFile, '');
      createOwnedFile(resizeFile, '');
      createOwnedFile(metaFile, JSON.stringify({
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
          assertRunDirectories(ctx, cwdIdentity);
          const previous = db.prepare('SELECT * FROM peers WHERE id = ?').get(id) || null;
          const evidence = previous ? resolvePeerEvidence({
            peer: previous,
            processes: [{
              storedIdentity: {
                pid: Number(previous.pid),
                startToken: previous.pid_start_token,
                commandHash: previous.pid_command_hash
              },
              current: inspectProcessIdentity(previous.pid)
            }]
          }) : null;
          if (previous && evidence.state !== 'dead' && (
            previous.pid || ['running', 'working', 'busy', 'starting', 'blocked', 'detached'].includes(previous.status)
          )) {
            throw new CliError('PEER_SESSION_EXISTS', `Peer ${id} already has a live or unresolved owner`, {
              peer: id, evidence_state: evidence.state
            });
          }
          upsertPeer(db, {
            id, kind, role,
            worktree: cwd,
            branch: detectBranch(cwd),
            pid: process.pid,
            processIdentity: publishingWrapperIdentity,
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
      } finally { db.close(); }
    } catch (error) {
      removeCreatedBufferFiles();
      throw error;
    }
  });

  // Estimate terminal size from current process
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;

  let child;
  try {
    child = pty.spawn(launch.command, launch.args, {
      name: 'xterm-256color', cols, rows, cwd: launch.cwd, env: launch.env
    });
  } catch (error) {
    // No PTY was returned. Only the current buffer generation may be removed;
    // historical bindings/events are kept as audit evidence rather than
    // blindly restored over a possible replacement owner.
    try { withBufferDirectoryLease(bufsDir, removeCreatedBufferFiles); } catch {}
    const failedDb = connect(ctx);
    try {
      tx(failedDb, () => {
        const mutation = failedDb.prepare(`
          UPDATE peers SET status = ?, last_seen_at = ?
          WHERE id = ? AND pid IS ? AND pid_start_token IS ? AND pid_command_hash IS ?
            AND status = 'running' AND capabilities = 'run-pty'
        `).run('exited', now(), id, process.pid, publishingWrapperIdentity?.startToken || null,
          publishingWrapperIdentity?.commandHash || null);
        if (Number(mutation.changes) > 0) {
          addEvent(failedDb, 'run.session.exited', id, null, auditPayload({
            actor: id, target: id, code: 127, signal: null, startup: true,
            error: error?.code || error?.message || 'pty_spawn_failed'
          }));
        }
      });
    } finally { failedDb.close(); }
    throw error;
  }
  child.onExit(launch.release);
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
      outFd = fs.openSync(outFile, fs.constants.O_WRONLY | fs.constants.O_CREAT |
        fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
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
  } finally {
    launch.release();
  }
}

  return { cmdRun, cmdRunWebManaged };
}
