import { splitGlobalArgs } from '../cli-args.mjs';
import { formatJson, printResult } from '../format.mjs';
import { diagnoseEnvironment } from '../diagnostics/environment.mjs';
import { CliError } from '../shared/errors.mjs';

export function environmentCommandArguments(argv) {
  const parsed = splitGlobalArgs(argv);
  const delimiter = parsed.rest.indexOf('--');
  const commandArgs = delimiter < 0 ? parsed.rest : parsed.rest.slice(0, delimiter);
  return commandArgs[0] === 'doctor' && commandArgs.includes('--environment') ? parsed : null;
}

export function runEnvironmentDoctor(ctx, args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('hcc doctor --environment [--json]\n\nCheck Node.js, the platform component and terminal prerequisites without opening a project database.');
    return;
  }
  if (args.some(arg => !['--environment', '--json'].includes(arg))) {
    throw new CliError('BAD_ARGS', '--environment cannot be combined with database or provider checks');
  }
  const report = diagnoseEnvironment();
  printResult(ctx, report, r => [
    `environment: ${r.ready ? 'ready' : 'requirements missing'}`,
    `  Node.js: ${r.node.version} (required ${r.node.required})`,
    `  platform: ${r.platform.os} ${r.platform.arch} ${r.platform.release}`,
    `  native component: ${r.native.status}${r.native.reason ? ` (${r.native.reason})` : ''}`,
    `  terminal: ${r.terminal.backend} (${r.terminal.available ? 'available' : 'unavailable'})`,
    ...(r.permissions ? [`  profile permissions: ${r.permissions.profile}`] : []),
    ...Object.entries(r.providers).map(([name, provider]) => `  ${name}: ${provider.available ? 'available' : provider.code}`),
    ...r.actions.map(action => `  ${action}`)
  ].join('\n'));
  if (!report.ready) process.exitCode = 1;
}

export function runEnvironmentEntry(parsed) {
  try {
    if (process.env.HCC_NATIVE_OWNER) {
      throw new CliError('NATIVE_CLI_SCOPE_REQUIRED', 'Native workers must use their scoped MCP tools');
    }
    runEnvironmentDoctor({ json: parsed.global.json }, parsed.rest.slice(1));
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    console.error(parsed.global.json ? formatJson(false, { code: error.code, message: error.message }) : `hcc: ${error.message}`);
    process.exitCode = 1;
  }
}
