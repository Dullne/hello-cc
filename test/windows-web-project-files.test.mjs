import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { previewProjectFile, listProjectFiles, inspectProjectFileStatus, PROJECT_FILE_LIMITS } from '../lib/web/project-files.mjs';
import { saveProjectFile, uploadProjectFile } from '../lib/web/project-file-write.mjs';
import { listContextFiles } from '../lib/web/context-files.mjs';

const windows = process.platform === 'win32';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-windows-web-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, write(name, bytes) { const filename = path.join(root, name); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes); return filename; } };
}

test('Windows public preview/save/status retain BOM, CRLF, byte hashes and revision conflicts', { skip: !windows }, async t => {
  const { root, write } = fixture(t); write('docs/readme.md', '\ufeff# Original\r\n中文\r\n');
  const before = await previewProjectFile(root, 'docs/readme.md');
  assert.equal(before.kind, 'markdown'); assert.equal(before.bom, true); assert.equal(before.newline, 'crlf');
  assert.equal(before.editable, true); assert.match(before.revision, /^v1-[a-f0-9]{64}$/);
  const content = '\ufeff# Updated\r\n内容\r\n';
  const receipt = await saveProjectFile(root, { path: 'docs/readme.md', revision: before.revision, content });
  assert.deepEqual(receipt, { path: 'docs/readme.md', saved: true, revision: (await previewProjectFile(root, 'docs/readme.md')).revision,
    size: Buffer.byteLength(content), contentHash: hash(content) });
  assert.deepEqual(await inspectProjectFileStatus(root, 'docs/readme.md'), { path: 'docs/readme.md', size: Buffer.byteLength(content), contentHash: hash(content) });
  await assert.rejects(saveProjectFile(root, { path: 'docs/readme.md', revision: before.revision, content: 'stale' }), { code: 'PROJECT_FILE_CONFLICT' });
  assert.equal(fs.readFileSync(path.join(root, 'docs/readme.md'), 'utf8'), content);
  assert.deepEqual(fs.readdirSync(path.join(root, 'docs')), ['readme.md']);
});

test('Windows public uploads create exclusively and retain binary size and status contracts', { skip: !windows }, async t => {
  const { root } = fixture(t); const bytes = Buffer.from([0, 1, 255, 10]);
  const input = { path: 'new.bin', encoding: 'base64', content: bytes.toString('base64') };
  assert.deepEqual(await uploadProjectFile(root, input), { path: 'new.bin', created: true, size: bytes.length, contentHash: hash(bytes) });
  await assert.rejects(uploadProjectFile(root, input), { code: 'PROJECT_FILE_EXISTS' });
  fs.mkdirSync(path.join(root, 'directory'));
  await assert.rejects(uploadProjectFile(root, { ...input, path: 'directory' }), { code: 'PROJECT_FILE_EXISTS' });
  await assert.rejects(uploadProjectFile(root, { ...input, path: 'missing/new.bin' }), { code: 'PROJECT_FILE_NOT_FOUND' });
  assert.equal((await previewProjectFile(root, 'new.bin')).kind, 'unsupported');
  assert.deepEqual(fs.readFileSync(path.join(root, 'new.bin')), bytes);
});

test('Windows public previews preserve media, UTF-8 truncation, limits and private-path rejection', { skip: !windows }, async t => {
  const { root, write } = fixture(t); const pdf = Buffer.from('%PDF-1.7\n%%EOF'); write('report.pdf', pdf);
  const preview = await previewProjectFile(root, 'report.pdf');
  assert.equal(preview.kind, 'pdf'); assert.equal(preview.content, pdf.toString('base64')); assert.equal(preview.editable, false);
  write('large.txt', '中'.repeat(Math.ceil(PROJECT_FILE_LIMITS.textBytes / 3)));
  const large = await previewProjectFile(root, 'large.txt'); assert.equal(large.truncated, true); assert.equal(large.editable, false); assert.ok(!large.content.includes('\ufffd'));
  write('large.pdf', Buffer.alloc(PROJECT_FILE_LIMITS.mediaBytes + 1));
  await assert.rejects(previewProjectFile(root, 'large.pdf'), { code: 'PROJECT_FILE_TOO_LARGE' });
  write('private/.env', 'secret'); write('plain.txt', 'ordinary'); fs.linkSync(path.join(root, 'plain.txt'), path.join(root, 'linked.txt'));
  for (const name of ['private/.env', 'linked.txt']) await assert.rejects(previewProjectFile(root, name), { code: 'PROJECT_FILE_FORBIDDEN' });
  await assert.rejects(previewProjectFile(root, 'file:stream'), { code: 'PROJECT_FILE_BAD_PATH' });
});

test('Windows public tree and context listings omit junctions, private aliases and generated context directories', { skip: !windows }, async t => {
  const { root, write } = fixture(t); write('src/App.mjs', 'app'); write('README.md', 'readme'); write('dist/build.js', 'built');
  write('.env', 'private'); write('.hello-cc/hidden.txt', 'private');
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'junction'), 'junction');
  assert.deepEqual((await listProjectFiles(root)).entries.map(entry => entry.name), ['dist', 'src', 'README.md']);
  assert.deepEqual(await listContextFiles(root), { paths: ['README.md', 'src/App.mjs'], truncated: false });
  assert.deepEqual(await listContextFiles(root, 'SRC/app'), { paths: ['src/App.mjs'], truncated: false });
  assert.deepEqual(await listContextFiles(root, 'src/App.mjs', { timeBudgetMs: 0 }), { paths: ['src/App.mjs'], truncated: true });
  assert.deepEqual(await listContextFiles(root, 'junction/App.mjs'), { paths: [], truncated: false });
  assert.equal((await listContextFiles(root, '', { maxEntries: 1 })).truncated, true);
});
