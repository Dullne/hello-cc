import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { CliError } from '../lib/shared/errors.mjs';
import { PROJECT_FILE_LIMITS, listProjectFiles, previewProjectFile } from '../lib/web/project-files.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hcc-project-files-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root,
    async file(relative, contents = '') {
      const target = path.join(root, relative);
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, contents); return target;
    },
    directory(relative) { return fs.mkdir(path.join(root, relative), { recursive: true }); }
  };
}

test('single-level project trees sort directories first, retain build artifacts and hide private/cache/link entries', async t => {
  const f = await fixture(t);
  for (const name of ['dist', 'build', 'src', '.git', '.hello-cc', '.hcc', '.codex', '.claude', '.dsh', '.ssh', '.aws', 'node_modules', '.cache', '.next']) await f.directory(name);
  for (const name of ['z.txt', 'a.txt', '.env', '.env.local', 'app.env', '.npmrc', '.netrc', 'client.key', 'client.key.backup', 'credentials.json', 'service-account.json', 'terraform.tfstate']) await f.file(name, 'data');
  await f.file('src/main.js', 'hello');
  await fs.symlink(path.join(f.root, 'src'), path.join(f.root, 'linked-src'));
  await fs.link(path.join(f.root, 'a.txt'), path.join(f.root, 'hardlink.txt'));
  const result = await listProjectFiles(f.root);
  assert.deepEqual(result, { path: '', entries: [
    { name: 'build', path: 'build', type: 'directory' }, { name: 'dist', path: 'dist', type: 'directory' },
    { name: 'src', path: 'src', type: 'directory' }, { name: 'z.txt', path: 'z.txt', type: 'file', size: 4 }
  ], truncated: false });
  assert.deepEqual((await listProjectFiles(f.root, 'src')).entries, [{ name: 'main.js', path: 'src/main.js', type: 'file', size: 5 }]);
});

test('tree entry counts are bounded and truncated is explicit', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: PROJECT_FILE_LIMITS.entries + 1 }, (_, index) => f.file(String(index).padStart(4, '0') + '.txt')));
  const result = await listProjectFiles(f.root);
  assert.equal(result.entries.length, 500); assert.equal(result.truncated, true);
  assert.equal(result.entries[0].name, '0000.txt'); assert.equal(result.entries.at(-1).name, '0499.txt');
});

test('invalid and excluded paths are refused by listing and direct preview', async t => {
  const f = await fixture(t);
  for (const relative of ['../x', 'a/../x', '/absolute', 'C:/absolute', 'a\\b', 'x\0y', 'a//b', './x', 'a/', 'name:stream', 'a'.repeat(4097)]) {
    await assert.rejects(listProjectFiles(f.root, relative), { code: 'PROJECT_FILE_BAD_PATH' });
    await assert.rejects(previewProjectFile(f.root, relative), { code: 'PROJECT_FILE_BAD_PATH' });
  }
  for (const relative of ['.env', '.ENV.local', 'app.env', '.envrc', '.git/config', 'src/.aws/config', 'node_modules/a.txt',
    '.ssh/id_rsa', 'config/secrets.json', 'credentials.txt', 'auth.json', 'client.pem', 'client.key.backup', 'terraform.tfstate.backup']) {
    await assert.rejects(listProjectFiles(f.root, relative), { code: 'PROJECT_FILE_FORBIDDEN' });
    await assert.rejects(previewProjectFile(f.root, relative), { code: 'PROJECT_FILE_FORBIDDEN' });
  }
  for (const relative of ['', null, undefined, 1]) await assert.rejects(previewProjectFile(f.root, relative), { code: 'PROJECT_FILE_BAD_PATH' });
});

