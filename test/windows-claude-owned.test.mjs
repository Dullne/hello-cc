import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeAdapter } from '../lib/integrations/native/claude.mjs';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';

const windows = { skip: process.platform !== 'win32', timeout: 20000 };
async function until(predicate, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for owned Claude helper');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-claude-job-'));
  const profile = path.join(root, 'profile'), project = path.join(root, 'project');
  fs.mkdirSync(profile); fs.mkdirSync(project);
  const sdk = path.join(project, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ type: 'module', exports: './sdk.mjs' }));
  fs.writeFileSync(path.join(sdk, 'sdk.mjs'), `
    import fs from 'node:fs';
    import {spawn} from 'node:child_process';
    if(process.env.FAKE_IMPORT_DELAY)await new Promise(resolve=>setTimeout(resolve,Number(process.env.FAKE_IMPORT_DELAY)));
    export async function forkSession(id) { return {sessionId: id + '-fork'}; }
    export function query({prompt, options}) {
      if(!process.env.FAKE_PID_FILE)throw new Error('SDK was not isolated in its configured helper environment');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});
      child.unref();fs.writeFileSync(process.env.FAKE_PID_FILE,JSON.stringify({helper:process.pid,child:child.pid}));
      const stream=(async function*(){
        const session=options.resume || 'owned-session';
        yield {type:'system',subtype:'init',session_id:session};
        for await(const input of prompt) {
          if(input.message.content==='exit') { setTimeout(()=>process.exit(17),25);await new Promise(()=>{}); }
          if(input.message.content==='oversized-output') {
            await new Promise(resolve=>setTimeout(resolve,25));
            yield {type:'assistant',message:{content:'x'.repeat(3*1024*1024)}};
          }
          const approval=await options.canUseTool('Bash',{command:'echo fake'},{requestId:'approval-1'});
          yield {type:'result',subtype:'success',session_id:session,user_message_uuid:input.uuid,result:JSON.stringify({helper:process.pid,decision:approval.behavior,home:process.env.USERPROFILE})};
        }
      })();
      stream.close=()=>new Promise(()=>{});
      stream.interrupt=async()=>({interrupted:true});
      return stream;
    }`);
  const events = [], pidFile = path.join(root, 'pids.json');
  const adapter = createClaudeAdapter({ cwd: project, timeoutMs: 250, ...extra,
    env: { ...process.env, HOME: profile, USERPROFILE: profile, FAKE_PID_FILE: pidFile, ...extra.env },
    onEvent: event => events.push(event) });
  t.after(async () => {
    await adapter.close().catch(() => {});
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 });
  });
  return { root, project, profile, adapter, events, pids: () => JSON.parse(fs.readFileSync(pidFile)) };
}

test('Windows Claude SDK and detached descendants are owned; close confirms Job exit despite hanging SDK close', windows, async t => {
  const { adapter, events, profile, project, pids } = fixture(t);
  await adapter.open(); await adapter.send({ text: 'hello' });
  await until(() => events.some(event => event.type === 'completed'));
  const result = JSON.parse(events.find(event => event.type === 'completed').text);
  assert.notEqual(result.helper, process.pid, 'SDK must never load in the HCC supervisor');
  assert.equal(result.home, profile);
  assert.equal(result.decision, 'deny');
  const owned = pids();
  assert.equal(loadWindowsNative().inspectProcess(owned.child).state, 'live');
  assert.throws(() => fs.renameSync(project, project + '-moved'), error => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code));
  await adapter.close();
  await until(() => Object.values(owned).every(pid => loadWindowsNative().inspectProcess(pid).state === 'dead'));
  fs.renameSync(project, project + '-moved');
  assert.equal(adapter.snapshot().status, 'closed');
});

test('Windows Claude helper preserves fork, streaming snapshots and explicit approval responses', windows, async t => {
  const { adapter, events } = fixture(t, { interactive: true });
  const opened = await adapter.open({ forkSessionId: 'source-session' });
  assert.equal(opened.sessionId, 'source-session-fork');
  await adapter.send({ text: 'permission', submissionId: 'owned-submission' });
  await until(() => adapter.snapshot().pendingApprovals.length === 1);
  const request = adapter.snapshot().pendingApprovals[0];
  await adapter.respond({ ...request, decision: 'accept' });
  await until(() => adapter.snapshot().status === 'completed');
  const completed = events.find(event => event.type === 'completed');
  assert.equal(completed.submissionId, 'owned-submission');
  assert.equal(JSON.parse(completed.text).decision, 'allow');
  assert.equal(adapter.snapshot().pendingApprovals.length, 0);
});

test('Windows Claude unexpected helper exit terminates its detached SDK descendants', windows, async t => {
  const { adapter, pids } = fixture(t);
  await adapter.open(); await adapter.send({ text: 'exit' });
  await until(() => adapter.snapshot().status === 'error');
  const owned = pids();
  await until(() => loadWindowsNative().inspectProcess(owned.child).state === 'dead');
  await adapter.close();
  assert.equal(loadWindowsNative().inspectProcess(owned.helper).state, 'dead');
});

test('Windows Claude rejects an oversized RPC request before sending a prompt', windows, async t => {
  const { adapter } = fixture(t);
  await adapter.open();
  await assert.rejects(adapter.send({ text: 'x'.repeat(3 * 1024 * 1024) }), { code: 'NATIVE_PROTOCOL_LIMIT' });
  assert.equal(adapter.snapshot().turnId, null);
});

test('Windows Claude normalizes inherited environment markers before isolation', windows, async () => {
  let received;
  const adapter = createClaudeAdapter({ env: { hcc_root: 'inherited-root', claUdeCode: '1', codex_thread_id: 'old-thread', PATH: process.env.PATH },
    query: ({ options, prompt }) => {
      received = options.env;
      const stream = (async function* () { for await (const input of prompt) yield input; })();
      stream.close = () => prompt.return(); return stream;
    } });
  try {
    await adapter.send({ text: 'inspect environment' });
    assert.equal(received.HCC_ROOT, undefined);
    assert.equal(received.CLAUDECODE, undefined);
    assert.equal(received.CODEX_THREAD_ID, undefined);
  } finally { await adapter.close(); }
});

test('Windows Claude prevents mixed-case NODE_OPTIONS preloads from running before the helper', windows, async t => {
  const { adapter } = fixture(t, { env: { node_options: '--require=C:\\hcc-nonexistent-preload-proof.cjs' } });
  await adapter.open();
  assert.equal(adapter.snapshot().status, 'ready');
});

test('Windows Claude oversized SDK output closes the helper and its descendants', windows, async t => {
  const { adapter, pids } = fixture(t);
  await adapter.open(); await adapter.send({ text: 'oversized-output' });
  await until(() => adapter.snapshot().status === 'error');
  const owned = pids();
  await until(() => Object.values(owned).every(pid => loadWindowsNative().inspectProcess(pid).state === 'dead'));
  await adapter.close();
});

test('Windows Claude close bounds an SDK import in progress and rejects late startup', windows, async t => {
  const { adapter } = fixture(t, { env: { FAKE_IMPORT_DELAY: '2000' }, timeoutMs: 400 });
  const opening = adapter.open().then(() => null, error => error);
  await new Promise(resolve => setTimeout(resolve, 150));
  await adapter.close();
  assert.ok(await opening);
  assert.equal(adapter.snapshot().status, 'closed');
});
