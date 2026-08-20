import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  compareProcessIdentity,
  inspectProcessIdentity,
  parseLinuxStatStartTicks,
  parsePsStartIdentity,
  waitForProcessIdentityExit,
  waitForLiveProcessIdentity
} from '../lib/process/identity.mjs';

function linuxStatRow(pid, command, startTicks, state = 'S') {
  const fields = [state, ...Array.from({ length: 29 }, (_, i) => String(i + 1))];
  fields[19] = String(startTicks);
  return `${pid} (${command}) ${fields.join(' ')}`;
}

function withPlatform(platform, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return callback();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

function inspectMockLinuxProcess(t, { command, firstStartTicks, secondStartTicks, state = 'S' }) {
  t.mock.method(process, 'kill', () => {});
  let statReads = 0;
  t.mock.method(fs, 'readFileSync', (path) => {
    if (path === '/proc/42/stat') {
      const startTicks = statReads++ === 0 ? firstStartTicks : secondStartTicks;
      return linuxStatRow(42, 'worker', startTicks, state);
    }
    if (path === '/proc/sys/kernel/random/boot_id') return 'boot-a\n';
    if (path === '/proc/42/cmdline') return command;
    throw new Error(`unexpected fixture path: ${path}`);
  });
  return withPlatform('linux', () => inspectProcessIdentity(42));
}

function successfulCommand(stdout) {
  return { error: undefined, status: 0, stdout, stderr: '' };
}

test('reads a stable identity for the current process', () => {
  const first = inspectProcessIdentity(process.pid);
  const second = inspectProcessIdentity(process.pid);
  assert.equal(first.state, 'live');
  assert.deepEqual(second.identity, first.identity);
  assert.equal(compareProcessIdentity(first.identity, second.identity), 'live');
});

test('parses Linux stat when command contains spaces and an unmatched right parenthesis', () => {
  assert.equal(parseLinuxStatStartTicks(linuxStatRow(42, 'worker ) one', 987654)), '987654');
});

test('rejects a malformed Linux process state', () => {
  assert.equal(parseLinuxStatStartTicks(linuxStatRow(42, 'worker', 987654, 'invalid')), null);
});

test('parses macOS ps start and command identity', () => {
  assert.deepEqual(parsePsStartIdentity('Mon Aug  3 06:10:11 2026\t/usr/bin/node app.mjs\n'), {
    startToken: 'Mon Aug  3 06:10:11 2026',
    command: '/usr/bin/node app.mjs'
  });
});

test('returns unknown when Linux start identity changes during inspection', (t) => {
  const result = inspectMockLinuxProcess(t, {
    command: '/usr/bin/node\0app.mjs\0',
    firstStartTicks: 100,
    secondStartTicks: 200
  });
  assert.deepEqual(result, { state: 'unknown', identity: null });
});

test('returns unknown when Linux cmdline is empty', (t) => {
  const result = inspectMockLinuxProcess(t, {
    command: '\0',
    firstStartTicks: 100,
    secondStartTicks: 100
  });
  assert.deepEqual(result, { state: 'unknown', identity: null });
});

test('reports a Linux zombie as dead while its pid still exists', (t) => {
  const result = inspectMockLinuxProcess(t, {
    command: '\0',
    firstStartTicks: 100,
    secondStartTicks: 100,
    state: 'Z'
  });
  assert.deepEqual(result, { state: 'dead', identity: null });
});

test('returns unknown when macOS start identity changes during inspection', (t) => {
  t.mock.method(process, 'kill', () => {});
  let startReads = 0;
  const spawnMock = t.mock.method(childProcess, 'spawnSync', (command, args) => {
    if (command === 'sysctl') return successfulCommand('{ sec = 1, usec = 0 }\n');
    if (args.at(-1) === 'lstart=') {
      return successfulCommand(startReads++ === 0
        ? 'Mon Aug  3 06:10:11 2026\n'
        : 'Mon Aug  3 06:10:12 2026\n');
    }
    if (args.at(-1) === 'command=') return successfulCommand('/usr/bin/node app.mjs\n');
    throw new Error(`unexpected fixture command: ${command} ${args.join(' ')}`);
  });
  syncBuiltinESMExports();
  try {
    const result = withPlatform('darwin', () => inspectProcessIdentity(42));
    assert.deepEqual(result, { state: 'unknown', identity: null });
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('collects the same macOS identity under different caller locales', (t) => {
  t.mock.method(process, 'kill', () => {});
  const psEnvironments = [];
  const spawnMock = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    if (command === 'sysctl') {
      return successfulCommand(
        `{ sec = 100, usec = 42 } ${process.env.TZ}/${process.env.LC_ALL}/${process.env.LANG}\n`
      );
    }
    psEnvironments.push(options?.env);
    const deterministic = options?.env?.TZ === 'UTC' &&
      options.env.LC_ALL === 'C' && options.env.LANG === 'C';
    if (args.at(-1) === 'lstart=') {
      return successfulCommand(deterministic || process.env.TZ === 'Asia/Shanghai'
        ? 'Mon Aug  3 06:10:11 2026\n'
        : 'Sun Aug  2 15:10:11 2026\n');
    }
    if (args.at(-1) === 'command=') return successfulCommand('/usr/bin/node app.mjs\n');
    throw new Error(`unexpected fixture command: ${command} ${args.join(' ')}`);
  });
  const originalEnvironment = {
    TZ: process.env.TZ,
    LC_ALL: process.env.LC_ALL,
    LANG: process.env.LANG
  };
  syncBuiltinESMExports();
  try {
    Object.assign(process.env, { TZ: 'Asia/Shanghai', LC_ALL: 'zh_CN.UTF-8', LANG: 'zh_CN.UTF-8' });
    const first = withPlatform('darwin', () => inspectProcessIdentity(42));
    Object.assign(process.env, { TZ: 'America/Los_Angeles', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' });
    const second = withPlatform('darwin', () => inspectProcessIdentity(42));

    assert.equal(first.state, 'live');
    assert.equal(first.identity.startToken, '100:42:Mon Aug  3 06:10:11 2026');
    assert.deepEqual(second.identity, first.identity);
    assert.equal(psEnvironments.length, 6);
    for (const environment of psEnvironments) {
      assert.equal(environment?.TZ, 'UTC');
      assert.equal(environment?.LC_ALL, 'C');
      assert.equal(environment?.LANG, 'C');
      assert.equal(environment?.PATH, process.env.PATH);
    }
  } finally {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('returns unknown for malformed macOS boot time fields', (t) => {
  t.mock.method(process, 'kill', () => {});
  const bootOutputs = ['not a boot time\n', '{ sec = 100 } Mon Aug  3 06:10:11 2026\n'];
  const spawnMock = t.mock.method(childProcess, 'spawnSync', (command, args) => {
    if (command === 'sysctl') return successfulCommand(bootOutputs.shift());
    if (args.at(-1) === 'lstart=') return successfulCommand('Mon Aug  3 06:10:11 2026\n');
    if (args.at(-1) === 'command=') return successfulCommand('/usr/bin/node app.mjs\n');
    throw new Error(`unexpected fixture command: ${command} ${args.join(' ')}`);
  });
  syncBuiltinESMExports();
  try {
    const malformed = withPlatform('darwin', () => inspectProcessIdentity(42));
    const missingUsec = withPlatform('darwin', () => inspectProcessIdentity(42));
    assert.deepEqual(malformed, { state: 'unknown', identity: null });
    assert.deepEqual(missingUsec, { state: 'unknown', identity: null });
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('rejects a reused PID fingerprint', () => {
  const stored = { pid: 42, startToken: 'boot-a:100', commandHash: 'a'.repeat(64) };
  const current = { pid: 42, startToken: 'boot-a:200', commandHash: 'a'.repeat(64) };
  assert.equal(compareProcessIdentity(stored, current), 'dead');
  assert.equal(compareProcessIdentity(null, current), 'unknown');
});

test('reports a PID that does not exist as dead', () => {
  assert.deepEqual(inspectProcessIdentity(2147483647), { state: 'dead', identity: null });
});

test('treats invalid and non-positive PIDs as unknown', () => {
  const unknown = { state: 'unknown', identity: null };
  assert.deepEqual(inspectProcessIdentity(Symbol('bad')), unknown);
  assert.deepEqual(inspectProcessIdentity(0), unknown);
  assert.deepEqual(inspectProcessIdentity('not-a-pid'), unknown);
});

test('treats a partial stored fingerprint as unknown', () => {
  const stored = { pid: 42, startToken: 'boot-a:100' };
  const current = { pid: 42, startToken: 'boot-a:100', commandHash: 'a'.repeat(64) };
  assert.equal(compareProcessIdentity(stored, current), 'unknown');
});

test('keeps the same process instance live when exec changes its command hash', () => {
  const stored = { pid: 42, startToken: 'boot-a:100', commandHash: 'a'.repeat(64) };
  const current = { pid: 42, startToken: 'boot-a:100', commandHash: 'b'.repeat(64) };
  assert.equal(compareProcessIdentity(stored, current), 'live');
});

test('waits through unknown observations until a complete process identity is live', async () => {
  const complete = {
    pid: 42,
    startToken: 'boot-a:100',
    commandHash: 'a'.repeat(64)
  };
  const observations = [
    { state: 'unknown', identity: null },
    { state: 'unknown', identity: null },
    { state: 'live', identity: complete }
  ];
  const sleeps = [];
  let monotonicMs = 0;

  const result = await waitForLiveProcessIdentity(42, {
    timeoutMs: 20,
    intervalMs: 5,
    inspect: () => observations.shift(),
    monotonicNow: () => monotonicMs,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      monotonicMs += delayMs;
    }
  });

  assert.deepEqual(result, { state: 'live', identity: complete });
  assert.deepEqual(sleeps, [5, 5]);
});

test('stops waiting immediately when the child is dead', async () => {
  let slept = false;
  const result = await waitForLiveProcessIdentity(42, {
    timeoutMs: 20,
    inspect: () => ({ state: 'dead', identity: null }),
    monotonicNow: () => 0,
    sleep: async () => { slept = true; }
  });

  assert.deepEqual(result, { state: 'dead', identity: null });
  assert.equal(slept, false);
});

test('returns unknown at the monotonic identity deadline', async () => {
  let monotonicMs = 100;
  let inspections = 0;
  const result = await waitForLiveProcessIdentity(42, {
    timeoutMs: 10,
    intervalMs: 6,
    inspect: () => {
      inspections += 1;
      return { state: 'unknown', identity: null };
    },
    monotonicNow: () => monotonicMs,
    sleep: async (delayMs) => { monotonicMs += delayMs; }
  });

  assert.deepEqual(result, { state: 'unknown', identity: null });
  assert.equal(monotonicMs, 110);
  assert.equal(inspections, 3);
});

test('waits for the exact process identity to exit', async () => {
  const stored = { pid: 42, startToken: 'boot-a:100', commandHash: 'a'.repeat(64) };
  const observations = [
    { state: 'live', identity: stored },
    { state: 'dead', identity: null }
  ];
  let monotonicMs = 0;

  const result = await waitForProcessIdentityExit(stored, {
    timeoutMs: 20,
    intervalMs: 5,
    inspect: () => observations.shift(),
    monotonicNow: () => monotonicMs,
    sleep: async (delayMs) => { monotonicMs += delayMs; }
  });

  assert.deepEqual(result, { state: 'dead', identity: null });
  assert.equal(monotonicMs, 5);
});

test('treats PID reuse as exit of the stored process instance', async () => {
  const stored = { pid: 42, startToken: 'boot-a:100', commandHash: 'a'.repeat(64) };
  const replacement = { pid: 42, startToken: 'boot-a:200', commandHash: 'b'.repeat(64) };

  const result = await waitForProcessIdentityExit(stored, {
    inspect: () => ({ state: 'live', identity: replacement }),
    monotonicNow: () => 0,
    sleep: async () => { throw new Error('must not sleep after PID reuse'); }
  });

  assert.deepEqual(result, { state: 'dead', identity: null });
});

test('reports a still-live process when the exit deadline expires', async () => {
  const stored = { pid: 42, startToken: 'boot-a:100', commandHash: 'a'.repeat(64) };
  let monotonicMs = 10;

  const result = await waitForProcessIdentityExit(stored, {
    timeoutMs: 10,
    intervalMs: 6,
    inspect: () => ({ state: 'live', identity: stored }),
    monotonicNow: () => monotonicMs,
    sleep: async (delayMs) => { monotonicMs += delayMs; }
  });

  assert.deepEqual(result, { state: 'live', identity: stored });
  assert.equal(monotonicMs, 20);
});

test('captures a complete real PTY identity that remains live across delayed exec', async (t) => {
  if (!['linux', 'darwin'].includes(process.platform)) {
    t.skip('process identity is supported on Linux and macOS');
    return;
  }
  const ptyModule = await import('node-pty');
  const pty = ptyModule.default || ptyModule;
  const child = pty.spawn('/bin/bash', [
    '--noprofile', '--norc', '-c',
    'trap "" HUP; sleep 0.1; exec sleep 30'
  ], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' }
  });

  try {
    const captured = await waitForLiveProcessIdentity(child.pid, { timeoutMs: 1000 });
    assert.equal(captured.state, 'live');
    assert.equal(captured.identity?.pid, child.pid);
    assert.ok(captured.identity?.startToken);
    assert.match(captured.identity?.commandHash || '', /^[a-f0-9]{64}$/);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterExec = inspectProcessIdentity(child.pid);
    assert.equal(afterExec.state, 'live');
    assert.equal(compareProcessIdentity(captured.identity, afterExec.identity), 'live');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
  }
});

test('rejects malformed Linux and macOS identity rows', () => {
  assert.equal(parseLinuxStatStartTicks('42 (worker) S 1 2 3'), null);
  assert.equal(parseLinuxStatStartTicks('42 worker) S 1 2 3'), null);
  assert.equal(parsePsStartIdentity('Mon Aug  3 06:10:11 2026 /usr/bin/node app.mjs\n'), null);
  assert.equal(parsePsStartIdentity('\t/usr/bin/node app.mjs\n'), null);
});
