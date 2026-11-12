import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('Windows CLI peer start survives its launcher, attaches and detaches, then confirms owned termination',
  { skip: process.platform !== 'win32', timeout: 40000 }, async t => {
    const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-peer-lifecycle-'));
    t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }));
    const root = path.join(base, 'project'), home = path.join(base, 'profile'); fs.mkdirSync(root); fs.mkdirSync(home);
    const entry = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
    const source = `import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
      import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
      import {ensureTerminalHost} from ${JSON.stringify(new URL('../lib/terminal/client.mjs', import.meta.url).href)};
      import {inspectProcessIdentity} from ${JSON.stringify(new URL('../lib/process/identity.mjs', import.meta.url).href)};
      import {createPeerCommands} from ${JSON.stringify(new URL('../lib/cli/commands/peer.mjs', import.meta.url).href)};
      import {parseOpts} from ${JSON.stringify(new URL('../lib/cli-args.mjs', import.meta.url).href)};
      import {CliError} from ${JSON.stringify(new URL('../lib/shared/errors.mjs', import.meta.url).href)};
      import {projectDbPath} from ${JSON.stringify(new URL('../lib/runtime/paths.mjs', import.meta.url).href)};
      const root=${JSON.stringify(root)},entry=${JSON.stringify(entry)};
      function cli(args,input){const r=spawnSync(process.execPath,[entry,'--root',root,...args],{env:process.env,cwd:root,input,encoding:'utf8',timeout:18000,windowsHide:true});assert.equal(r.error,undefined,r.stderr);assert.equal(r.status,0,r.stderr);return r}
      cli(['init']);const host=await ensureTerminalHost();
      try {
        const started=JSON.parse(cli(['--json','peer','start','owned-win','--kind','other','--',process.execPath,'-e','console.log("PERSISTED");setInterval(()=>{},1000)']).stdout).data;
        assert.equal(started.peerId,'owned-win');assert.equal(started.status,'running');assert.equal(inspectProcessIdentity(started.pid).state,'live');
        await delay(100);
        const rows=JSON.parse(cli(['--json','peer','list']).stdout).data;assert.equal(rows.find(row=>row.peerId==='owned-win').pid,started.pid);
        const ctx={root,dbPath:projectDbPath(root),json:true},printed=[],requests=[];
        const structured={id:'native-runtime-id',peer_id:'native-peer',type:'native',status:'running',kind:'claude'};
        const {cmdPeer}=createPeerCommands({process,path,Map,parseOpts,CliError,wantsHelp:()=>false,
          connect:()=>new DatabaseSync(ctx.dbPath),resolveCurrentPeer:()=>({id:'test'}),addEvent:()=>{},auditPayload:value=>value,
          printResult:(_ctx,value)=>printed.push(value),runtimeRequest:async(_ctx,method,route)=>{
            requests.push([method,route]);if(method==='GET')return{sessions:[structured,{...started,type:'windows-terminal'}]};
            assert.equal(route,'/api/sessions/native-runtime-id/stop');return{session:{...structured,status:'closed'}}}});
        await cmdPeer(ctx,['list']);assert.equal(printed.at(-1).filter(row=>row.type==='native').length,1);
        assert.equal(printed.at(-1).filter(row=>row.peerId==='owned-win').length,1);
        await cmdPeer(ctx,['stop','native-peer']);assert.equal(printed.at(-1).status,'closed');
        assert.equal(requests.filter(([method])=>method==='POST').length,1);
        const view=JSON.parse(cli(['--json','peer','attach','owned-win']).stdout).data;assert.equal(view.generation,started.generation);
        const attached=cli(['peer','attach','owned-win'],'\x1d');assert.match(attached.stdout,/PERSISTED/);assert.equal(inspectProcessIdentity(started.pid).state,'live');
        const stopped=JSON.parse(cli(['--json','peer','stop','owned-win','--force']).stdout).data;assert.equal(stopped.status,'exited');assert.equal(inspectProcessIdentity(started.pid).state,'dead');
      } finally {
        if(host){for(const s of await host.list()){if(s.status!=='exited'){const c=await host.connect(s.id,s.generation);try{if(!c.control.can_control)await c.action({type:'claim',epoch:c.control.epoch,takeover:true});await c.action({type:'terminate',epoch:c.control.epoch})}finally{c.close()}}}
          await host.shutdown();for(let i=0;i<300&&inspectProcessIdentity(host.pointer.identity.pid).state!=='dead';i++)await delay(10)}
      }
      process.stdout.write('persistent-cli-complete');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: root,
      env: { ...process.env, USERPROFILE: home, HOME: home, NODE_NO_WARNINGS: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = '', errors = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    assert.deepEqual(await once(child, 'close'), [0, null], errors);
    assert.equal(output, 'persistent-cli-complete');
  });
