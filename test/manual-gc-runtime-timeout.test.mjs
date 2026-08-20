import assert from 'node:assert/strict';
import test from 'node:test';

import { RUNTIME_BUFFER_GC_TIMEOUT_MS } from '../lib/cli/commands/gc.mjs';

test('manual buffer GC allows a bounded 30 second runtime evidence window', () => {
  assert.equal(RUNTIME_BUFFER_GC_TIMEOUT_MS, 30_000);
});
