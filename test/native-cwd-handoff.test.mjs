import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.env.HCC_NATIVE_CWD_HANDOFF_BINARY || path.join(root, 'native', 'bin',
  `${process.platform}-${process.arch}`, 'hcc-cwd-handoff');
const available = fs.existsSync(binary);
const required = process.env.HCC_NATIVE_CWD_HANDOFF_REQUIRED === '1';
if (required && !available) throw new Error(`Required native cwd handoff helper missing: ${binary}`);

function capture(child) {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  const complete = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { complete, output: () => ({ stdout, stderr }) };
}

function ready(child, captured) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (captured.output().stdout.includes('READY\n')) {
        clearInterval(timer);
        resolve();
      } else if (child.exitCode !== null || Date.now() - started > 5000) {
        clearInterval(timer);
        reject(new Error(`Broker did not become ready: ${JSON.stringify(captured.output())}`));
      }
    }, 10);
  });
}

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-cwd-native-test-'));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function brokerFor({ socket, directoryFd, identity, nonce }) {
  const child = spawn(binary, ['broker', '--socket', socket, '--dir-fd', '3',
    '--dev', identity.dev, '--ino', identity.ino, '--nonce', nonce], {
    cwd: '/', stdio: ['pipe', 'pipe', 'pipe', directoryFd]
  });
  return { child, captured: capture(child) };
}

