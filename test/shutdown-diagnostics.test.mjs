import assert from 'node:assert/strict';
import test from 'node:test';
import { createShutdownDiagnostics, parseShutdownDiagnostics } from '../lib/web/shutdown-diagnostics.mjs';

test('shutdown telemetry emits only bounded fixed fields and preserves monotonic phase timing', () => {
  let time = 100;
  const lines = [];
  const record = createShutdownDiagnostics({ enabled: true, pid: 123, now: () => time, write: line => lines.push(line) });
  time = 250;
  record('request_received', { sessions: 2, tmux: 1, running: 2, secret: 'PRIVATE_VALUE' });
  time = 300;
  record('cleanup_begin', { sessions: 2, native: -1, appServer: 'PRIVATE_VALUE', pty: Infinity });
  record('PRIVATE_PHASE', { sessions: 2 });
  assert.deepEqual(parseShutdownDiagnostics(lines.join('\n'), 123), [
    { phase: 'request_received', elapsedMs: 150, sessions: 2, running: 2, tmux: 1 },
    { phase: 'cleanup_begin', elapsedMs: 200, sessions: 2 }
  ]);
  assert.doesNotMatch(lines.join('\n'), /PRIVATE/);
});

test('disabled or failing telemetry cannot change shutdown behavior', () => {
  const disabled = createShutdownDiagnostics({ now() { throw new Error('must not inspect'); }, write() { throw new Error('must not emit'); } });
  assert.doesNotThrow(() => disabled('cleanup_begin'));
  const failing = createShutdownDiagnostics({ enabled: true, write() { throw new Error('sink failed'); } });
  assert.doesNotThrow(() => failing('cleanup_begin'));
});

test('shutdown parser rejects foreign owners, raw errors and injected fields', () => {
  const prefix = 'HCC_SHUTDOWN_PHASE ';
  const records = [
    'PRIVATE_RAW_LOG', prefix + '{invalid',
    prefix + JSON.stringify({ pid: 456, phase: 'cleanup_begin', elapsedMs: 2 }),
    prefix + JSON.stringify({ pid: 123, phase: 'PRIVATE_PHASE', elapsedMs: 2 }),
    prefix + JSON.stringify({ pid: 123, phase: 'cleanup_begin', elapsedMs: -1 }),
    prefix + JSON.stringify({ pid: 123, phase: 'cleanup_begin', elapsedMs: 2, message: 'PRIVATE_MESSAGE', sessions: 'PRIVATE_COUNT', tmux: 1 })
  ];
  assert.deepEqual(parseShutdownDiagnostics(records.join('\n'), 123), [{ phase: 'cleanup_begin', elapsedMs: 2, tmux: 1 }]);
  assert.deepEqual(parseShutdownDiagnostics('x'.repeat(65537), 123), []);
  assert.deepEqual(parseShutdownDiagnostics(prefix + ' '.repeat(2048), 123), []);
});

test('shutdown parser keeps only the last bounded phase sequence', () => {
  const text = Array.from({ length: 20 }, (_, elapsedMs) => 'HCC_SHUTDOWN_PHASE ' + JSON.stringify({ pid: 123, phase: 'cleanup_begin', elapsedMs })).join('\n');
  const result = parseShutdownDiagnostics(text, 123);
  assert.equal(result.length, 16);
  assert.equal(result[0].elapsedMs, 4);
});
