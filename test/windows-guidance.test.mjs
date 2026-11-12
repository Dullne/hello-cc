import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { writeProjectGuidanceFiles, removeProjectGuidanceFiles } from '../lib/process/pinned-guidance.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';

const windows = process.platform === 'win32';
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-guidance-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, '项目 with spaces'); fs.mkdirSync(root);
  return { base, root };
}

test('Windows guidance atomically updates managed blocks and retains unrelated text', { skip: !windows }, t => {
  const { root } = fixture(t);
  const claude = path.join(root, 'CLAUDE.md'), agents = path.join(root, 'AGENTS.md');
  fs.writeFileSync(claude, 'Existing note\n');
  assert.deepEqual(writeProjectGuidanceFiles(root, 'First 中文'), [claude, agents]);
  assert.match(fs.readFileSync(claude, 'utf8'), /^Existing note\n/);
  assert.match(fs.readFileSync(agents, 'utf8'), /First 中文/);
  assert.deepEqual(writeProjectGuidanceFiles(root, 'First 中文'), []);
  writeProjectGuidanceFiles(root, 'Updated');
  assert.equal(fs.readFileSync(claude, 'utf8').includes('First'), false);
  assert.deepEqual(removeProjectGuidanceFiles(root), [claude, agents]);
  assert.equal(fs.readFileSync(claude, 'utf8'), 'Existing note\n');
  assert.equal(fs.readFileSync(agents, 'utf8'), '');
  assert.deepEqual(fs.readdirSync(root).sort(), ['AGENTS.md', 'CLAUDE.md']);
});

test('Windows guidance preflights both targets and refuses unsafe or stale root objects before writing',
  { skip: !windows }, t => {
    const { base, root } = fixture(t);
    const outside = path.join(base, 'outside.md'); fs.writeFileSync(outside, 'outside');
    fs.linkSync(outside, path.join(root, 'AGENTS.md'));
    assert.throws(() => writeProjectGuidanceFiles(root, 'do not write'), { code: 'GUIDANCE_WRITE_FAILED' });
    assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md')), false);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
    fs.unlinkSync(path.join(root, 'AGENTS.md'));
    const expectedSnapshot = captureSelectedCwdSnapshot(root);
    fs.renameSync(root, root + '-old'); fs.mkdirSync(root);
    assert.throws(() => writeProjectGuidanceFiles(root, 'do not write', { expectedSnapshot }), { code: 'PROJECT_PATH_CHANGED' });
    assert.deepEqual(fs.readdirSync(root), []);
  });

test('default Windows CLI init writes project and private guidance under an isolated profile',
  { skip: !windows }, t => {
    const { base, root } = fixture(t); const home = path.join(base, 'profile'); fs.mkdirSync(home);
    const cli = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, '--root', root, '--json', 'init'], {
      env: { ...process.env, HOME: home, USERPROFILE: home, NODE_NO_WARNINGS: '1' },
      encoding: 'utf8', timeout: 20000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const data = JSON.parse(result.stdout);
    const guidance = data.data?.guidance ?? data.guidance;
    assert.match(fs.readFileSync(guidance, 'utf8'), /hello-cc Coordination Rules/);
    assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /hello-cc Coordination Rules/);
    assert.match(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), /hello-cc Coordination Rules/);
    assert.equal(fs.existsSync(path.join(root, '.hello-cc')), false);
  });
