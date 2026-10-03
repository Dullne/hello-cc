// Freeze a checkout candidate or verify an immutable release without installing
// Harness, calling a model, changing an archive, or publishing a package.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ARCHIVED_BASELINE = 'docs/verification/dsh-1.0.3-package.json';
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function resolveAcceptanceMode({ eventName, ref, dispatchMode } = {}) {
  if (ref?.startsWith('refs/tags/v')) return 'release';
  if (eventName !== 'workflow_dispatch') return 'candidate';
  const mode = dispatchMode || 'release';
  assert.ok(['candidate', 'release'].includes(mode), 'Acceptance mode must be candidate or release');
  return mode;
}

export function selectAcceptancePackage({ repo, metadata, candidateTarball, packageDir, mode,
  archivedManifest = ARCHIVED_BASELINE }) {
  assert.ok(['candidate', 'release'].includes(mode), 'Acceptance mode must be candidate or release');
  // A development version need not have a release manifest yet. Its archived
  // integrity baseline is explicit and independent of its package version.
  const manifestPath = mode === 'release'
    ? `docs/verification/dsh-${metadata.version}-package.json` : archivedManifest;
  const frozen = JSON.parse(fs.readFileSync(path.resolve(repo, manifestPath), 'utf8'));
  assert.equal(path.basename(frozen.filename), frozen.filename, 'Archive filename must be a basename');
  const frozenArtifact = path.join(repo, 'docs', 'verification', frozen.filename);
  assert.equal(hash(frozenArtifact), frozen.sha256, 'Stored release artifact must match its frozen digest');
  let frozenContentMatch = null;
  if (mode === 'release') {
    assert.equal(metadata.version, frozen.version, 'Frozen manifest version must match');
    assert.deepEqual(metadata.files.map(file => file.path).sort(), Object.keys(frozen.files).sort(),
      'The package file set must match the frozen release artifact');
    for (const file of metadata.files) {
      assert.equal(hash(path.join(packageDir, file.path)), frozen.files[file.path], `Frozen release file differs: ${file.path}`);
      assert.equal(file.mode, frozen.fileModes[file.path], `Package mode differs: ${file.path}`);
    }
    frozenContentMatch = true;
  }
  return {
    mode, acceptanceTarget: mode === 'release' ? 'immutable-release' : 'checkout-candidate',
    tarball: mode === 'release' ? frozenArtifact : candidateTarball,
    frozenContentMatch,
    archiveIntegrity: { manifest: manifestPath, version: frozen.version,
      filename: frozen.filename, sha256: frozen.sha256, verified: true }
  };
}

export function freezeAcceptancePackage({ root, repo = fileURLToPath(new URL('..', import.meta.url)),
  mode, env = process.env }) {
  assert.ok(root, 'HCC_DSH_ACCEPTANCE_ROOT or --output-dir is required');
  assert.ok(['candidate', 'release'].includes(mode), 'Acceptance mode must be candidate or release');
  root = path.resolve(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // Require fresh output directories so an earlier extraction cannot supply
  // stale files to this run's source comparison or acceptance script.
  for (const name of ['home', 'official', 'candidate', 'candidate-unpacked', 'unpacked', 'evidence']) {
    fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  }
  const childEnv = { ...env, HOME: path.join(root, 'home'), DSH_HOME: path.join(root, 'home', 'dsh'),
    NPM_CONFIG_CACHE: path.join(root, 'npm-cache'), NPM_CONFIG_USERCONFIG: path.join(root, 'home', '.npmrc') };
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete childEnv[key];
  const run = (command, args) => execFileSync(command, args, { cwd: repo, env: childEnv, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const npm = args => env.npm_execpath
    ? run(process.execPath, [env.npm_execpath, ...args]) : run('npm', args);
  const metadata = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', path.join(root, 'candidate')]))[0];
  if (env.GITHUB_REF?.startsWith('refs/tags/v')) {
    assert.equal(mode, 'release', 'Version tags require immutable release acceptance');
    assert.equal(env.GITHUB_REF.slice('refs/tags/v'.length), metadata.version, 'Version tag must match the package version');
  }
  const candidateTarball = path.join(root, 'candidate', metadata.filename);
  run('tar', ['-xzf', candidateTarball, '-C', path.join(root, 'candidate-unpacked')]);
  const selected = selectAcceptancePackage({ repo, metadata, candidateTarball, mode,
    packageDir: path.join(root, 'candidate-unpacked', 'package') });
  // The script and the installed archive must come from the same selected
  // package. Release mode must not run a candidate script against the archive.
  run('tar', ['-xzf', selected.tarball, '-C', path.join(root, 'unpacked')]);
  const receipt = {
    schemaVersion: 2, createdAt: new Date().toISOString(),
    revision: run('git', ['rev-parse', 'HEAD']).trim(),
    platform: { os: process.platform, architecture: process.arch, node: process.version },
    harness: '0.2.0-rc.2', pnpm: '12.8.1', npm: npm(['--version']).trim(),
    mode, acceptanceTarget: selected.acceptanceTarget,
    archiveIntegrity: selected.archiveIntegrity, frozenContentMatch: selected.frozenContentMatch,
    repackedSha256: hash(candidateTarball),
    package: { name: metadata.name, version: metadata.version, filename: path.basename(selected.tarball),
      fileCount: metadata.files.length, sha256: hash(selected.tarball) },
    registryReadbackPerformed: false, npmPublicationRequested: false,
    validation: mode === 'candidate'
      ? 'Checkout candidate installation on a CI runner; not a published-package, device or business acceptance'
      : 'Immutable archived release installation on a CI runner; no registry readback, device or business acceptance'
  };
  fs.writeFileSync(path.join(root, 'evidence', 'package-provenance.json'), JSON.stringify(receipt, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'candidate.json'), JSON.stringify({ tarball: selected.tarball, mode, acceptanceTarget: selected.acceptanceTarget }));
  fs.writeFileSync(path.join(root, 'official', 'package.json'), JSON.stringify({ name: 'hcc-isolated-dsh-acceptance', private: true, version: '0.0.0' }));
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `mode=${mode}\nacceptanceTarget=${selected.acceptanceTarget}\n`);
  return receipt;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = new Map();
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index], value = process.argv[index + 1];
      assert.ok(['--mode', '--output-dir'].includes(key) && value && !value.startsWith('--'), `Invalid option: ${key}`);
      options.set(key, value);
    }
    const mode = options.get('--mode') || resolveAcceptanceMode({ eventName: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF, dispatchMode: process.env.HCC_DSH_DISPATCH_MODE });
    console.log(JSON.stringify(freezeAcceptancePackage({ root: options.get('--output-dir') || process.env.HCC_DSH_ACCEPTANCE_ROOT, mode }), null, 2));
  } catch (error) {
    const details = String(error.stack || error.message || error).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.error(`::error::${details}`); process.exitCode = 1;
  }
}
