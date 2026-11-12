import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('Windows hcc run launches literal arguments with stdin EOF and closes the tracked peer',
  { skip: process.platform !== 'win32', timeout: 20000 }, t => {
    const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-windows-run-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, 'project'), home = path.join(base, 'profile'); fs.mkdirSync(root); fs.mkdirSync(home);
    const entry = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
    const args = ['', '%PATH% & 中文', 'a"b', 'tail\\'];
    const source = `import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
      import {projectDbPath} from ${JSON.stringify(new URL('../lib/runtime/paths.mjs', import.meta.url).href)};
      const root=${JSON.stringify(root)},entry=${JSON.stringify(entry)},args=${JSON.stringify(args)};
      const init=spawnSync(process.execPath,[entry,'--root',root,'init'],{env:process.env,encoding:'utf8',windowsHide:true});assert.equal(init.status,0,init.stderr);
      const program='let text="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>text+=x);process.stdin.on("end",()=>{console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),input:text}));process.exitCode=7})';
      const run=spawnSync(process.execPath,[entry,'--root',root,'run','--peer','win-owned','--kind','other','--',process.execPath,'-e',program,...args],
        {cwd:root,env:process.env,input:'literal input 中文',encoding:'utf8',timeout:6000,windowsHide:true});
      assert.equal(run.error,undefined,run.stderr);assert.equal(run.status,7,run.stderr);
      assert.deepEqual(JSON.parse(run.stdout),{args,cwd:root,input:'literal input 中文'});
      const db=new DatabaseSync(projectDbPath(root));try{assert.equal(db.prepare('SELECT status FROM peers WHERE id=?').get('win-owned').status,'exited')}finally{db.close()}
      process.stdout.write('owned-run-complete');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root,
      env: { ...process.env, USERPROFILE: home, HOME: home, NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 18000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'owned-run-complete');
  });

test('interactive Windows hcc run gives its provider a real ConPTY and preserves terminal output',
  { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
    const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-windows-run-tty-'));
    t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }));
    const root = path.join(base, 'project'), home = path.join(base, 'profile'); fs.mkdirSync(root); fs.mkdirSync(home);
    const entry = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
    const source = `import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
      import {spawnWindowsPty} from ${JSON.stringify(new URL('../lib/platform/windows-pty.mjs', import.meta.url).href)};
      import {ensureTerminalHost} from ${JSON.stringify(new URL('../lib/terminal/client.mjs', import.meta.url).href)};
      import {inspectProcessIdentity} from ${JSON.stringify(new URL('../lib/process/identity.mjs', import.meta.url).href)};
      import {setTimeout as delay} from 'node:timers/promises';
      const root=${JSON.stringify(root)},entry=${JSON.stringify(entry)};
      const init=spawnSync(process.execPath,[entry,'--root',root,'init'],{env:process.env,encoding:'utf8',windowsHide:true});assert.equal(init.status,0,init.stderr);
      const code='console.log("PROVIDER_TTY:"+JSON.stringify({input:process.stdin.isTTY,output:process.stdout.isTTY,cwd:process.cwd()}))';
      const host=await ensureTerminalHost();
      const child=spawnWindowsPty(process.execPath,[entry,'--root',root,'run','--peer','interactive-win','--kind','other','--',process.execPath,'-e',code],{cwd:root,env:process.env,cols:120,rows:30});
      let output='';child.onData(data=>output+=data);
      try{const exited=await new Promise(resolve=>child.onExit(resolve));assert.equal(exited.exitCode,0,output);
        assert.match(output,/PROVIDER_TTY:.*"input":true,"output":true/)}finally{await child.closeOwned();await host.shutdown();
          for(let i=0;i<200&&inspectProcessIdentity(host.pointer.identity.pid).state!=='dead';i++)await delay(10)}
      process.stdout.write('interactive-run-complete');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: root,
      env: { ...process.env, USERPROFILE: home, HOME: home, NODE_NO_WARNINGS: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = '', errors = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { errors += x; });
    assert.deepEqual(await once(child, 'close'), [0, null], errors);
    assert.equal(output, 'interactive-run-complete');
  });
