import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

test('Windows registry initializes private global state and canonicalizes project case aliases',
  { skip: process.platform !== 'win32' }, t => {
    const base = fs.mkdtempSync(path.join(os.homedir(), '.hcc-registry-test-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const home = path.join(base, '用户 home'); const root = path.join(base, 'Project 中文');
    fs.mkdirSync(home); fs.mkdirSync(root);
    const code = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs'; import path from 'node:path';
      import {registerProject, readProjectRegistry} from ${JSON.stringify(new URL('../lib/runtime/projects.mjs', import.meta.url).href)};
      import {loadWindowsNative} from ${JSON.stringify(new URL('../lib/platform/windows-native.mjs', import.meta.url).href)};
      const [home,root]=process.argv.slice(1);
      registerProject({root,dbPath:path.join(root,'mesh.db')});
      registerProject({root:root.toUpperCase(),dbPath:path.join(root,'mesh.db')});
      const rows=readProjectRegistry(); assert.equal(rows.length,1);
      assert.equal(rows[0].root,fs.realpathSync.native(root));
      const native=loadWindowsNative(), dir=path.join(home,'.hello-cc');
      assert.equal(native.inspectPathSecurity(dir).private,true);
      assert.equal(native.inspectPathSecurity(path.join(dir,'projects.json')).private,true);
      assert.deepEqual(fs.readdirSync(root),[]);
      const registry=path.join(dir,'projects.json');
      fs.writeFileSync(registry,'{invalid existing registry');
      assert.throws(()=>registerProject({root,dbPath:path.join(root,'other.db')}));
      assert.equal(fs.readFileSync(registry,'utf8'),'{invalid existing registry');
      console.log('ok');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, home, root], {
      env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: 'utf8', timeout: 20000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(result.stdout.trim(), 'ok');
  });
