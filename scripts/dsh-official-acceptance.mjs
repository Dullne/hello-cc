import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureDshIntegration } from '../lib/integrations/dsh.mjs';

// Opt-in integration acceptance against an isolated install, with no project
// dependency changes and no model or credential calls. Install with scripts
// disabled into a temporary directory, then pass that directory as argv[2].
const installPath = process.argv[2];
if (!installPath) throw new Error('Usage: node scripts/dsh-official-acceptance.mjs /absolute/path/to/isolated-dsh-install');
const runtimeRoot = path.resolve(installPath);
const resolveOfficial = createRequire(path.join(runtimeRoot, 'package.json'));
for (const name of ['dsh', 'dsh-hooks-claude-code']) {
  const manifest = JSON.parse(fs.readFileSync(resolveOfficial.resolve(`@deepseek-ai/${name}/package.json`), 'utf8'));
  assert.equal(manifest.version, '0.2.0-rc.2', `Acceptance baseline requires @deepseek-ai/${name}@0.2.0-rc.2`);
}
const loadOfficial = (name) => import(pathToFileURL(resolveOfficial.resolve(`@deepseek-ai/${name}`)).href);
const [cordis, subprocess, bash, sessions, projections, agentLoop, Hooks, llm] = await Promise.all([
  'cordis', 'dsh-subprocess-local', 'dsh-bash-local', 'dsh-session',
  'dsh-session-projection', 'dsh-agent-loop', 'dsh-hooks-claude-code', 'dsh-llm'
].map(loadOfficial));
const { Context } = cordis;
const { default: Subprocess } = subprocess;
const { default: Bash } = bash;
const { default: Sessions } = sessions;
const { default: Projections } = projections;
const { turnBoundaryProjectionDefinition } = agentLoop;
const { createUserMessage } = llm;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hcc=path.join(repo,'bin/hcc.mjs');
const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'hcc-dsh-real-bridge-'));
const home=path.join(sandbox,'isolated-home');
const rootA=path.join(sandbox,'project A');
const rootB=path.join(sandbox,'project B');
for(const dir of [home,rootA,rootB]) fs.mkdirSync(dir,{recursive:true});
const cleanEnv={HOME:home,DSH_HOME:path.join(home,'dsh'),DSH_TELEMETRY_DISABLED:'1',PATH:path.dirname(process.execPath)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C',LC_ALL:'C',SHELL:'/bin/bash'};
// Keep all state writes, including the hcc project registry, inside this sandbox.
for(const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env,cleanEnv);
const results=[];
function pass(name,data={}) { results.push({name,...data}); }
function runHcc(root,args,options={}) {
  const env={...cleanEnv,...options.env};
  const r=spawnSync(process.execPath,[hcc,'--root',root,'--json',...args],{cwd:root,encoding:'utf8',env,input:options.input,timeout:15000});
  if(options.expectedCode!==undefined) assert.equal(r.status,options.expectedCode,r.stderr+r.stdout);
  else assert.equal(r.status,0,r.stderr+r.stdout);
  const parsed=r.stdout ? JSON.parse(r.stdout):null;
  return {r,data:parsed?.data??parsed};
}
function dbRows(root,sql,...args) { const db=new DatabaseSync(path.join(root,'.hello-cc','mesh.db')); try { return db.prepare(sql).all(...args).map(r=>({...r})); } finally {db.close();} }
function peer(id) {return 'dsh-'+createHash('sha1').update(id).digest('hex').slice(0,8);}
function textOf(messages) {return messages.flatMap(m=>m.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');}
const setup=ensureDshIntegration({root:rootA,cwd:rootA},{hccBin:hcc,nodeBin:process.execPath});
assert.ok(setup.ready);
pass('project-local setup generated official overlay',{hooks:setup.hooksPath,patch:setup.patchPath});
runHcc(rootA,['register','--peer','claude-acceptance','--kind','claude']);
runHcc(rootA,['register','--peer','codex-acceptance','--kind','codex']);
runHcc(rootA,['task','create','--title','DSH_FIRST_STEP_TASK','--from','claude-acceptance']);
runHcc(rootA,['lock','acquire','--peer','claude-acceptance','--resource','shared.txt','--reason','DSH_LOCK_CONFLICT']);

const ctx=new Context();
const fibers=[];
let unregister;
try {
 for(const plugin of [Subprocess,Bash,Sessions,Projections]) {const f=ctx.plugin(plugin);await f.await();fibers.push(f);}
 unregister=ctx.sessionProjections.register(turnBoundaryProjectionDefinition);
 const bridge=ctx.plugin(Hooks,{configPath:setup.hooksPath,defaultTimeoutMs:10000});await bridge.await();fibers.push(bridge);
 function agent(id,cwd) {
  const session=ctx.sessions.create(id,{meta:{cwd}});
  const injected=[],steered=[];
  return {session,injected,steered,inject(message){injected.push(message);},steer(message){steered.push(message);}};
 }
 const firstId='s.official-non-uuid/first';
 const secondId='s.official-non-uuid/second';
 const first=agent(firstId,rootA),second=agent(secondId,rootA),elsewhere=agent(firstId+'.another-workspace',rootB);
 // Deliberate desktop-provider env pollution plus a process-global hcc peer.
 process.env.CODEX_THREAD_ID='stale-codex-thread';
 process.env.CLAUDE_CODE_SESSION_ID='stale-claude-session';
 process.env.HCC_PEER='one-runtime-global-peer';
 await ctx.parallel('agent/created',{agent:first,source:'startup',signal:new AbortController().signal});
 assert.equal(first.injected.length,1,'awaited agent/created must inject first-step context before resolving');
 const initial=textOf(first.injected);
 assert.match(initial,/DSH_FIRST_STEP_TASK/);
 assert.match(initial,/claude-acceptance/);
 assert.match(initial,/codex-acceptance/);
 assert.match(initial,/shared\.txt/);
 assert.match(initial,new RegExp(peer(firstId)));
 pass('awaited first-step SessionStart injection includes tasks peers and locks');
 await ctx.parallel('agent/created',{agent:second,source:'startup',signal:new AbortController().signal});
 await ctx.parallel('agent/created',{agent:elsewhere,source:'startup',signal:new AbortController().signal});
 const bindings=dbRows(rootA,'SELECT peer,provider,provider_session_id,provider_session_name,transport FROM peer_bindings WHERE provider = ?','dsh');
 assert.equal(bindings.length,2);
 assert.deepEqual(bindings.map(x=>x.provider_session_id).sort(),[firstId,secondId].sort());
 assert.ok(bindings.every(x=>x.provider_session_name===null));
 assert.ok(bindings.every(x=>x.peer!==process.env.HCC_PEER));
 assert.equal(dbRows(rootB,'SELECT provider_session_id FROM peer_bindings WHERE provider = ?','dsh')[0].provider_session_id,elsewhere.session.id);
 assert.equal(dbRows(rootA,'SELECT id FROM peers WHERE id = ?','one-runtime-global-peer').length,0);
 pass('non-UUID real session IDs kept independently despite inherited Claude Codex and HCC_PEER markers',{bindings});
 assert.match(textOf(elsewhere.injected),new RegExp(peer(elsewhere.session.id)));
 assert.doesNotMatch(textOf(elsewhere.injected),/DSH_FIRST_STEP_TASK/);
 pass('one official bridge serves distinct workspaces without cross-project task leakage');
 await ctx.parallel('agent/created',{agent:first,source:'resume',signal:new AbortController().signal});
 assert.equal(dbRows(rootA,'SELECT peer FROM peer_bindings WHERE provider = ?','dsh').length,2);
 pass('SessionStart resume maps back to same peer');

 process.env.HCC_ROOT=rootB;
 process.env.HCC_DB=path.join(rootB,'.hello-cc','mesh.db');
 for(const [carrier,id] of [[first,firstId],[second,secondId]]) {
  const prefix=textOf(carrier.injected).split('\n').find(line=>line.startsWith('env ')&&line.includes('HCC_PEER='));
  assert.ok(prefix,'injected dsh context must contain its own exact hcc command prefix');
  const execution=await (await ctx.shell.execute(ctx.shell.resolve({
   command:prefix+' msg send --to codex-acceptance --body DSH_PREFIX_SHELL_REPLY',workdir:rootB
  }))).result();
  assert.equal(execution.exitCode,0,execution.stderr.text);
  assert.equal(dbRows(rootA,'SELECT sender FROM messages WHERE body = ? AND sender = ?','DSH_PREFIX_SHELL_REPLY',peer(id)).length,1);
 }
 assert.equal(dbRows(rootB,'SELECT id FROM messages WHERE body = ?','DSH_PREFIX_SHELL_REPLY').length,0);
 pass('official shell executes both injected session command prefixes under polluted peer and workspace env with correct sender and database');

 for(const key of ['CODEX_THREAD_ID','CLAUDE_CODE_SESSION_ID','HCC_PEER','HCC_ROOT','HCC_DB']) delete process.env[key];
 first.session.append('turn/start',{turn:1});
 runHcc(rootA,['msg','send','--from','claude-acceptance','--to',peer(firstId),'--body','DSH_FROM_CLAUDE_FRESH_PROMPT']);
 const prompt=createUserMessage({content:[{type:'text',text:'acceptance prompt'}],source:{kind:'user'}});
 const entered=await ctx.waterfall('agent/pre-step',{agent:first,messages:[prompt],turn:1,signal:new AbortController().signal},async()=>({kind:'enter',messages:[prompt],extraMetadata:'retained'}));
 assert.equal(entered.kind,'enter');
 assert.equal(entered.extraMetadata,'retained');
 assert.match(textOf(entered.messages),/DSH_FROM_CLAUDE_FRESH_PROMPT/);
 assert.equal(dbRows(rootA,'SELECT message_id FROM message_reads WHERE peer = ?',peer(firstId)).length,1);
 pass('UserPromptSubmit official bridge appends parsed additionalContext and acknowledges delivered inbox');
 runHcc(rootA,['msg','send','--from',peer(firstId),'--to','claude-acceptance','--body','DSH_REPLY_TO_CLAUDE']);
 const inbox=runHcc(rootA,['msg','inbox','--peer','claude-acceptance']).data;
 assert.ok(inbox.some(m=>m.body==='DSH_REPLY_TO_CLAUDE'));
 pass('DSH peer can reply through same real hcc bus');
 const conflict=runHcc(rootA,['lock','acquire','--peer',peer(firstId),'--resource','shared.txt'],{expectedCode:1});
 assert.match(conflict.r.stdout+conflict.r.stderr,/LOCK_CONFLICT|LOCK_HELD|locked|held/i);
 pass('actual advisory lock conflict is visible and prevents second acquisition');

 const pre=await ctx.waterfall('tools/pre-execute',{agent:first,name:'bash',arguments:{command:'true'},callId:'call-1',signal:new AbortController().signal},async()=>({kind:'allow'}));
 assert.equal(pre.kind,'allow');
 runHcc(rootA,['msg','send','--from','codex-acceptance','--to',peer(firstId),'--body','DSH_POST_TOOL_CONTEXT']);
 const post=await ctx.waterfall('tools/post-execute',{agent:first,name:'str_replace_editor',arguments:{path:'dummy.txt'},callId:'call-2',signal:new AbortController().signal},{content:[{type:'text',text:'tool done'}]},async()=>({kind:'accept'}));
 assert.match(textOf(post.additionalContexts),/DSH_POST_TOOL_CONTEXT/);
 pass('official dsh lower-case bash and str_replace_editor tool names invoke all-tool hooks');
 runHcc(rootA,['msg','send','--from','codex-acceptance','--to',peer(firstId),'--body','DSH_STOP_CONTINUE']);
 await ctx.parallel('agent/turn-stopping',{agent:first,turn:1,signal:new AbortController().signal});
 assert.equal(first.steered.length,1);
 assert.match(textOf(first.steered),/DSH_STOP_CONTINUE/);
 await ctx.parallel('agent/turn-stopping',{agent:first,turn:1,signal:new AbortController().signal});
 assert.equal(first.steered.length,1,'acknowledged message must not produce another Stop continuation');
 pass('Stop hook block is mapped to official steer exactly once per inbox message');
 const hookResults=first.session.snapshotEvents().filter(e=>e.type==='hook/result');
 assert.ok(hookResults.length>=5);
 assert.ok(hookResults.every(e=>e.data.exitCode===0));
 pass('official Session log records successful command hook results',{resultEvents:hookResults.length});
 const dump=spawnSync(process.execPath,[resolveOfficial.resolve('@deepseek-ai/dsh/lib/bin.js'),'web','--patch',setup.patchPath,'--dump-config'],{cwd:rootA,encoding:'utf8',env:cleanEnv,timeout:20000});
 assert.equal(dump.status,0,dump.stderr);
 assert.match(dump.stdout,/hello-cc-dsh-hooks/);
 assert.match(dump.stdout,/@deepseek-ai\/dsh-hooks-claude-code/);
 fs.writeFileSync(path.join(sandbox,'effective-config.yml'),dump.stdout);
 pass('official dsh0.2.0rc2 CLI composes generated overlay with web profile');
 const launch=spawnSync(process.execPath,[hcc,'--root',rootA,'dsh','web',
  '--dsh-bin',resolveOfficial.resolve('@deepseek-ai/dsh/lib/bin.js'),
  '--dsh-home',cleanEnv.DSH_HOME,'--','--help'],{cwd:rootA,encoding:'utf8',env:cleanEnv,timeout:20000});
 assert.equal(launch.status,0,launch.stderr);
 assert.match(launch.stdout,/Usage: dsh --profile web/);
 assert.equal(dbRows(rootA,'SELECT peer FROM peer_bindings WHERE provider = ?','dsh').length,2);
 pass('public hcc dsh web wrapper launches official app and forwards runtime help without creating a service peer');
} finally {
 if(unregister) await unregister();
 for(const f of fibers.reverse()) await f.dispose();
}
const receipt={baseline:'@deepseek-ai/dsh@0.2.0-rc.2',sandbox,results,passed:results.length,boundary:'Official Cordis, Sessions/projections, hooks bridge, shell executor/subprocess, and real hcc commands; in-memory agent carrier only; no LLM, credentials, or external API calls.'};
fs.writeFileSync(path.join(sandbox,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt,null,2));
