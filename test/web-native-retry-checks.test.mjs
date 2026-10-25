import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { summarizeNativeRetryResponse } from '../scripts/web-native-retry-checks.mjs';

test('retry evidence distinguishes real HTTP error codes without retaining response secrets', () => {
  const secret = 'sk-response-secret-DRAFT-action-token';
  const body = Buffer.from(JSON.stringify({ ok: false, error: { code: 'NATIVE_OWNER_CHANGED', message: secret },
    receipt: { action_token: secret }, text: secret }));
  const result = summarizeNativeRetryResponse(409, body);
  assert.deepEqual(result, { status: 409, bytes: body.length,
    bodySha256: createHash('sha256').update(body).digest('hex'), format: 'json', code: 'NATIVE_OWNER_CHANGED' });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.notEqual(result.bodySha256, summarizeNativeRetryResponse(409, Buffer.from('{}')).bodySha256);
});

test('retry evidence preserves malformed and oversized response diagnostics and rejects arbitrary code payloads', () => {
  for (const body of [Buffer.alloc(0), Buffer.from('<html>private proxy error</html>'), Buffer.from('{invalid')]) {
    const result = summarizeNativeRetryResponse(502, body);
    assert.equal(result.status, 502); assert.equal(result.format, 'non-json'); assert.equal(result.code, null);
    assert.equal(result.bytes, body.length); assert.match(result.bodySha256, /^[a-f0-9]{64}$/);
  }
  const oversized = summarizeNativeRetryResponse(500, Buffer.alloc(65537, 120));
  assert.equal(oversized.format, 'oversized'); assert.equal(oversized.code, null);
  for (const code of ['sk-response-secret', 'NATIVE_ERROR\n::error::payload', 'X'.repeat(81), { value: 'secret' }, null]) {
    assert.equal(summarizeNativeRetryResponse(409, Buffer.from(JSON.stringify({ error: { code } }))).code, null);
  }
  assert.equal(summarizeNativeRetryResponse(200, Buffer.from(JSON.stringify({ receipt: { message_id: 1 } }))).format, 'json');
});
