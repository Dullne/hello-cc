// Pack and install a local candidate, then run its public CLI and browser fixture.
// No model, real account, global installation or publication is involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FILE_PREVIEW_CHECKS } from './web-file-preview-checks.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/web-workbench-installed-acceptance.mjs [--output-dir DIR] [--output FILE]');
  console.log('Packs this checkout, installs into a disposable prefix, and runs its model-free browser acceptance. Requires Node 24+, npm, tmux and Playwright Chromium.');
  process.exit(0);
}
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  if (!['--output-dir', '--output'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Unknown or incomplete option: ' + args[index]);
  options.set(args[index], args[index + 1]);
}
assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Installed acceptance requires Node 24+');
assert.notEqual(process.platform, 'win32', 'Run this tmux-based acceptance under WSL on Windows');
const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = path.resolve(options.get('--output-dir') || fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-workbench-installed-evidence-')));
fs.mkdirSync(dir, { recursive: true });
const output = path.resolve(options.get('--output') || path.join(dir, 'evidence.json'));
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-workbench-install-')));
const prefix = path.join(sandbox, 'install'), taskHome = path.join(sandbox, 'home');
fs.mkdirSync(prefix, { recursive: true }); fs.mkdirSync(taskHome, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({ name: 'hcc-browser-install-fixture', version: '0.0.0', private: true }));
fs.writeFileSync(path.join(taskHome, '.npmrc'), '');
fs.writeFileSync(path.join(taskHome, 'global-npmrc'), '');
const env = {
  PATH: [path.dirname(process.execPath), process.env.PATH || '/usr/bin:/bin'].join(path.delimiter),
  HOME: taskHome, TMPDIR: sandbox, LANG: 'C.UTF-8', SHELL: '/bin/sh',
  NPM_CONFIG_CACHE: path.join(sandbox, 'npm-cache'), NPM_CONFIG_USERCONFIG: path.join(taskHome, '.npmrc'),
  NPM_CONFIG_GLOBALCONFIG: path.join(taskHome, 'global-npmrc'),
  NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
  HCC_NO_AUTO_INSTALL_TMUX: '1'
};
const sha256 = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
function hashes() {
  const result = {};
  const walk = relative => {
    const filename = path.join(repo, relative);
    if (!fs.existsSync(filename)) return;
    if (fs.statSync(filename).isDirectory()) for (const name of fs.readdirSync(filename).sort()) walk(path.join(relative, name));
    else result[relative] = sha256(filename);
  };
  for (const name of ['bin', 'lib', 'scripts', 'package.json', 'package-lock.json']) walk(name);
  return result;
}
const receipt = {
  schemaVersion: 1, startedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  sourceRoot: repo, sourceFiles: hashes(), checks: [], success: false,
  scope: 'Local npm archive and disposable installation; simulated providers; no model, publication or employee-device acceptance'
};
function run(command, parameters, name, settings = {}) {
  const result = spawnSync(command, parameters, { cwd: repo, env, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024, ...settings });
  fs.writeFileSync(path.join(dir, name + '.log'), (result.stdout || '') + (result.stderr || ''));
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(name + ' failed (see ' + name + '.log)');
  return result.stdout;
}
try {
  // Invoking npm's JS entry with this Node keeps the pack/install engine at 24+.
  const npmEntry = process.env.npm_execpath;
  const npm = parameters => npmEntry && fs.existsSync(npmEntry)
    ? { command: process.execPath, parameters: [npmEntry, ...parameters] }
    : { command: 'npm', parameters };
  const pack = npm(['pack', '--ignore-scripts', '--json', '--pack-destination', dir]);
  const metadata = JSON.parse(run(pack.command, pack.parameters, 'pack'))[0];
  const archive = path.join(dir, metadata.filename);
  receipt.package = { name: metadata.name, version: metadata.version, archive, sha256: sha256(archive), files: metadata.files.length };
  const install = npm(['install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false', '--fetch-retries=1', '--fetch-timeout=120000', archive]);
  run(install.command, install.parameters, 'install');
  const installed = path.join(prefix, 'node_modules', '@logicseek', 'hello-cc');
  assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version, metadata.version);
  const publicCli = path.join(prefix, 'node_modules', '.bin', 'hcc');
  assert.equal(fs.realpathSync(publicCli), path.join(installed, 'bin', 'hcc.mjs'));
  const help = run(publicCli, ['--help'], 'public-cli', { cwd: prefix });
  assert.match(help, /hello-cc|hcc/);
  receipt.checks.push('npm pack archive installed and public hcc CLI works');

  const specification = process.env.HCC_ACCEPTANCE_PLAYWRIGHT;
  const playwrightUrl = specification && path.isAbsolute(specification) ? pathToFileURL(specification).href : specification || import.meta.resolve('playwright');
  const { chromium } = await import(playwrightUrl);
  const browserOutput = path.join(dir, 'browser');
  const browserEnv = { ...env, HCC_ACCEPTANCE_PACKAGE_ROOT: installed, HCC_ACCEPTANCE_PLAYWRIGHT: playwrightUrl,
    HCC_ACCEPTANCE_CHROME: process.env.HCC_ACCEPTANCE_CHROME || chromium.executablePath(),
    ...(process.env.HCC_ACCEPTANCE_TMUX ? { HCC_ACCEPTANCE_TMUX: process.env.HCC_ACCEPTANCE_TMUX } : {}) };
  run(process.execPath, [path.join(installed, 'scripts', 'web-workbench-acceptance.mjs'), '--output-dir', browserOutput], 'installed-browser', { env: browserEnv, timeout: 300000 });
  const browserReceipt = JSON.parse(fs.readFileSync(path.join(browserOutput, 'evidence.json'), 'utf8'));
  assert.equal(browserReceipt.success, true);
  assert.equal(browserReceipt.packageRoot, installed);
  assert.ok(browserReceipt.assets.length >= 4 && browserReceipt.assets.every(asset => asset.bytes > 0 && asset.sha256));
  for (const required of ['/assets/web/browser/core.mjs', '/assets/web/browser/session-sync.mjs', '/assets/web/ui-native.mjs', '/assets/web/ui-files.mjs']) {
    assert.ok(browserReceipt.assets.some(asset => asset.path === required), 'Installed ESM asset missing: ' + required);
  }
  assert.equal(browserReceipt.filePreview?.success, true, 'Installed archive must complete project file preview acceptance');
  assert.deepEqual(browserReceipt.filePreview.checks, FILE_PREVIEW_CHECKS);
  receipt.browserReceipt = path.join(browserOutput, 'evidence.json');
  receipt.assets = browserReceipt.assets;
  receipt.filePreview = browserReceipt.filePreview;
  receipt.checks.push('installed script loads static assets and completes real-browser acceptance');
  receipt.checks.push('installed archive previews test-owned artifacts and passes read-only lifecycle checks');
  receipt.success = true;
} catch (error) {
  receipt.failure = { message: error.message, stack: error.stack }; console.error(error);
} finally {
  const after = hashes();
  receipt.sourceChanges = [...new Set([...Object.keys(receipt.sourceFiles), ...Object.keys(after)])].filter(name => receipt.sourceFiles[name] !== after[name]);
  if (receipt.sourceChanges.length) { receipt.success = false; receipt.failure ||= { message: 'Source changed during pack/install acceptance' }; }
  try { fs.rmSync(sandbox, { recursive: true, force: true }); receipt.cleanup = true; }
  catch (error) { receipt.cleanup = error.message; receipt.success = false; }
  receipt.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log('EVIDENCE ' + output);
  if (!receipt.success) process.exitCode = 1;
}
