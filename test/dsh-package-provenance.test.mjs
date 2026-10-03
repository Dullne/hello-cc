import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { resolveAcceptanceMode, selectAcceptancePackage } from '../scripts/dsh-package-provenance.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-dsh-provenance-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const packageDir = path.join(repo, 'package'), archiveDir = path.join(repo, 'docs', 'verification');
  fs.mkdirSync(packageDir); fs.mkdirSync(archiveDir, { recursive: true });
  const metadata = { name: '@logicseek/hello-cc', version: '1.0.3',
    files: [{ path: 'package.json', mode: 0o644 }, { path: 'bin/hcc.mjs', mode: 0o755 }] };
  const content = { 'package.json': JSON.stringify({ name: metadata.name, version: metadata.version }), 'bin/hcc.mjs': '#!/usr/bin/env node\nconsole.log("frozen");\n' };
  for (const [file, value] of Object.entries(content)) {
    fs.mkdirSync(path.dirname(path.join(packageDir, file)), { recursive: true });
    fs.writeFileSync(path.join(packageDir, file), value);
  }
  const frozen = { version: metadata.version, filename: 'logicseek-hello-cc-1.0.3.tgz',
    sha256: hash('immutable archive bytes'), files: Object.fromEntries(Object.entries(content).map(([file, value]) => [file, hash(value)])),
    fileModes: Object.fromEntries(metadata.files.map(file => [file.path, file.mode])) };
  const frozenArtifact = path.join(archiveDir, frozen.filename);
  fs.writeFileSync(frozenArtifact, 'immutable archive bytes');
  fs.writeFileSync(path.join(archiveDir, 'dsh-1.0.3-package.json'), JSON.stringify(frozen));
  const candidateTarball = path.join(repo, 'candidate.tgz'); fs.writeFileSync(candidateTarball, 'new candidate bytes');
  return { repo, packageDir, metadata, candidateTarball, frozenArtifact };
}

test('source events select candidate; dispatch defaults to release; version tags cannot opt out', () => {
  for (const ref of ['refs/heads/master', 'refs/heads/codex/web-workbench-integration', 'refs/pull/4/merge']) {
    assert.equal(resolveAcceptanceMode({ eventName: ref.includes('/pull/') ? 'pull_request' : 'push', ref, dispatchMode: 'release' }), 'candidate');
  }
  assert.equal(resolveAcceptanceMode({ eventName: 'workflow_dispatch' }), 'release');
  assert.equal(resolveAcceptanceMode({ eventName: 'workflow_dispatch', dispatchMode: 'candidate' }), 'candidate');
  assert.equal(resolveAcceptanceMode({ eventName: 'workflow_dispatch', ref: 'refs/tags/v1.0.3', dispatchMode: 'candidate' }), 'release');
  assert.throws(() => resolveAcceptanceMode({ eventName: 'workflow_dispatch', dispatchMode: 'unexpected' }), /Acceptance mode/);
});

test('candidate preserves the checkout archive despite source drift and records only archive integrity', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.packageDir, 'bin/hcc.mjs'), 'new development code');
  const selected = selectAcceptancePackage({ ...f, mode: 'candidate' });
  assert.equal(selected.tarball, f.candidateTarball);
  assert.equal(selected.acceptanceTarget, 'checkout-candidate');
  assert.equal(selected.frozenContentMatch, null);
  assert.equal(selected.archiveIntegrity.verified, true);
  assert.equal(fs.readFileSync(f.candidateTarball, 'utf8'), 'new candidate bytes');
  assert.equal(fs.readFileSync(f.frozenArtifact, 'utf8'), 'immutable archive bytes');
});

test('a future development version uses the explicit archived baseline without requiring a future release manifest', t => {
  const f = fixture(t); f.metadata.version = '1.0.4';
  const selected = selectAcceptancePackage({ ...f, mode: 'candidate' });
  assert.equal(selected.tarball, f.candidateTarball);
  assert.equal(selected.archiveIntegrity.version, '1.0.3');
  assert.throws(() => selectAcceptancePackage({ ...f, mode: 'release' }), { code: 'ENOENT' });
});

test('release selects immutable bytes only after package content and modes match', t => {
  const f = fixture(t);
  const selected = selectAcceptancePackage({ ...f, mode: 'release' });
  assert.equal(selected.tarball, f.frozenArtifact);
  assert.equal(selected.acceptanceTarget, 'immutable-release');
  assert.equal(selected.frozenContentMatch, true);
});

for (const change of ['content', 'mode', 'files']) {
  test(`release rejects ${change} drift instead of silently selecting a candidate`, t => {
    const f = fixture(t);
    if (change === 'content') fs.writeFileSync(path.join(f.packageDir, 'bin/hcc.mjs'), 'changed');
    if (change === 'mode') f.metadata.files[1].mode = 0o644;
    if (change === 'files') f.metadata.files.pop();
    assert.throws(() => selectAcceptancePackage({ ...f, mode: 'release' }), /Frozen release file differs|Package mode differs|package file set/);
  });
}

for (const mode of ['candidate', 'release']) {
  test(`${mode} rejects corrupted archived bytes`, t => {
    const f = fixture(t); fs.appendFileSync(f.frozenArtifact, 'corruption');
    assert.throws(() => selectAcceptancePackage({ ...f, mode }), /Stored release artifact must match/);
  });
}
