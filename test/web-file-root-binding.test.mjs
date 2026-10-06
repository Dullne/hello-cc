import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureSelectedCwdIdentity } from '../lib/process/selected-cwd-identity.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';
import { listContextFiles } from '../lib/web/context-files.mjs';

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
    let swapped = false;
    const { handleWebRequest } = createHttpRoutes({
      ctx: { root: selected }, sessions: new Map(), token: 'fixture-token',
      webAuthMode: (_url, req) => req.headers.authorization === 'Bearer fixture-token' ? 'token' : null,
      cookieSessionOk: () => false,
      projectFromRequest: () => {
        const rootIdentity = captureSelectedCwdIdentity(selected);
        const assertUnchanged = rootIdentity.assertUnchanged.bind(rootIdentity);
        rootIdentity.assertUnchanged = () => {
          assertUnchanged();
          if (!swapped) {
            swapped = true;
            fsSync.renameSync(selected, moved);
            fsSync.renameSync(replacement, selected);
          }
        };
        bindings.push(rootIdentity);
        return { root: selected, rootIdentity };
      },
      webErrorStatus: error => error.code === 'PROJECT_PATH_CHANGED' ? 409 : 500
    });
    const server = http.createServer(handleWebRequest);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
        headers: { Authorization: 'Bearer fixture-token', 'X-HCC-API-Version': '2' }
      });
      const body = await response.json();
      assert.equal(swapped, true, 'replacement occurred inside the selected-project reader');
      assert.equal(response.status, 409);
      assert.equal(body.error.code, 'PROJECT_PATH_CHANGED');
      assert.ok(!JSON.stringify(body).includes('directory B'));
      assert.ok(!JSON.stringify(body).includes('replacement-only.txt'));
    } finally {
      for (const binding of bindings) binding.release();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test('context file listing does not reopen a transient A→B→A directory swap', async t => {
  if (process.platform === 'win32') return t.skip('Pinned directory enumeration is POSIX-only');
  const container = await fs.mkdtemp(path.join(os.tmpdir(), 'hcc-context-transient-'));
  t.after(() => fs.rm(container, { recursive: true, force: true }));
  const selected = path.join(container, 'selected');
  const replacement = path.join(container, 'replacement');
  const moved = path.join(container, 'moved');
  await fs.mkdir(selected);
  await fs.mkdir(replacement);
  await fs.writeFile(path.join(selected, 'a-only.txt'), 'A');
  await fs.writeFile(path.join(replacement, 'b-only.txt'), 'B');
  const canonical = await fs.realpath(selected);
  const rootIdentity = captureSelectedCwdIdentity(selected);
  const originalOpendir = fs.opendir;
  let swapped = false;
  fs.opendir = async (directory, ...args) => {
    if (!swapped && directory === canonical) {
      swapped = true;
      await fs.rename(selected, moved);
      await fs.rename(replacement, selected);
      const handle = await originalOpendir(directory, ...args);
      await fs.rename(selected, replacement);
      await fs.rename(moved, selected);
      return handle;
    }
    return originalOpendir(directory, ...args);
  };
  try {
    assert.deepEqual(await listContextFiles(selected, '', { rootIdentity }),
      { paths: ['a-only.txt'], truncated: false });
    assert.equal(swapped, false);
  } finally {
    fs.opendir = originalOpendir;
    rootIdentity.release();
  }
});
