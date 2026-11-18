import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnWindowsOwnedProcess } from '../lib/platform/windows-process.mjs';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('Windows native launcher defaults admit delayed readiness, honor short overrides and stop the authenticated owner',
  { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
    const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-native-background-'));
    t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 }));
    const home = path.join(base, 'profile'), root = path.join(base, 'project');
    fs.mkdirSync(home); fs.mkdirSync(root);
    const entry = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
    // Delay only publication, after the real service has acquired its owner
    // and initialized storage. This exercises the public factory default with
    // actual readiness later than the former Windows startup deadline.
    const preload = path.join(base, 'delay-native-readiness.mjs');
    fs.writeFileSync(preload, `import {registerHooks} from 'node:module';
      registerHooks({load(url,context,nextLoad){const result=nextLoad(url,context);
        if(!url.endsWith('/lib/runtime/native/service.mjs'))return result;
        const source=String(result.source),marker='owner.withWrite(() => writeNativePointer(ctx,';
        if(!source.includes(marker))throw Error('Native readiness fixture boundary missing');
        return {...result,source:source.replace(marker,
          'await new Promise(resolve=>setTimeout(resolve,Math.max(0,Number(process.env.HCC_TEST_NATIVE_READY_AT)-Date.now())));'+marker)};
      }});`);
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
      let status;
      try {
        await assert.rejects(createNativeLauncher({env:process.env,startupTimeoutMs:1,pollMs:1})(ctx),
          {code:'NATIVE_RUNTIME_START_FAILED'});
        assert.equal(readNativePointer(ctx),null);
        const readyAt=Date.now()+14000;
        const env={...process.env,HCC_TEST_NATIVE_READY_AT:String(readyAt),
          NODE_OPTIONS:[process.env.NODE_OPTIONS||'',${JSON.stringify('--import=' + pathToFileURL(preload).href)}].filter(Boolean).join(' ')};
        const ensure=createNativeLauncher({env,pollMs:20});
        status=await ensure(ctx);assert.equal(status.root,root);assert.equal(status.pid,readNativePointer(ctx).pid);
        assert.ok(Date.now()>=readyAt,'Native readiness must pass through the delayed publication boundary');
        assert.equal(fs.statSync(logFile+'.1').size,5*1024*1024+1);
        assert.equal((await ensure(ctx)).generation,status.generation);
      } finally {
        if(readNativePointer(ctx))await nativeRequest(ctx,'POST','/down',{}, {timeoutMs:2000});
      }
      for(let i=0;i<200&&loadWindowsNative().inspectProcess(status.pid).state!=='dead';i++)await delay(10);
      assert.equal(loadWindowsNative().inspectProcess(status.pid).state,'dead');
      assert.equal(readNativePointer(ctx),null);process.stdout.write('isolated-runtime-complete');`;
    const child = spawnWindowsOwnedProcess(process.execPath, ['--input-type=module', '-e', source], {
      cwd: root, env: { ...process.env, USERPROFILE: home, HOME: home, NODE_NO_WARNINGS: '1', HCC_SKIP_SHIM_INSTALL: '1' },
    });
    child.stdin.end();
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    let timer;
    try {
      const result = await Promise.race([once(child, 'close'), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native background fixture exceeded its owned-process deadline')), 50000);
      })]);
      assert.deepEqual(result, [0, null], errors);
      assert.equal(output, 'isolated-runtime-complete');
    } finally { clearTimeout(timer); await child.close({ timeoutMs: 5000 }); }
  });
