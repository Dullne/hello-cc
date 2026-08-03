import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

function hashCommand(command) {
  return createHash('sha256').update(String(command ?? '').trim()).digest('hex');
}

export function parseLinuxStatStartTicks(text) {
  const stat = String(text ?? '');
  const prefix = stat.match(/^\s*\d+\s+\(/);
  if (!prefix) return null;

  const close = stat.lastIndexOf(')');
  if (close < prefix[0].length - 1 || !/^\s/.test(stat.slice(close + 1))) return null;

  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const startTicks = fields[19];
  if (fields.length < 20 || !/^[RSDZTWXxKtPI]$/.test(state) ||
      !/^\d+$/.test(startTicks) || BigInt(startTicks) <= 0n) return null;
  return startTicks;
}

export function parsePsStartIdentity(text) {
  const line = String(text ?? '').trimEnd();
  if (line.includes('\n') || line.includes('\r')) return null;

  const tab = line.indexOf('\t');
  if (tab < 0) return null;

  const startToken = line.slice(0, tab).trim();
  const command = line.slice(tab + 1).trim();
  return startToken && command ? { startToken, command } : null;
}

function probeProcess(pid) {
  try {
    process.kill(pid, 0);
    return 'present';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    if (error?.code === 'EPERM') return 'present';
    return 'unknown';
  }
}

function linuxIdentity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const startTicks = parseLinuxStatStartTicks(stat);
  const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    .split('\0')
    .filter(Boolean)
    .join(' ');
  const confirmedStartTicks = parseLinuxStatStartTicks(
    fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  );

  if (!startTicks || !bootId || !command.trim() || confirmedStartTicks !== startTicks) return null;
  return {
    pid,
    startToken: `${bootId}:${startTicks}`,
    commandHash: hashCommand(command)
  };
}

function run(command, args, environment) {
  const options = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  };
  if (environment) options.env = environment;
  return spawnSync(command, args, options);
}

function parseMacBootToken(text) {
  const match = String(text ?? '').match(
    /^\s*\{\s*sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)\s*\}/
  );
  if (!match) return null;

  const seconds = BigInt(match[1]);
  const microseconds = Number(match[2]);
  if (seconds <= 0n || !Number.isInteger(microseconds) ||
      microseconds < 0 || microseconds > 999999) return null;
  return `${seconds}:${microseconds}`;
}

function macIdentity(pid) {
  const boot = run('sysctl', ['-n', 'kern.boottime']);
  if (boot.error || boot.status !== 0) return null;
  const bootToken = parseMacBootToken(boot.stdout);
  if (!bootToken) return null;

  const psEnvironment = { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' };
  const started = run('ps', ['-p', String(pid), '-o', 'lstart='], psEnvironment);
  const command = run('ps', ['-p', String(pid), '-o', 'command='], psEnvironment);
  const confirmedStarted = run('ps', ['-p', String(pid), '-o', 'lstart='], psEnvironment);
  if (started.error || command.error || confirmedStarted.error) return null;
  if (started.status !== 0 ||
      command.status !== 0 || confirmedStarted.status !== 0) return null;

  const commandOutput = String(command.stdout ?? '').trim();
  const parsed = parsePsStartIdentity(
    `${String(started.stdout ?? '').trim()}\t${commandOutput}\n`
  );
  const confirmed = parsePsStartIdentity(
    `${String(confirmedStarted.stdout ?? '').trim()}\t${commandOutput}\n`
  );
  if (!parsed || !confirmed || confirmed.startToken !== parsed.startToken) return null;

  return {
    pid,
    startToken: `${bootToken}:${parsed.startToken}`,
    commandHash: hashCommand(parsed.command)
  };
}

function isCompleteIdentity(value) {
  return Number.isInteger(value?.pid) && value.pid > 0 &&
    typeof value.startToken === 'string' && value.startToken.trim().length > 0 &&
    typeof value.commandHash === 'string' && /^[a-f0-9]{64}$/.test(value.commandHash);
}

export function inspectProcessIdentity(value) {
  let pid;
  try {
    pid = Number(value);
  } catch {
    return { state: 'unknown', identity: null };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'unknown', identity: null };

  const initialState = probeProcess(pid);
  if (initialState === 'dead') return { state: 'dead', identity: null };
  if (initialState === 'unknown') return { state: 'unknown', identity: null };

  let identity = null;
  try {
    if (process.platform === 'linux') identity = linuxIdentity(pid);
    else if (process.platform === 'darwin') identity = macIdentity(pid);
  } catch {
    identity = null;
  }

  const finalState = probeProcess(pid);
  if (finalState === 'dead') return { state: 'dead', identity: null };
  if (finalState === 'unknown' || !isCompleteIdentity(identity)) {
    return { state: 'unknown', identity: null };
  }
  return { state: 'live', identity };
}

export function compareProcessIdentity(stored, current) {
  if (!isCompleteIdentity(stored) || !isCompleteIdentity(current)) return 'unknown';
  return stored.pid === current.pid &&
    stored.startToken === current.startToken &&
    stored.commandHash === current.commandHash ? 'live' : 'dead';
}
