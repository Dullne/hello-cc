import path from 'node:path';
import { spawn } from 'node:child_process';
import { shortHash } from '../core/peers/format.mjs';
import { CliError } from '../shared/errors.mjs';
import { ensurePrivateProjectStateDir } from '../runtime/private-state.mjs';
import { resolveWindowsCommand, windowsEnvironment } from './windows-command.mjs';

const codexValueOptions = new Set(['-c', '--config', '-i', '--image', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval', '--remote', '--remote-auth-token-env']);
function firstCodexCommand(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (codexValueOptions.has(argv[index])) { index += 1; continue; }
    if (!argv[index].startsWith('-')) return argv[index];
  }
  return '';
}
function passthrough(tool, argv) {
  if (tool === 'claude') {
    return argv.some(arg => ['-h', '--help', '-v', '--version', '-p', '--print', '--bare', '--safe-mode'].includes(arg)) ||
      ['agents', 'auth', 'auto-mode', 'doctor', 'install', 'mcp', 'plugin', 'plugins', 'project', 'setup-token', 'ultrareview', 'update', 'upgrade'].includes(argv[0]);
  }
  return argv.some(arg => ['-h', '--help', '-V', '--version'].includes(arg)) ||
    ['help', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'mcp-server', 'app-server', 'remote-control', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'archive', 'unarchive', 'cloud', 'exec-server', 'features'].includes(firstCodexCommand(argv));
}
function option(argv, names) {
  let value = '';
  for (let index = 0; index < argv.length; index += 1) {
    if (names.includes(argv[index])) value = argv[++index] || '';
    else for (const name of names) if (argv[index].startsWith(name + '=')) value = argv[index].slice(name.length + 1);
  }
  return value;
}
function peerId(tool, argv, env, ppid) {
  if (env.HCC_PEER) return env.HCC_PEER;
  let session = '';
  if (tool === 'claude') {
    const fork = argv.includes('--fork-session'), continued = argv.some(arg => ['--continue', '-c'].includes(arg));
    session = option(argv, ['--session-id']) || (!fork && option(argv, ['--resume', '-r'])) ||
      env.CLAUDE_CODE_SESSION_ID || (!fork && !continued && option(argv, ['--name', '-n']));
  } else {
    const command = firstCodexCommand(argv);
    if (command === 'resume') {
      const rest = argv.slice(argv.indexOf('resume') + 1);
      if (!rest.includes('--last')) session = rest.find(arg => !arg.startsWith('-')) || '';
    }
  }
  return `${tool}-${session ? shortHash(session) : ppid}`;
}

export function planWindowsShimLaunch(config, argv, { root = null, env = process.env, cwd = process.cwd(), ppid = process.ppid } = {}) {
  if (!['claude', 'codex'].includes(config?.tool) || !path.isAbsolute(config.hccBin || '') ||
      !path.isAbsolute(config.realBin || '') || !Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) {
    throw new CliError('WINDOWS_SHIM_INVALID', 'The Windows provider launcher configuration is invalid. Reinstall the HCC shims.');
  }
  const environment = windowsEnvironment(env);
  const command = resolveWindowsCommand(config.realBin, { env: environment, cwd });
  const providerArgs = [...command.args, ...argv];
  if (!root || passthrough(config.tool, argv) || environment.HCC_WINDOWS_SHIM_ACTIVE === '1') {
    return { route: 'provider', file: command.file, args: providerArgs, env: environment, cwd };
  }
  const peer = peerId(config.tool, argv, environment, ppid);
  return { route: 'managed', file: process.execPath,
    args: [config.hccBin, '--root', root, 'run', '--peer', peer, '--kind', config.tool, '--', command.file, ...providerArgs],
    env: { ...environment, HCC_ROOT: root, HCC_PEER: peer, HCC_WINDOWS_SHIM_ACTIVE: '1' }, cwd };
}

export async function runWindowsShim(config, argv) {
  try {
    const env = windowsEnvironment();
    let root = null;
    if (!passthrough(config.tool, argv) && env.HCC_WINDOWS_SHIM_ACTIVE !== '1') {
      const candidate = path.resolve(env.HCC_ROOT || process.cwd());
      if (ensurePrivateProjectStateDir(candidate, { create: false })) root = candidate;
    }
    const launch = planWindowsShimLaunch(config, argv, { root, env });
    const child = spawn(launch.file, launch.args, { env: launch.env, cwd: launch.cwd, stdio: 'inherit', windowsHide: true, shell: false });
    // Console control events also reach the child. Let it finish its own
    // cancellation and return the actual child exit status to the thin launcher.
    const ignoreControl = () => {};
    process.on('SIGINT', ignoreControl); process.on('SIGBREAK', ignoreControl);
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('exit', code => resolve(Number.isInteger(code) ? code : 1));
      });
    } finally { process.off('SIGINT', ignoreControl); process.off('SIGBREAK', ignoreControl); }
  } catch (error) { console.error(`hcc: ${error.message}`); process.exitCode = 1; }
}
