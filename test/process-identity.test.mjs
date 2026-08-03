import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareProcessIdentity,
  inspectProcessIdentity,
  parseLinuxStatStartTicks,
  parsePsStartIdentity
} from '../lib/process/identity.mjs';

test('reads a stable identity for the current process', () => {
  const first = inspectProcessIdentity(process.pid);
  const second = inspectProcessIdentity(process.pid);
  assert.equal(first.state, 'live');
  assert.deepEqual(second.identity, first.identity);
  assert.equal(compareProcessIdentity(first.identity, second.identity), 'live');
});

test('parses Linux stat when command contains spaces and parentheses', () => {
  const fields = Array.from({ length: 30 }, (_, i) => String(i + 1));
  fields[19] = '987654';
  assert.equal(parseLinuxStatStartTicks(`42 (worker (one)) ${fields.join(' ')}`), '987654');
});

test('parses macOS ps start and command identity', () => {
  assert.deepEqual(parsePsStartIdentity('Mon Aug  3 06:10:11 2026\t/usr/bin/node app.mjs\n'), {
    startToken: 'Mon Aug  3 06:10:11 2026',
    command: '/usr/bin/node app.mjs'
  });
});

test('rejects a reused PID fingerprint', () => {
  const stored = { pid: 42, startToken: 'boot-a:100', commandHash: 'a'.repeat(64) };
  const current = { pid: 42, startToken: 'boot-a:200', commandHash: 'a'.repeat(64) };
  assert.equal(compareProcessIdentity(stored, current), 'dead');
  assert.equal(compareProcessIdentity(null, current), 'unknown');
});
