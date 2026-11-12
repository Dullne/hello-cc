import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WINDOWS_NATIVE_NAPI_VERSION, WINDOWS_NATIVE_PROTOCOL_VERSION,
  windowsNativeSourceHash } from '../lib/platform/windows-native.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = data => createHash('sha256').update(data).digest('hex');

function checkedRun(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(file)} failed (${result.status ?? result.signal})`);
  return result.stdout;
}

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--headers', '--node-lib', '--vswhere'].includes(args[i]) || !args[i + 1] || Object.hasOwn(result, args[i])) {
      throw new Error('Usage: node scripts/build-windows-native.mjs --headers NODE_INCLUDE_DIR --node-lib NODE_LIB [--vswhere VSWHERE_EXE]');
    }
    result[args[i]] = path.resolve(args[i + 1]);
  }
  if (!result['--headers'] || !result['--node-lib']) throw new Error('--headers and --node-lib are required');
  return result;
}

function compilerEnvironment(vswhere) {
  const installation = checkedRun(vswhere, ['-latest', '-products', '*', '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath', '-utf8']).trim();
  if (!installation || /[\r\n"%&|<>^]/.test(installation)) throw new Error('Visual Studio installation path is unavailable or unsafe');
  const vcvars = path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
  if (!fs.existsSync(vcvars)) throw new Error('Visual Studio C++ environment script is missing');
  const command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  // Only the fixed, checked VS path enters cmd syntax. Compiler inputs go in a
  // response file and never pass through shell parsing. No global PATH changes.
  const output = checkedRun(command, ['/d', '/s', '/c', `chcp 65001 >nul && call "${vcvars}" x64 >nul && set`],
    { windowsVerbatimArguments: true });
  const environment = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  // CL and _CL_ can silently add or override flags; this build owns its flags.
  for (const name of Object.keys(environment)) {
    if (['cl', '_cl_'].includes(name.toLowerCase())) delete environment[name];
  }
  const toolsKey = Object.keys(environment).find(key => key.toLowerCase() === 'vctoolsinstalldir');
  if (!toolsKey) throw new Error('Visual Studio did not provide its C++ tools directory');
  const compiler = path.join(environment[toolsKey], 'bin', 'Hostx64', 'x64', 'cl.exe');
  if (!fs.existsSync(compiler)) throw new Error('Visual Studio x64 C++ compiler is missing');
  return { environment, compiler };
}

function responseArgument(argument) {
  if (/[\r\n\0]/.test(argument)) throw new Error('Compiler argument contains a control character');
  return '"' + argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build requires a native Windows x64 Node.js process');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Build requires Node.js 24 or later');
  const opts = options(process.argv.slice(2));
  if (!fs.existsSync(path.join(opts['--headers'], 'node_api.h')) || !fs.existsSync(opts['--node-lib'])) {
    throw new Error('Node.js headers or node.lib are missing');
  }
  const vswhere = opts['--vswhere'] || path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const { environment, compiler } = compilerEnvironment(vswhere);
  const sourceDirectory = path.join(root, 'native', 'windows');
  const sourceHash = windowsNativeSourceHash(root);
  const sources = fs.readdirSync(sourceDirectory).filter(name => name.endsWith('.cc')).sort()
    .map(name => path.join(sourceDirectory, name));
  const outputDirectory = path.join(root, 'native', 'bin', 'win32-x64');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(outputDirectory, '.build-'));
  if (path.dirname(path.resolve(temporary)) !== outputDirectory || !path.basename(temporary).startsWith('.build-')) {
    throw new Error('Temporary native build directory escaped its output directory');
  }
  try {
    const binary = path.join(temporary, 'hcc-windows.node');
    const response = path.join(temporary, 'compile.rsp');
    const args = ['/nologo', '/std:c++17', '/O2', '/W4', '/WX', '/EHsc', '/MT', '/LD', '/utf-8',
      '/guard:cf', '/D_WIN32_WINNT=0x0A00', `/DNAPI_VERSION=${WINDOWS_NATIVE_NAPI_VERSION}`,
      `/DHCC_WINDOWS_PROTOCOL_VERSION=${WINDOWS_NATIVE_PROTOCOL_VERSION}`,
      `/DHCC_SOURCE_SHA256="${sourceHash}"`, `/I${opts['--headers']}`,
      ...sources, '/link', '/NOLOGO', '/DYNAMICBASE', '/NXCOMPAT', '/GUARD:CF',
      `/OUT:${binary}`, opts['--node-lib'], 'kernel32.lib', 'advapi32.lib'];
    // MSVC recognizes a UTF-16 LE response file with a BOM, including Unicode
    // checkouts/toolchain paths without dependence on the active OEM code page.
    // /link consumes the remainder of its response-file line, so keep compiler
    // and linker arguments together rather than putting one option per line.
    fs.writeFileSync(response, Buffer.from('\uFEFF' + args.map(responseArgument).join(' '), 'utf16le'));
    checkedRun(compiler, [`@${response}`], { cwd: temporary, env: environment, stdio: 'inherit' });
    const shimSource = path.join(sourceDirectory, 'launcher', 'shim.cc');
    const shimSourceHash = sha256(fs.readFileSync(shimSource));
    const shimBinary = path.join(temporary, 'hcc-shim.exe');
    const shimArgs = ['/nologo', '/std:c++17', '/O2', '/W4', '/WX', '/EHsc', '/MT', '/utf-8', '/guard:cf',
      '/D_WIN32_WINNT=0x0A00', shimSource, '/link', '/NOLOGO', '/DYNAMICBASE', '/NXCOMPAT',
      '/GUARD:CF', `/OUT:${shimBinary}`, 'kernel32.lib', 'shell32.lib'];
    const shimResponse = path.join(temporary, 'shim.rsp');
    fs.writeFileSync(shimResponse, Buffer.from('\uFEFF' + shimArgs.map(responseArgument).join(' '), 'utf16le'));
    checkedRun(compiler, [`@${shimResponse}`], { cwd: temporary, env: environment, stdio: 'inherit' });
    if (sha256(fs.readFileSync(shimSource)) !== shimSourceHash) throw new Error('Shim source changed while compiling');
    const shimManifest = path.join(temporary, 'hcc-shim.json');
    fs.writeFileSync(shimManifest, JSON.stringify({ manifestVersion: 1, platform: 'win32', arch: 'x64',
      sourceSha256: shimSourceHash, binarySha256: sha256(fs.readFileSync(shimBinary)) }, null, 2) + '\n');
    if (windowsNativeSourceHash(root) !== sourceHash) throw new Error('Native sources changed while compiling; rebuild required');
    const manifest = {
      manifestVersion: 1, protocolVersion: WINDOWS_NATIVE_PROTOCOL_VERSION,
      napiVersion: WINDOWS_NATIVE_NAPI_VERSION, platform: 'win32', arch: 'x64',
      sourceSha256: sourceHash, binarySha256: sha256(fs.readFileSync(binary)),
      buildNodeVersion: process.versions.node
    };
    const manifestTemporary = path.join(temporary, 'hcc-windows.json');
    fs.writeFileSync(manifestTemporary, JSON.stringify(manifest, null, 2) + '\n');
    // Publish metadata last. An interrupted pair update fails validation.
    fs.renameSync(binary, path.join(outputDirectory, 'hcc-windows.node'));
    fs.renameSync(manifestTemporary, path.join(outputDirectory, 'hcc-windows.json'));
    fs.renameSync(shimBinary, path.join(outputDirectory, 'hcc-shim.exe'));
    fs.renameSync(shimManifest, path.join(outputDirectory, 'hcc-shim.json'));
    console.log(`Built native/bin/win32-x64/hcc-windows.node (Node-API ${WINDOWS_NATIVE_NAPI_VERSION})`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

try { main(); }
catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
