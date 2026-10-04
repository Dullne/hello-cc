import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { observeFixtureOwner, signalFixtureOwner, waitForFixtureOwnerExit,
  fixtureDiagnosticText, fixtureDownResult, fixtureFailureError,
  fixtureFailureDiagnostic, fixtureStopEnvironment } from '../scripts/regression.mjs';
import { readRuntime } from '../lib/runtime/state.mjs';
import { formatJson } from '../lib/format.mjs';

const owner = { pid: 12345, startToken: 'boot:original', commandHash: 'a'.repeat(64) };
const observation = (value, state = 'S') => observeFixtureOwner(owner, {
  inspect: () => value, psState: () => state
});

test('fixture entry guard runs direct and aliased entries but preserves import-only execution', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-reg-entry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entry = path.join(directory, 'entry.mjs');
  const alias = path.join(directory, 'alias.mjs');
  const regressionUrl = pathToFileURL(path.resolve(import.meta.dirname, '../scripts/regression.mjs')).href;
  fs.writeFileSync(entry, `import { isRegressionEntry } from ${JSON.stringify(regressionUrl)};
    if (isRegressionEntry(process.argv[1], import.meta.filename)) console.log('fixture-main');
  `);
  fs.symlinkSync(entry, alias);
  const options = { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 };
  for (const file of [entry, alias]) {
    const direct = spawnSync(process.execPath, [file], options);
    assert.equal(direct.status, 0);
    assert.equal(direct.stdout, 'fixture-main\n');
    assert.equal(direct.stderr, '');
  }
  const importer = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log('import-only');`], options);
  assert.equal(importer.status, 0);
  assert.equal(importer.stdout, 'import-only\n');
  assert.equal(importer.stderr, '');
});

test('fixture import does not run regression; owner observations distinguish reuse, zombies and unknown evidence', () => {
  assert.equal(observation({ state: 'live', identity: owner }).state, 'same-owner');
  assert.equal(observation({ state: 'dead', identity: null }, null).reason, 'process_dead');
  assert.equal(observation({ state: 'live', identity: owner }, 'Z+').reason, 'zombie_or_dead');
  assert.equal(observation({ state: 'unknown', identity: null }, 'Z').state, 'exited');
  assert.equal(observation({ state: 'live', identity: { ...owner, startToken: 'boot:replacement' } }).reason, 'pid_reused');
  assert.equal(observation({ state: 'live', identity: { ...owner, commandHash: 'b'.repeat(64) } }).state, 'unknown');
  assert.equal(observation({ state: 'unknown', identity: null }).state, 'unknown');
  assert.equal(observeFixtureOwner(null).reason, 'missing_owner_identity');
});

test('signals recheck original ownership and never signal a reused, zombie or unknown PID', () => {
  const sent = [];
  const states = [
    observation({ state: 'live', identity: { ...owner, startToken: 'replacement' } }),
    observation({ state: 'live', identity: owner }, 'Z'),
    observation({ state: 'unknown', identity: null }),
    observation({ state: 'live', identity: owner })
  ];
  for (const observed of states) {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const result = signalFixtureOwner(owner, signal, { observe: () => observed,
        send: (pid, value) => sent.push([pid, value]) });
      assert.equal(result.sent, observed.state === 'same-owner');
    }
  }
  assert.deepEqual(sent, [[owner.pid, 'SIGTERM'], [owner.pid, 'SIGKILL']]);
});

test('fixture owner refuses signals when macOS start-token formats cannot be compared', () => {
  const suffix = '26f764bf-dad6-4f9c-b55d-522470aaf4e8:Mon Aug  3 06:10:11 2026';
  const legacy = { ...owner, startToken: `mac:${suffix}` };
  const current = { ...owner, startToken: `darwin:${suffix}` };
  const sent = [];
  for (const [stored, inspected] of [[legacy, current], [current, legacy]]) {
    const observe = () => observeFixtureOwner(stored, {
      inspect: () => ({ state: 'live', identity: inspected }), psState: () => 'S'
    });
    assert.equal(observe().state, 'unknown');
    assert.equal(observe().reason, 'identity_incompatible');
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      assert.equal(signalFixtureOwner(stored, signal, {
        observe, send: (pid, value) => sent.push([pid, value])
      }).sent, false);
    }
  }
  assert.deepEqual(sent, []);
});

test('fixture wait accepts original owner exit by PID reuse without signaling the replacement', async () => {
  let calls = 0, clock = 0;
  const result = await waitForFixtureOwnerExit(owner, 5000, {
    observe: () => ++calls < 3 ? { state: 'same-owner' } : { state: 'exited', reason: 'pid_reused' },
    monotonicNow: () => clock, wait: async ms => { clock += ms; }
  });
  assert.equal(result.reason, 'pid_reused');
  assert.equal(clock, 200);
});

for (const state of ['same-owner', 'unknown']) {
  test(`fixture wait preserves its exact deadline for ${state} evidence`, async () => {
    let clock = 0;
    await assert.rejects(waitForFixtureOwnerExit(owner, 5000, {
      observe: () => ({ state }), monotonicNow: () => clock,
      wait: async ms => { clock += ms; }
    }), error => error.observation.state === state);
    assert.equal(clock, 5000);
  });
}

test('diagnostics retain down code and safe context without stdout, message bodies or credentials', () => {
  const result = fixtureDownResult({ status: 1, stdout: JSON.stringify({ ok: false,
    error: { code: 'RUNTIME_STOP_TIMEOUT', message: 'stop failed', extra: {
      pid: owner.pid, state: 'unknown', token: 'hidden-token', body: 'private user text',
      method: 'POST', path: '/api/runtime/stop', timeoutMs: 8000,
      message: 'private user text\nsecond private line', runtime: 'private user text',
      elapsedMs: 'private user text', errorName: 'private user text'
    } } }), stderr: 'private user text Bearer hidden-token' });
  assert.equal(result.code, 'RUNTIME_STOP_TIMEOUT');
  assert.equal(result.extra.pid, owner.pid);
  assert.deepEqual(result.extra, { pid: owner.pid, timeoutMs: 8000 });
  const text = fixtureDiagnosticText({ result, webLog: ['Bearer hidden-token', '{"token":"hidden-token"}',
    '?token=hidden-token', 'known literal private-runtime-token'] }, ['private-runtime-token']);
  assert.doesNotMatch(text, /hidden-token|private-runtime-token|private user text/);
  assert.match(text, /RUNTIME_STOP_TIMEOUT/);
  const detail = observation({ state: 'live', identity: owner });
  assert.equal(detail.birthHash.length, 64);
  assert.doesNotMatch(JSON.stringify(detail), /boot:original|startToken/);
});

test('fixture down reads the real CLI JSON error channel without exposing stderr', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-down-channel-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const home = path.join(scratch, 'home');
  const root = path.join(scratch, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(root, { mode: 0o700 });
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/hcc.mjs'),
    '--root', root, '--json', 'down'], {
    encoding: 'utf8', timeout: 5000,
    env: { HOME: home, PATH: process.env.PATH, SHELL: '/bin/bash', NODE_NO_WARNINGS: '1' }
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'RUNTIME_NOT_RUNNING');
  const diagnostic = fixtureDownResult(result);
  assert.equal(diagnostic.code, 'RUNTIME_NOT_RUNNING');
  assert.equal(diagnostic.source, 'stderr');
  assert.equal(diagnostic.status, 1);
  assert.equal('stderr' in diagnostic, false);
});

test('fixture down extracts bounded warning-prefixed JSON and ignores private output fields', () => {
  const failure = JSON.stringify({ ok: false, error: {
    code: 'RUNTIME_STOP_TIMEOUT', pid: owner.pid, timeoutMs: 5000, elapsedMs: 5001,
    message: 'PRIVATE_OUTPUT', token: 'PRIVATE_OUTPUT', state: 'PRIVATE_OUTPUT'
  } }, null, 2);
  for (const prefix of ['', '(node:123) ExperimentalWarning: PRIVATE_OUTPUT\n' +
    '(Use `node --trace-warnings ...` to show where the warning was created)\n']) {
    const diagnostic = fixtureDownResult({ status: 1, stdout: '', stderr: prefix + failure });
    assert.equal(diagnostic.code, 'RUNTIME_STOP_TIMEOUT');
    assert.equal(diagnostic.source, 'stderr');
    assert.deepEqual(diagnostic.extra, { pid: owner.pid, elapsedMs: 5001, timeoutMs: 5000 });
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_OUTPUT|ExperimentalWarning|message/);
  }
  for (const stderr of ['arbitrary private prefix\n' + failure,
    '(node:123) ExperimentalWarning: ' + 'x'.repeat(65536) + '\n' + failure,
    '{"ok":false,"error":', '{"ok":true,"error":{"code":"RUNTIME_STOP_TIMEOUT"}}']) {
    const diagnostic = fixtureDownResult({ status: 1, stdout: '', stderr });
    assert.equal(diagnostic.code, null);
    assert.deepEqual(diagnostic.extra, {});
    assert.doesNotMatch(JSON.stringify(diagnostic), /arbitrary private prefix|ExperimentalWarning/);
  }
});

for (const stdout of ['', 'ordinary stdout', formatJson(true, { runtime: 'private-runtime' })]) {
  test(`down diagnostics extract stderr CliError JSON after ${stdout ? 'non-error' : 'empty'} stdout`, () => {
    const stderr = formatJson(false, {
        code: 'RUNTIME_UNREACHABLE', pid: owner.pid, elapsedMs: 12, timeoutMs: 8000,
        message: 'Bearer private-token', token: 'private-token', body: 'private-body',
        runtime: 'private-runtime', method: 'POST', path: '/api/runtime/stop',
        errorName: 'private-name', state: 'unknown'
      }) + '\n';
    const result = fixtureDownResult({ status: 1, signal: null, stdout, stderr });
    assert.deepEqual(result, {
      status: 1, signal: null, code: 'RUNTIME_UNREACHABLE',
      source: 'stderr', stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
      extra: { pid: owner.pid, elapsedMs: 12, timeoutMs: 8000 }
    });
    assert.doesNotMatch(JSON.stringify(result), /private-|Bearer|POST|runtime\/stop|unknown/);
  });
}

test('down stderr diagnostics reject malformed output, invalid codes and nonnumeric context', () => {
  for (const [stderr, source] of [
    ['private-body Bearer private-token', null],
    ['null', null],
    [JSON.stringify({ error: ['private-body'] }), null],
    [formatJson(false, { code: 'PRIVATE\nTOKEN', pid: 'private-pid', elapsedMs: -1, timeoutMs: 'private-timeout' }), 'stderr']
  ]) {
    assert.deepEqual(fixtureDownResult({ status: 1, stdout: '', stderr }), {
      status: 1, signal: null, code: null, source, stdoutBytes: 0, stderrBytes: Buffer.byteLength(stderr), extra: {}
    });
  }
  assert.deepEqual(fixtureDownResult({ status: null, error: { code: 'ENOENT' }, stderr: 'private-body' }), {
    status: null, signal: null, code: 'ENOENT', source: 'spawn', stdoutBytes: 0,
    stderrBytes: Buffer.byteLength('private-body'), extra: {}
  });
});

for (const pretty of [true, false]) {
  test(`down diagnostics read a standalone ${pretty ? 'pretty' : 'single-line'} JSON error around Node warnings`, () => {
    const error = {
      code: 'RUNTIME_STOP_TIMEOUT', pid: owner.pid, timeoutMs: 5000,
      message: 'private-body "quoted" { fake: [private-token] } \\ escaped',
      private: [{ error: { code: 'PRIVATE_FAKE_CODE' } }], token: 'private-token'
    };
    const document = pretty ? formatJson(false, error) : JSON.stringify({ ok: false, error });
    const warning = '(node:123) ExperimentalWarning: SQLite is an experimental feature\n(Use node --trace-warnings to show where the warning was created)';
    for (const stderr of [document, `${warning}\n${document}`, `${document}\n${warning}`, `${warning}\n${document}\n${warning}`]) {
      const result = fixtureDownResult({ status: 1, stdout: '', stderr });
      assert.deepEqual(result, {
        status: 1, signal: null, code: 'RUNTIME_STOP_TIMEOUT', source: 'stderr', stdoutBytes: 0,
        stderrBytes: Buffer.byteLength(stderr), extra: { pid: owner.pid, timeoutMs: 5000 }
      });
      assert.doesNotMatch(JSON.stringify(result), /private-|PRIVATE_FAKE_CODE|ExperimentalWarning|quoted|escaped/);
    }
  });
}

test('down diagnostics reject nested, prefixed, truncated and malformed JSON error fragments', () => {
  const document = formatJson(false, { code: 'PRIVATE_FAKE_CODE', token: 'private-token' });
  for (const stderr of [
    `private-log ${document}`,
    `${document} private-log`,
    `[\n${document}\n]`,
    `{ "private":\n${document}\n}`,
    `private-log { "private": [\n${document}\n] }`,
    `{ "private": [\n${document}`,
    `{ "private": [\n${document}\n}`, // Mismatched delimiters.
    '{"error":{"code":"PRIVATE_FAKE_CODE",}}',
    JSON.stringify({ message: document }),
    '{"message":"private-body\n' + document + '\n"}'
  ]) {
    assert.deepEqual(fixtureDownResult({ status: 1, stdout: '', stderr }), {
      status: 1, signal: null, code: null, source: null, stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(stderr), extra: {}
    });
  }
});

test('down diagnostics reject arbitrary log containers even before a later independent error object', () => {
  const nested = formatJson(false, { code: 'PRIVATE_FAKE_CODE', pid: 99, token: 'private-token' });
  const actual = formatJson(false, { code: 'RUNTIME_UNREACHABLE', elapsedMs: 12 });
  for (const prefixed of [
    `private-log [meta] { "private":\n${nested}\n}`,
    `private-log {} [meta] [\n${nested}\n]`,
    `{} { "private":\n${nested}\n}`
  ]) {
    // Only known Node warnings may surround the CLI error. A valid JSON object
    // later in arbitrary output does not establish that it is the CLI failure.
    for (const stderr of [prefixed, `${prefixed}\n${actual}`]) {
      const result = fixtureDownResult({ status: 1, stderr });
      assert.deepEqual(result, {
        status: 1, signal: null, code: null, source: null, stdoutBytes: 0,
        stderrBytes: Buffer.byteLength(stderr), extra: {}
      });
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FAKE_CODE|private-token/);
    }
  }
});

test('down diagnostic warning limits apply across both sides of the JSON document', () => {
  const document = formatJson(false, { code: 'RUNTIME_STOP_TIMEOUT' });
  const warning = '(node:123) ExperimentalWarning: PRIVATE_WARNING\n';
  const accepted = warning.repeat(4) + document + '\n' + warning.repeat(4);
  assert.equal(fixtureDownResult({ status: 1, stderr: accepted }).code, 'RUNTIME_STOP_TIMEOUT');
  for (const stderr of [
    warning.repeat(5) + document + '\n' + warning.repeat(4),
    document + '\n(node:123) ExperimentalWarning: ' + 'x'.repeat(4096)
  ]) {
    const result = fixtureDownResult({ status: 1, stderr });
    assert.equal(result.code, null);
    assert.equal(result.source, null);
    assert.deepEqual(result.extra, {});
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_WARNING|ExperimentalWarning/);
  }
});

test('structured fixture failures use independently captured frames without multiline message content', () => {
  const privateMessage = 'failure heading\nPRIVATE_FIXTURE_BODY\nmore private message text';
  const owned = fixtureFailureError(privateMessage);
  assert.equal(owned.message, privateMessage); // Ordinary stderr still uses the existing redactor.
  const known = fixtureFailureDiagnostic(owned);
  assert.equal(known.stack, owned.fixtureStack);
  assert.ok(known.stack.length > 0 && Object.isFrozen(owned.fixtureStack));
  assert.doesNotMatch(fixtureDiagnosticText(known), /PRIVATE_FIXTURE_BODY|more private message text/);
  const external = new Error(privateMessage);
  external.name = privateMessage;
  external.fixtureStack = ['PRIVATE_FIXTURE_BODY'];
  const unknown = fixtureFailureDiagnostic(external);
  assert.equal(unknown.name, 'Error');
  assert.notEqual(unknown.stack, external.fixtureStack);
  assert.doesNotMatch(fixtureDiagnosticText(unknown), /PRIVATE_FIXTURE_BODY|more private message text/);
});

test('fixture down cannot fall back from a dead unknown or replaced local owner to a live global runtime', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-reg-owner-test-'));
  const home = path.join(scratch, 'home'), root = path.join(scratch, 'project');
  const keys = ['HOME', 'HCC_RUNTIME_LOCAL_ONLY', 'HCC_RUNTIME_URL', 'HCC_RUNTIME_TOKEN'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  for (const key of keys) delete process.env[key];
  process.env.HOME = home;
  // Match the runtime's existing private-state contract using only fixture
  // directories; a permissive pointer must not invalidate this ownership test.
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const directory of [home, root]) {
    fs.mkdirSync(path.join(directory, '.hello-cc'), { recursive: true, mode: 0o700 });
  }
  const globalOwner = { ...owner, pid: owner.pid + 1, startToken: 'boot:other' };
  const localPointer = { base_url: 'http://127.0.0.1:1', pid: owner.pid, process_identity: owner };
  const globalPointer = { base_url: 'http://127.0.0.1:2', pid: globalOwner.pid, process_identity: globalOwner };
  fs.writeFileSync(path.join(root, '.hello-cc/runtime.json'), JSON.stringify(localPointer), { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.hello-cc/runtime.json'), JSON.stringify(globalPointer), { mode: 0o600 });
  let localObservation = { state: 'dead', identity: null };
  const inspect = pid => pid === owner.pid ? localObservation : { state: 'live', identity: globalOwner };
  assert.equal(readRuntime({ root }, { inspectProcessIdentity: inspect }).base_url, globalPointer.base_url);
  const scoped = fixtureStopEnvironment({ ...process.env, HCC_RUNTIME_URL: 'http://127.0.0.1:3', HCC_RUNTIME_TOKEN: 'fixture-token' });
  assert.equal(scoped.HCC_RUNTIME_URL, undefined); assert.equal(scoped.HCC_RUNTIME_TOKEN, undefined);
  process.env.HCC_RUNTIME_LOCAL_ONLY = scoped.HCC_RUNTIME_LOCAL_ONLY;
  for (const observation of [
    { state: 'dead', identity: null },
    { state: 'unknown', identity: null },
    { state: 'live', identity: { ...owner, startToken: 'boot:replacement' } }
  ]) {
    localObservation = observation;
    assert.throws(() => readRuntime({ root }, { inspectProcessIdentity: inspect }), { code: 'RUNTIME_NOT_RUNNING' });
  }
  localObservation = { state: 'live', identity: owner };
  assert.equal(readRuntime({ root }, { inspectProcessIdentity: inspect }).base_url, localPointer.base_url);
});
