import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { terminalAssetPath } from '../lib/web/terminal-assets.mjs';

test('terminal assets resolve from the installed dependency entry', () => {
  for (const name of ['xterm.js', 'xterm.css', 'addon-fit.js', 'addon-search.js']) {
    assert.ok(fs.statSync(terminalAssetPath(name)).isFile());
    assert.equal(path.basename(terminalAssetPath(name)), name);
  }
  assert.throws(() => terminalAssetPath('../../package.json'), TypeError);
});

test('a scoped HCC package finds npm-hoisted assets without nested dependencies', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-hoisted-web-assets-')));
  try {
    const installed = path.join(root, 'node_modules/@logicseek/hello-cc');
    fs.mkdirSync(path.join(installed, 'lib/web'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'package.json'), '{"type":"module"}');
    fs.copyFileSync(new URL('../lib/web/terminal-assets.mjs', import.meta.url), path.join(installed, 'lib/web/terminal-assets.mjs'));
    for (const [pkg, file] of [['xterm', 'xterm.js'], ['addon-fit', 'addon-fit.js'], ['addon-search', 'addon-search.js']]) {
      const dependency = path.join(root, 'node_modules/@xterm', pkg);
      fs.mkdirSync(path.join(dependency, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: '@xterm/' + pkg, main: 'lib/' + file }));
      fs.writeFileSync(path.join(dependency, 'lib', file), '/* fixture */');
      if (pkg === 'xterm') {
        fs.mkdirSync(path.join(dependency, 'css'));
        fs.writeFileSync(path.join(dependency, 'css/xterm.css'), '/* fixture */');
      }
    }
    const { terminalAssetPath: installedAsset } = await import(pathToFileURL(path.join(installed, 'lib/web/terminal-assets.mjs')));
    assert.equal(fs.existsSync(path.join(installed, 'node_modules')), false);
    for (const name of ['xterm.js', 'xterm.css', 'addon-fit.js', 'addon-search.js']) {
      const resolved = installedAsset(name);
      assert.ok(fs.statSync(resolved).isFile());
      assert.ok(resolved.startsWith(path.join(root, 'node_modules/@xterm/')));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
