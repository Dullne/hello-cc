import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('Windows native launcher authenticates an isolated HCC service before handoff and stops it through its owner',
  { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
    const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-native-background-'));
    t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 }));
    const home = path.join(base, 'profile'), root = path.join(base, 'project');
    fs.mkdirSync(home); fs.mkdirSync(root);
    const entry = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
    const source = `import assert from 'node:assert/strict';import fs from 'node:fs';import {spawnSync} from 'node:child_process';
      import {setTimeout as delay} from 'node:timers/promises';
      import {createNativeLauncher} from ${JSON.stringify(new URL('../lib/runtime/native/launcher.mjs', import.meta.url).href)};
      import {nativeRequest} from ${JSON.stringify(new URL('../lib/runtime/native/client.mjs', import.meta.url).href)};
      import {readNativePointer,nativePaths} from ${JSON.stringify(new URL('../lib/runtime/native/store.mjs', import.meta.url).href)};
      import {openPrivateAppendResource} from ${JSON.stringify(new URL('../lib/runtime/private-file.mjs', import.meta.url).href)};
      import {projectDbPath} from ${JSON.stringify(new URL('../lib/runtime/paths.mjs', import.meta.url).href)};
      import {loadWindowsNative} from ${JSON.stringify(new URL('../lib/platform/windows-native.mjs', import.meta.url).href)};
      const root=${JSON.stringify(root)},entry=${JSON.stringify(entry)};
      const initialized=spawnSync(process.execPath,[entry,'--root',root,'init'],{env:process.env,encoding:'utf8',windowsHide:true});
      assert.equal(initialized.status,0,initialized.stderr);
      const ctx={root,dbPath:projectDbPath(root)};
      const logFile=nativePaths(ctx,{create:true}).log, prior=openPrivateAppendResource(logFile);
      try{prior.write(Buffer.alloc(5*1024*1024+1,120));}finally{prior.close()}
      const ensure=createNativeLauncher({env:process.env,startupTimeoutMs:20000,pollMs:20});
      let status;
      try {
        status=await ensure(ctx);assert.equal(status.root,root);assert.equal(status.pid,readNativePointer(ctx).pid);
        assert.equal(fs.statSync(logFile+'.1').size,5*1024*1024+1);
        assert.equal((await ensure(ctx)).generation,status.generation);
      } finally {
        if(readNativePointer(ctx))await nativeRequest(ctx,'POST','/down',{}, {timeoutMs:2000});
      }
      for(let i=0;i<200&&loadWindowsNative().inspectProcess(status.pid).state!=='dead';i++)await delay(10);
      assert.equal(loadWindowsNative().inspectProcess(status.pid).state,'dead');
      assert.equal(readNativePointer(ctx),null);process.stdout.write('isolated-runtime-complete');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: root, env: { ...process.env, USERPROFILE: home, HOME: home, NODE_NO_WARNINGS: '1', HCC_SKIP_SHIM_INSTALL: '1' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    assert.deepEqual(await once(child, 'close'), [0, null], errors);
    assert.equal(output, 'isolated-runtime-complete');
  });
