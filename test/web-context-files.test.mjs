import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listContextFiles } from '../lib/web/context-files.mjs';
import { captureSelectedCwdIdentity } from '../lib/process/selected-cwd-identity.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hcc-context-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('context files stay project-relative and omit symlinks, credentials and generated directories', async t => {
  const container = await fixture(t), root = path.join(container, 'project'), outside = path.join(container, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.txt'), 'not read');
  const files = ['src/App.mjs', 'README.md', '.env', '.env.local', '.git/config', '.hcc/state.json', '.codex/auth.json', '.claude/settings.json', '.dsh/history', '.ssh/id_rsa', '.aws/credentials', 'node_modules/library/a.js', 'dist/a.js', 'build/a.js', 'coverage/a.js', '.next/a.js'];
  for (const file of files) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), 'fixture'); }
  await fs.symlink(outside, path.join(root, 'linked-directory'));
  await fs.symlink(path.join(outside, 'private.txt'), path.join(root, 'linked-file'));
  await fs.symlink(path.join(root, 'src'), path.join(root, 'internal-link'));
  assert.deepEqual(await listContextFiles(root), { paths: ['README.md', 'src/App.mjs'], truncated: false });
  assert.deepEqual(await listContextFiles(root, 'SRC/app'), { paths: ['src/App.mjs'], truncated: false });
  for (const query of [...files.filter(file => file !== 'README.md' && file !== 'src/App.mjs'), 'linked-directory/private.txt', 'linked-file', 'internal-link/App.mjs']) {
    assert.deepEqual(await listContextFiles(root, query), { paths: [], truncated: false }, query);
  }
});

test('an exact relative filename remains available when directory reads consume the scan budget', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.hello-cc'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/claude-marker.txt'), 'fixture');
  const identity = captureSelectedCwdIdentity(root); t.after(() => identity.release());
  const opendir = fs.opendir;
  const delayed = t.mock.method(fs, 'opendir', async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 225));
    return opendir(...args);
  });
  assert.deepEqual(await listContextFiles(root, 'src/claude-marker.txt', { rootIdentity: identity }),
    { paths: ['src/claude-marker.txt'], truncated: true });
  assert.deepEqual(await listContextFiles(root, 'claude-marker', { rootIdentity: identity }),
    { paths: [], truncated: true });
  delayed.mock.restore();
  assert.deepEqual(await listContextFiles(root, 'src/claude-marker.txt', { rootIdentity: identity }),
    { paths: ['src/claude-marker.txt'], truncated: false });
});

test('an exact hit is deduplicated while other substring matches and result limits remain intact', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'marker.txt'), 'fixture');
  await fs.writeFile(path.join(root, 'src/marker.txt'), 'fixture');
  assert.deepEqual(await listContextFiles(root, 'marker.txt'),
    { paths: ['marker.txt', 'src/marker.txt'], truncated: false });
  assert.deepEqual(await listContextFiles(root, 'marker.txt', { limit: 1 }),
    { paths: ['marker.txt'], truncated: true });
});

test('invalid context queries and nonfinite budgets are rejected before filesystem traversal', async () => {
  for (const query of ['../file', 'src/../file', '/etc/passwd', 'src\\file', 'a\0b', 'a\nb', 'x'.repeat(257), null]) {
    await assert.rejects(listContextFiles('/missing-fixture', query), { code: 'INVALID_CONTEXT_QUERY' });
  }
  for (const options of [{ limit: 0 }, { maxEntries: -1 }, { maxEntries: Infinity }, { timeBudgetMs: NaN }, { timeBudgetMs: -1 }, { now: null }]) {
    await assert.rejects(listContextFiles('/missing-fixture', '', options), /Invalid context file listing budget/);
  }
});

test('result, entry and elapsed-time budgets report incomplete listings without exceeding limits', async t => {
  const root = await fixture(t);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await fs.writeFile(path.join(root, name), 'fixture');
  const limited = await listContextFiles(root, '', { limit: 2 });
  assert.equal(limited.paths.length, 2); assert.equal(limited.truncated, true);
  const scanned = await listContextFiles(root, 'no-match', { maxEntries: 1 });
  assert.deepEqual(scanned, { paths: [], truncated: true });
  assert.deepEqual(await listContextFiles(root, '', { timeBudgetMs: 0, now: () => 0 }), { paths: [], truncated: true });
  let clock = 0;
  const timed = await listContextFiles(root, '', { timeBudgetMs: 3, now: () => clock++ });
  assert.ok(timed.paths.length < 3); assert.equal(timed.truncated, true);
});
