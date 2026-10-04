import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  compareProcessIdentity,
  isProcessIdentityIncompatible,
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

const MAC_BOOT_UUID = '26f764bf-dad6-4f9c-b55d-522470aaf4e8';
const MAC_PROCESS_START = 'Mon Aug  3 06:10:11 2026';
const MAC_START_TOKEN = `darwin:${MAC_BOOT_UUID}:${MAC_PROCESS_START}`;

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
    if (command === 'sysctl') return successfulCommand(MAC_BOOT_UUID + '\n');
    if (args.at(-1) === 'lstart=') {
      return successfulCommand(startReads++ === 0
        ? 'S  Mon Aug  3 06:10:11 2026\n'
        : 'R+ Mon Aug  3 06:10:12 2026\n');
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

for (const scenario of [
  { name: 'zombie present before inspection', first: 'Z', last: 'Z', expected: 'dead', reads: 1 },
  { name: 'unsupported primary state remains unknown', first: 'X', last: 'X', expected: 'unknown', reads: 1 },
  { name: 'becomes a zombie during inspection', first: 'S', last: 'Z+', expected: 'dead', reads: 2 },
  { name: 'ordinary process with documented state modifiers', first: 'S+<>AELNSsVWX', last: 'R+', expected: 'live', reads: 2 },
  { name: 'sleeping process using FIFO page replacement', first: 'SS', last: 'SS', expected: 'live', reads: 2 },
  { name: 'sleeping process being debugged', first: 'SX', last: 'SX', expected: 'live', reads: 2 },
  { name: 'stopped process being debugged', first: 'TX', last: 'TX', expected: 'live', reads: 2 },
  { name: 'malformed initial state', first: 'invalid', last: 'S', expected: 'unknown', reads: 1 },
  { name: 'malformed confirming state', first: 'S', last: 'S!', expected: 'unknown', reads: 2 }
]) {
  test(`macOS process state: ${scenario.name}`, t => {
    t.mock.method(process, 'kill', () => {}); // PID remains addressable, including Z.
    let reads = 0;
    const spawnMock = t.mock.method(childProcess, 'spawnSync', (command, args) => {
      if (command === 'sysctl') return successfulCommand(MAC_BOOT_UUID + '\n');
      if (args.at(-1) === 'lstart=') {
        assert.deepEqual(args.slice(-4), ['-o', 'stat=', '-o', 'lstart=']);
        const state = reads++ === 0 ? scenario.first : scenario.last;
        return successfulCommand(`${state} Mon Aug  3 06:10:11 2026\n`);
      }
      if (args.at(-1) === 'command=') return successfulCommand('/usr/bin/node app.mjs\n');
      throw new Error('unexpected fixture command');
    });
    syncBuiltinESMExports();
    try {
      const observed = withPlatform('darwin', () => inspectProcessIdentity(42));
      assert.equal(observed.state, scenario.expected);
      assert.equal(reads, scenario.reads);
      if (scenario.expected !== 'live') assert.equal(observed.identity, null);
      else assert.equal(observed.identity.startToken, MAC_START_TOKEN);
    } finally {
      spawnMock.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test('an owned unreaped macOS zombie is dead to both inspection and exit waiting', t => {
  if (process.platform !== 'darwin') { t.skip('Darwin zombie acceptance'); return; }
  // Python is only a parent that can defer waitpid; Node reaps its own child
  // processes automatically. Every path releases and reaps this owned child.
  const script = String.raw`
import json, os, subprocess, sys, time
node, module = sys.argv[1:]
probe_script = 'import fs from "node:fs"; import {inspectProcessIdentity,waitForProcessIdentityExit} from '+json.dumps(module)+''';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
if(input.capture) console.log(JSON.stringify(inspectProcessIdentity(input.pid)));
else console.log(JSON.stringify({observedState:inspectProcessIdentity(input.pid).state,
waitState:(await waitForProcessIdentityExit(input.owner,{timeoutMs:200,intervalMs:25})).state}));'''
def probe(payload):
    result=subprocess.run([node,'--input-type=module','-e',probe_script],input=json.dumps(payload),text=True,capture_output=True,timeout=3)
    if result.returncode: raise RuntimeError('owned process probe failed')
    return json.loads(result.stdout)
r,w=os.pipe(); pid=os.fork()
if pid==0:
    os.close(w)
    try: os.read(r,1)
    finally: os._exit(0)
os.close(r); report={}; released=False
try:
    captured=probe({'capture':True,'pid':pid})
    report['initialObservedState']=captured['state']
    if captured['state']!='live': raise RuntimeError('owned process identity unavailable')
    os.write(w,b'1'); released=True
    deadline=time.monotonic()+3
    while time.monotonic()<deadline:
        result=subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True,timeout=1)
        report['psState']=result.stdout.strip()
        if report['psState'].startswith('Z'): break
        time.sleep(0.02)
    os.kill(pid,0); report['pidStillPresent']=True
    report.update(probe({'pid':pid,'owner':captured['identity']}))
finally:
    if not released:
        try: os.write(w,b'1')
        except OSError: pass
    os.close(w)
    reaped,status=os.waitpid(pid,0)
    report['reapedByParent']=reaped==pid
    report['childExitedNormally']=os.WIFEXITED(status) and os.WEXITSTATUS(status)==0
    print(json.dumps(report))
`;
  const result = childProcess.spawnSync('python3', ['-c', script, process.execPath,
    new URL('../lib/process/identity.mjs', import.meta.url).href], { encoding: 'utf8', timeout: 15000 });
  if (result.error?.code === 'ENOENT') { t.skip('Python 3 unavailable for owned fork fixture'); return; }
  assert.equal(result.status, 0, 'owned zombie fixture failed');
  const report = JSON.parse(result.stdout);
  assert.equal(report.initialObservedState, 'live');
  assert.match(report.psState, /^Z/);
  assert.equal(report.pidStillPresent, true);
  assert.equal(report.observedState, 'dead');
  assert.equal(report.waitState, 'dead');
  assert.equal(report.reapedByParent, true);
  assert.equal(report.childExitedNormally, true);
  t.diagnostic(JSON.stringify(report));
});

test('collects the same macOS identity under different caller locales', (t) => {
  t.mock.method(process, 'kill', () => {});
  const psEnvironments = [];
  const spawnMock = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    if (command === 'sysctl') {
      assert.deepEqual(args, ['-n', 'kern.bootsessionuuid']);
      return successfulCommand(MAC_BOOT_UUID + '\n');
    }
    psEnvironments.push(options?.env);
    const deterministic = options?.env?.TZ === 'UTC' &&
      options.env.LC_ALL === 'C' && options.env.LANG === 'C';
    if (args.at(-1) === 'lstart=') {
      return successfulCommand(deterministic || process.env.TZ === 'Asia/Shanghai'
        ? 'S  Mon Aug  3 06:10:11 2026\n'
        : 'S  Sun Aug  2 15:10:11 2026\n');
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
    assert.equal(first.identity.startToken, MAC_START_TOKEN);
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

test('returns unknown for malformed or absent macOS boot-session UUID without a wall-clock fallback', (t) => {
  t.mock.method(process, 'kill', () => {});
  const bootOutputs = ['', 'not-a-uuid\n', '{ sec = 100, usec = 42 }\n',
    '00000000-0000-0000-0000-000000000000\n', MAC_BOOT_UUID + '\n' + MAC_BOOT_UUID,
    '26f764bf-dad6-0f9c-b55d-522470aaf4e8', '26f764bf-dad6-4f9c-755d-522470aaf4e8'];
  const spawnMock = t.mock.method(childProcess, 'spawnSync', (command, args) => {
    assert.equal(command, 'sysctl');
    assert.deepEqual(args, ['-n', 'kern.bootsessionuuid']);
    return successfulCommand(bootOutputs.shift());
  });
  syncBuiltinESMExports();
  try {
    while (bootOutputs.length) assert.deepEqual(withPlatform('darwin', () => inspectProcessIdentity(42)), { state: 'unknown', identity: null });
  } finally { spawnMock.mock.restore(); syncBuiltinESMExports(); }
});

for (const failure of [{ status: 1, stdout: '', stderr: 'unknown oid' },
  { error: { code: 'EACCES' }, status: null, stdout: '' }]) {
  test(`macOS boot-session query failure stays unknown (${failure.error?.code || failure.status})`, t => {
    t.mock.method(process, 'kill', () => {});
    const spawnMock = t.mock.method(childProcess, 'spawnSync', (command, args) => {
      assert.equal(command, 'sysctl'); assert.deepEqual(args, ['-n', 'kern.bootsessionuuid']); return failure;
    });
    syncBuiltinESMExports();
    try { assert.deepEqual(withPlatform('darwin', () => inspectProcessIdentity(42)), { state: 'unknown', identity: null }); }
    finally { spawnMock.mock.restore(); syncBuiltinESMExports(); }
  });
}

test('missing sysctl PATH entry uses the same boot-session query at its system path', t => {
  t.mock.method(process, 'kill', () => {});
  const calls = [];
  const spawnMock = t.mock.method(childProcess, 'spawnSync', (command, args) => {
    calls.push([command, args]);
    if (command === 'sysctl') return { error: { code: 'ENOENT' }, status: null };
    if (command === '/usr/sbin/sysctl') return successfulCommand(MAC_BOOT_UUID.toUpperCase() + '\n');
    if (args.at(-1) === 'lstart=') return successfulCommand('S ' + MAC_PROCESS_START + '\n');
    if (args.at(-1) === 'command=') return successfulCommand('/usr/bin/node app.mjs\n');
    throw new Error('unexpected fixture command');
  });
  syncBuiltinESMExports();
  try {
    const observed = withPlatform('darwin', () => inspectProcessIdentity(42));
    assert.equal(observed.state, 'live'); assert.equal(observed.identity.startToken, MAC_START_TOKEN);
    assert.deepEqual(calls.slice(0, 2), [['sysctl', ['-n', 'kern.bootsessionuuid']], ['/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']]]);
  } finally { spawnMock.mock.restore(); syncBuiltinESMExports(); }
});

test('macOS clock-adjusted boottime never enters the process identity; a new boot UUID does', t => {
  t.mock.method(process, 'kill', () => {});
  let bootUuid = MAC_BOOT_UUID, wallBootUsec = 539676;
  const reads = [];
  const spawnMock = t.mock.method(childProcess, 'spawnSync', (command, args) => {
    if (command === 'sysctl') {
      reads.push(args[1]);
      if (args[1] === 'kern.boottime') return successfulCommand(`{ sec = 1789353593, usec = ${wallBootUsec} }\n`);
      if (args[1] === 'kern.bootsessionuuid') return successfulCommand(bootUuid + '\n');
    }
    if (args.at(-1) === 'lstart=') return successfulCommand('S ' + MAC_PROCESS_START + '\n');
    if (args.at(-1) === 'command=') return successfulCommand('/usr/bin/node app.mjs\n');
    throw new Error('unexpected fixture command');
  });
  syncBuiltinESMExports();
  try {
    const first = withPlatform('darwin', () => inspectProcessIdentity(42));
    wallBootUsec = 379612;
    const corrected = withPlatform('darwin', () => inspectProcessIdentity(42));
    assert.equal(first.state, 'live'); assert.deepEqual(corrected, first);
    bootUuid = 'fd45eeca-410c-464b-b795-39a8d9c6059e';
    const rebooted = withPlatform('darwin', () => inspectProcessIdentity(42));
    assert.equal(rebooted.state, 'live');
    assert.equal(compareProcessIdentity(first.identity, rebooted.identity), 'dead');
    assert.deepEqual(reads, ['kern.bootsessionuuid', 'kern.bootsessionuuid', 'kern.bootsessionuuid']);
  } finally { spawnMock.mock.restore(); syncBuiltinESMExports(); }
});

test('legacy Darwin wall-clock and current boot-session tokens grant neither ownership nor exit', async () => {
  const legacy = { pid: 42, startToken: `100:42:${MAC_PROCESS_START}`, commandHash: 'a'.repeat(64) };
  const current = { ...legacy, startToken: MAC_START_TOKEN };
  assert.equal(compareProcessIdentity(legacy, current), 'unknown');
  assert.equal(compareProcessIdentity(current, legacy), 'unknown');
  assert.equal(compareProcessIdentity(legacy, legacy), 'live');
  assert.equal(compareProcessIdentity(current, current), 'live');
  assert.equal(compareProcessIdentity(legacy, { ...current, pid: 43 }), 'dead');
  assert.equal(isProcessIdentityIncompatible(legacy, current), true);
  assert.equal(isProcessIdentityIncompatible(current, legacy), true);
  assert.equal(isProcessIdentityIncompatible(legacy, { ...current, pid: 43 }), false);
  assert.equal(isProcessIdentityIncompatible(legacy, { ...current, commandHash: null }), false);
  assert.equal(isProcessIdentityIncompatible(legacy, { ...current, startToken: 'darwin:invalid:Mon Aug  3 06:10:11 2026' }), false);
  assert.equal(isProcessIdentityIncompatible(legacy, legacy), false);
  assert.equal(isProcessIdentityIncompatible({ ...legacy, startToken: `0:42:${MAC_PROCESS_START}` }, current), false);
  assert.equal(isProcessIdentityIncompatible({ ...legacy, startToken: `100:1000000:${MAC_PROCESS_START}` }, current), false);
  assert.deepEqual(await waitForProcessIdentityExit(legacy, { timeoutMs: 0,
    inspect: () => ({ state: 'live', identity: current }) }), { state: 'unknown', identity: null });
  assert.deepEqual(await waitForProcessIdentityExit(legacy, { timeoutMs: 0,
    inspect: () => ({ state: 'dead', identity: null }) }), { state: 'dead', identity: null });
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
