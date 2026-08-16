// Up command extracted from bin/hcc.mjs.
// hcc up bootstraps the local coordination bus: guidance, provider hooks,
// optional shims, and provider-session discovery.

import { parseOpts, validateOpts } from '../../cli-args.mjs';
import { printResult } from '../../format.mjs';
import { commandPath } from '../../cli-runtime.mjs';
import { detectBranch } from '../../project-context.mjs';
import { bindingFromDetected } from '../../core/peers/bindings.mjs';

export function createUpCommand(deps) {
  const {
    connect, helpUp, PRODUCT_NAME,
    loadSetup, loadDiscover,
    writeGuidance, sameResolvedPath,
    upsertPeer, upsertCanonicalPeerBinding
  } = deps;

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

  return { cmdUp, prepareLocalBus };
}
