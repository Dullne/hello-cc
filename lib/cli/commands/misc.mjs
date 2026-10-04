// Small utility commands extracted from bin/hcc.mjs: down, find-root, which-real.
import { performance } from 'node:perf_hooks';
import { resolveProjectDatabase } from '../../runtime/project-path.mjs';

export function createMiscCommands(deps) {
  const {
    path, fs, process, CliError, parseOpts, printResult,
    readRuntime, runtimeRequest, runtimePath, globalRuntimePath,
    reclaimRuntimePointerFiles, helpDown, loadSetup,
    waitForProcessIdentityExit, inspectProcessIdentity, compareProcessIdentity, withFileLock,
    PRODUCT_NAME
  } = deps;

  function sameStopPointer(left, right) {
    return left.raw === right.raw && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']
      .every((key) => left.stat[key] === right.stat[key]);
  }

  function readStopPointer(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('invalid runtime pointer');
    const raw = fs.readFileSync(file, 'utf8');
    const current = fs.lstatSync(file);
    if (current.isSymbolicLink() || !current.isFile() ||
        !sameStopPointer({ raw, stat }, { raw, stat: current })) {
      throw new Error('runtime pointer changed');
    }
    return { raw, stat };
  }

  function stopOwnerEvidence(runtime, pointerFiles) {
    try {
      if (runtime.source === 'env') return null;
      const source = pointerFiles.find((file) => path.resolve(file) === path.resolve(runtime.source || ''));
      const url = new URL(runtime.base_url);
      if (!source || !['http:', 'https:'].includes(url.protocol) ||
          !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) return null;
      const owner = runtime.process_identity || runtime.processIdentity;
      if (Object.hasOwn(runtime, 'process_identity') && Object.hasOwn(runtime, 'processIdentity')) return null;
      if (owner?.pid !== Number(runtime.pid) || compareProcessIdentity(owner, owner) !== 'live') return null;
      const observed = inspectProcessIdentity(owner.pid);
      if (observed.state !== 'live' || compareProcessIdentity(owner, observed.identity) !== 'live' ||
          owner.commandHash !== observed.identity.commandHash) return null;
      const pointer = readStopPointer(source);
      const recorded = JSON.parse(pointer.raw);
      if (Object.hasOwn(recorded, 'process_identity') && Object.hasOwn(recorded, 'processIdentity')) return null;
      const recordedOwner = recorded.process_identity || recorded.processIdentity;
      if (Number(recorded.pid) !== owner.pid ||
          compareProcessIdentity(owner, recordedOwner) !== 'live' || owner.commandHash !== recordedOwner.commandHash ||
          ['base_url', 'token', 'tls_ca_file'].some((key) => recorded[key] !== runtime[key])) return null;
      return { source, owner, pointer };
    } catch {
      return null;
    }
  }

  async function cmdDown(ctx, args) {
    if (args[0] === '--help' || args[0] === '-h') return helpDown();
    const stopStartedAt = performance.now();
    const elapsedSince = (startedAt) => Math.max(0, Math.round(performance.now() - startedAt));
    function stopFailure(error, phase, state = 'unknown', confirmationMs = null) {
      // Retain the original error and transport context. Only fixed phase/state
      // vocabulary and monotonic durations describe the local confirmation.
      error.extra = {
        ...error.extra,
        stopPhase: phase,
        state: ['live', 'dead', 'unknown'].includes(state) ? state : 'unknown',
        stopElapsedMs: elapsedSince(stopStartedAt),
        ...(confirmationMs === null ? {} : { confirmationMs })
      };
      return error;
    }
    const localPointer = ctx.root
      ? path.join(resolveProjectDatabase({ root: ctx.root, createStateDir: false }).stateDir, 'runtime.json')
      : runtimePath(ctx);
    const pointerFiles = [localPointer, globalRuntimePath()];
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
    const stopEvidence = stopOwnerEvidence(runtime, pointerFiles);
    try {
      await runtimeRequest(ctx, 'POST', '/api/runtime/stop', {}, runtime);
    } catch (err) {
      if (!(err instanceof CliError && err.code === 'RUNTIME_UNREACHABLE')) throw err;
      if (!stopEvidence) throw stopFailure(err, 'evidence_unavailable');
      const confirmationStartedAt = performance.now();
      const stopped = await waitForProcessIdentityExit(stopEvidence.owner, {
        timeoutMs: 5_000,
        intervalMs: 25
      });
      const confirmationMs = elapsedSince(confirmationStartedAt);
      if (stopped.state !== 'dead') throw stopFailure(err, 'exit_unconfirmed', stopped.state, confirmationMs);
      let cleanup;
      let cleanupPhase = 'pointer_cleanup_failed';
      try {
        cleanup = withFileLock(stopEvidence.source, (file) => {
          let current;
          try { current = readStopPointer(file); }
          catch (error) {
            if (error.code === 'ENOENT') return { reclaimed: 0, blocked: false };
            throw error;
          }
          if (!sameStopPointer(stopEvidence.pointer, current)) {
            cleanupPhase = 'pointer_changed';
            throw err;
          }
          // Hold the pointer's existing lock across comparison and reclamation.
          // A replacement owner must never be removed by this stop request.
          return reclaimRuntimePointerFiles([file], {
            reclaimUnknown: false,
            withLock: (_file, operation) => operation(file)
          });
        }, { createParent: false });
      } catch { throw stopFailure(err, cleanupPhase, 'dead', confirmationMs); }
      if (cleanup.blocked || cleanup.reclaimed > 1) throw stopFailure(err, 'pointer_cleanup_failed', 'dead', confirmationMs);
      printResult(ctx, { runtime: stopEvidence.source }, () => cleanup.reclaimed === 1
        ? `${PRODUCT_NAME} stale runtime pointer removed`
        : `${PRODUCT_NAME} runtime stopped`);
      return;
    }
    if (runtime.source !== 'env') {
      const processIdentity = runtime.process_identity || runtime.processIdentity || runtime.pid;
      const confirmationStartedAt = performance.now();
      const stopped = await waitForProcessIdentityExit(processIdentity, {
        timeoutMs: 5_000,
        intervalMs: 25
      });
      const confirmationMs = elapsedSince(confirmationStartedAt);
      if (stopped.state !== 'dead') {
        throw stopFailure(new CliError(
          'RUNTIME_STOP_TIMEOUT',
          `Runtime accepted the stop request, but process ${runtime.pid || 'unknown'} did not exit within 5s.`,
          { pid: runtime.pid || null }
        ), 'exit_unconfirmed', stopped.state, confirmationMs);
      }
    }
    printResult(ctx, { runtime: runtime.source || runtime.base_url }, () => `${PRODUCT_NAME} runtime stopped`);
  }

  async function cmdFindRoot(ctx, args) {
    const opts = parseOpts(args);
    if (process.env.HCC_ROOT) {
      process.stdout.write(path.resolve(process.env.HCC_ROOT) + '\n');
      return;
    }
    const root = ctx.explicitRoot ? ctx.root : path.resolve(opts.cwd || process.cwd());
    process.stdout.write(root + '\n');
  }

  async function cmdWhichReal(ctx, args) {
    const name = args[0];
    if (!name) throw new CliError('BAD_ARGS', 'Usage: hcc which-real <binary>');
    const { findRealBinary } = await loadSetup();
    const p = findRealBinary(name);
    if (!p) { process.exitCode = 1; return; }
    process.stdout.write(p + '\n');
  }

  return { cmdDown, cmdFindRoot, cmdWhichReal };
}