test('previews do not follow file or parent links and refuse hard links and special files', async t => {
  const f = await fixture(t);
  await f.file('source/file.txt', 'safe data');
  await fs.symlink(path.join(f.root, 'source'), path.join(f.root, 'parent-link'));
  await fs.symlink(path.join(f.root, 'source/file.txt'), path.join(f.root, 'file-link.txt'));
  for (const relative of ['parent-link/file.txt', 'file-link.txt']) await assert.rejects(previewProjectFile(f.root, relative), { code: 'PROJECT_FILE_FORBIDDEN' });
  await assert.rejects(listProjectFiles(f.root, 'parent-link'), { code: 'PROJECT_FILE_FORBIDDEN' });
  await fs.link(path.join(f.root, 'source/file.txt'), path.join(f.root, 'hardlink.txt'));
  await assert.rejects(previewProjectFile(f.root, 'hardlink.txt'), { code: 'PROJECT_FILE_FORBIDDEN' });
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [path.join(f.root, 'pipe.txt')]);
    await assert.rejects(previewProjectFile(f.root, 'pipe.txt'), { code: 'PROJECT_FILE_FORBIDDEN' });
  }
});

test('text, Markdown, HTML and extensionless project files return data, while SVG remains source text', async t => {
  const f = await fixture(t);
  for (const [name, content, kind, mime] of [
    ['README', '项目说明\n', 'text', 'text/plain'], ['Dockerfile', 'FROM node:24\n', 'text', 'text/plain'],
    ['docs/info.md', '# title\n', 'markdown', 'text/markdown'], ['dist/index.html', '<h1>result</h1>', 'html', 'text/html'],
    ['icon.svg', '<svg><script>example()</script></svg>', 'text', 'text/plain'], ['src/app.ts', 'export const n = 1;\n', 'text', 'text/plain']
  ]) {
    await f.file(name, content);
    assert.deepEqual(await previewProjectFile(f.root, name), { path: name, name: path.basename(name), size: Buffer.byteLength(content),
      kind, mime, encoding: 'utf8', content, truncated: false });
  }
});

test('unsupported binary files and mismatched media signatures never return a content payload', async t => {
  const f = await fixture(t);
  for (const [name, content] of [['archive.bin', Buffer.from('arbitrary data')], ['binary.txt', Buffer.from([0, 1, 2, 255])],
    ['unknown', Buffer.from([0, 255])], ['invalid.txt', Buffer.from([0xff, 0xff])], ['fake.png', '<html>not PNG</html>']]) {
    await f.file(name, content);
    const result = await previewProjectFile(f.root, name);
    assert.equal(result.kind, 'unsupported'); assert.equal(result.content, '');
    assert.equal(result.mime, 'application/octet-stream');
  }
});

