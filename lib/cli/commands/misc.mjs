// Small utility commands extracted from bin/hcc.mjs: down, find-root, which-real.

export function createMiscCommands(deps) {
  const {
    path, process, CliError, parseOpts, printResult,
    readRuntime, runtimeRequest, runtimePath, globalRuntimePath,
    reclaimRuntimePointerFiles, helpDown, loadSetup,
    PRODUCT_NAME
  } = deps;

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
