import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

function hashCommand(command) {
  return createHash('sha256').update(String(command ?? '').trim()).digest('hex');
}

function parseLinuxStat(text) {
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
  return { state, startTicks };
}

export function parseLinuxStatStartTicks(text) {
  return parseLinuxStat(text)?.startTicks || null;
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

function linuxObservation(pid) {
  const first = parseLinuxStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  if (!first) return { state: 'unknown', identity: null };
  if (['Z', 'X', 'x'].includes(first.state)) return { state: 'dead', identity: null };
  const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    .split('\0')
    .filter(Boolean)
    .join(' ');
  const confirmed = parseLinuxStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));

  if (!confirmed) return { state: 'unknown', identity: null };
  if (['Z', 'X', 'x'].includes(confirmed.state)) return { state: 'dead', identity: null };
  if (!bootId || !command.trim() || confirmed.startTicks !== first.startTicks) {
    return { state: 'unknown', identity: null };
  }
  return {
    state: 'live',
    identity: {
      pid,
      startToken: `${bootId}:${first.startTicks}`,
      commandHash: hashCommand(command)
    }
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

const MAC_BOOT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseMacBootToken(text) {
  const uuid = String(text ?? '').trim();
  return MAC_BOOT_UUID.test(uuid) ? uuid.toLowerCase() : null;
}

function macTokenFormat(token) {
  const start = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2}\\s+\\d{1,2} \\d{2}:\\d{2}:\\d{2} \\d{4}';
  const legacy = new RegExp(`^(\\d+):(\\d+):${start}$`).exec(token);
  if (legacy && BigInt(legacy[1]) > 0n && Number(legacy[2]) >= 0 && Number(legacy[2]) <= 999999) return 'legacy-wall-clock';
  const current = /^darwin:([^:]+):(.+)$/.exec(token);
  if (current && MAC_BOOT_UUID.test(current[1]) && new RegExp(`^${start}$`).test(current[2])) return 'boot-session';
  return null;
}

function parseMacStateStart(text) {
  const match = /^(\S+)\s+([^\r\n]+)$/.exec(String(text ?? '').trim());
  // Darwin ps uses X only as a traced/debugged modifier; Z is its exit state.
  if (!match || !/^[IRSTUZ][+<>AELNSsVWX]*$/.test(match[1])) return null;
  return { state: match[1][0], startToken: match[2].trim() };
}

function macObservation(pid) {
  const unknown = { state: 'unknown', identity: null };
  // kern.boottime is a wall-clock timestamp and can change during one boot.
  // The boot-session UUID remains stable across those clock corrections.
  let boot = run('sysctl', ['-n', 'kern.bootsessionuuid']);
  // Launchers often omit /usr/sbin from PATH; macOS still provides sysctl here.
  if (boot.error?.code === 'ENOENT') boot = run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
  if (boot.error || boot.status !== 0) return unknown;
  const bootToken = parseMacBootToken(boot.stdout);
  if (!bootToken) return unknown;

  const psEnvironment = { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' };
  // kill(pid, 0) also succeeds for an unreaped zombie on Darwin. Read state
  // alongside each existing start-time probe, without adding subprocesses.
  const started = run('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='], psEnvironment);
  const first = parseMacStateStart(started.stdout);
  if (started.error || started.status !== 0 || !first) return unknown;
  if (first.state === 'Z') return { state: 'dead', identity: null };
  const command = run('ps', ['-p', String(pid), '-o', 'command='], psEnvironment);
  const confirmedStarted = run('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='], psEnvironment);
  const last = parseMacStateStart(confirmedStarted.stdout);
  if (confirmedStarted.error || confirmedStarted.status !== 0 || !last) return unknown;
  if (last.state === 'Z') return { state: 'dead', identity: null };
  if (command.error || command.status !== 0) return unknown;

  const commandOutput = String(command.stdout ?? '').trim();
  const parsed = parsePsStartIdentity(
    `${first.startToken}\t${commandOutput}\n`
  );
  const confirmed = parsePsStartIdentity(
    `${last.startToken}\t${commandOutput}\n`
  );
  if (!parsed || !confirmed || confirmed.startToken !== parsed.startToken) return unknown;

  return {
    state: 'live',
    identity: {
      pid,
      startToken: `darwin:${bootToken}:${parsed.startToken}`,
      commandHash: hashCommand(parsed.command)
    }
  };
}

