import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../../shared/errors.mjs';
import { parseOpts, validateOpts, wantsHelp, intOpt } from '../../cli-args.mjs';
import { printResult } from '../../format.mjs';
import { ensureNativeRuntime } from '../../runtime/native/launcher.mjs';
import { nativeRequest } from '../../runtime/native/client.mjs';
import { listCliSubmissions, matchingCliSubmission, prepareCliSubmission,
  recordCliSubmissionReceipt } from '../../runtime/native/cli-submissions.mjs';
import { assertPinnedSessionLaunchAllowed } from '../../process/pinned-cwd.mjs';
import { startNativeService } from '../../runtime/native/service.mjs';

export function nativeHelp() {
  console.log(`Usage: hcc native up|status|down
       hcc native start --peer NAME --provider codex|claude|dsh [--cwd DIR] [--model MODEL] [--binary PATH] [--resume last] [--sandbox read-only|workspace-write]
       hcc native fork --parent NAME --peer NEW_NAME [--model MODEL] [--binary PATH]
       hcc native send --peer NAME --body TEXT [--from NAME] [--task ID] [--submission-id ID]
       hcc native events --peer NAME [--after ID]
       hcc native deliveries [--peer NAME]
       hcc native submissions [--peer NAME]
       hcc native requests --peer NAME
       hcc native respond --peer NAME --request ID --decision accept|decline|cancel [--response-file JSON]
       hcc native interrupt --peer NAME [--turn ID]
       hcc native close --peer NAME

Native workers share the project task/message/lock bus. Only HCC-owned saved
sessions can resume. Existing TUI/Desktop sessions keep their own transport.
Generated CLI submission IDs are saved before sending. Inspect native
submissions after an uncertain receipt; retry only with the original ID and
exact peer, sender, task and body. Explicit --submission-id also remains valid.
Providers retain their permission checks; interactive requests await an explicit Web or local response.
Codex alone accepts --sandbox. New sessions default to workspace-write; resumed and forked sessions inherit their saved policy.
read-only disables permission escalation and HCC scoped MCP tools. It is a provider file sandbox, not an all-tools/network guarantee.
Claude workers require the optional @anthropic-ai/claude-agent-sdk package.
dsh workers use the ACP profile, not its Web-service terminal.`);
}

