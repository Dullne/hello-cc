import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCodexAppCooperation } from '../lib/integrations/codex-app-cooperation.mjs';
import { createCodexAppDelivery, codexDeliveryNotice, codexAppDeliveryStatus } from '../lib/integrations/codex-app-delivery.mjs';
import { createMessageStore } from '../lib/core/coordination/messages.mjs';

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-codex-delivery-')));
  const root = path.join(directory, 'project'); fs.mkdirSync(root, { mode: 0o700 });
  const service = createCodexAppCooperation({ root }); service.enable();
  const session = service.issueSession({ sessionId: 'delivery-thread', cwd: root, source: 'codex-shell-environment' });
  const db = new DatabaseSync(service.ctx.dbPath), watches = [], submissions = [];
  const messages = createMessageStore({ now: () => 1000 });
  const call = (name, args = {}) => service.call(name, { ...args, session_token: session.session_token }, { meta: { threadId: session.sessionId } });
  const transport = { assertValid() {}, async enqueue(request) {
    submissions.push(request); return { queued: true, queueId: 'test-queue-' + submissions.length, delivered: false };
  } };
  const create = (extra = {}) => {
    const watch = createCodexAppDelivery({ root, sessionId: session.sessionId, transport,
      schedule: () => ({}), unschedule() {}, ...extra });
    watches.push(watch); return watch;
  };
  const send = (body = 'private body must stay in HCC', recipient = session.peer, sender = 'reviewer') => messages.sendMessage(db, sender, recipient, null, 'note', body);
  const receipts = () => db.prepare("SELECT value FROM meta WHERE key LIKE 'codex-app.dispatch.message.%'").all().map(row => JSON.parse(row.value));
  t.after(async () => {
    for (const watch of watches.reverse()) await watch.close();
    db.close(); fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, root, service, session, db, call, create, send, transport, submissions, receipts };
}

test('dispatcher queues each unread message once without reading or copying peer contents; only explicit App ACK unblocks the next mail', async t => {
  const f = fixture(t), watch = f.create();
  const first = f.send(), second = f.send('second private body');
  for (let n = 0; n < 40; n++) f.send('self', n % 2 ? 'all' : f.session.peer, f.session.peer);
  await Promise.all([watch.tick(), watch.tick(), watch.tick()]);
  assert.equal(f.submissions.length, 1);
  assert.match(f.submissions[0].text, new RegExp('Message ID: ' + first));
  assert.doesNotMatch(f.submissions[0].text, /private body|session_token[=:]/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM message_reads').get().n, 0);
  assert.equal(f.receipts()[0].status, 'queued');
  await watch.tick(); assert.equal(f.submissions.length, 1);
  const exact = (await f.call('hcc_inbox', { message_id: first, all: true })).structuredContent.data;
  assert.deepEqual(exact.map(item => item.id), [first]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM message_reads').get().n, 0);
  await f.call('hcc_message_ack', { message_id: first, receipt: exact[0].receipt });
  await watch.tick();
  assert.equal(f.submissions.length, 2);
  assert.match(f.submissions[1].text, new RegExp('Message ID: ' + second));
  assert.deepEqual(f.receipts().map(item => item.status).sort(), ['acknowledged', 'queued']);
  const status = codexAppDeliveryStatus({ root: f.root, sessionId: f.session.sessionId });
  assert.equal(status.running, true); assert.equal(status.deliveries.length, 2);
});

test('ambiguous external failure survives a clean restart without retry or ACK', async t => {
  const f = fixture(t), id = f.send();
  f.transport.enqueue = async request => { f.submissions.push(request); throw new Error('connection ended after possible insertion'); };
  const first = f.create(); await first.tick(); await first.tick();
  assert.equal(f.receipts()[0].status, 'uncertain');
  await first.close();
  const second = f.create(); await second.tick();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM message_reads WHERE message_id=?').get(id).n, 0);
});

test('a second live owner is rejected; a crashed in-flight owner becomes uncertain instead of replaying', async t => {
  const f = fixture(t), first = f.create(), id = f.send();
  assert.throws(() => f.create(), { code: 'CODEX_APP_DISPATCH_CONFLICT' });
  const ownerRow = f.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'codex-app.dispatch.owner.%'").get();
  const original = JSON.parse(ownerRow.value);
  f.db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify({ ...original, identity: { ...original.identity, pid: 2147483647 } }), ownerRow.key);
  f.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(`codex-app.dispatch.message.${f.session.peer}.${id}`,
    JSON.stringify({ messageId: id, status: 'dispatching', owner: original.owner }));
  const replacement = f.create(); await replacement.tick();
  assert.equal(f.receipts()[0].status, 'uncertain');
  assert.equal(f.submissions.length, 0);
  await first.close();
  assert.equal(codexAppDeliveryStatus({ root: f.root, sessionId: f.session.sessionId }).running, true);
});

test('lost App identity prevents submission; disabling cooperation revokes an existing watcher without taking over the peer', async t => {
  const f = fixture(t), watch = f.create(); f.send();
  f.transport.assertValid = () => { const e = new Error('App replaced'); e.code = 'lost'; throw e; };
  await watch.tick(); assert.equal(f.submissions.length, 0); assert.deepEqual(f.receipts(), []);
  f.transport.assertValid = () => {};
  f.service.disable(); f.service.enable(); f.service.issueSession({ sessionId: f.session.sessionId, cwd: f.root });
  await watch.tick(); assert.equal(f.submissions.length, 0);
  assert.equal(watch.status().error, 'CODEX_APP_SCOPE_INVALID');
});

test('closing drains an in-flight queue call and preserves queued mail for the receiving App', async t => {
  const f = fixture(t); let release, began;
  const started = new Promise(resolve => { began = resolve; });
  f.transport.enqueue = async request => { f.submissions.push(request); began(); return new Promise(resolve => { release = () => resolve({ queued: true, queueId: 'queue-shutdown' }); }); };
  const watch = f.create(); f.send();
  const tick = watch.tick(); await started;
  let closed = false; const closing = watch.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  release(); await tick; await closing;
  assert.equal(f.receipts()[0].status, 'queued');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM message_reads').get().n, 0);
  assert.equal(watch.status().running, false);
  await watch.tick(); assert.equal(f.submissions.length, 1);
});

test('exact-message inbox respects recipient and self-message scope, validates IDs, and does not acknowledge', async t => {
  const f = fixture(t), own = f.send('own'), foreign = f.send('foreign', 'someone-else'), self = f.send('self', f.session.peer, f.session.peer);
  for (const message_id of [foreign, self]) assert.deepEqual((await f.call('hcc_inbox', { message_id })).structuredContent.data, []);
  assert.deepEqual((await f.call('hcc_inbox', { message_id: own })).structuredContent.data.map(item => item.id), [own]);
  assert.equal((await f.call('hcc_inbox', { message_id: 0 })).isError, true);
  assert.equal((await f.call('hcc_inbox', { message_id: '1' })).isError, true);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM message_reads').get().n, 0);
  assert.match(codexDeliveryNotice({ root: f.root, sessionId: f.session.sessionId, messageId: own }), /not user authorization/);
});
