import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnWindowsOwnedProcess } from '../lib/platform/windows-process.mjs';
import { windowsTestStages } from './windows-test-groups.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const providerSessionKeys = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CONVERSATION_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_CODE_PARENT_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_AGENT_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID',
  'CODEX_CONVERSATION_ID', 'CODEX_PARENT_THREAD_ID', 'PARENT_THREAD_ID', 'CODEX_PROJECT_DIR',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'NODE_TEST_CONTEXT'
]);

export function testPlan(platform, phase, { logDirectory, group } = {}) {
  if (!['unit', 'regression', 'windows-group'].includes(phase)) throw new Error('Expected unit or regression test phase');
  if (platform !== 'win32') {
    if (phase === 'windows-group') throw new Error('Windows groups require native Windows');
    return [{ name: phase, args: phase === 'unit' ? ['--test', 'test/*.test.mjs'] : ['./scripts/regression.mjs'] }];
  }
  if (!logDirectory) throw new Error('Windows tests require a log directory');
  if (phase === 'windows-group') return windowsTestStages(group, logDirectory);
  if (phase === 'unit') return ['core', 'ui', 'shared'].flatMap(name => windowsTestStages(name, path.join(logDirectory, name)));
  return [{ name: 'installed', timeoutMs: 10 * 60_000,
    args: ['./scripts/windows-installed-acceptance.mjs', '--output', path.join(logDirectory, 'installed-acceptance.json')] }];
}

export function createWindowsTestProfile(environment = process.env) {
  const home = fs.realpathSync.native(os.homedir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(home, 'hcc-tests-')));
  const temporary = path.join(root, 'tmp');
  fs.mkdirSync(temporary);
  const env = { ...environment };
  const directories = { CODEX_HOME: '.codex', CLAUDE_CONFIG_DIR: '.claude', DSH_HOME: '.dsh',
    XDG_CONFIG_HOME: '.config', XDG_CACHE_HOME: '.cache' };
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (normalized.startsWith('HCC_') || providerSessionKeys.has(normalized) || normalized in directories) delete env[key];
  }
  for (const [key, name] of Object.entries(directories)) {
    env[key] = path.join(root, name);
    fs.mkdirSync(env[key]);
  }
  Object.assign(env, { HOME: root, USERPROFILE: root, TEMP: temporary, TMP: temporary, HCC_SKIP_SHIM_INSTALL: '1' });
  return { root, env };
}

function runStage(stage, { cwd, env, logDirectory }) {
  return new Promise((resolve, reject) => {
    const log = logDirectory ? fs.openSync(path.join(logDirectory, `${stage.name}.log`), 'w') : undefined;
    let child, timer, stopping = false, settled = false;
    const write = (stream, data) => {
      if (settled) return;
      if (log !== undefined) fs.writeSync(log, data);
      stream.write(data);
    };
    const finish = (code, error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
      if (log !== undefined) fs.closeSync(log);
      if (error) reject(error); else resolve(Number.isInteger(code) && code >= 0 ? code : 1);
    };
    const stop = async (code, reason) => {
      if (stopping || settled) return;
      stopping = true;
      write(process.stderr, `${stage.name}: ${reason}\n`);
      if (process.platform === 'win32') {
        try { await child.close({ timeoutMs: 5000 }); }
        catch {
          const error = Object.assign(new Error(`${stage.name}: owned process cleanup unconfirmed`), { cleanupUnconfirmed: true });
          write(process.stderr, `${error.message}\n`);
          finish(1, error);
          return;
        }
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }
      finish(code);
    };
    const interrupt = () => void stop(130, 'interrupted');
    const terminate = () => void stop(143, 'terminated');
    try {
      child = process.platform === 'win32'
        ? spawnWindowsOwnedProcess(process.execPath, stage.args, { cwd, env })
        : spawn(process.execPath, stage.args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { write(process.stderr, `${stage.name}: ${error.message}\n`); finish(1); return; }
    child.stdin?.end();
    child.stdout.on('data', data => write(process.stdout, data));
    child.stderr.on('data', data => write(process.stderr, data));
    child.once('error', error => void stop(1, error.message));
    child.once('close', code => { if (!stopping) finish(code); });
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    if (stage.timeoutMs) timer = setTimeout(() => void stop(1, 'deadline exceeded'), stage.timeoutMs);
  });
}

export async function runTestStages(stages, { cwd = repo, env = process.env, logDirectory } = {}) {
  if (logDirectory) fs.mkdirSync(logDirectory, { recursive: true });
  const childEnvironment = { ...env };
  for (const key of Object.keys(childEnvironment)) if (key.toUpperCase() === 'NODE_TEST_CONTEXT') delete childEnvironment[key];
  for (const stage of stages) {
    process.stdout.write(`Starting ${stage.name}\n`);
    const code = await runStage(stage, { cwd, env: childEnvironment, logDirectory });
    if (code !== 0) return code;
  }
  return 0;
}

async function main() {
  const args = process.argv.slice(2), phase = args.shift();
  let group, logDirectory;
  while (args.length) {
    const key = args.shift(), value = args.shift();
    if (!value || !['--group', '--log-dir'].includes(key)) throw new Error('Usage: test-platform.mjs unit|regression [--log-dir DIR]');
    if (key === '--group') group = value; else logDirectory = path.resolve(value);
  }
  if (process.platform !== 'win32') {
    process.exitCode = await runTestStages(testPlan(process.platform, phase), { logDirectory });
    return;
  }
  logDirectory ||= path.join(repo, '.superpowers', 'test-runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  const stages = testPlan(process.platform, phase, { group, logDirectory });
  const profile = createWindowsTestProfile();
  process.stdout.write(`Windows test logs: ${logDirectory}\nIsolated test profile: ${profile.root}\n`);
  const report = { phase, group, startedAt: new Date().toISOString(), profile: profile.root, logDirectory };
  try {
    process.exitCode = await runTestStages(stages, { env: profile.env, logDirectory });
    report.exitCode = process.exitCode;
  } catch (error) {
    process.exitCode = report.exitCode = 1;
    report.cleanupUnconfirmed = error.cleanupUnconfirmed === true;
    throw error;
  } finally {
    // Failed fixtures are useful evidence. On success every stage's owned Job
    // has exited, so removing this run's private profile cannot race its child.
    if (report.exitCode === 0) {
      try { fs.rmSync(profile.root, { recursive: true, force: true }); }
      catch (error) { process.exitCode = report.exitCode = 1; report.cleanupError = error.code; }
    }
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.writeFileSync(path.join(logDirectory, 'driver-summary.json'), JSON.stringify(report, null, 2) + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
    // A still-live native controller retains its poll timer. Exiting this
    // owner closes its Job handles after the failed receipt has been saved.
    if (error.cleanupUnconfirmed) process.exit(1);
  });
}
