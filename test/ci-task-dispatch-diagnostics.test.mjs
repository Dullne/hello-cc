import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { taskDispatchFailureDiagnostics } from '../.github/scripts/task-dispatch-diagnostics.mjs';

const markers = [
  'task dispatch injected default natural-language prompt into shell session:',
  'task dispatch did not inject explicit shell-safe message:'
];
const safeResult = {
  injected: false, delivery: 'message-only', injection_reason: 'runtime_unavailable', session: null
};
const summary = {
  injected: false, delivery: 'message-only', injectionReason: 'runtime_unavailable',
  sessionPresent: false, sessionKind: null, sessionStatus: null
};
const failure = (value = safeResult, marker = markers[0]) =>
  'Error: ' + marker + '\n' + JSON.stringify(value, null, 2) + '\n    at PRIVATE_STACK_PATH:1:2\n';

test('CI dispatch diagnostics extract both exact markers and only fixed fields', () => {
  for (const marker of markers) {
    const value = { ...safeResult, task: { title: 'PRIVATE_TITLE', id: 'PRIVATE_ID' },
      message: 'PRIVATE_MESSAGE', target: 'PRIVATE_PEER', path: '/PRIVATE_PATH',
      token: 'PRIVATE_TOKEN', command: 'PRIVATE_COMMAND', code: 'PRIVATE_CODE' };
    assert.deepEqual(taskDispatchFailureDiagnostics(failure(value, marker)), [summary]);
    assert.deepEqual(taskDispatchFailureDiagnostics(failure(value, marker).replace('Error: ', '')), [summary]);
    assert.doesNotMatch(JSON.stringify(taskDispatchFailureDiagnostics(failure(value, marker))), /PRIVATE/);
  }
});

test('CI dispatch diagnostics preserve booleans and known session enums without identifiers', () => {
  const result = taskDispatchFailureDiagnostics(failure({
    injected: true, delivery: 'message+inject', injection_reason: 'injected',
    session: { id: 'PRIVATE_ID', peer_id: 'PRIVATE_PEER', kind: 'codex', status: 'running' }
  }));
  assert.deepEqual(result, [{ injected: true, delivery: 'message+inject', injectionReason: 'injected',
    sessionPresent: true, sessionKind: 'codex', sessionStatus: 'running' }]);
  for (const reason of ['no_inject', 'session_not_running', 'unsupported_session_kind', 'target_busy']) {
    assert.equal(taskDispatchFailureDiagnostics(failure({ ...safeResult, injection_reason: reason }))[0].injectionReason, reason);
  }
});

test('CI dispatch diagnostics replace unknown values and incorrect types with null', () => {
  for (const unknown of ['PRIVATE_SECRET', true, 1, [], { value: 'PRIVATE_SECRET' }, null]) {
    const result = taskDispatchFailureDiagnostics(failure({
      injected: 'false', delivery: unknown, injection_reason: unknown,
      session: { kind: unknown, status: unknown }
    }));
    assert.deepEqual(result, [{ injected: null, delivery: null, injectionReason: null,
      sessionPresent: true, sessionKind: null, sessionStatus: null }]);
  }
  for (const session of [undefined, null, 'PRIVATE_SESSION', []]) {
    assert.deepEqual(taskDispatchFailureDiagnostics(failure({ ...safeResult, session })), [summary]);
  }
});

test('CI dispatch diagnostics do not mistake string braces or escaped quotes for JSON boundaries', () => {
  const privateText = 'PRIVATE \\"}]} { \\n' + markers[1] + '\n{"injected":true}';
  const log = failure({ ...safeResult, message: privateText,
    task: { body: ['PRIVATE [ }', { nested: 'PRIVATE \\ " { ]' }] } });
  assert.deepEqual(taskDispatchFailureDiagnostics(log), [summary]);
  assert.doesNotMatch(JSON.stringify(taskDispatchFailureDiagnostics(log)), /PRIVATE/);
});

test('CI dispatch diagnostics refuse malformed JSON, wrappers and non-immediate objects', () => {
  for (const suffix of [
    '{"injected":false,', '{"task":[}', '{"message":"unterminated}',
    '[{"injected":false}]', 'PRIVATE_PREFIX\n' + JSON.stringify(safeResult),
    JSON.stringify(safeResult) + ' PRIVATE_TRAILER',
    '{"message":"PRIVATE", "nested":' + JSON.stringify(safeResult)
  ]) {
    assert.deepEqual(taskDispatchFailureDiagnostics('Error: ' + markers[0] + '\n' + suffix), []);
  }
  for (const log of [undefined, null, {}, failure().replace(markers[0], markers[0] + ' PRIVATE_SUFFIX'),
    failure().replace('Error: ', 'PRIVATE_PREFIX Error: '),
    'Error: unrelated PRIVATE_ERROR\n' + JSON.stringify(safeResult)]) {
    assert.deepEqual(taskDispatchFailureDiagnostics(log), []);
  }
});

test('CI dispatch diagnostics bound input, payloads and duplicate results', () => {
  assert.deepEqual(taskDispatchFailureDiagnostics(failure() + 'x'.repeat(256 * 1024)), []);
  assert.deepEqual(taskDispatchFailureDiagnostics('x'.repeat(300 * 1024) + '\n' + failure()), [summary]);
  assert.deepEqual(taskDispatchFailureDiagnostics(failure({ ...safeResult, message: 'x'.repeat(64 * 1024) })), []);
  assert.deepEqual(taskDispatchFailureDiagnostics(failure({ ...safeResult, message: '私'.repeat(24 * 1024) })), []);
  assert.deepEqual(taskDispatchFailureDiagnostics(failure().repeat(4)), [summary]);
  assert.deepEqual(taskDispatchFailureDiagnostics('\u001b[31m' + failure() + '\u001b[0m'), [summary]);
});

test('workflow annotation publishes the exact mock reason and no private failure JSON', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-ci-dispatch-diagnostic-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  fs.writeFileSync(path.join(scratch, 'hcc-regression.log'), failure({ ...safeResult,
    task: { title: 'PRIVATE_TITLE', body: 'PRIVATE_BODY', id: 'PRIVATE_ID' },
    token: 'PRIVATE_TOKEN', message: 'PRIVATE_MESSAGE', command: 'PRIVATE_COMMAND',
    path: '/PRIVATE_PATH', code: 'PRIVATE_CODE'
  }));
  const repo = path.resolve(import.meta.dirname, '..');
  const workflow = fs.readFileSync(path.join(repo, '.github/workflows/test.yml'), 'utf8');
  const step = workflow.split('      - name: Annotate failed Node tests\n')[1]
    ?.split('      - name: Upload regression log\n')[0];
  const script = step?.match(/          node --input-type=module <<'NODE'\n([\s\S]*?)          NODE\n/)?.[1]
    .replace(/^          /gm, '');
  assert.ok(script, 'the actual annotation step must be executable');
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    cwd: repo, input: script, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, RUNNER_TEMP: scratch, HCC_REGRESSION_OUTCOME: 'failure', HCC_CROSS_UID_OUTCOME: 'success' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^::error title=Regression test failure::/);
  assert.ok(result.stdout.includes('Task dispatch result: ' + JSON.stringify(summary)));
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE|Different-UID test failure/);
});
