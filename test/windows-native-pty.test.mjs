import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';

const windows = { skip: process.platform !== 'win32', timeout: 15000 };
const controllers = new Map();
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-native-pty-'));
  controllers.set(cwd, []);
  t.after(async () => {
    for (const child of controllers.get(cwd) || []) child.close();
    controllers.delete(cwd);
    await fs.promises.rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  });
  return cwd;
}
function start(t, cwd, args, dimensions = {}) {
  const native = loadWindowsNative();
  assert.equal(typeof native.startOwnedPty, 'function');
  const lease = native.captureDirectory(cwd);
  let child;
  try { child = native.startOwnedPty({ file: process.execPath, args, cwd, env: process.env, lease,
    cols: 83, rows: 27, ...dimensions }); }
  finally { lease.close(); }
  controllers.get(cwd).push(child);
  t.after(() => child.close());
  return child;
}
async function until(t, child, predicate) {
  let output = '';
  for (let i = 0; i < 300; i++) {
    const data = child.readStdout(); if (data) output += data.toString();
    if (predicate(output, child.poll(), data === null)) return output;
    await sleep(10);
  }
  assert.fail('ConPTY condition timed out: ' + output.slice(-500));
}
async function finish(t, child) {
  let output = '';
  await until(t, child, (text, status, eof) => {
    output = text;
    if (status.exited && status.activeProcesses === 0) child.endPty();
    return status.exited && status.activeProcesses === 0 && status.ptyClosed && eof;
  });
  return output;
}

test('native ConPTY provides a real terminal with Unicode output and literal arguments', windows, async t => {
  const cwd = fixture(t), args = ['中文 & %!', 'a"b', 'tail\\'];
  const code = 'console.log("HCC_DATA:"+JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),tty:process.stdout.isTTY,size:[process.stdout.columns,process.stdout.rows]}));';
  const child = start(t, cwd, ['-e', code, ...args]);
  const imagePath = child.imagePath;
  assert.equal(imagePath.toLowerCase(), fs.realpathSync(process.execPath).toLowerCase());
  assert.throws(() => { child.imagePath = 'C:\\wrong.exe'; }, TypeError);
  const output = await finish(t, child);
  const match = output.match(/HCC_DATA:(\{[^\r\n]+\})/);
  assert.ok(match, output);
  assert.deepEqual(JSON.parse(match[1]), { cwd, args, tty: true, size: [83, 27] });
  assert.equal(child.poll().exitCode, 0);
  assert.equal(child.imagePath, imagePath);
  child.close();
});

test('ConPTY input, resize and control-C operate on its owned terminal', windows, async t => {
  const cwd = fixture(t);
  const code = `process.stdin.setRawMode(true);process.stdin.resume();console.log('READY');
    process.stdin.on('data',data=>{if(data[0]===3){console.log('STOP');process.exit(0)}
      const out=new (require('node:tty').WriteStream)(1);
      console.log('INPUT:'+data.toString()+':'+out.columns+','+out.rows)});`;
  const child = start(t, cwd, ['-e', code]);
  await until(t, child, text => text.includes('READY'));
  child.resize(101, 31);
  await until(t, child, text => text.includes('\x1b[8;31;101t'));
  assert.equal(child.writeStdin(Buffer.from('hello')), true);
  const output = await until(t, child, text => text.includes('INPUT:hello:101,31'));
  assert.match(output, /INPUT:hello:101,31/);
  assert.equal(child.writeStdin(Buffer.from([3])), true);
  assert.match(await finish(t, child), /STOP/);
  child.close();
});

test('silent ConPTY kill confirms Job descendants and output closure without first data', windows, async t => {
  const cwd = fixture(t), child = start(t, cwd, ['-e', 'setInterval(()=>{},1000)']);
  child.terminate();
  await finish(t, child);
  // Attach/resize can race the final output drain after root exit. That
  // completed terminal must retain its successful exit receipt.
  assert.doesNotThrow(() => child.resize(100, 30));
  assert.throws(() => child.resize(0, 30));
  assert.equal(child.poll().activeProcesses, 0);
  assert.equal(child.poll().ptyClosed, true);
  child.close();
});

test('ConPTY closes while draining large final output and rejects invalid dimensions before spawn', windows, async t => {
  const cwd = fixture(t);
  const child = start(t, cwd, ['-e', 'process.stdout.write("x".repeat(300000),()=>console.log("ENDMARK"));']);
  const output = await finish(t, child);
  assert.match(output, /ENDMARK/);
  assert.ok(output.length >= 300000);
  child.close();
  const native = loadWindowsNative(), lease = native.captureDirectory(cwd);
  try {
    for (const value of [0, -1, 32768, 1.5, '80']) {
      assert.throws(() => native.startOwnedPty({ file: process.execPath, args: [], cwd, env: process.env, lease, cols: value, rows: 25 }));
      assert.throws(() => child.resize(value, 25));
    }
    assert.throws(() => native.startOwnedPty({ file: process.execPath, args: [], cwd, env: process.env, cols: 80, rows: 25 }));
  } finally { lease.close(); }
});
