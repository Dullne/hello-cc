// Generate the protocol from the selected installed Codex, without starting an
// App Server, model turn, or login. Existing output directories are never used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CODEX_PROTOCOL_SCHEMA_FILES, CODEX_PROTOCOL_SCHEMA_PATHS, inspectCodexProtocol } from '../lib/diagnostics/codex-protocol.mjs';

function argumentsFor(argv) {
  const options = { binary: 'codex', out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') return { help: true };
    if (!['--codex-bin', '--out'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Use --codex-bin PATH and/or --out NEW_DIRECTORY');
    const key = argv[i] === '--codex-bin' ? 'binary' : 'out';
    options[key] = argv[++i];
  }
  if (options.binary.includes(path.sep) || options.binary.includes('/')) options.binary = path.resolve(options.binary);
  if (options.out) options.out = path.resolve(options.out);
  return options;
}
function inventory(directory, parent = directory) {
  return fs.readdirSync(parent, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(parent, entry.name);
    if (entry.isDirectory()) return inventory(directory, file);
    if (!entry.isFile()) throw new Error('Generated protocol contains a non-regular file');
    return [{ path: path.relative(directory, file).split(path.sep).join('/'),
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }];
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

let workspace;
try {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) {
    console.log('node scripts/codex-protocol.mjs [--codex-bin PATH] [--out NEW_DIRECTORY]\nGenerates official TypeScript and JSON Schema with --experimental, checks the HCC subset, and records version and file hashes. No model or account access. Output must not already exist.');
  } else {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-codex-protocol-'));
    fs.chmodSync(workspace, 0o700);
    const home = path.join(workspace, 'home'), codexHome = path.join(workspace, 'codex-home');
    fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(codexHome, { mode: 0o700 });
    const output = options.out || path.join(workspace, 'protocol');
    fs.mkdirSync(output, { mode: 0o700 });
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
      APPDATA: home, LOCALAPPDATA: home, TMPDIR: workspace, TEMP: workspace, TMP: workspace,
      HCC_SHIM_NO_ATTACH: '1', HCC_SHIM_ENSURED: '1', NO_COLOR: '1' };
    const run = args => {
      const result = spawnSync(options.binary, args, { cwd: workspace, env, encoding: 'utf8',
        timeout: 30000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      // Arbitrary executable output must not appear in a failure receipt.
      if (result.error || result.status !== 0) throw new Error(`Codex protocol command failed: ${args.slice(0, 2).join(' ')}`);
      return result.stdout.trim();
    };
    const versionOutput = run(['--version']);
    const version = /^codex-cli (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(versionOutput)?.[1];
    if (!version) throw new Error('Codex returned an unrecognized version');
    const commands = [['app-server', 'generate-json-schema', '--experimental', '--out', path.join(output, 'json-schema')],
      ['app-server', 'generate-ts', '--experimental', '--out', path.join(output, 'typescript')]];
    for (const command of commands) run(command);
    if (run(['--version']) !== versionOutput) throw new Error('Codex version changed during generation');
    let schemas;
    try {
      schemas = Object.fromEntries(CODEX_PROTOCOL_SCHEMA_FILES.map(name => [name,
        JSON.parse(fs.readFileSync(path.join(output, 'json-schema', CODEX_PROTOCOL_SCHEMA_PATHS[name]), 'utf8'))]));
    } catch { throw new Error('Official JSON Schema output is missing or invalid'); }
    const contract = inspectCodexProtocol(schemas);
    const files = inventory(output);
    if (!files.some(file => file.path === 'typescript/ClientRequest.ts') || !files.some(file => file.path === 'typescript/ServerRequest.ts')) throw new Error('Official TypeScript output is incomplete');
    const manifest = { schemaVersion: 1, codexVersion: version, experimental: true,
      commands: commands.map(command => [...command.slice(0, -1), path.relative(output, command.at(-1))]),
      contract, files, bundleSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    if (!options.out) workspace = null; // Retain generated output; remove only disposable homes.
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(codexHome, { recursive: true, force: true });
    console.log(JSON.stringify({ outputDirectory: output, codexVersion: version, status: contract.status,
      checks: contract.checks.length, failedChecks: contract.checks.filter(check => check.status === 'fail'),
      unsupportedServerRequests: contract.unsupportedServerRequests, fileCount: files.length,
      bundleSha256: manifest.bundleSha256, inferenceCalled: false, accountAccessed: false }));
    if (contract.status !== 'compatible') process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: 'CODEX_PROTOCOL_GENERATION_FAILED',
    message: error.code === 'EEXIST' ? 'Output directory already exists; choose a new directory' :
      error.code === 'ENOENT' ? 'Codex executable or generated protocol file is missing' : error.message }));
  process.exitCode = 1;
} finally {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
}
