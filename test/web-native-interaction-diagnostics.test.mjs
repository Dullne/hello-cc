import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { interactionCompletionDiagnostics } from '../scripts/web-native-interaction-diagnostics.mjs';

const request = (requestId, tool = 'write', input = {}) => ({ requestId, kind: 'approval', method: 'session/request_permission',
  params: { toolCall: { title: tool, rawInput: input } } });
const state = pending => ({ snapshot: { status: 'running', pendingApprovals: pending },
  deliveries: [{ submission_id: 'expected', state: 'dispatched' }], events: [] });

test('a different request after numeric id zero is diagnosed without approving or treating a read/get as completion', () => {
  for (const tool of ['write', 'read', 'get', 'unknown-sensitive-tool']) {
    const diagnostic = interactionCompletionDiagnostics(state([request(1, tool)]), {
      answeredRequest: request(0), submissionId: 'expected',
    });
    assert.equal(diagnostic.differentPendingRequest, true);
    assert.equal(diagnostic.answeredRequestId, 0);
    assert.equal(diagnostic.pending[0].requestId, 1);
    assert.equal(diagnostic.deliveryState, 'dispatched');
    assert.equal(diagnostic.pending[0].toolName, tool.startsWith('unknown-') ? 'other' : tool);
  }
});

test('the still-visible answered request is not misclassified as a new request', () => {
  assert.equal(interactionCompletionDiagnostics(state([request(0)]), { answeredRequest: request(0) }).differentPendingRequest, false);
  assert.equal(interactionCompletionDiagnostics(state([]), { answeredRequest: request(0) }).differentPendingRequest, false);
});

test('diagnostics keep bounded whitelisted metadata and discard raw body, input, paths, and unknown event text', () => {
  const secret = 'SECRET-FIXTURE-DO-NOT-RECORD';
  const value = state([request(1, 'write', { file_path: '/' + secret, content: secret, env: { TOKEN: secret } })]);
  value.snapshot.error = { message: secret };
  value.events = Array.from({ length: 20 }, (_, index) => ({ created_at: index, payload: { type: secret, body: secret } }));
  const diagnostic = interactionCompletionDiagnostics(value, { answeredRequest: request(0), submissionId: 'expected' });
  assert.equal(diagnostic.recentEvents.length, 8);
  assert.deepEqual(diagnostic.recentEvents[0], { type: 'other', timestamp: 12 });
  assert.equal(diagnostic.pending[0].targetExactOwned, false);
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
});

test('only exact test-owned paths are identified and regular bounded targets are hashed without following links', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-interaction-diagnostic-'));
  try {
    const allowed = path.join(directory, 'allowed'), denied = path.join(directory, 'denied');
    fs.writeFileSync(allowed, 'DSH_APPROVED_OK');
    fs.symlinkSync(allowed, denied);
    const diagnostic = interactionCompletionDiagnostics(state([request(1, 'write', { file_path: allowed })]), {
      answeredRequest: request(0), ownedTargets: [{ role: 'allowed', path: allowed }, { role: 'denied', path: denied }],
    });
    assert.equal(diagnostic.pending[0].targetExactOwned, true);
    assert.equal(diagnostic.pending[0].targetRole, 'allowed');
    assert.deepEqual(diagnostic.targets[0], { role: 'allowed', exists: true, regularFile: true,
      sha256: createHash('sha256').update('DSH_APPROVED_OK').digest('hex') });
    assert.deepEqual(diagnostic.targets[1], { role: 'denied', exists: true, regularFile: false, sha256: null });
    assert.equal(JSON.stringify(diagnostic).includes(directory), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