test('allowlisted media requires matching magic and returns only base64 JSON data', async t => {
  const f = await fixture(t);
  for (const [name, bytes, mime, kind] of [
    ['image.PNG', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jDZkAAAAASUVORK5CYII=', 'base64'), 'image/png', 'image'],
    ['image.jpg', Buffer.from([255, 216, 255, 224, 0, 0]), 'image/jpeg', 'image'],
    ['image.gif', Buffer.from('GIF89a'), 'image/gif', 'image'],
    ['image.webp', Buffer.from('RIFF0000WEBP'), 'image/webp', 'image'],
    ['report.pdf', Buffer.from('%PDF-1.7\n%%EOF'), 'application/pdf', 'pdf']
  ]) {
    await f.file(name, bytes);
    assert.deepEqual(await previewProjectFile(f.root, name), { path: name, name, size: bytes.length, kind, mime, encoding: 'base64', content: bytes.toString('base64') });
  }
});

test('text truncation keeps complete UTF-8 and media limits fail before reading oversized contents', async t => {
  const f = await fixture(t);
  const prefix = 'a'.repeat(PROJECT_FILE_LIMITS.textBytes - 1);
  await f.file('large.txt', prefix + '中文');
  const result = await previewProjectFile(f.root, 'large.txt');
  assert.equal(result.truncated, true); assert.equal(result.content, prefix); assert.ok(!result.content.includes('\ufffd'));
  await f.file('large.html', '<p>' + 'a'.repeat(PROJECT_FILE_LIMITS.textBytes));
  const html = await previewProjectFile(f.root, 'large.html'); assert.equal(html.kind, 'html'); assert.equal(html.truncated, true);
  const target = await f.file('large.pdf', '%PDF-1.7'); await fs.truncate(target, PROJECT_FILE_LIMITS.mediaBytes + 1);
  await assert.rejects(previewProjectFile(f.root, 'large.pdf'), { code: 'PROJECT_FILE_TOO_LARGE' });
});

test('a file replaced between inspection and opening is refused without returning either body', async t => {
  const f = await fixture(t), target = await f.file('changing.txt', 'first data');
  const original = fs.open;
  fs.open = async (...args) => {
    if (args[0] === target) { await fs.rename(target, target + '.old'); await fs.writeFile(target, 'second data'); }
    return original(...args);
  };
  try { await assert.rejects(previewProjectFile(f.root, 'changing.txt'), { code: 'PROJECT_FILE_CHANGED' }); }
  finally { fs.open = original; }
});

test('a file changed during a bounded FD read is refused before publishing the result', async t => {
  const f = await fixture(t), target = await f.file('changing.txt', 'first data');
  const original = fs.open;
  fs.open = async (...args) => {
    const handle = await original(...args);
    if (args[0] === target) {
      const read = handle.read.bind(handle); let mutated = false;
      handle.read = async (...input) => {
        const result = await read(...input);
        if (!mutated) { mutated = true; await fs.writeFile(target, 'replacement data'); }
        return result;
      };
    }
    return handle;
  };
  try { await assert.rejects(previewProjectFile(f.root, 'changing.txt'), { code: 'PROJECT_FILE_CHANGED' }); }
  finally { fs.open = original; }
});

test('a directory changed during enumeration is refused before exposing a stale tree', async t => {
  const f = await fixture(t); await f.file('result/a.txt', 'data');
  const target = path.join(f.root, 'result'), original = fs.opendir;
  fs.opendir = async (...args) => {
    const directory = await original(...args);
    if (args[0] === target) { await fs.rename(target, target + '-old'); await fs.mkdir(target); }
    return directory;
  };
  try { await assert.rejects(listProjectFiles(f.root, 'result'), { code: 'PROJECT_FILE_CHANGED' }); }
  finally { fs.opendir = original; }
});

test('file API retains auth, project selection and JSON-only response boundaries', async t => {
  const first = await fixture(t), second = await fixture(t);
  await first.file('output.html', '<script>window.example = true</script>'); await second.file('output.html', '<p>second project</p>');
  const { handleWebRequest } = createHttpRoutes({ ctx: { root: first.root }, sessions: new Map(), token: 'fixture-token',
    webAuthMode: (_url, req) => req.headers.authorization === 'Bearer fixture-token' ? 'token' : null,
    cookieSessionOk: () => false,
    projectFromRequest: (_req, url) => {
      const selected = url.searchParams.get('root');
      if (selected && selected !== 'second') throw new CliError('PROJECT_FILE_FORBIDDEN', 'Select a registered project');
      return { root: selected === 'second' ? second.root : first.root };
    }, webErrorStatus: () => 500 });
  const server = http.createServer(handleWebRequest); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (suffix, options = {}) => fetch(base + suffix, { headers: { Authorization: 'Bearer fixture-token', 'X-HCC-API-Version': '2' }, ...options });
  const unauthenticated = await request('/api/files/tree', { headers: { 'X-HCC-API-Version': '2' } }); assert.equal(unauthenticated.status, 401);
  const unversioned = await request('/api/files/tree', { headers: { Authorization: 'Bearer fixture-token' } }); assert.equal(unversioned.status, 426);
  const preview = await request('/api/files/preview?path=output.html&root=second');
  assert.equal(preview.status, 200); assert.match(preview.headers.get('content-type'), /^application\/json/);
  assert.equal((await preview.json()).content, '<p>second project</p>');
  const tree = await request('/api/files/tree'); assert.equal((await tree.json()).entries[0].path, 'output.html');
  const traversal = await request('/api/files/preview?path=..%2Fother.txt'); assert.equal(traversal.status, 400);
  const denied = await request('/api/files/preview?path=.env'); assert.equal(denied.status, 403);
  const missing = await request('/api/files/preview?path=absent.txt'); assert.equal(missing.status, 404);
  assert.ok(!JSON.stringify(await missing.json()).includes(first.root));
  const post = await request('/api/files/preview?path=output.html', { method: 'POST' }); assert.equal(post.status, 404);
  assert.equal(await fs.readFile(path.join(first.root, 'output.html'), 'utf8'), '<script>window.example = true</script>');
});
