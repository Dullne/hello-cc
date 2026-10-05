import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../lib/integrations/claude-app-collaboration.mjs', import.meta.url).href;
const pathsUrl = new URL('../lib/runtime/paths.mjs', import.meta.url).href;
const storeUrl = new URL('../lib/core/coordination/messages.mjs', import.meta.url).href;
const cwdUrl = new URL('../lib/process/selected-cwd-identity.mjs', import.meta.url).href;
const errorsUrl = new URL('../lib/shared/errors.mjs', import.meta.url).href;
const cli = new URL('../bin/hcc.mjs', import.meta.url).pathname;
function scenario(t, body) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-claude-bus-')));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'project'), privateHome = path.join(temporary, 'home');
  for (const directory of [root, privateHome]) fs.mkdirSync(directory, { mode: 0o700 });
  const source = `import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import { spawnSync } from 'node:child_process';
    import { createClaudeAppCoordination } from ${JSON.stringify(moduleUrl)};
    import { projectDbPath } from ${JSON.stringify(pathsUrl)};
    import { createMessageStore } from ${JSON.stringify(storeUrl)};
    import { captureSelectedCwdSnapshot } from ${JSON.stringify(cwdUrl)};
    import { CliError } from ${JSON.stringify(errorsUrl)};
    const root=process.env.HCC_APP_TEST_ROOT, sessionId='desktop-test-session', requests=new Map(), sent=[];
    let ready=true;
    const bridge={list:()=>[{sessionId,cwd:root,ready}],
      send:request=>{sent.push(request);requests.set(request.requestId,{...request,status:'queued'});},
      getRequest:id=>requests.get(id)};
    const create=()=>createClaudeAppCoordination({root,sessionId,bridge,schedule:()=>({}),unschedule:()=>{}});
    const dbRun=fn=>{const db=new DatabaseSync(projectDbPath(root));try{return fn(db);}finally{db.close();}};
    const messages=createMessageStore();
    const enqueue=(peer,kind='note',sender='coordinator')=>dbRun(db=>messages.sendMessage(db,sender,peer,null,kind,'test input'));
    const acked=(peer,id)=>dbRun(db=>db.prepare('SELECT * FROM message_reads WHERE peer=? AND message_id=?').all(peer,id).length);
    const complete=(index=sent.length-1,status='completed')=>requests.set(sent[index].requestId,
      {...requests.get(sent[index].requestId),status,answer:'test answer',turnId:'turn-'+index});
    ${body}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, HOME: privateHome, HCC_APP_TEST_ROOT: root, LANG: 'C.UTF-8' } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

test('an unconnected Desktop Mod does not register or create a project database', t => scenario(t, `
  ready=false; const service=create(); service.tick();
  assert.equal(service.status().registered,false); assert.equal(fs.existsSync(projectDbPath(root)),false);
  service.close();`));

test('Desktop bus delivery ACKs and replies only after its correlated completion without reply loops', t => scenario(t, `
  const service=create(); service.tick(); const id=enqueue(service.peer);
  service.tick(); service.tick(); assert.equal(sent.length,1); assert.equal(acked(service.peer,id),0);
  assert.match(sent[0].text,/not a new user authorization/);
  complete(); service.tick(); service.tick(); assert.equal(acked(service.peer,id),1);
  const reply=dbRun(db=>db.prepare("SELECT * FROM messages WHERE kind='reply'").get());
  assert.equal(reply.reply_to,id); assert.equal(reply.recipient,'coordinator'); assert.equal(reply.body,'test answer');
  const incomingReply=enqueue(service.peer,'reply'); service.tick(); complete(); service.tick();
  assert.equal(acked(service.peer,incomingReply),1);
  assert.equal(dbRun(db=>db.prepare("SELECT count(*) AS n FROM messages WHERE kind='reply'").get().n),2);
  service.close();`));

test('uncertain delivery survives bridge restart without blocking later messages or being replayed', t => scenario(t, `
  const first=create(); first.tick(); const id=enqueue(first.peer); first.tick();
  assert.equal(sent.length,1); first.close();
  const second=create(); second.tick(); assert.equal(sent.length,1); assert.equal(acked(second.peer,id),0);
  enqueue(second.peer); second.tick(); assert.equal(sent.length,2); complete(); second.tick();
  assert.equal(acked(second.peer,id),0); second.close();`));

test('aborted and lost provider requests remain unread and cannot trigger automatic replay', t => scenario(t, `
  const service=create(); service.tick(); const id=enqueue(service.peer); service.tick();
  complete(0,'aborted'); service.tick(); service.tick();
  assert.equal(acked(service.peer,id),0); assert.equal(sent.length,1);
  const lost=enqueue(service.peer); service.tick(); requests.delete(sent[1].requestId); service.tick(); service.tick();
  assert.equal(acked(service.peer,lost),0); assert.equal(sent.length,2); service.close();`));

test('another provider transport cannot be taken over or mutated by the Desktop bridge', t => scenario(t, `
  const first=create(); first.tick();
  dbRun(db=>db.prepare("UPDATE peer_bindings SET transport='native',runtime_target='foreign'").run());
  const second=create(); second.tick();
  assert.equal(second.status().error,'CLAUDE_APP_OWNERSHIP_CONFLICT');
  assert.equal(sent.length,0);
  assert.equal(dbRun(db=>db.prepare('SELECT runtime_target FROM peer_bindings').get().runtime_target),'foreign');
  second.close(); assert.throws(()=>first.close(),{code:'CLAUDE_APP_OWNERSHIP_CONFLICT'});`));

test('ordinary Claude hooks leave a Mod-owned session binding and unread inbox intact', t => scenario(t, `
  const service=create(); service.tick(); const id=enqueue(service.peer);
  const before=dbRun(db=>db.prepare('SELECT * FROM peer_bindings').get());
  const hook=spawnSync(process.execPath,[${JSON.stringify(cli)},'--root',root,'hook','user-prompt-submit','--provider','claude'],
    {env:process.env,input:JSON.stringify({session_id:sessionId,cwd:root,hook_event_name:'UserPromptSubmit'}),encoding:'utf8',timeout:10000});
  assert.equal(hook.status,0,hook.stderr);
  assert.deepEqual(dbRun(db=>db.prepare('SELECT * FROM peer_bindings').get()),before);
  assert.equal(acked(service.peer,id),0); service.close();`));

test('a synchronous send failure records uncertainty without acknowledging or repeated submission', t => scenario(t, `
  const service=create(); service.tick(); const id=enqueue(service.peer);
  let attempts=0; bridge.send=()=>{attempts++;throw new Error('transport failed');};
  service.tick(); service.tick(); assert.equal(attempts,1); assert.equal(acked(service.peer,id),0);
  service.close();`));

test('self broadcasts cannot starve a later external message', t => scenario(t, `
  const service=create(); service.tick();
  for(let i=0;i<60;i++) enqueue('all','note',service.peer);
  const id=enqueue(service.peer); service.tick(); assert.equal(sent.length,1);
  assert.match(sent[0].text,new RegExp('Message #'+id+' '));
  complete();service.tick();assert.equal(acked(service.peer,id),1);service.close();`));

test('close can retry a temporary database failure without leaving a live owner behind', t => scenario(t, `
  const service=create();service.tick();const file=projectDbPath(root);
  fs.renameSync(file,file+'.held');
  assert.throws(()=>service.close());assert.equal(service.status().closing,true);
  assert.equal(service.status().closed,false);
  fs.renameSync(file+'.held',file);service.close();assert.equal(service.status().closed,true);
  const replacement=create();replacement.tick();assert.equal(replacement.status().registered,true);
  replacement.close();`));

test('ordinary hooks can register again after the Mod owner is cleanly retired', t => scenario(t, `
  const service=create();service.tick();service.close();
  const hook=spawnSync(process.execPath,[${JSON.stringify(cli)},'--root',root,'hook','session-start','--provider','claude'],
    {env:process.env,input:JSON.stringify({session_id:sessionId,cwd:root,hook_event_name:'SessionStart'}),encoding:'utf8',timeout:10000});
  assert.equal(hook.status,0,hook.stderr);
  assert.equal(dbRun(db=>db.prepare('SELECT transport FROM peer_bindings').get().transport),'hook');
  assert.equal(dbRun(db=>db.prepare('SELECT status FROM peers').get().status),'working');`));

test('returning to ordinary hooks never replays uncertain App input but still receives new messages', t => scenario(t, `
  const service=create();service.tick();const id=enqueue(service.peer);service.tick();service.close();
  const nextId=dbRun(db=>messages.sendMessage(db,'coordinator',service.peer,null,'note','FRESH_HOOK_MESSAGE'));
  const hook=spawnSync(process.execPath,[${JSON.stringify(cli)},'--root',root,'hook','user-prompt-submit','--provider','claude'],
    {env:process.env,input:JSON.stringify({session_id:sessionId,cwd:root,hook_event_name:'UserPromptSubmit'}),encoding:'utf8',timeout:10000});
  assert.equal(hook.status,0,hook.stderr);assert.doesNotMatch(hook.stdout,/test input/);
  assert.match(hook.stdout,/FRESH_HOOK_MESSAGE/);assert.equal(acked(service.peer,id),0);
  assert.equal(acked(service.peer,nextId),1);
  assert.equal(dbRun(db=>messages.queryInbox(db,service.peer,false,20).some(item=>item.id===id)),true);`));

test('known queue capacity failures leave input pending and resume after capacity is available', t => scenario(t, `
  const service=create();service.tick();const id=enqueue(service.peer),send=bridge.send;
  bridge.send=()=>{throw new CliError('CLAUDE_APP_QUEUE_FULL','full');};
  service.tick();assert.equal(service.status().error,'CLAUDE_APP_QUEUE_FULL');assert.equal(acked(service.peer,id),0);
  assert.equal(dbRun(db=>db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'claude-app.delivery.%'").get().n),0);
  bridge.send=send;service.tick();assert.equal(sent.length,1);complete();service.tick();service.close();`));

test('terminal transport memory is released only after the local receipt and reply are durable', t => scenario(t, `
  const service=create();service.tick();const id=enqueue(service.peer);service.tick();
  let released=0;bridge.releaseRequest=requestId=>{assert.equal(acked(service.peer,id),1);released++;requests.delete(requestId);};
  complete();service.tick();assert.equal(released,1);service.close();`));

test('coordination rejects a project replaced after CLI selection before creating a database', t => scenario(t, `
  const initialRootIdentity=captureSelectedCwdSnapshot(root);fs.renameSync(root,root+'.original');fs.mkdirSync(root);
  assert.throws(()=>createClaudeAppCoordination({root,sessionId,bridge,initialRootIdentity}),{code:'PROJECT_PATH_CHANGED'});
  assert.equal(fs.existsSync(projectDbPath(root)),false);`));
