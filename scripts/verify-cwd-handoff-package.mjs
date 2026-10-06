import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'native', 'cwd-handoff', 'hcc-cwd-handoff.c'));
const sourceHash = createHash('sha256').update(source).digest('hex');
const buildIdentity = Buffer.from(`HCC_SOURCE_SHA256:${sourceHash}`);
const targets = new Map([
  ['darwin-arm64', 0x0100000c],
  ['darwin-x64', 0x01000007],
  ['linux-arm64', 183],
  ['linux-x64', 62]
]);

function verifyBinary(target, machine) {
  const filename = path.join(root, 'native', 'bin', target, 'hcc-cwd-handoff');
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) {
    throw new Error(`${target}: helper must be an executable, non-writable regular file`);
  }
  const binary = fs.readFileSync(filename);
  if (binary.indexOf(buildIdentity) < 0) {
    throw new Error(`${target}: binary is stale relative to its packaged C source`);
  }
  if (target.startsWith('darwin-')) {
    if (binary.length < 8 || binary.readUInt32LE(0) !== 0xfeedfacf ||
        binary.readUInt32LE(4) !== machine) {
      throw new Error(`${target}: unexpected Mach-O architecture`);
    }
  } else {
    if (binary.length < 64 || binary.subarray(0, 4).toString('hex') !== '7f454c46' ||
        binary[4] !== 2 || binary[5] !== 1 || binary.readUInt16LE(18) !== machine) {
      throw new Error(`${target}: unexpected ELF architecture`);
    }
    const programHeaderOffset = Number(binary.readBigUInt64LE(32));
    const programHeaderSize = binary.readUInt16LE(54);
    const programHeaderCount = binary.readUInt16LE(56);
    if (programHeaderSize < 56 || programHeaderCount === 0 ||
        programHeaderOffset + programHeaderSize * programHeaderCount > binary.length) {
      throw new Error(`${target}: invalid ELF program headers`);
    }
    for (let i = 0; i < programHeaderCount; i++) {
      const type = binary.readUInt32LE(programHeaderOffset + programHeaderSize * i);
      if (type === 2 || type === 3) {
        throw new Error(`${target}: Linux helper must not need a dynamic loader`);
      }
    }
  }
  console.log(`Verified ${path.relative(root, filename)}`);
}

try {
  for (const [target, machine] of targets) verifyBinary(target, machine);
} catch (error) {
  console.error(`Native cwd handoff package incomplete: ${error.message}`);
  process.exitCode = 1;
}
