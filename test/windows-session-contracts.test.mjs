import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childSessionEnv, launchEnvironmentFingerprint } from '../lib/core/sessions/launch.mjs';
import { parseNativeCwdIdentity } from '../lib/runtime/native/store.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';
import { createProjectContexts } from '../lib/web/project-contexts.mjs';
import { contextForProject } from '../lib/runtime/paths.mjs';
import { provisionPrivateProjectGeneration } from '../lib/runtime/private-state.mjs';

test('Windows launch environment strips inherited markers regardless of case and applies explicit overrides once',
  { skip: process.platform !== 'win32' }, () => {
    const env = childSessionEnv({ hcc_peer: 'next', path: 'selected' }, {
      HCC_PEER: 'old', PATH: 'old path', hcc_web_child: '1', Hcc_Runtime_Local_Only: '1',
      hcc_codex_session_origin: 'new', Other: 'keep'
    });
    assert.deepEqual(env, { HCC_PEER: 'next', PATH: 'selected', OTHER: 'keep' });
    assert.equal(launchEnvironmentFingerprint({ Path: 'same', other: 'value', hcc_peer: 'a' }),
      launchEnvironmentFingerprint({ PATH: 'same', OTHER: 'value', HCC_PEER: 'b' }));
  });

test('native cwd receipt reads a real versioned Windows identity and rejects invalid identity fields',
  { skip: process.platform !== 'win32' }, t => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-windows-native-cwd-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const snapshot = captureSelectedCwdSnapshot(cwd), record = { version: 1, ...snapshot };
    const decode = value => parseNativeCwdIdentity(JSON.stringify(value), snapshot.canonical);
    assert.deepEqual(decode(record), record);
    for (const patch of [{ version: 2 }, { volumeSerial: 1 }, { fileId: '123' },
      { creationTime: 1 }, { platform: 'linux' }]) {
      assert.equal(decode({ ...record, identity: { ...record.identity, ...patch } }), null);
    }
    assert.equal(decode({ ...record, requested: cwd + '-replacement' }), null);
  });

test('Web requests accept the current Windows project identity and reject a changed receipt',
  { skip: process.platform !== 'win32' }, t => {
    const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-windows-request-'));
    const root = path.join(base, 'project'), home = path.join(base, 'profile'); fs.mkdirSync(root); fs.mkdirSync(home);
    const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home; process.env.USERPROFILE = home;
    let projects;
    t.after(() => {
      projects?.releaseProjectContexts();
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      fs.rmSync(base, { recursive: true, force: true });
    });
    provisionPrivateProjectGeneration(root);
    const ctx = contextForProject(root), snapshot = captureSelectedCwdSnapshot(root);
    projects = createProjectContexts({ ctx, sessions: new Map(), sessionKey: (_ctx, id) => id,
      sessionsForProject: () => [], sameResolvedPath: (left, right) => left === right });
    const request = expected => projects.projectFromRequest({ headers: {
      'x-hcc-root-identity': Buffer.from(JSON.stringify(expected)).toString('base64url')
    } }, new URL('http://localhost/api/runtime'), { requireIdentity: true });
    assert.equal(request(snapshot).root, snapshot.canonical);
    assert.throws(() => request({ ...snapshot, identity: { ...snapshot.identity, fileId: '0'.repeat(32) } }), { code: 'PROJECT_PATH_CHANGED' });
  });
