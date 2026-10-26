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
  hcc --root PROJECT app codex setup --plugin-dir NEW_DIRECTORY
  hcc --root PROJECT app codex call --tool hcc_inbox [--arguments '{}']
  hcc --root PROJECT app codex session
  hcc --root PROJECT app codex watch --cli ABSOLUTE_APP_EXECUTABLE --sqlite-home DIRECTORY --app-server-pid PID [--poll-ms 1000]
  hcc --root PROJECT app codex dispatch-status
  hcc --root PROJECT app codex disable
  hcc app claude capability --version VERSION

Claude: generate an opt-in private Desktop Mod and run its local bridge in the
foreground. Requires Claude Code 2.1.287+ in Desktop and the selected session.
No plugin is installed and no account or global configuration is changed.
Ctrl-C closes this bridge, removes its generated plugin and preserves the App.
Queued/submitted input is not acknowledged until its own turn completes.

Codex: read-only probe of an explicitly supplied existing Unix socket. It never
starts/resumes a thread or sends a prompt. A loaded thread does not establish
that the desktop App owns the endpoint; writable remains false.
Cooperation: setup writes an opt-in local MCP/hooks plugin for the selected
project. Add it and approve its hook in the App. session/call run inside the
original App terminal tool, using its current CODEX_THREAD_ID. MCP checks its
per-call threadId against a short-lived session capability. Read/wait never
acknowledge; explicit reply/ack does. Optional watch forwards unread-message
notifications through the audited official CLI queue to this current App thread.
Keep watch running. It never acknowledges mail or starts/resumes a thread.
The original App must remain running with this thread loaded and uninterrupted.

