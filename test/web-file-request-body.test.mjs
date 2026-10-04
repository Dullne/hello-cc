import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readJsonRequest, sendJson } from '../lib/web/http.mjs';

test('bounded JSON uses UTF-8 byte counts and reconstructs code points split across chunks', async () => {
  const content = JSON.stringify({ text: '中文😀' }), bytes = Buffer.from(content);
  const chunks = Array.from(bytes, byte => Buffer.from([byte]));
  assert.deepEqual(await readJsonRequest(Readable.from(chunks), { maxBytes: bytes.length }), { text: '中文😀' });
  await assert.rejects(readJsonRequest(Readable.from(chunks), { maxBytes: bytes.length - 1 }), { code: 'PROJECT_FILE_TOO_LARGE' });
  assert.ok(bytes.length > content.length);
  await assert.rejects(readJsonRequest(Readable.from([bytes]), { maxBytes: content.length }), { code: 'PROJECT_FILE_TOO_LARGE' });
});

test('bounded JSON rejects malformed UTF-8 and JSON while preserving empty-body handling', async () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0x22, 0xc3, 0x22]), Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22])]) {
    await assert.rejects(readJsonRequest(Readable.from([bytes]), { maxBytes: 64 }), { code: 'BAD_REQUEST', message: 'JSON request body must use valid UTF-8' });
  }
  await assert.rejects(readJsonRequest(Readable.from(['{invalid}']), { maxBytes: 64 }), { code: 'BAD_REQUEST', message: 'Invalid JSON request body' });
  assert.deepEqual(await readJsonRequest(Readable.from([]), { maxBytes: 64 }), {});
  assert.deepEqual(await readJsonRequest(Readable.from([' \r\n\t']), { maxBytes: 64 }), {});
  for (const maxBytes of [0, -1, NaN, Infinity, 1.5, '1', null]) {
    await assert.rejects(readJsonRequest(Readable.from([]), { maxBytes }), TypeError);
  }
});

test('oversized declared and streamed requests are drained without destruction', async () => {
  for (const declared of [undefined, '9999']) {
    const req = Readable.from(['{"a":', '"longer than the limit"}'], { autoDestroy: false });
    req.headers = declared ? { 'content-length': declared } : {};
    const ended = new Promise(resolve => req.once('end', resolve));
    await assert.rejects(readJsonRequest(req, { maxBytes: 8 }), { code: 'PROJECT_FILE_TOO_LARGE' });
    await ended;
    assert.equal(req.destroyed, false);
    assert.equal(req.listenerCount('data'), 0);
  }
});

test('bounded request aborts settle the reader and release stream listeners', async () => {
  const req = new Readable({ read() {} }), pending = readJsonRequest(req, { maxBytes: 64 });
  req.push('{"partial":'); req.destroy();
  await assert.rejects(pending, { code: 'BAD_REQUEST', message: 'JSON request body was interrupted' });
  for (const event of ['data', 'end', 'error', 'aborted', 'close']) assert.equal(req.listenerCount(event), 0);
});

test('real HTTP chunked and Content-Length overflows deliver parseable 413 responses', async t => {
  const server = http.createServer(async (req, res) => {
    try { sendJson(res, 200, { body: await readJsonRequest(req, { maxBytes: 16 }) }); }
    catch (error) { sendJson(res, error.code === 'PROJECT_FILE_TOO_LARGE' ? 413 : 400, { error: { code: error.code, message: error.message } }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const post = (headers, chunks) => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/', method: 'POST', headers }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
      response.on('error', reject);
    });
    request.on('error', reject);
    function next(index) {
      if (index === chunks.length) { request.end(); return; }
      request.write(chunks[index]); setImmediate(() => next(index + 1));
    }
    next(0);
  });
  for (const headers of [{ 'transfer-encoding': 'chunked' }, { 'content-length': '64' }]) {
    const result = await post(headers, ['x'.repeat(20), 'y'.repeat(20), 'z'.repeat(24)]);
    assert.equal(result.status, 413); assert.equal(result.body.error.code, 'PROJECT_FILE_TOO_LARGE');
    assert.match(result.body.error.message, /byte limit/);
  }
  const invalid = await post({ 'transfer-encoding': 'chunked' }, [Buffer.from([0x22, 0xff, 0x22])]);
  assert.equal(invalid.status, 400); assert.equal(invalid.body.error.code, 'BAD_REQUEST');
});

test('default readJsonRequest calls retain their existing empty, object and size-error behavior', async () => {
  assert.deepEqual(await readJsonRequest(Readable.from([])), {});
  assert.deepEqual(await readJsonRequest(Readable.from(['{"ok":true}'])), { ok: true });
  await assert.rejects(readJsonRequest(Readable.from(['x'.repeat(1024 * 1024 + 1)])), { code: 'REQUEST_TOO_LARGE' });
});
