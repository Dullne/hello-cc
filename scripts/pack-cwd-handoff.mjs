import { spawnSync } from 'node:child_process';
import process from 'node:process';

const verify = spawnSync(process.execPath, ['./scripts/verify-cwd-handoff-package.mjs'], {
  stdio: 'inherit'
});
if (verify.error) throw verify.error;
if (verify.status !== 0) process.exit(verify.status || 1);

const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json'], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
});
if (packed.error) throw packed.error;
if (packed.status !== 0) {
  process.stderr.write(packed.stderr);
  process.exit(packed.status || 1);
}
const [archive] = JSON.parse(packed.stdout);
const files = new Map(archive.files.map(file => [file.path, file]));
for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
  const name = `native/bin/${target}/hcc-cwd-handoff`;
  const entry = files.get(name);
  if (!entry || (entry.mode & 0o111) === 0 || (entry.mode & 0o022) !== 0) {
    throw new Error(`npm tarball is missing safe executable ${name}`);
  }
}
console.log(`Verified npm tarball ${archive.filename} (${archive.files.length} files)`);
