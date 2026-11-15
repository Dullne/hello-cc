import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { ensureSelfSignedCert, opensslAvailable } from '../lib/web/tls.mjs';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';

const windows = process.platform === 'win32';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.homedir(), 'hcc-win-tls-'));
  const old = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test('Windows TLS generates a private stable certificate and serves verified HTTPS', { skip: !windows }, async t => {
  const home = fixture(t);
  assert.equal(opensslAvailable(), true);
  const first = ensureSelfSignedCert(['test.example']);
  assert.equal(new X509Certificate(first.cert).checkHost('test.example'), 'test.example');
  assert.equal(ensureSelfSignedCert(['test.example']).cert, first.cert);
  for (const filename of [first.certPath, path.join(path.dirname(first.certPath), 'self-signed.key'),
    path.join(home, '.hello-cc', 'tls', 'current.json')]) {
    assert.equal(loadWindowsNative().inspectPathSecurity(filename).private, true);
  }
  const server = https.createServer({ key: first.key, cert: first.cert }, (_, res) => res.end('tls-ok'));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const body = await new Promise((resolve, reject) => {
      const req = https.get({ hostname: '127.0.0.1', port: server.address().port, ca: first.cert }, res => {
        let data = ''; res.on('data', b => { data += b; }); res.on('end', () => resolve(data));
      }); req.on('error', reject);
    });
    assert.equal(body, 'tls-ok');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Windows TLS rotates when a required SAN changes and rejects invalid host syntax', { skip: !windows }, t => {
  fixture(t);
  const before = ensureSelfSignedCert();
  const after = ensureSelfSignedCert(['new.example']);
  assert.notEqual(after.cert, before.cert);
  assert.equal(new X509Certificate(after.cert).checkHost('new.example'), 'new.example');
  assert.throws(() => ensureSelfSignedCert(['good.example,DNS:injected.example']), /host|SAN/i);
});

test('Windows TLS refuses public credentials without repairing or replacing them', { skip: !windows }, t => {
  fixture(t); const credentials = ensureSelfSignedCert();
  const key = path.join(path.dirname(credentials.certPath), 'self-signed.key');
  const before = fs.readFileSync(key);
  const result = spawnSync('icacls.exe', [key, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
  assert.equal(result.status, 0);
  assert.throws(() => ensureSelfSignedCert(), { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.deepEqual(fs.readFileSync(key), before);
});

test('Windows TLS refuses a redirected generation', { skip: !windows }, t => {
  fixture(t); const credentials = ensureSelfSignedCert();
  const generation = path.dirname(credentials.certPath);
  fs.renameSync(generation, generation + '-original');
  fs.symlinkSync(generation + '-original', generation, 'junction');
  assert.throws(() => ensureSelfSignedCert());
});

for (const rotation of [false, true]) test(`Windows TLS concurrent ${rotation ? 'rotation' : 'first start'} publishes one stable trust identity`, { skip: !windows, timeout: 30000 }, async t => {
  fixture(t);
  if (rotation) ensureSelfSignedCert();
  const hosts = rotation ? ['rotation.example'] : [];
  const script = `import {ensureSelfSignedCert} from ${JSON.stringify(new URL('../lib/web/tls.mjs', import.meta.url).href)};
    console.log(JSON.stringify({cert:ensureSelfSignedCert(${JSON.stringify(hosts)}).cert}));`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, windowsHide: true });
    let output = '', errors = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('TLS child timed out')); }, 20000);
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { errors += b; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer);
      if (code) reject(new Error(errors)); else { try { resolve(JSON.parse(output).cert); } catch (e) { reject(e); } }
    });
  });
  const certs = await Promise.all(Array.from({ length: 8 }, run));
  assert.equal(new Set(certs).size, 1);
  assert.equal(ensureSelfSignedCert(hosts).cert, certs[0]);
});

