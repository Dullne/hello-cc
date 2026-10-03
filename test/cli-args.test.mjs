import assert from 'node:assert/strict';
import test from 'node:test';

import { intOpt, positiveSafeIntOpt, splitGlobalArgs } from '../lib/cli-args.mjs';

test('global options never consume provider arguments after the forwarding boundary', () => {
  const args = ['--root', '/project', 'dsh', 'web', '--', '--json', '--root=/provider', '--db', 'provider.db', '--port', '3081'];
  assert.deepEqual(splitGlobalArgs(args), {
    global: { json: false, root: '/project', db: null },
    rest: ['dsh', 'web', '--', '--json', '--root=/provider', '--db', 'provider.db', '--port', '3081']
  });
  assert.deepEqual(splitGlobalArgs(['run', '--json', '--peer', 'p', '--', 'node', '--json']), {
    global: { json: true, root: null, db: null },
    rest: ['run', '--peer', 'p', '--', 'node', '--json']
  });
});

test('integer options accept only exact safe integer values', () => {
  assert.equal(intOpt({ value: '12' }, 'value'), 12);
  assert.equal(intOpt({ value: '-12' }, 'value'), -12);
  assert.equal(intOpt({ value: 12 }, 'value'), 12);

  for (const value of ['1e30', '12junk', '1.5', '9007199254740992', 1e30, 1.5]) {
    assert.throws(
      () => intOpt({ value }, 'value'),
      (error) => error?.code === 'BAD_ARGS' && /safe integer/.test(error.message)
    );
  }
});

test('positive safe integer options reject zero and negatives at the parse boundary', () => {
  assert.equal(positiveSafeIntOpt({ ttl: '90' }, 'ttl', 900), 90);
  for (const ttl of ['0', '-1', '1e30', '12junk', '1.5']) {
    assert.throws(
      () => positiveSafeIntOpt({ ttl }, 'ttl', 900),
      (error) => error?.code === 'BAD_ARGS'
    );
  }
});
