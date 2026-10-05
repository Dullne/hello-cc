import process from 'node:process';
import { CliError } from '../../shared/errors.mjs';
import { parseOpts, required, validateOpts, wantsHelp, intOpt } from '../../cli-args.mjs';
import { printResult } from '../../format.mjs';
import { projectDbPath } from '../../runtime/paths.mjs';
import { assertSelectedCwdSnapshot } from '../../process/selected-cwd-identity.mjs';

export function appBridgeHelp() {
  console.log(`Usage:
  hcc --root PROJECT app claude serve --session-id ID [--plugin-dir NEW_DIRECTORY]
  hcc --root PROJECT app codex probe --socket ABSOLUTE_PATH --thread ID [--timeout-ms 5000]
  hcc app claude capability --version VERSION

Claude: generate an opt-in private Desktop Mod and run its local bridge in the
foreground. Requires Claude Code 2.1.287+ in Desktop and the selected session.
No plugin is installed and no account or global configuration is changed.
Ctrl-C closes this bridge, removes its generated plugin and preserves the App.
Queued/submitted input is not acknowledged until its own turn completes.

Codex: read-only probe of an explicitly supplied existing Unix socket. It never
starts/resumes a thread or sends a prompt. A loaded thread does not establish
that the desktop App owns the endpoint; writable remains false.

DSH App: use the Cordis integration (hcc dsh setup --mode cordis).
Its inboxPollMs setting controls idle wakeup; 0 disables automatic polling.`);
}

export function createAppBridgeCommands() {
  async function cmdAppBridge(ctx, args) {
    if (!args.length || wantsHelp(args)) return appBridgeHelp();
    const [provider, action, ...rest] = args;
    const opts = parseOpts(rest);
    if (provider === 'codex' && action === 'probe') {
      validateOpts('app codex probe', opts, ['socket', 'thread', 'timeout-ms']);
      const { probeCodexEndpoint } = await import('../../integrations/codex-app-probe.mjs');
      if (ctx.initialRootIdentity) assertSelectedCwdSnapshot(ctx.initialRootIdentity);
      const result = await probeCodexEndpoint({ socketPath: required(opts, 'socket'),
        threadId: required(opts, 'thread'), expectedCwd: ctx.root, timeoutMs: intOpt(opts, 'timeout-ms', 5000) });
      if (ctx.initialRootIdentity) assertSelectedCwdSnapshot(ctx.initialRootIdentity);
      printResult(ctx, result, value => [
        `Endpoint connected: ${value.transportConnected}; target loaded: ${value.loaded ?? 'unknown'}`,
        'Desktop ownership unverified; message sending disabled.',
        ...value.unmetConditions.map(item => `${item.code}: ${item.message}`)
      ].join('\n'));
      return result;
    }
    if (provider === 'claude' && action === 'capability') {
      validateOpts('app claude capability', opts, ['version']);
      const { claudeAppCapability } = await import('../../integrations/claude-app.mjs');
      const result = claudeAppCapability(required(opts, 'version'));
      const prerequisite = result.supported ? 'met' : 'not met';
      printResult(ctx, result, value => `Desktop Mod version prerequisite: ${prerequisite} (minimum ${value.minimumVersion}); this does not test a connected session.`);
      return result;
    }
    if (provider !== 'claude' || action !== 'serve') throw new CliError('BAD_ARGS', 'Unknown App bridge command');
    validateOpts('app claude serve', opts, ['session-id', 'plugin-dir']);
    // This service always uses the selected project's canonical managed bus.
    if (ctx.dbPath !== projectDbPath(ctx.root)) throw new CliError('BAD_ARGS', 'App bridges use the project managed database; omit --db');
    const sessionId = required(opts, 'session-id');
    const { createClaudeAppBridge, writeClaudeAppPlugin } = await import('../../integrations/claude-app.mjs');
    const { createClaudeAppCoordination } = await import('../../integrations/claude-app-collaboration.mjs');
    let bridge, plugin, coordination, stop;
    const finished = new Promise(resolve => { stop = resolve; });
    const signal = () => stop();
    try {
      bridge = await createClaudeAppBridge({ root: ctx.root, sessionId, initialRootIdentity: ctx.initialRootIdentity });
      plugin = writeClaudeAppPlugin({ directory: opts['plugin-dir'], bridge });
      coordination = createClaudeAppCoordination({ root: ctx.root, sessionId, bridge, initialRootIdentity: ctx.initialRootIdentity,
        onStatus: status => {
          const message = status.error ? `Claude App bridge: ${status.error}` : `Claude App peer ${status.peer} connected`;
          process.stderr.write(message + '\n');
        } });
      process.once('SIGINT', signal); process.once('SIGTERM', signal);
      printResult(ctx, { sessionId, peer: coordination.peer, pluginDirectory: plugin.directory,
        marketplaceDirectory: plugin.marketplaceDirectory, marketplace: plugin.marketplace, pluginName: plugin.name,
        minimumVersion: plugin.minimumVersion, connected: false, foreground: true }, value =>
        `Waiting for the selected Claude Desktop Code session.\nPeer: ${value.peer}\n` +
        `Private marketplace: ${value.marketplaceDirectory}\nPlugin: ${value.pluginName}@${value.marketplace}\n` +
        `Requires Claude Code ${value.minimumVersion}+. Add this local marketplace and plugin explicitly, then /reload-plugins in the selected session.\n` +
        'Keep this command running; Ctrl-C removes the generated plugin and disconnects HCC.');
      await finished;
    } finally {
      process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
      try { coordination?.close(); }
      finally { try { await bridge?.close(); } finally { plugin?.dispose(); } }
    }
  }
  return { cmdAppBridge };
}
