import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureSelectedCwdIdentity } from '../lib/process/selected-cwd-identity.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';

for (const endpoint of [
  '/api/files/tree',
  '/api/files/preview?path=proof.txt',
  '/api/context/files'
]) {
  test(`${endpoint} refuses replacement B after selecting directory A`, async t => {
    const container = await fs.mkdtemp(path.join(os.tmpdir(), 'hcc-web-file-binding-'));
    t.after(() => fs.rm(container, { recursive: true, force: true }));
    const selected = path.join(container, 'selected');
    const replacement = path.join(container, 'replacement');
    const moved = path.join(container, 'selected-moved');
    await fs.mkdir(selected);
    await fs.mkdir(replacement);
    await fs.writeFile(path.join(selected, 'proof.txt'), 'directory A');
    await fs.writeFile(path.join(replacement, 'proof.txt'), 'directory B');
    await fs.writeFile(path.join(replacement, 'replacement-only.txt'), 'directory B');

    const bindings = [];
    const { handleWebRequest } = createHttpRoutes({
      ctx: { root: selected }, sessions: new Map(), token: 'fixture-token',
      webAuthMode: (_url, req) => req.headers.authorization === 'Bearer fixture-token' ? 'token' : null,
      cookieSessionOk: () => false,
      projectFromRequest: () => {
        const rootIdentity = captureSelectedCwdIdentity(selected);
        bindings.push(rootIdentity);
        return { root: selected, rootIdentity };
      },
      webErrorStatus: error => error.code === 'PROJECT_PATH_CHANGED' ? 409 : 500
    });
    const server = http.createServer(handleWebRequest);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const originalRealpath = fs.realpath;
    let swapped = false;
    fs.realpath = async (...args) => {
      if (!swapped && args[0] === selected) {
        swapped = true;
        await fs.rename(selected, moved);
        await fs.rename(replacement, selected);
      }
      return originalRealpath(...args);
    };
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
        headers: { Authorization: 'Bearer fixture-token', 'X-HCC-API-Version': '2' }
      });
      const body = await response.json();
      assert.equal(swapped, true, 'replacement occurred inside the asynchronous reader');
      assert.equal(response.status, 409);
      assert.equal(body.error.code, 'PROJECT_PATH_CHANGED');
      assert.ok(!JSON.stringify(body).includes('directory B'));
      assert.ok(!JSON.stringify(body).includes('replacement-only.txt'));
    } finally {
      fs.realpath = originalRealpath;
      for (const binding of bindings) binding.release();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
