// Small utility commands extracted from bin/hcc.mjs: down, find-root, which-real.
import { resolveProjectDatabase } from '../../runtime/project-path.mjs';
import { compareProcessIdentity } from '../../process/identity.mjs';

export function createMiscCommands(deps) {
  const {
    path, process, CliError, parseOpts, printResult,
    readRuntime, runtimeRequest, runtimePath, globalRuntimePath,
    reclaimRuntimePointerFiles, helpDown, loadSetup,
    waitForProcessIdentityExit,
    PRODUCT_NAME
  } = deps;

  async function cmdDown(ctx, args) {
    if (args[0] === '--help' || args[0] === '-h') return helpDown();
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
    try {
      await runtimeRequest(ctx, 'POST', '/api/runtime/stop', {}, runtime);
    } catch (err) {
      if (!(err instanceof CliError && err.code === 'RUNTIME_UNREACHABLE')) throw err;
      if (runtime.source === 'env') throw err;
      const source = path.resolve(String(runtime.source || ''));
      const localSource = pointerFiles.find((file) => path.resolve(file) === source);
      if (!localSource) throw err;
      const identity = runtime.process_identity || runtime.processIdentity;
      if (compareProcessIdentity(identity, identity) !== 'live' || identity.pid !== Number(runtime.pid)) throw err;
      // The runtime removes its pointer before finishing shutdown. A lost HTTP
      // reply can therefore leave nothing to reclaim even after a successful
      // stop. Confirm the captured process instance, never infer exit from a
      // missing pointer or send another stop request to its replacement.
      const stopped = await waitForProcessIdentityExit(identity, { timeoutMs: 5_000, intervalMs: 25 });
      if (stopped.state !== 'dead') throw err;
      // A new runtime may already have published here. Failure to reclaim that
      // pointer does not undo the confirmed exit of the original owner.
      reclaimRuntimePointerFiles([localSource], { reclaimUnknown: false, expectedIdentity: identity });
      printResult(ctx, { runtime: localSource, pid: identity.pid }, () =>
        `${PRODUCT_NAME} runtime process ${identity.pid} stopped (stop response unavailable)`);
      return;
    }
    if (runtime.source !== 'env') {
      const processIdentity = runtime.process_identity || runtime.processIdentity || runtime.pid;
      const stopped = await waitForProcessIdentityExit(processIdentity, {
        timeoutMs: 5_000,
        intervalMs: 25
      });
      if (stopped.state !== 'dead') {
        throw new CliError(
          'RUNTIME_STOP_TIMEOUT',
          `Runtime accepted the stop request, but process ${runtime.pid || 'unknown'} did not exit within 5s.`,
          { pid: runtime.pid || null, state: stopped.state }
        );
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
