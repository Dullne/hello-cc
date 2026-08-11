// Install/setup/update/uninstall/shim commands extracted from bin/hcc.mjs.

import { execFileSync, spawnSync } from 'node:child_process';

export function createInstallCommands(deps) {
  const {
    path, fs, process, CliError, parseOpts, validateOpts, wantsHelp,
    printResult, commandPath, connect, readRuntime, runtimeRequest,
    runtimePath, globalRuntimePath, PRODUCT_NAME, VERSION, NPM_PACKAGE_NAME,
    helpInstallHooks, helpShim, helpUninstall, helpUpdate,
    loadSetup, shellCommand,


    sameResolvedPath, writeGuidance, removeGuidanceBlocks,
  
  } = deps;

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


  return { cmdInstallHooks, cmdShim, cmdSetup, cmdUpdate, cmdUninstall };
}