function clientFor({ socket, identity, nonce, script, executable = process.execPath }) {
  const child = spawn(binary, ['client', '--socket', socket,
    '--dev', identity.dev, '--ino', identity.ino, '--nonce', nonce,
    '--', executable, '-e', script], {
    cwd: '/', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` }
  });
  return { child, captured: capture(child) };
}

test('SCM_RIGHTS binds the pane to a renamed directory inode, not its replacement path',
  { skip: !available, timeout: 30_000 }, async () => {
    const temporary = temporaryDirectory();
    try {
      const selected = path.join(temporary, 'selected');
      const moved = path.join(temporary, 'moved');
      const replacement = path.join(temporary, 'replacement');
      fs.mkdirSync(selected);
      fs.mkdirSync(replacement);
      fs.writeFileSync(path.join(selected, 'marker'), 'ORIGINAL');
      fs.writeFileSync(path.join(replacement, 'marker'), 'REPLACEMENT');
      const directoryFd = fs.openSync(selected,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(directoryFd, { bigint: true });
      const identity = { dev: stat.dev.toString(), ino: stat.ino.toString() };
      const nonce = randomBytes(32).toString('hex');
      const socket = path.join(temporary, 's');
      const broker = brokerFor({ socket, directoryFd, identity, nonce });
      fs.closeSync(directoryFd);
      await ready(broker.child, broker.captured);

      fs.renameSync(selected, moved);
      fs.symlinkSync(replacement, selected);
      const client = clientFor({ socket, identity, nonce,
        executable: path.basename(process.execPath),
        script: 'process.stdout.write(JSON.stringify({marker:require("fs").readFileSync("marker", "utf8"),cwd:process.cwd(),pwd:process.env.PWD}))' });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(client.captured.output().stdout, '');
      assert.equal(client.child.exitCode, null);
      assert.equal(fs.existsSync(`${socket}.bound`), false, 'no admission receipt before ALLOW');
      broker.child.stdin.end(`ALLOW ${client.child.pid} ${nonce}\n`);
      const [clientResult, brokerResult] = await Promise.all([
        client.captured.complete, broker.captured.complete
      ]);
      assert.equal(clientResult.code, 0, clientResult.stderr);
      assert.deepEqual(JSON.parse(clientResult.stdout),
        { marker: 'ORIGINAL', cwd: fs.realpathSync(moved), pwd: fs.realpathSync(moved) });
      assert.equal(brokerResult.code, 0, brokerResult.stderr);
      assert.equal(brokerResult.stdout, 'READY\nBOUND\n');
      assert.equal(fs.existsSync(socket), false);
      assert.equal(fs.readFileSync(`${socket}.bound`, 'utf8'), `${nonce}\n`);
      const receipt = fs.lstatSync(`${socket}.bound`);
      assert.equal(receipt.isFile(), true);
      assert.equal(receipt.nlink, 1);
      assert.equal(receipt.mode & 0o777, 0o600);
      assert.equal(receipt.uid, process.geteuid());
      assert.equal(fs.existsSync(`${socket}.bound.tmp`), false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

test('broker refuses a descriptor whose inode does not match the parent claim',
  { skip: !available, timeout: 10_000 }, async () => {
    const temporary = temporaryDirectory();
    try {
      const directoryFd = fs.openSync(temporary,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(directoryFd, { bigint: true });
      const broker = brokerFor({ socket: path.join(temporary, 's'), directoryFd,
        identity: { dev: stat.dev.toString(), ino: (stat.ino + 1n).toString() },
        nonce: randomBytes(32).toString('hex') });
      fs.closeSync(directoryFd);
      const result = await broker.captured.complete;
      assert.equal(result.code, 42);
      assert.match(result.stderr, /BROKER_DIRECTORY_INVALID/);
      assert.equal(fs.existsSync(path.join(temporary, 's')), false);
      assert.equal(fs.existsSync(path.join(temporary, 's.bound')), false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

test('broker will not overwrite an existing admission receipt',
  { skip: !available, timeout: 10_000 }, async () => {
    const temporary = temporaryDirectory();
    try {
      const socket = path.join(temporary, 's');
      const prior = 'existing receipt must survive';
      fs.writeFileSync(`${socket}.bound`, prior, { mode: 0o600 });
      const directoryFd = fs.openSync(temporary,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(directoryFd, { bigint: true });
      const broker = brokerFor({ socket, directoryFd,
        identity: { dev: stat.dev.toString(), ino: stat.ino.toString() },
        nonce: randomBytes(32).toString('hex') });
      fs.closeSync(directoryFd);
      const result = await broker.captured.complete;
      assert.equal(result.code, 42);
      assert.match(result.stderr, /SOCKET_EXISTS/);
      assert.equal(fs.readFileSync(`${socket}.bound`, 'utf8'), prior);
      assert.equal(fs.existsSync(socket), false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

test('client refuses a transferred directory with a different inode before exec',
  { skip: !available, timeout: 10_000 }, async () => {
    const temporary = temporaryDirectory();
    try {
      const directoryFd = fs.openSync(temporary,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(directoryFd, { bigint: true });
      const identity = { dev: stat.dev.toString(), ino: stat.ino.toString() };
      const nonce = randomBytes(32).toString('hex');
      const socket = path.join(temporary, 's');
      const broker = brokerFor({ socket, directoryFd, identity, nonce });
      fs.closeSync(directoryFd);
      await ready(broker.child, broker.captured);
      const client = clientFor({ socket,
        identity: { ...identity, ino: (stat.ino + 1n).toString() }, nonce,
        script: 'process.stdout.write("SHOULD_NOT_EXEC")' });
      broker.child.stdin.end(`ALLOW ${client.child.pid} ${nonce}\n`);
      const [clientResult, brokerResult] = await Promise.all([
        client.captured.complete, broker.captured.complete
      ]);
      assert.equal(clientResult.code, 42);
      assert.match(clientResult.stderr, /CLIENT_DIRECTORY_CHANGED/);
      assert.equal(clientResult.stdout, '');
      assert.equal(brokerResult.code, 42);
      assert.match(brokerResult.stderr, /CLIENT_BIND_UNCONFIRMED/);
      assert.equal(fs.existsSync(`${socket}.bound`), false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

test('broker never transfers a directory FD to a different kernel peer PID',
  { skip: !available || process.env.HCC_NATIVE_CWD_HANDOFF_EXTENDED_TESTS !== '1',
    timeout: 35_000 }, async () => {
    const temporary = temporaryDirectory();
    try {
      const directoryFd = fs.openSync(temporary,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(directoryFd, { bigint: true });
      const identity = { dev: stat.dev.toString(), ino: stat.ino.toString() };
      const nonce = randomBytes(32).toString('hex');
      const socket = path.join(temporary, 's');
      const broker = brokerFor({ socket, directoryFd, identity, nonce });
      fs.closeSync(directoryFd);
      await ready(broker.child, broker.captured);
      const client = clientFor({ socket, identity, nonce,
        script: 'process.stdout.write("SHOULD_NOT_EXEC")' });
      broker.child.stdin.end(`ALLOW ${client.child.pid + 1} ${nonce}\n`);
      const [clientResult, brokerResult] = await Promise.all([
        client.captured.complete, broker.captured.complete
      ]);
      assert.equal(clientResult.code, 42);
      // PID rejection can close the socket before HELLO is written or before
      // the subsequent FD receive; either scheduling order must fail closed.
      assert.match(clientResult.stderr, /(?:CLIENT_HELLO_FAILED|FD_RECEIVE_FAILED)/);
      assert.equal(clientResult.stdout, '');
      assert.equal(brokerResult.code, 42);
      assert.match(brokerResult.stderr, /BROKER_CLIENT_TIMEOUT/);
      assert.doesNotMatch(brokerResult.stdout, /BOUND/);
      assert.equal(fs.existsSync(`${socket}.bound`), false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
