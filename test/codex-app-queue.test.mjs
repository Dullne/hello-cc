import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCodexAppQueueTransport } from '../lib/integrations/codex-app-queue.mjs';

const threadId = '00000000-0000-4000-8000-000000000001';
const queueId = '00000000-0000-4000-8000-000000000002';
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-codex-queue-')));
  const root = path.join(directory, 'project with spaces $()'), sqliteHome = path.join(directory, 'home');
  fs.mkdirSync(root); fs.mkdirSync(sqliteHome);
  const cli = path.join(directory, 'codex'); fs.writeFileSync(cli, 'not executed', { mode: 0o700 });
  const queueFile = path.join(sqliteHome, 'queue_1.sqlite'), db = new DatabaseSync(queueFile);
  db.exec('CREATE TABLE queued_items(id TEXT,thread_id TEXT,payload_json TEXT)');
  const calls = [];
  const sync = (command, args) => command.endsWith('lsof') ? 'verified' :
    args.includes('ppid=') ? `${process.ppid} ${cli}` : '/Applications/Codex.app/Contents/MacOS/Codex';
  const run = async (executable, args) => {
    calls.push({ executable, args });
    if (args[0] === '--version') return { stdout: 'codex-cli 0.164.0-alpha.11.1\n' };
    const text = args[args.indexOf('--message') + 1];
    db.prepare('INSERT INTO queued_items VALUES(?,?,?)').run(queueId, threadId, JSON.stringify({ UserInput: { content: [{ type: 'text', text }] } }));
    return { stdout: `Queued message ${queueId} for thread ${threadId}.\n` };
  };
  const create = options => createCodexAppQueueTransport({ root, threadId, cli, sqliteHome, appServerPid: process.pid,
    platform: 'darwin', sync, run, ...options });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, root, cli, sqliteHome, queueFile, db, create, calls, run };
}

test('official queue uses one argument array and the exact UUID/shared SQLite home; enqueue is not ACK or delivery', async t => {
  const f = fixture(t), transport = await f.create();
  const text = 'bounded notice with literal `touch /tmp/never` and $(nothing)';
  const receipt = await transport.enqueue({ text });
  assert.equal(receipt.queueId, queueId); assert.equal(receipt.sharedQueueRowVerified, true);
  assert.equal(receipt.delivered, false); assert.equal(receipt.acknowledged, false);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].args, ['-c', 'sqlite_home=' + JSON.stringify(f.sqliteHome),
    'queue', '--thread', threadId, '--message', text, '--cd', f.root]);
  assert.doesNotMatch(f.calls[1].args.join(' '), /thread\/resume|turn\/start|--remote|--dangerously/);
});

test('unknown CLI versions and missing original App queue ownership fail before submission', async t => {
  const f = fixture(t);
  await assert.rejects(f.create({ run: async () => ({ stdout: 'codex-cli 9.9.9' }) }), { code: 'CODEX_APP_QUEUE_VERSION_UNVERIFIED' });
  await assert.rejects(f.create({ sync: (command, args) => {
    if (command.endsWith('lsof')) throw new Error('not held');
    return args.includes('ppid=') ? `${process.ppid} ${f.cli}` : '/Applications/Codex.app/Contents/MacOS/Codex';
  } }));
  assert.equal(f.calls.filter(call => call.args.includes('queue')).length, 0);
});

test('queue replacement and executable update invalidate a previously established transport', async t => {
  const f = fixture(t), transport = await f.create();
  fs.renameSync(f.queueFile, f.queueFile + '.old');
  fs.writeFileSync(f.queueFile, 'replacement');
  await assert.rejects(transport.enqueue({ text: 'must not send' }), { code: 'CODEX_APP_QUEUE_IDENTITY_CHANGED' });
  assert.equal(f.calls.length, 1);
  fs.unlinkSync(f.queueFile); fs.renameSync(f.queueFile + '.old', f.queueFile);
  fs.appendFileSync(f.cli, 'changed');
  await assert.rejects(transport.enqueue({ text: 'must not send' }), { code: 'CODEX_APP_QUEUE_IDENTITY_CHANGED' });
});

test('timeout and wrong-thread receipts remain uncertain, with no automatic second command', async t => {
  const f = fixture(t); let submissions = 0;
  const timedOut = await f.create({ run: async (_executable, args) => {
    if (args[0] === '--version') return { stdout: 'codex-cli 0.164.0-alpha.11.1' };
    submissions++; throw new Error('timeout after possible insertion');
  } });
  await assert.rejects(timedOut.enqueue({ text: 'notice' }), { code: 'CODEX_APP_QUEUE_UNCERTAIN' });
  assert.equal(submissions, 1);
  const foreign = await f.create({ run: async (_executable, args) => args[0] === '--version' ?
    { stdout: 'codex-cli 0.164.0-alpha.11.1' } : { stdout: `Queued message ${queueId} for thread ${queueId}.` } });
  await assert.rejects(foreign.enqueue({ text: 'notice' }), { code: 'CODEX_APP_QUEUE_UNCERTAIN' });
});

test('unsupported platforms and non-UUID targets cannot queue into another session', async t => {
  const f = fixture(t);
  await assert.rejects(f.create({ platform: 'win32' }), { code: 'CODEX_APP_QUEUE_UNSUPPORTED' });
  await assert.rejects(f.create({ threadId: 'an-exact-name-is-still-not-allowed' }), { code: 'BAD_ARGS' });
  assert.equal(f.calls.length, 0);
});
