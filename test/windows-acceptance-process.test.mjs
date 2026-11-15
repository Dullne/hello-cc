import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWindowsAcceptanceCommand } from '../scripts/windows-acceptance-process.mjs';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';

test('installed acceptance deadline kills an exited root\'s detached child holding its output pipe',
  { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.homedir(), 'hcc-acceptance-command-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const receipt = path.join(root, 'child.json');
    const stop = path.join(root, 'stop');
    const peer = `const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0)},25);setTimeout(()=>process.exit(0),5000);`;
    const code = `import {spawn} from 'node:child_process';import fs from 'node:fs';
      import {loadWindowsNative} from ${JSON.stringify(new URL('../lib/platform/windows-native.mjs', import.meta.url).href)};
      const child=spawn(process.execPath,['-e',${JSON.stringify(peer)}],{detached:true,stdio:['ignore',1,2],windowsHide:true});
      fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(loadWindowsNative().inspectProcess(child.pid)));child.unref();`;
    const began = performance.now();
    try {
      await assert.rejects(runWindowsAcceptanceCommand(process.execPath, ['--input-type=module', '-e', code],
        { cwd: root, stage: 'leaked descriptor fixture', timeoutMs: 500 }), /command deadline exceeded/);
      const { pid } = JSON.parse(fs.readFileSync(receipt));
      assert.equal(loadWindowsNative().inspectProcess(pid).state, 'dead');
      assert.ok(performance.now() - began < 4000, 'deadline did not release inherited output pipes');
    } finally {
      // The failing baseline has no Job. Ask only this disposable fixture to
      // exit through its private stop file, and never signal a recycled PID.
      if (fs.existsSync(receipt)) {
        const identity = JSON.parse(fs.readFileSync(receipt));
        fs.writeFileSync(stop, 'stop');
        for (let i = 0; i < 220; i++) {
          const observed = loadWindowsNative().inspectProcess(identity.pid);
          if (observed.state === 'dead' || (observed.state === 'live' && observed.creationTime !== identity.creationTime)) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
    }
  });

test('installed acceptance waits for detached children before reporting success',
  { skip: process.platform !== 'win32' }, async () => {
    const output = await runWindowsAcceptanceCommand(process.execPath, ['-e', `
      const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},250)'],
        {detached:true,stdio:'ignore',windowsHide:true});console.log(child.pid);child.unref();`],
    { cwd: os.homedir(), stage: 'finite descendant', timeoutMs: 3000 });
    assert.equal(loadWindowsNative().inspectProcess(Number(output.trim())).state, 'dead');
  });

test('installed acceptance reports unconfirmed cleanup before rejecting its deadline',
  { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
    const native = loadWindowsNative(), original = native.startOwnedProcess;
    t.mock.method(native, 'startOwnedProcess', options => {
      const controller = original(options);
      t.after(() => controller.close());
      const wrapper = Object.fromEntries(Object.getOwnPropertyNames(controller).map(name => {
        const value = controller[name];
        return [name, typeof value === 'function' ? value.bind(controller) : value];
      }));
      let terminating = false;
      wrapper.terminate = () => { terminating = true; return controller.terminate(); };
      wrapper.poll = () => {
        if (terminating) throw new Error('injected observation failure during cancellation');
        return controller.poll();
      };
      return wrapper;
    });
    await assert.rejects(runWindowsAcceptanceCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
      { cwd: os.homedir(), stage: 'unconfirmed cleanup fixture', timeoutMs: 100 }), error => {
      assert.match(error.message, /command deadline exceeded/);
      assert.equal(error.cleanupUnconfirmed, true);
      return true;
    });
  });
