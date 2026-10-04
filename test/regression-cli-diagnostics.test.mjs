import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixtureFailureError, fixtureFailureDiagnostic, fixtureDiagnosticText } from '../scripts/regression.mjs';

const payload = error => JSON.stringify({ ok: false, error });
const diagnostic = (result, operation = 'broadcast') => fixtureFailureDiagnostic(
  fixtureFailureError('fixture failed\nPRIVATE_FAILURE_TEXT', result, operation)
);

test('broadcast diagnostics retain GET failure context without CLI output or arbitrary fields', () => {
  const stderr = payload({ code: 'RUNTIME_UNREACHABLE', method: 'GET', path: '/api/sessions',
    elapsedMs: 8003, timeoutMs: 8000, message: 'PRIVATE_MESSAGE', token: 'PRIVATE_TOKEN',
    runtime: 'PRIVATE_RUNTIME', body: 'PRIVATE_BODY', errorName: 'PRIVATE_NAME' });
  const result = diagnostic({ status: 1, signal: null, stderr, stdout: 'PRIVATE_STDOUT' });
  assert.deepEqual(result.command, {
    operation: 'broadcast', status: 1, signal: null, code: 'RUNTIME_UNREACHABLE', source: 'stderr',
    stdoutBytes: Buffer.byteLength('PRIVATE_STDOUT'), stderrBytes: Buffer.byteLength(stderr),
    extra: { elapsedMs: 8003, timeoutMs: 8000, method: 'GET', path: '/api/sessions' }
  });
  assert.doesNotMatch(fixtureDiagnosticText(result), /PRIVATE_|message|token|runtime|errorName/);
});

test('broadcast diagnostics template POST routes and retain a typed HTTP status', () => {
  const result = diagnostic({ status: 1, stderr: payload({ code: 'SESSION_NOT_RUNNING', extra: {
    method: 'POST', path: '/api/sessions/PRIVATE_PEER/input?token=PRIVATE_QUERY#PRIVATE_FRAGMENT',
    status: 409, elapsedMs: 17, timeoutMs: 30000, target: 'PRIVATE_TARGET'
  } }) });
  assert.deepEqual(result.command.extra, {
    elapsedMs: 17, timeoutMs: 30000, status: 409, method: 'POST', path: '/api/sessions/:peer/input'
  });
  assert.doesNotMatch(fixtureDiagnosticText(result), /PRIVATE_/);
});

test('broadcast diagnostics reject unsupported routes, methods and wrongly typed metadata', () => {
  for (const context of [
    { method: 'PRIVATE_METHOD', path: 'https://PRIVATE_HOST/api/sessions',
      status: '409', elapsedMs: '8000', timeoutMs: -1 },
    { method: ['GET'], path: '/api/private/PRIVATE_PATH', status: 600,
      elapsedMs: 1.5, timeoutMs: Number.MAX_SAFE_INTEGER + 1 },
    { method: { value: 'POST' }, path: ['/api/sessions'], status: 0,
      elapsedMs: null, timeoutMs: true }
  ]) {
    const result = diagnostic({ status: '1', signal: 'SIGPRIVATE', stderr: payload({
      code: 'private invalid code', ...context
    }) });
    assert.deepEqual(result.command.extra, {});
    assert.equal(result.command.status, null);
    assert.equal(result.command.signal, null);
    assert.equal(result.command.code, null);
    assert.doesNotMatch(fixtureDiagnosticText(result), /PRIVATE_|private invalid code/);
  }
});

test('broadcast diagnostics keep spawn and signal results while refusing non-JSON output', () => {
  const signal = diagnostic({ status: null, signal: 'SIGTERM', stderr: 'PRIVATE_STDERR' }).command;
  assert.equal(signal.status, null);
  assert.equal(signal.signal, 'SIGTERM');
  assert.equal(signal.code, null);
  assert.equal(signal.source, null);
  const spawn = diagnostic({ status: null, error: { code: 'ENOENT', message: 'PRIVATE_SPAWN' } }).command;
  assert.equal(spawn.code, 'ENOENT');
  assert.equal(spawn.source, 'spawn');
  assert.doesNotMatch(fixtureDiagnosticText({ signal, spawn }), /PRIVATE_/);
});

test('broadcast diagnostic parser preserves bounded warning JSON and rejects unsafe envelopes', () => {
  const failure = payload({ code: 'RUNTIME_UNREACHABLE', method: 'GET', path: '/api/sessions' });
  const prefixed = diagnostic({ status: 1,
    stderr: '(node:123) ExperimentalWarning: PRIVATE_WARNING\n' + failure }).command;
  assert.equal(prefixed.code, 'RUNTIME_UNREACHABLE');
  assert.equal(prefixed.source, 'stderr');
  assert.doesNotMatch(JSON.stringify(prefixed), /PRIVATE_WARNING/);
  for (const stderr of [
    'PRIVATE_PREFIX\n' + failure,
    'x'.repeat(64 * 1024) + failure,
    '{"ok":false,"error":',
    '{"ok":true,"error":{"code":"RUNTIME_UNREACHABLE"}}'
  ]) {
    const result = diagnostic({ status: 1, stderr }).command;
    assert.equal(result.code, null);
    assert.equal(result.source, null);
    assert.deepEqual(result.extra, {});
  }
});

test('only the fixture factory can attach frozen diagnostics for an explicit operation', () => {
  const input = { status: 1, stderr: payload({ code: 'BAD_ARGS', message: 'PRIVATE_ERROR' }) };
  const error = fixtureFailureError('PRIVATE_ERROR', input, 'broadcast');
  input.status = 0;
  input.stderr = 'PRIVATE_CHANGED_OUTPUT';
  error.command = { body: 'PRIVATE_FORGED_COMMAND' };
  const saved = fixtureFailureDiagnostic(error).command;
  assert.equal(saved.status, 1);
  assert.equal(saved.code, 'BAD_ARGS');
  assert.ok(Object.isFrozen(saved));
  assert.ok(Object.isFrozen(saved.extra));
  assert.doesNotMatch(fixtureDiagnosticText(fixtureFailureDiagnostic(error)), /PRIVATE_/);
  const external = new Error('PRIVATE_EXTERNAL');
  external.command = saved;
  external.fixtureCommand = saved;
  assert.equal('command' in fixtureFailureDiagnostic(external), false);
  for (const operation of [undefined, null, 'PRIVATE_OPERATION', 'ask']) {
    assert.equal('command' in diagnostic(input, operation === undefined ? null : operation), false);
  }
});

test('real broadcast CLI failures use stderr JSON that the fixture can publish safely', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-broadcast-diagnostic-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const home = path.join(scratch, 'home');
  const root = path.join(scratch, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(root, { mode: 0o700 });
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/hcc.mjs'),
    '--root', root, '--json', 'broadcast'], {
    encoding: 'utf8', timeout: 5000,
    env: { HOME: home, PATH: process.env.PATH, SHELL: '/bin/bash', NODE_NO_WARNINGS: '1' }
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'BAD_ARGS');
  const actual = diagnostic(result).command;
  assert.equal(actual.code, 'BAD_ARGS');
  assert.equal(actual.source, 'stderr');
  assert.equal(actual.status, 1);
  assert.equal('stderr' in actual, false);
  assert.equal('message' in actual, false);
});