function publicationProbe(t, action) {
  fixture(t);
  const module = new URL('../lib/platform/windows-private-state.mjs', import.meta.url).href;
  const tls = new URL('../lib/web/tls.mjs', import.meta.url).href;
  const script = `import fs from 'node:fs'; import path from 'node:path'; import {spawnSync} from 'node:child_process'; import {registerHooks} from 'node:module';
    const target=${JSON.stringify(module)};
    registerHooks({load(url,context,next){ if(url!==target)return next(url,context); return {format:'module',shortCircuit:true,source:
      'export * from '+JSON.stringify(target+'?original')+'; import * as actual from '+JSON.stringify(target+'?original')+'; export function publishWindowsPrivateManifest(...args){globalThis.beforePointer?.(...args);return actual.publishWindowsPrivateManifest(...args);}'}; }});
    const {ensureSelfSignedCert}=await import(${JSON.stringify(tls)});
    let attempted=false, blocked=false;
    globalThis.beforePointer=(file,contents)=>{ if(path.basename(file)!=='current.json')return;
      attempted=true; const key=path.join(path.dirname(file),contents.generation,'self-signed.key');
      ${action}
    };
    try {const result=ensureSelfSignedCert(); const key=path.join(path.dirname(result.certPath),'self-signed.key');
      console.log(JSON.stringify({ok:true,attempted,blocked,nlink:fs.statSync(key).nlink}));}
    catch(e){console.log(JSON.stringify({ok:false,attempted,blocked,code:e.code}));}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HCC_SKIP_SHIM_INSTALL: '1' }, encoding: 'utf8', windowsHide: true, timeout: 15000
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('Windows TLS retains immutable key and certificate objects through pointer publication', { skip: !windows }, t => {
  const result = publicationProbe(t, `const alias=path.join(process.env.USERPROFILE,'alias'); fs.copyFileSync(key,alias);
    let denials=0;
    try {fs.unlinkSync(key); fs.linkSync(alias,key);} catch {denials++;}
    try {fs.writeFileSync(key,'changed key');} catch {denials++;}
    try {fs.writeFileSync(path.join(path.dirname(key),'self-signed.crt'),'changed cert');} catch {denials++;}
    blocked=denials===3;`);
  assert.equal(result.attempted, true); assert.equal(result.blocked, true);
  assert.equal(result.ok, true); assert.equal(result.nlink, 1);
});

test('Windows TLS rejects private-key permission drift at publication', { skip: !windows }, t => {
  const result = publicationProbe(t, `const changed=spawnSync('icacls.exe',[key,'/grant','*S-1-1-0:(R)'],{windowsHide:true});
    if(changed.status!==0)throw new Error('ACL fixture failed');`);
  assert.equal(result.attempted, true); assert.equal(result.ok, false);
  assert.ok(['PROJECT_PATH_FORBIDDEN', 'PROJECT_FILE_CHANGED', 'TLS_PUBLICATION_UNCONFIRMED'].includes(result.code));
});

test('Windows TLS reuses a valid certificate without OpenSSL and requires it only for rotation', { skip: !windows }, t => {
  const home = fixture(t), first = ensureSelfSignedCert(['reuse.example']);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = home;
    assert.equal(opensslAvailable(), false);
    assert.equal(ensureSelfSignedCert(['reuse.example']).cert, first.cert);
    assert.throws(() => ensureSelfSignedCert(['rotation.example']), { code: 'TLS_UNAVAILABLE' });
    assert.equal(ensureSelfSignedCert(['reuse.example']).cert, first.cert);
  } finally { process.env.PATH = previousPath; }
});

test('Windows TLS rejects in-place tampering between file publication and immutable-reader acquisition', { skip: !windows }, t => {
  fixture(t);
  const module = new URL('../lib/platform/windows-filesystem.mjs', import.meta.url).href;
  const tls = new URL('../lib/web/tls.mjs', import.meta.url).href;
  const script = `import fs from 'node:fs'; import path from 'node:path'; import {registerHooks} from 'node:module';
    const target=${JSON.stringify(module)};
    registerHooks({load(url,context,next){ if(url!==target)return next(url,context); return {format:'module',shortCircuit:true,source:
      'import * as actual from '+JSON.stringify(target+'?original')+'; export const inspectDirectory=actual.inspectDirectory;' +
      'function wrap(value){const result={};for(const key of Object.getOwnPropertyNames(value)){const entry=value[key]; if(typeof entry!=="function"){result[key]=entry;continue;} result[key]=(...args)=>{const out=entry.apply(value,args); if(key==="publish")globalThis.afterNativePublish?.(value.snapshot().canonical,args[0]); return key==="openDirectory"?wrap(out):out;};}return result;}' +
      'export function captureDirectory(...args){return wrap(actual.captureDirectory(...args));}'}; }});
    let modified=false;
    globalThis.afterNativePublish=(directory,name)=>{if(name==='self-signed.key'){fs.writeFileSync(path.join(directory,name),'corrupted before immutable open');modified=true;}};
    const {ensureSelfSignedCert}=await import(${JSON.stringify(tls)});
    try{ensureSelfSignedCert();console.log(JSON.stringify({ok:true,modified}));}
    catch(e){console.log(JSON.stringify({ok:false,modified,code:e.code,pointerExists:fs.existsSync(path.join(process.env.USERPROFILE,'.hello-cc','tls','current.json'))}));}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HCC_SKIP_SHIM_INSTALL: '1' }, encoding: 'utf8', windowsHide: true, timeout: 15000
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.modified, true); assert.equal(output.ok, false); assert.equal(output.pointerExists, false);
});