DSH App: use the Cordis integration (hcc dsh setup --mode cordis).
Its inboxPollMs setting controls idle wakeup; 0 disables automatic polling.`);
}

export function createAppBridgeCommands() {
  async function cmdAppBridge(ctx, args) {
    if (!args.length || wantsHelp(args)) return appBridgeHelp();
    const [provider, action, ...rest] = args;
    const opts = parseOpts(rest);
    if (provider === 'codex' && ['setup', 'session', 'call', 'mcp', 'hook', 'disable', 'status', 'watch', 'dispatch-status'].includes(action)) {
      if (ctx.dbPath !== projectDbPath(ctx.root)) throw new CliError('BAD_ARGS', 'App cooperation uses the selected project managed database; omit --db');
      const { createCodexAppCooperation, codexShellSession, codexCooperationHook } = await import('../../integrations/codex-app-cooperation.mjs');
      const service = createCodexAppCooperation({ root: ctx.root, initialRootIdentity: ctx.initialRootIdentity });
      if (action === 'watch' || action === 'dispatch-status') {
        validateOpts(`app codex ${action}`, opts, action === 'watch' ? ['cli', 'sqlite-home', 'app-server-pid', 'poll-ms'] : []);
        const sessionId = codexShellSession();
        const { createCodexAppDelivery, codexAppDeliveryStatus } = await import('../../integrations/codex-app-delivery.mjs');
        if (action === 'dispatch-status') {
          const result = codexAppDeliveryStatus({ root: ctx.root, sessionId, initialRootIdentity: ctx.initialRootIdentity });
          printResult(ctx, result, value => JSON.stringify(value));
          return result;
        }
        const { createCodexAppQueueTransport } = await import('../../integrations/codex-app-queue.mjs');
        const pollMs = intOpt(opts, 'poll-ms', 1000);
        if (pollMs < 100 || pollMs > 60000) throw new CliError('BAD_ARGS', '--poll-ms must be between 100 and 60000');
        const transport = await createCodexAppQueueTransport({ root: ctx.root, threadId: sessionId,
          cli: required(opts, 'cli'), sqliteHome: required(opts, 'sqlite-home'),
          appServerPid: intOpt(opts, 'app-server-pid', 0) });
        // Establish the same opt-in peer binding as an ordinary current-App
        // session call. The short-lived model capability is never exported.
        service.issueSession({ sessionId, cwd: ctx.root, source: 'codex-shell-environment' });
        let delivery, finish;
        const finished = new Promise(resolve => { finish = resolve; });
        const signal = () => finish();
        process.once('SIGINT', signal); process.once('SIGTERM', signal);
        try {
          delivery = createCodexAppDelivery({ root: ctx.root, sessionId, transport, pollMs,
            initialRootIdentity: ctx.initialRootIdentity,
            onStatus: value => process.stderr.write(JSON.stringify(value) + '\n') });
          const result = { root: ctx.root, peer: delivery.peer, sessionId, foreground: true, pollMs,
            automaticIdleDispatchEnabled: true, idleWakeupVerified: false, transport: transport.info };
          printResult(ctx, result, value => `Watching HCC inbox for ${value.peer} in this existing Codex App thread.\n` +
            'Keep this process running. Ctrl-C stops only this dispatcher; mail remains unread until the receiving App explicitly acknowledges it.');
          await finished;
          return result;
        } finally {
          process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
          await delivery?.close();
        }
      }
      if (action === 'setup') {
        validateOpts('app codex setup', opts, ['plugin-dir']);
        const { writeCodexCooperationPlugin } = await import('../../integrations/codex-app-install.mjs');
        const result = writeCodexCooperationPlugin({ root: ctx.root, directory: required(opts, 'plugin-dir'), initialRootIdentity: ctx.initialRootIdentity });
        printResult(ctx, result, value => `Project cooperation enabled. Add local marketplace ${value.marketplaceDirectory} in Codex App and approve its UserPromptSubmit hook.\nMCP loading and hook trust are not yet verified. Optional idle dispatch requires a separate app codex watch process.`);
        return result;
      }
      if (action === 'call') validateOpts('app codex call', opts, ['tool', 'arguments']);
      else validateOpts(`app codex ${action}`, opts, []);
      if (action === 'mcp') {
        const { serveMcpStdio } = await import('../../mcp/stdio.mjs');
        if (!service.isEnabled()) throw new CliError('CODEX_APP_SCOPE_INVALID', 'Enable cooperation for this project first');
        return serveMcpStdio({ tools: service, concurrentToolCalls: true });
      }
      if (action === 'hook') {
        let text = '';
        for await (const chunk of process.stdin) {
          text += chunk;
          if (Buffer.byteLength(text) > 65536) throw new CliError('BAD_ARGS', 'Hook payload is too large');
        }
        let payload;
        try { payload = JSON.parse(text); } catch { throw new CliError('BAD_ARGS', 'Hook requires JSON input'); }
        const result = await codexCooperationHook({ root: ctx.root, initialRootIdentity: ctx.initialRootIdentity, payload });
        if (result) process.stdout.write(JSON.stringify(result) + '\n');
        return result;
      }
      if (action === 'disable' || action === 'status') {
        const result = action === 'disable' ? service.disable() : { root: ctx.root, enabled: service.isEnabled(), automaticIdleWakeup: false };
        printResult(ctx, result, value => JSON.stringify(value));
        return result;
      }
      const sessionId = codexShellSession();
      // Each terminal invocation belongs to its current App thread. This
      // environment is never used to identify calls on the persistent MCP.
      const session = service.issueSession({ sessionId, cwd: ctx.root, source: 'codex-shell-environment' });
      if (action === 'session') {
        // Capability is intended only for the current model context/MCP call.
        process.stdout.write(JSON.stringify({ ok: true, data: session }) + '\n');
        return session;
      }
      let input;
      try { input = JSON.parse(opts.arguments || '{}'); } catch { throw new CliError('BAD_ARGS', '--arguments must be a JSON object'); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, 'session_token')) throw new CliError('BAD_ARGS', 'CLI arguments cannot override the current session capability');
      const result = await service.call(required(opts, 'tool'), { ...input, session_token: session.session_token }, { meta: { threadId: sessionId } });
      printResult(ctx, result.structuredContent, value => JSON.stringify(value));
      if (result.isError) process.exitCode = 1;
      return result;
    }
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
