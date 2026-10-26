import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDshRuntime, DSH_SUPPORTED_VERSIONS } from '../lib/integrations/dsh-cordis.mjs';

const corePackages = ['dsh-agent', 'dsh-agent-loop', 'dsh-tools', 'dsh-session'];
function runtime(t, versions) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-dsh-versions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [index, pkg] of corePackages.entries()) {
    const dest = path.join(directory, 'node_modules', '@deepseek-ai', pkg);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/' + pkg, version: versions[index] ?? versions[0], main: './index.js'
    }));
    fs.writeFileSync(path.join(dest, 'index.js'), '');
  }
  return path.join(directory, 'anchor.mjs');
}

for (const version of DSH_SUPPORTED_VERSIONS) {
  test(`Cordis accepts the complete official core set at ${version}`, t => {
    assert.equal(checkDshRuntime(runtime(t, [version])), version);
  });
}
test('Cordis refuses a mixture of individually supported core packages', t => {
  const anchor = runtime(t, ['0.2.0-rc.2', '0.2.1-rc.3']);
  assert.throws(() => checkDshRuntime(anchor), /matching core package versions/);
});
test('Cordis refuses an unverified prerelease before loading tools', t => {
  assert.throws(() => checkDshRuntime(runtime(t, ['0.2.1-rc.4'])), /requires.*found 0\.2\.1-rc\.4/);
});
