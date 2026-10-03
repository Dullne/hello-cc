import process from 'node:process';
import { CliError } from '../../shared/errors.mjs';
import { parseOpts, validateOpts, wantsHelp } from '../../cli-args.mjs';
import { commandPath } from '../../cli-runtime.mjs';
import { printResult } from '../../format.mjs';
import {
  DSH_INSTALL_HINT, ensureDshIntegration, inspectDshIntegration,
  resolveDshBinary, launchDshWeb
} from '../../integrations/dsh.mjs';

function defaultHelp() {
  console.log([
    'Usage: hcc dsh setup [--mode hooks|cordis|off]',
    '       hcc dsh status [--dsh-bin PATH]',
    '       hcc dsh web [--mode hooks|cordis|off] [--dsh-bin PATH] [--dsh-home PATH] -- [dsh web arguments]',
    '',
    'Setup writes project-local configuration under .hello-cc/dsh/. Modes: hooks (default), cordis (native tools), off.',
    'Web starts the official dsh web runtime; its real sessions join hello-cc through the selected integration.',
    'Pass runtime arguments after --, for example: hcc dsh web -- --port 8080',
    'Show dsh web help: hcc dsh web -- --help',
    `Install the tested dsh version: ${DSH_INSTALL_HINT}`
  ].join('\n'));
}

export function createDshCommands(deps = {}) {
  const getCommandPath = deps.commandPath || commandPath;
  const help = deps.helpDsh || defaultHelp;

  async function cmdDsh(ctx, args) {
    const helpBoundary = args.indexOf('--');
    const wrapperArgs = helpBoundary < 0 ? args : args.slice(0, helpBoundary);
    if (!args.length || wantsHelp(wrapperArgs)) return help();
    const sub = args[0];
    if (!['setup', 'status', 'web'].includes(sub)) throw new CliError('BAD_ARGS', `Unknown dsh subcommand: ${sub}`);
    const tail = args.slice(1);
    const boundary = tail.indexOf('--');
    const forwarded = boundary < 0 ? [] : tail.slice(boundary + 1);
    const opts = parseOpts(boundary < 0 ? tail : tail.slice(0, boundary));
    const allowed = sub === 'setup' ? ['mode'] : sub === 'status' ? ['dsh-bin'] : ['mode', 'dsh-bin', 'dsh-home'];
    validateOpts(`dsh ${sub}`, opts, allowed);
    if (sub !== 'web' && boundary >= 0) throw new CliError('BAD_ARGS', `dsh ${sub}: unexpected -- argument separator`);
    if (opts.mode !== undefined && !['hooks', 'cordis', 'off'].includes(opts.mode)) throw new CliError('BAD_ARGS', '--mode must be hooks, cordis, or off');
    for (const name of allowed.filter(name => name !== 'mode')) {
      if (opts[name] !== undefined && !opts[name]) throw new CliError('BAD_ARGS', `--${name} must be a non-empty path`);
    }
    const config = { hccBin: getCommandPath(), ...(opts.mode !== undefined ? { mode: opts.mode } : {}) };
    if (sub === 'setup') {
      const result = ensureDshIntegration(ctx, config);
      const label = result.changed.length ? 'configured' : 'already current';
      printResult(ctx, result, (data) => [
        `dsh integration ${label}: ${data.root}`,
        `hooks: ${data.hooksPath}`,
        `patch: ${data.patchPath}`,
        `mode: ${data.mode}`,
        'start: hcc dsh web'
      ].join('\n'));
      return;
    }
    if (sub === 'status') {
      const result = inspectDshIntegration(ctx, config);
      const binary = resolveDshBinary({ dshBin: opts['dsh-bin'], cwd: ctx.cwd });
      const data = { ...result, binary, installed: Boolean(binary), installHint: binary ? null : DSH_INSTALL_HINT };
      const binaryLabel = binary || `missing (install: ${DSH_INSTALL_HINT})`;
      printResult(ctx, data, () => [
        `dsh integration: ${result.state}`,
        `mode: ${result.mode || 'unknown'}`,
        `binary: ${binaryLabel}`,
        result.error?.message,
        !result.ready && result.state !== 'conflict' ? 'configure: hcc dsh setup' : null
      ].filter(Boolean).join('\n'));
      return;
    }
    const result = await launchDshWeb(ctx, { ...config, dshBin: opts['dsh-bin'], dshHome: opts['dsh-home'], args: forwarded });
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.code ?? 1;
  }

  return { cmdDsh };
}
