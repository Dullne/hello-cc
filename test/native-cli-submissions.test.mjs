import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { contextForProject } from '../lib/runtime/paths.mjs';
import { listCliSubmissions, matchingCliSubmission, prepareCliSubmission } from '../lib/runtime/native/cli-submissions.mjs';
import { createNativeTestRoot } from './helpers/native-root.mjs';
import { nativePaths } from '../lib/runtime/native/store.mjs';

test('CLI submissions keep database bindings when one project uses two coordination databases', async t => {
  const root = await createNativeTestRoot('hcc-cli-submission-db-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = contextForProject(root);
  const alternate = { ...primary, dbPath: path.join(path.dirname(primary.dbPath), 'alternate.db') };
  const input = { peer: 'worker', from: 'coordinator', taskId: null, body: 'one intent' };
  const first = prepareCliSubmission(primary, input);
  const second = prepareCliSubmission(alternate, input);
  assert.notEqual(first.submission_id, second.submission_id);
  assert.deepEqual(listCliSubmissions(primary).map(row => row.submission_id), [first.submission_id]);
  assert.deepEqual(listCliSubmissions(alternate).map(row => row.submission_id), [second.submission_id]);
  assert.throws(() => matchingCliSubmission(alternate, { ...input, submissionId: first.submission_id }),
    { code: 'NATIVE_CLI_JOURNAL_INVALID' });
  assert.equal(matchingCliSubmission(primary, { ...input, submissionId: first.submission_id }).submission_id,
    first.submission_id);
});

test('an outside coordination database cannot prepare a CLI submission', async t => {
  const root = await createNativeTestRoot('hcc-cli-submission-outside-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => prepareCliSubmission({ root, dbPath: path.join(root, 'outside.db') },
    { peer: 'worker', from: 'coordinator', taskId: null, body: 'not sent' }),
    { code: 'NATIVE_STATE_UNSAFE' });
  assert.equal(fs.existsSync(path.join(root, '.hello-cc', 'native-cli-submissions')), false);
});

test('CLI listing rejects unsafe saved database bindings before filtering another database', async t => {
  const root = await createNativeTestRoot('hcc-cli-submission-corrupt-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = contextForProject(root);
  const record = prepareCliSubmission(ctx, { peer: 'worker', from: 'coordinator', body: 'one intent' });
  const file = path.join(path.dirname(nativePaths(ctx).dir), 'native-cli-submissions',
    `submission-${record.submission_id}.json`);
  for (const binding of ['', null, 17, '../outside.db', '..\\outside.db', '/outside.db', 'C:\\outside.db']) {
    fs.writeFileSync(file, JSON.stringify({ ...record, mesh_db_relative: binding }));
    assert.throws(() => listCliSubmissions(ctx), { code: 'NATIVE_CLI_JOURNAL_INVALID' });
  }
  fs.writeFileSync(file, JSON.stringify({ ...record, mesh_db_relative: 'alternate.db', root: '/another/project' }));
  assert.throws(() => listCliSubmissions(ctx), { code: 'NATIVE_CLI_JOURNAL_INVALID' });
});