function isCompleteIdentity(value) {
  return Number.isInteger(value?.pid) && value.pid > 0 &&
    typeof value.startToken === 'string' && value.startToken.trim().length > 0 &&
    typeof value.commandHash === 'string' && /^[a-f0-9]{64}$/.test(value.commandHash);
}

export async function waitForLiveProcessIdentity(value, options = {}) {
  const inspect = options.inspect || inspectProcessIdentity;
  const monotonicNow = options.monotonicNow || (() => performance.now());
  const wait = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 250));
  const intervalMs = Math.max(1, Number(options.intervalMs ?? 5));
  const deadline = monotonicNow() + timeoutMs;

  while (true) {
    const observed = inspect(value);
    if (observed?.state === 'dead') return { state: 'dead', identity: null };
    if (observed?.state === 'live' && isCompleteIdentity(observed.identity)) return observed;

    const remainingMs = deadline - monotonicNow();
    if (remainingMs <= 0) return { state: 'unknown', identity: null };
    await wait(Math.min(intervalMs, remainingMs));
  }
}

export async function waitForProcessIdentityExit(value, options = {}) {
  const inspect = options.inspect || inspectProcessIdentity;
  const monotonicNow = options.monotonicNow || (() => performance.now());
  const wait = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 5_000));
  const intervalMs = Math.max(1, Number(options.intervalMs ?? 25));
  const storedIdentity = isCompleteIdentity(value) ? value : null;
  const pid = Number(storedIdentity?.pid ?? value);
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'unknown', identity: null };

  const deadline = monotonicNow() + timeoutMs;
  let lastObservation = { state: 'unknown', identity: null };
  while (true) {
    const observed = inspect(pid);
    if (observed?.state === 'dead') return { state: 'dead', identity: null };
    if (observed?.state === 'live' && isCompleteIdentity(observed.identity)) {
      const comparison = storedIdentity ? compareProcessIdentity(storedIdentity, observed.identity) : 'live';
      if (comparison === 'dead') return { state: 'dead', identity: null };
      lastObservation = comparison === 'live' ? observed : { state: 'unknown', identity: null };
    } else {
      lastObservation = { state: 'unknown', identity: null };
    }

    const remainingMs = deadline - monotonicNow();
    if (remainingMs <= 0) return lastObservation;
    await wait(Math.min(intervalMs, remainingMs));
  }
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
    if (process.platform === 'linux') {
      const observed = linuxObservation(pid);
      if (observed.state === 'dead') return observed;
      identity = observed.identity;
    }
    else if (process.platform === 'darwin') {
      const observed = macObservation(pid);
      if (observed.state === 'dead') return observed;
      identity = observed.identity;
    }
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

export function isProcessIdentityIncompatible(stored, current) {
  if (!isCompleteIdentity(stored) || !isCompleteIdentity(current) || stored.pid !== current.pid) return false;
  const storedFormat = macTokenFormat(stored.startToken), currentFormat = macTokenFormat(current.startToken);
  return Boolean(storedFormat && currentFormat && storedFormat !== currentFormat);
}

export function compareProcessIdentity(stored, current) {
  if (!isCompleteIdentity(stored) || !isCompleteIdentity(current)) return 'unknown';
  if (stored.pid !== current.pid) return 'dead';
  if (stored.startToken === current.startToken) return 'live';
  // An upgrade cannot translate wall-clock boot evidence to a boot UUID.
  // Preserve a still-present legacy owner until it exits normally; a format
  // change proves neither ownership nor process exit.
  if (isProcessIdentityIncompatible(stored, current)) return 'unknown';
  return 'dead';
}
