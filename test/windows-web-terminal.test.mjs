import { registerCleanup } from './helpers/fixture-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnWindowsOwnedProcess } from '../lib/platform/windows-process.mjs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// Two real Web boots, host/session admission, two attachments and stop, plus
// cleanup. Each operation below also has its own deadline and phase receipt.
const fixtureBudgetMs = 2 * 30000 + 2 * 20000 + 5 * 10000 + 20000;
test('Windows Web creates a managed terminal, proxies control and restores it after Web restart',
  { skip: process.platform !== 'win32', timeout: fixtureBudgetMs }, async t => {
    const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-web-terminal-'));
    registerCleanup(t, () => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 }));
    const home = path.join(base, 'profile'), root = path.join(base, '项目 空格');
    fs.mkdirSync(home); fs.mkdirSync(root);
    const program = path.join(root, 'web-terminal.cjs');
    fs.writeFileSync(program, 'process.stdin.setRawMode(true);process.stdout.write("WEB中文\\r\\n");process.stdin.on("data",d=>process.stdout.write("INPUT:"+d));setInterval(()=>{},1000)');
    const entry = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
    const source = `import assert from 'node:assert/strict';import fs from 'node:fs';import {spawn,spawnSync} from 'node:child_process';
      import {setTimeout as delay} from 'node:timers/promises';import {once} from 'node:events';import {createRequire} from 'node:module';
      import {ensureTerminalHost} from ${JSON.stringify(new URL('../lib/terminal/client.mjs', import.meta.url).href)};
      import {projectDbPath} from ${JSON.stringify(new URL('../lib/runtime/paths.mjs', import.meta.url).href)};
      import {readRuntimeFile} from ${JSON.stringify(new URL('../lib/runtime/state.mjs', import.meta.url).href)};
      import {loadWindowsNative} from ${JSON.stringify(new URL('../lib/platform/windows-native.mjs', import.meta.url).href)};
      const root=${JSON.stringify(root)},entry=${JSON.stringify(entry)},WebSocket=createRequire(entry)('ws');
      const init=spawnSync(process.execPath,[entry,'--root',root,'init'],{env:process.env,encoding:'utf8',windowsHide:true});assert.equal(init.status,0,init.stderr);
      const phase=name=>process.stderr.write(new Date().toISOString()+' Web terminal fixture: '+name+'\\n');
      async function bounded(name,ms,run){phase(name);let timer;try{return await Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(name+' exceeded '+ms+'ms')),ms)})])}finally{clearTimeout(timer)}}
      const ctx={root,dbPath:projectDbPath(root)};let web,webClosed,log='',runtime,host,ws;
      async function start(){log='';web=spawn(process.execPath,[entry,'--root',root,'web','--port','0','--token','web-test-token','--no-discover'],
        {env:{...process.env,HCC_WEB_CHILD:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});webClosed=once(web,'close');web.stdout.on('data',b=>log+=b);web.stderr.on('data',b=>log+=b);
        for(let i=0;i<250;i++){if(web.exitCode!==null)throw Error('Web exited: '+log);runtime=readRuntimeFile(ctx);if(runtime?.pid===web.pid)return;await delay(30)}throw Error('Web timeout '+log);}
      async function request(method,route,body){const r=await fetch(runtime.base_url+route,{method,signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+runtime.token,'content-type':'application/json','x-hcc-api-version':'2'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;}
      async function attach(id){phase('begin browser attachment');return (async()=>{ws=new WebSocket(runtime.base_url.replace('http:','ws:')+'/ws/terminal/'+id+'?api_version=2',{headers:{authorization:'Bearer '+runtime.token,origin:runtime.base_url}});const frames=[];ws.on('message',b=>frames.push(JSON.parse(b)));ws.on('error',()=>{});await bounded('browser handshake',10000,()=>once(ws,'open'));return bounded('browser snapshot',10000,async()=>{while(true){const snapshot=frames.find(x=>x.type==='snapshot');if(snapshot)return{frames,snapshot};if(ws.readyState===WebSocket.CLOSED)throw Error('Browser closed before snapshot');await delay(20)}})})()}
      try{
        await bounded('start web',30000,start);host=await bounded('ensure terminal host',20000,ensureTerminalHost);
        const state=await request('GET','/api/state');assert.equal(state.terminal_backend,'windows-terminal');
        phase('create terminal');const created=(await request('POST','/api/sessions',{id:'shell-web',kind:'shell',invocation:{file:process.execPath,args:[${JSON.stringify(program)}]}})).session;
        assert.equal(created.type,'windows-terminal');assert.ok(created.pid>0);
        let browser=await attach(created.id);assert.equal(browser.snapshot.control.can_control,true);
        ws.send(JSON.stringify({type:'input',action_token:browser.snapshot.action_token,epoch:browser.snapshot.control.epoch,data:'重新连接',input_id:'one'}));
        for(let i=0;i<200&&!browser.frames.some(f=>f.type==='input_ack');i++)await delay(20);
        assert.ok(browser.frames.some(f=>f.type==='input_ack'));
        await bounded('stop first web',10000,async()=>{await request('POST','/api/runtime/stop',{});await webClosed});web=null;
        assert.equal(loadWindowsNative().inspectProcess(created.pid).state,'live');
        await bounded('restart web',30000,start);const restored=(await request('GET','/api/sessions')).sessions.find(x=>x.id===created.id);
        assert.equal(restored.pid,created.pid);assert.equal(restored.terminal_generation,created.terminal_generation);
        browser=await attach(created.id);assert.match(browser.snapshot.data,/WEB中文/);assert.match(browser.snapshot.data,/INPUT:重新连接/);
        if(!browser.snapshot.control.can_control){ws.send(JSON.stringify({type:'control',action:'claim',force:true,epoch:browser.snapshot.control.epoch,action_token:browser.snapshot.action_token}));for(let i=0;i<100&&!browser.frames.some(f=>f.type==='control'&&f.control.can_control);i++)await delay(20);}
        const control=browser.frames.filter(f=>f.control).at(-1).control;
        await request('POST','/api/sessions/'+created.id+'/stop',{action_token:browser.snapshot.action_token,epoch:control.epoch});
        assert.equal(loadWindowsNative().inspectProcess(created.pid).state,'dead');
      }finally{
        await bounded('cleanup web and host',20000,async()=>{
        ws?.close();if(web&&web.exitCode===null){try{await request('POST','/api/runtime/stop',{});await webClosed}catch{web.kill()}}
        host ||= await ensureTerminalHost();for(const row of await host.list()){if(row.status==='exited')continue;const c=await host.connect(row.id,row.generation);try{if(!c.control.can_control)await c.action({type:'claim',epoch:c.control.epoch,takeover:true});await c.action({type:'terminate',epoch:c.control.epoch})}finally{c.close()}}
        await host.shutdown();for(let i=0;i<200&&loadWindowsNative().inspectProcess(host.pointer.identity.pid).state!=='dead';i++)await delay(20);
        });
      }
      process.stdout.write('web-terminal-complete');`;
    const child = spawnWindowsOwnedProcess(process.execPath, ['--input-type=module', '-e', source], {
      cwd: root, env: { ...process.env, USERPROFILE: home, HOME: home, NODE_NO_WARNINGS: '1', HCC_SKIP_SHIM_INSTALL: '1' }
    });
    registerCleanup(t, () => child.close());
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; process.stderr.write(data); });
    assert.deepEqual(await once(child, 'close'), [0, null], errors);
    assert.equal(output, 'web-terminal-complete');
  });
