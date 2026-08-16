// Run command extracted from bin/hcc.mjs.
// hcc run: wrap a child process as a tracked peer; the web-managed variant
// bridges an external PTY into shared buffer files for hcc web streaming.

import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CliError } from '../../shared/errors.mjs';
import { tx } from '../../db/schema.mjs';
import { parseOpts, validateOpts } from '../../cli-args.mjs';
import { runtimeProcessIdentity } from '../../runtime/state.mjs';
import { withBufferDirectoryLease } from '../../runtime/buffer-directory-lease.mjs';
import {
  externalBufferEvidence,
  externalBufferOwnerKey,
  readExternalBufferMetadata
} from '../../runtime/buffer-evidence.mjs';
import { inspectProcessIdentity } from '../../process/identity.mjs';
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
    helpRun, redactedLogText, CLI_NAME, BUFS_DIR_NAME
  } = deps;

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

  return { cmdRun, cmdRunWebManaged };
}
