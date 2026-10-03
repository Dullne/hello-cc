import { CliError } from '../../shared/errors.mjs';
import { parseOpts, required, validateOpts, wantsHelp } from '../../cli-args.mjs';
import { loadScopedMcpBootstrap } from '../../mcp/scope.mjs';
import { createScopedMcpTools } from '../../mcp/tools.mjs';
import { serveMcpStdio } from '../../mcp/stdio.mjs';

export function mcpHelp() {
  console.log(`Usage: hcc --root PROJECT --db DATABASE mcp serve --peer PEER

Serve project/peer-scoped coordination tools over MCP stdio. The executor must
supply a private, temporary capability; --peer alone does not grant ownership.
No global Codex configuration is changed. Task claiming and handoff never mark
tasks done. Errors from tools are returned as MCP tool results.`);
}

export function createMcpCommands(dependencies) {
  async function cmdMcp(ctx, args) {
    if (!args[0] || wantsHelp(args)) return mcpHelp();
    if (args[0] !== 'serve') throw new CliError('BAD_ARGS', 'Unknown MCP command');
    const options = parseOpts(args.slice(1));
    validateOpts('mcp serve', options, ['peer']);
    const peer = required(options, 'peer');
    const authority = loadScopedMcpBootstrap(ctx, peer);
    const tools = createScopedMcpTools({ ...dependencies, ctx, authority });
    await serveMcpStdio({ tools });
  }
  return { cmdMcp };
}
