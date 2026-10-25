import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import test from 'node:test';
import { listProjectFiles, previewProjectFile, inspectProjectFileStatus,
  prepareProjectFileParent, projectFileErrorStatus } from '../lib/web/project-files.mjs';
import { listContextFiles } from '../lib/web/context-files.mjs';
import { saveProjectFile, uploadProjectFile } from '../lib/web/project-file-write.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';

test('native Windows refuses every file access entry point before filesystem or identity access', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const accesses = [];
  const forbidden = name => () => { accesses.push(name); throw new Error('Unexpected filesystem access: ' + name); };
  for (const name of ['realpath', 'lstat', 'stat', 'open', 'opendir', 'readFile']) t.mock.method(fsp, name, forbidden(name));
  for (const name of ['openSync', 'statSync', 'lstatSync', 'readFileSync']) t.mock.method(fs, name, forbidden(name));
  t.mock.method(fs.realpathSync, 'native', forbidden('realpathSync.native'));
  const rootIdentity = { assertUnchanged: forbidden('rootIdentity.assertUnchanged') };
  // Drive, UNC, device namespace and POSIX-looking roots must all stop at the
  // same boundary. A pre-supplied identity must not bypass the host check.
  for (const root of ['C:\\project', '\\\\server\\share\\project', '\\\\?\\C:\\project', '/selected/project']) {
    for (const options of [{}, { rootIdentity }]) {
      for (const operation of [
        () => listProjectFiles(root, '', options),
        () => listProjectFiles(root, 'src', options),
        () => previewProjectFile(root, 'src/file.txt', options),
        () => inspectProjectFileStatus(root, 'src/file.txt', options),
        () => prepareProjectFileParent(root, 'src/new.txt', options),
        () => listContextFiles(root, '', options),
        () => listContextFiles(root, 'src/file.txt', { ...options, timeBudgetMs: 0 })
      ]) {
        await assert.rejects(operation(), error => {
          assert.equal(error.code, 'PROJECT_FILE_READ_UNAVAILABLE');
          assert.equal(projectFileErrorStatus(error), 503);
          assert.match(error.message, /WSL/);
          assert.ok(!error.message.includes(root));
          return true;
        });
      }
      await assert.rejects(saveProjectFile(root, { path: 'file.txt', revision: 'v1-' + 'a'.repeat(64), content: 'text' }, options),
        { code: 'PROJECT_FILE_WRITE_UNAVAILABLE' });
      await assert.rejects(uploadProjectFile(root, { path: 'new.txt', content: Buffer.from('text').toString('base64'), encoding: 'base64' }, options),
        { code: 'PROJECT_FILE_WRITE_UNAVAILABLE' });
    }
  }
  assert.deepEqual(accesses, []);
});

test('file and context HTTP handlers expose safe-access refusal as JSON 503', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const root = 'C:\\private-test-project';
  const { handleWebRequest } = createHttpRoutes({ ctx: { root }, sessions: new Map(), token: 'test-token',
    webAuthMode: () => 'token', cookieSessionOk: () => false,
    projectFromRequest: () => ({ root }), webErrorStatus: () => 500 });
  for (const url of ['/api/files/tree', '/api/files/preview?path=file.txt', '/api/files/status?path=file.txt',
    '/api/context/files', '/api/context/files?query=src%2Ffile.txt']) {
    let status, headers, body;
    const res = { writeHead(code, value) { status = code; headers = value; }, end(value) { body = value; } };
    await handleWebRequest({ method: 'GET', url,
      headers: { host: 'localhost', 'x-hcc-api-version': '2' } }, res);
    assert.equal(status, 503, url);
    assert.match(headers['Content-Type'], /^application\/json/);
    const value = JSON.parse(body);
    assert.equal(value.ok, false); assert.equal(value.error.code, 'PROJECT_FILE_READ_UNAVAILABLE');
    assert.match(value.error.message, /WSL/); assert.ok(!body.includes('private-test-project'));
  }
});
