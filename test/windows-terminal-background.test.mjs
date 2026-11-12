import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('Windows terminal service survives its launcher, restores Unicode screen and confirms owned process exit',
  { skip: process.platform !== 'win32', timeout: 40000 }, async t => {
    const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-terminal-background-'));
    t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 }));
    const home = path.join(base, 'profile'), root = path.join(base, '项目 空格');
    fs.mkdirSync(home); fs.mkdirSync(root);
    const program = path.join(root, 'terminal-fixture.cjs');
    fs.writeFileSync(program, 'process.stdin.setRawMode(true);process.stdout.write("中文开始\\r\\n");process.stdin.on("data",d=>{process.stdout.write("收到:"+d);});setInterval(()=>{},1000)');
    const entry = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
    const source = `import assert from 'node:assert/strict';import fs from 'node:fs';import {spawnSync} from 'node:child_process';
      import {setTimeout as delay} from 'node:timers/promises';
      import {ensureTerminalHost} from ${JSON.stringify(new URL('../lib/terminal/client.mjs', import.meta.url).href)};
      import {projectDbPath} from ${JSON.stringify(new URL('../lib/runtime/paths.mjs', import.meta.url).href)};
      import {ensurePrivateProjectStateDir} from ${JSON.stringify(new URL('../lib/runtime/private-state.mjs', import.meta.url).href)};
      import {captureSelectedCwdSnapshot} from ${JSON.stringify(new URL('../lib/process/selected-cwd-identity.mjs', import.meta.url).href)};
      import {loadWindowsNative} from ${JSON.stringify(new URL('../lib/platform/windows-native.mjs', import.meta.url).href)};
      const root=${JSON.stringify(root)},entry=${JSON.stringify(entry)};
      const initialized=spawnSync(process.execPath,[entry,'--root',root,'init'],{env:process.env,encoding:'utf8',windowsHide:true});
      assert.equal(initialized.status,0,initialized.stderr);
      const launcher=spawnSync(process.execPath,['--input-type=module','-e',
        'import {ensureTerminalHost} from '+${JSON.stringify(JSON.stringify(new URL('../lib/terminal/client.mjs', import.meta.url).href))}+';const c=await ensureTerminalHost();console.log(c.pointer.generation);'],
        {env:process.env,encoding:'utf8',windowsHide:true,timeout:18000});
      assert.equal(launcher.status,0,launcher.stderr);
      let client,connection,session;
      try{
        client=await ensureTerminalHost();assert.equal(client.pointer.generation,launcher.stdout.trim());
        const identity=captureSelectedCwdSnapshot(root);
        session=await client.create({id:'persist-one',peerId:'shell-one',kind:'shell',role:'peer',
          project:{root,rootIdentity:identity,stateDir:ensurePrivateProjectStateDir(root),dbPath:projectDbPath(root)},
          cwd:root,cwdIdentity:identity,command:{file:process.execPath,args:[${JSON.stringify(program)}]},
          env:process.env,cols:90,rows:28});
        assert.ok(session.pid>0);assert.equal(session.status,'running');assert.ok(session.processIdentity?.startToken);
        connection=await client.connect(session.id,session.generation);
        const blocked=spawnSync(process.execPath,[entry,'--root',root,'--json','inject','shell-one','blocked'],{env:process.env,encoding:'utf8',windowsHide:true});
        assert.equal(blocked.status,1);assert.match(blocked.stderr,/CONTROL_HELD/);
        await connection.action({type:'input',epoch:connection.control.epoch,data:'测试\\r'});
        for(let i=0;i<100;i++){if((await client.snapshot(session.id,session.generation)).screen.includes('收到:测试'))break;await delay(30);}
        const snapshot=await client.snapshot(session.id,session.generation);assert.match(snapshot.screen,/中文开始/);assert.match(snapshot.screen,/收到:测试/);
        const clientToken=connection.clientToken;connection.close();connection=null;await delay(100);
        const reconnected=await ensureTerminalHost();assert.equal(reconnected.pointer.generation,client.pointer.generation);
        connection=await reconnected.connect(session.id,session.generation,{clientToken});
        assert.match(connection.initial.screen,/收到:测试/);assert.equal(connection.initial.session.pid,session.pid);
        const released=await connection.action({type:'release',epoch:connection.control.epoch});
        const injected=spawnSync(process.execPath,[entry,'--root',root,'--json','inject','shell-one','命令注入'],{env:process.env,encoding:'utf8',windowsHide:true});
        assert.equal(injected.status,0,injected.stderr);
        for(let i=0;i<100&&connection.control.epoch<=released.epoch;i++)await delay(10);
        await connection.action({type:'claim',epoch:connection.control.epoch});
        await connection.action({type:'terminate',epoch:connection.control.epoch});
        assert.equal((await client.list())[0].status,'exited');
        assert.equal(loadWindowsNative().inspectProcess(session.pid).state,'dead');
      }finally{
        connection?.close();
        if(client){for(const row of await client.list()){if(row.status==='exited')continue;const c=await client.connect(row.id,row.generation);try{if(!c.control.can_control)await c.action({type:'claim',epoch:c.control.epoch,takeover:true});await c.action({type:'terminate',epoch:c.control.epoch});}finally{c.close()}}
        await client.shutdown();for(let i=0;i<200&&loadWindowsNative().inspectProcess(client.pointer.identity.pid).state!=='dead';i++)await delay(20);assert.equal(loadWindowsNative().inspectProcess(client.pointer.identity.pid).state,'dead');}
      }
      process.stdout.write('persistent-terminal-complete');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: root, env: { ...process.env, USERPROFILE: home, HOME: home, NODE_NO_WARNINGS: '1' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    assert.deepEqual(await once(child, 'close'), [0, null], errors);
    assert.equal(output, 'persistent-terminal-complete');
  });