export function createNativeCommands(deps) {
  function requireSandboxRuntime(runtime) {
    if (runtime?.sandboxPolicyVersion !== 1) {
      throw new CliError('NATIVE_SANDBOX_RUNTIME_UNSUPPORTED',
        'This native runtime cannot preserve Codex sandbox policies. Stop the project native runtime after its work has finished, then start it with this HCC version. No worker was created.');
    }
    if (typeof runtime?.generation !== 'string' ||
        !runtime.generation.trim() || runtime.generation.length > 128) {
      throw new CliError('NATIVE_OWNER_CHANGED', 'Native runtime did not report a verifiable generation. No worker was created.');
    }
  }
  async function cmdNative(ctx, args) {
    const command = args[0];
    if (!command || wantsHelp(args)) return nativeHelp();
    const opts = parseOpts(args.slice(1));
    const allowed = {
      up: [], serve: [], down: [], status: [],
      start: ['peer', 'provider', 'cwd', 'model', 'binary', 'resume', 'sandbox'],
      send: ['peer', 'body', 'from', 'task', 'submission-id'],
      events: ['peer', 'after'], deliveries: ['peer'], submissions: ['peer'], requests: ['peer'],
      respond: ['peer', 'request', 'decision', 'response-file'],
      fork: ['peer', 'parent', 'model', 'binary'],
      interrupt: ['peer', 'turn'], close: ['peer']
    };
    if (!Object.hasOwn(allowed, command)) throw new CliError('BAD_ARGS', `Unknown native command: ${command}`);
    validateOpts(`native ${command}`, opts, allowed[command]);
    if (['start', 'fork', 'send', 'events', 'interrupt', 'close', 'requests', 'respond'].includes(command) && !opts.peer) throw new CliError('BAD_ARGS', 'Missing --peer');
    if (command === 'start' && !opts.provider) throw new CliError('BAD_ARGS', 'Missing --provider');
    if (command === 'start' && opts.provider === 'claude' && opts.binary !== undefined) throw new CliError('BAD_ARGS', 'Claude workers use the Agent SDK; --binary is available for Codex and dsh');
    if (command === 'start' && opts.sandbox !== undefined &&
        (opts.provider !== 'codex' || !['read-only', 'workspace-write'].includes(opts.sandbox))) {
      throw new CliError('BAD_ARGS', '--sandbox accepts read-only or workspace-write for Codex only');
    }
    if (command === 'send' && !opts.body?.trim()) throw new CliError('BAD_ARGS', 'Missing --body');
    let result;
    if (command === 'up') result = await ensureNativeRuntime(ctx);
    else if (command === 'serve') {
      const service = await startNativeService(ctx, deps);
      const shutdown = () => { void service.shutdown().catch((error) => console.error(JSON.stringify({ code: error.code, message: error.message }))); };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
      return;
    } else if (command === 'start') {
      assertPinnedSessionLaunchAllowed();
      const runtime = await ensureNativeRuntime(ctx);
      if (opts.provider === 'codex') requireSandboxRuntime(runtime);
      result = await nativeRequest(ctx, 'POST', '/workers', { peer: opts.peer, provider: opts.provider,
        cwd: opts.cwd ? path.resolve(ctx.cwd, opts.cwd) : ctx.root, model: opts.model, binary: opts.binary, resume: opts.resume,
        ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}) },
        opts.provider === 'codex' ? { expectedGeneration: runtime.generation } : undefined);
    } else if (command === 'fork') {
      assertPinnedSessionLaunchAllowed();
      if (!opts.parent) throw new CliError('BAD_ARGS', 'Missing --parent');
      const runtime = await nativeRequest(ctx, 'GET', '/status');
      requireSandboxRuntime(runtime);
      result = await nativeRequest(ctx, 'POST', '/fork', { parent: opts.parent, peer: opts.peer, model: opts.model, binary: opts.binary },
        { expectedGeneration: runtime.generation });
    } else if (command === 'send') {
      const taskId = intOpt(opts, 'task', null);
      if (taskId !== null && taskId < 1) throw new CliError('BAD_ARGS', 'Task ID must be positive');
      const submissionId = opts['submission-id'];
      if (submissionId !== undefined && !/^[A-Za-z0-9_-]{8,100}$/.test(submissionId)) {
        throw new CliError('BAD_ARGS', 'Submission ID must contain 8 to 100 letters, digits, underscores, or hyphens');
      }
      const sender = deps.resolveCurrentPeer(ctx, opts, 'from', 'shell').id;
      const input = { peer: opts.peer, from: sender, taskId, body: opts.body };
      const prepared = submissionId ? matchingCliSubmission(ctx, { ...input, submissionId })
        : prepareCliSubmission(ctx, input);
      result = await nativeRequest(ctx, 'POST', '/send', { peer: opts.peer, from: sender, body: opts.body, taskId,
        submissionId: submissionId || prepared.submission_id });
      if (prepared) recordCliSubmissionReceipt(ctx, prepared, result);
    } else if (command === 'events') {
      const after = intOpt(opts, 'after', 0);
      if (after < 0) throw new CliError('BAD_ARGS', 'Event cursor must be nonnegative');
      result = await nativeRequest(ctx, 'GET', `/events?peer=${encodeURIComponent(opts.peer)}&after=${after}`);
    } else if (command === 'deliveries') {
      result = await nativeRequest(ctx, 'GET', `/deliveries${opts.peer ? `?peer=${encodeURIComponent(opts.peer)}` : ''}`);
    } else if (command === 'submissions') {
      result = listCliSubmissions(ctx, { peer: opts.peer || null });
    } else if (command === 'requests' || command === 'respond') {
      const state = await nativeRequest(ctx, 'GET', '/workers/' + encodeURIComponent(opts.peer) + '/state');
      if (command === 'requests') result = state.snapshot.pendingApprovals || [];
      else {
        if (!opts.request || !['accept', 'decline', 'cancel'].includes(opts.decision)) throw new CliError('BAD_ARGS', 'Respond requires --request ID and --decision accept|decline|cancel');
        const pending = (state.snapshot.pendingApprovals || []).filter(request => String(request.requestId) === opts.request);
        if (pending.length !== 1) throw new CliError('NATIVE_APPROVAL_MISMATCH', 'Select an exact pending request from hcc native requests');
        let response = {};
        if (opts['response-file']) {
          const data = fs.readFileSync(path.resolve(ctx.cwd, opts['response-file']), 'utf8');
          if (data.length > 100000) throw new CliError('BAD_ARGS', 'Response file exceeds the limit');
          try { response = JSON.parse(data); } catch { throw new CliError('BAD_ARGS', 'Response file must contain JSON'); }
          if (!response || typeof response !== 'object' || Array.isArray(response) || Object.keys(response).some(key => !['permissions','scope','answers','content'].includes(key))) throw new CliError('BAD_ARGS', 'Response file accepts permissions, scope, answers and MCP content only');
        }
        const request = pending[0];
        result = await nativeRequest(ctx, 'POST', '/respond', { peer: opts.peer, generation: state.generation,
          owner: state.owner, provider: state.provider, executorId: state.owner, sessionId: request.sessionId,
          turnId: request.turnId, requestId: request.requestId, decision: opts.decision, ...response });
      }
    } else if (command === 'interrupt') result = await nativeRequest(ctx, 'POST', '/interrupt', { peer: opts.peer, turnId: opts.turn });
    else if (command === 'close') result = await nativeRequest(ctx, 'POST', '/close', { peer: opts.peer });
    else if (command === 'down') result = await nativeRequest(ctx, 'POST', '/down', {});
    else result = await nativeRequest(ctx, 'GET', '/status');
    printResult(ctx, result, (data) => JSON.stringify(data, null, 2));
  }
  return { cmdNative };
}
