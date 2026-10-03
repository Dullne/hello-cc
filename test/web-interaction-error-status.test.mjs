import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { CliError } from '../lib/shared/errors.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';
import { codexInteractionResponse } from '../lib/integrations/codex-interactions.mjs';

// Read the production mapping: a permissive test-only mapper previously hid 500s.
const appSource = fs.readFileSync(new URL('../lib/cli/app.mjs', import.meta.url), 'utf8');
const start = appSource.indexOf('function webErrorStatus(err) {');
const end = appSource.indexOf('\nfunction autoPeerDefaults(', start);
assert.ok(start >= 0 && end > start);
const productionStatus = new Function('CliError', appSource.slice(start, end) + '\nreturn webErrorStatus;')(CliError);

test('a selected project inode change is an HTTP conflict, not a server error', () => {
  assert.equal(productionStatus(new CliError('PROJECT_PATH_CHANGED', 'selected root changed')), 409);
});

test('invalid permissions return HTTP 400 while the original request can still accept an exact subset', async t => {
  const entry = path => ({ path: { type: 'path', path }, access: 'write' });
  const request = { kind: 'permissions', params: { permissions: { fileSystem: { entries: [entry('/requested-a'), entry('/requested-b')] } } } };
  let pending = true, accepted;
  const ctx = { root: '/test-project' };
  const session = { id: 'native-a', type: 'native', nativeSnapshot: () => ({ pending }) };
  const { handleWebRequest } = createHttpRoutes({
    ctx, projectFromRequest: () => ctx, webAuthMode: () => 'cookie', cookieSessionOk: () => true,
    connectWebProject: () => ({ close() {} }), getSession: () => session,
    assertWebWrite() {}, webErrorStatus: productionStatus,
    async nativeAction(_session, action, input) {
      assert.equal(action, 'respond');
      let result;
      try { result = codexInteractionResponse(request, input); }
      catch (error) { throw new CliError(error.code, error.message); }
      pending = false; accepted = result; return { status: 'submitted' };
    }
  });
  const server = http.createServer(handleWebRequest);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const post = async permissions => {
    const response = await fetch(origin + '/api/sessions/native-a/native/respond', {
      method: 'POST', headers: { Origin: origin, 'X-HCC-API-Version': '2', 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'accept', scope: 'turn', permissions })
    });
    return { status: response.status, body: await response.json() };
  };
  const invalid = await post({ fileSystem: { entries: [entry('/unrequested')] } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'INTERACTION_RESPONSE_INVALID');
  assert.equal(pending, true); assert.equal(accepted, undefined);
  const valid = await post({ fileSystem: { entries: [entry('/requested-a')] } });
  assert.equal(valid.status, 200); assert.equal(pending, false);
  assert.deepEqual(accepted, { permissions: { fileSystem: { entries: [entry('/requested-a')] } }, scope: 'turn' });
});
