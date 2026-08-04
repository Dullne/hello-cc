import assert from 'node:assert/strict';
import test from 'node:test';

import { intOpt, positiveSafeIntOpt } from '../lib/cli-args.mjs';

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
