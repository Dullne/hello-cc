import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostTarget = `${process.platform}-${process.arch}`;
const target = process.argv.length === 4 && process.argv[2] === '--target'
  ? process.argv[3] : hostTarget;
const supported = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
if ((process.argv.length !== 2 &&
     !(process.argv.length === 4 && process.argv[2] === '--target')) ||
    !supported.has(target) ||
    (target !== hostTarget && !(process.platform === 'darwin' && target.startsWith('darwin-')))) {
  console.error(`Unsupported native cwd handoff build target: ${target}`);
  process.exit(1);
}

const source = path.join(root, 'native', 'cwd-handoff', 'hcc-cwd-handoff.c');
const sourceHash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
const outputDirectory = path.join(root, 'native', 'bin', target);
const output = path.join(outputDirectory, 'hcc-cwd-handoff');
fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
const temporary = path.join(outputDirectory,
  `.hcc-cwd-handoff-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
const compiler = process.env.CC || 'cc';
const args = [
  '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-pedantic',
  '-D_FORTIFY_SOURCE=2', '-fstack-protector-strong',
  `-DHCC_SOURCE_SHA256="${sourceHash}"`,
  ...(process.platform === 'darwin' ? ['-arch', target.endsWith('arm64') ? 'arm64' : 'x86_64'] : []),
  ...(process.platform === 'linux' ? ['-static', '-Wl,-z,relro,-z,now'] : []),
  '-o', temporary, source
];
try {
  const result = spawnSync(compiler, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native compiler exited with ${result.status ?? result.signal}`);
  fs.chmodSync(temporary, 0o755);
  fs.renameSync(temporary, output);
  console.log(`Built ${path.relative(root, output)}`);
} finally {
  try { fs.unlinkSync(temporary); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
