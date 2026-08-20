import assert from 'node:assert/strict';
import test from 'node:test';

import { WEB_RUNTIME_START_TIMEOUT_MS } from '../lib/web/startup.mjs';

test('web startup allows a bounded 60 second window on loaded CI hosts', () => {
  assert.equal(WEB_RUNTIME_START_TIMEOUT_MS, 60_000);
});
