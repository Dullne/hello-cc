import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Read-only HTTP acceptance of a real isolated official dsh Web service.
// Only this script's owned wrapper/process group is stopped during cleanup.
const installPath = process.argv[2];
const mode = process.argv[3] || 'hooks';
if (!['hooks', 'cordis'].includes(mode)) throw new Error('Mode must be hooks or cordis');
if (!installPath) throw new Error('Usage: node scripts/dsh-web-startup-acceptance.mjs /absolute/path/to/isolated-dsh-install');
const resolveOfficial = createRequire(path.join(path.resolve(installPath), 'package.json'));
const manifest = JSON.parse(fs.readFileSync(resolveOfficial.resolve('@deepseek-ai/dsh/package.json'), 'utf8'));
if (manifest.version !== '0.2.0-rc.2') throw new Error('Acceptance requires @deepseek-ai/dsh@0.2.0-rc.2');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'hcc-dsh-web-startup-'));
const project=path.join(sandbox,'project with spaces');
const isolatedHome=path.join(sandbox,'isolated-home');
fs.mkdirSync(project,{recursive:true});fs.mkdirSync(isolatedHome,{recursive:true});
const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const officialBin=resolveOfficial.resolve('@deepseek-ai/dsh/lib/bin.js');
const env={HOME:isolatedHome,DSH_HOME:path.join(isolatedHome,'dsh'),DSH_TELEMETRY_DISABLED:'1',PATH:path.dirname(process.execPath)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C',LC_ALL:'C',SHELL:'/bin/bash'};
const args=[path.join(repo,'bin/hcc.mjs'),'--root',project,'dsh','web','--mode',mode,'--dsh-bin',officialBin,'--dsh-home',env.DSH_HOME,'--','--host','127.0.0.1','--port',String(port),'--no-open'];
let stdout='',stderr='',exitCode=null,exitSignal=null,exited=false;
const child=spawn(process.execPath,args,{cwd:project,env,stdio:['ignore','pipe','pipe'],detached:true});
const ended=new Promise(resolve=>child.once('close',(code,signal)=>{exitCode=code;exitSignal=signal;exited=true;resolve();}));
child.stdout.on('data',chunk=>{stdout+=chunk;fs.appendFileSync(path.join(sandbox,'stdout.log'),chunk);});
child.stderr.on('data',chunk=>{stderr+=chunk;fs.appendFileSync(path.join(sandbox,'stderr.log'),chunk);});
const url=`http://127.0.0.1:${port}`;
const receipt={sandbox,project,mode,officialVersion:'0.2.0-rc.2',url,wrapperPid:child.pid,command:args,ready:false,port};
let html='';
try {
 const until=Date.now()+40000;
 while(Date.now()<until&&!exited) {
  try {
   let cookie='';
   let res=await fetch(url,{signal:AbortSignal.timeout(1000),redirect:'manual'});
   receipt.unauthenticatedStatus=res.status;
   await res.text();
   const launchUrl=stdout.match(/dsh web: (http:\/\/[^\s]+)/)?.[1];
   if(res.status===401&&launchUrl&&new URL(launchUrl).origin===url) {
    const login=await fetch(launchUrl,{signal:AbortSignal.timeout(1000),redirect:'manual'});
    receipt.loginStatus=login.status;
    cookie=login.headers.get('set-cookie')?.split(';')[0]||'';
    await login.text();
    receipt.cookieIssued=Boolean(cookie);
    res=await fetch(url,{headers:{cookie},signal:AbortSignal.timeout(1000),redirect:'manual'});
   }
   html=await res.text();
   if(res.status===200){
    receipt.httpStatus=res.status;receipt.title=html.match(/<title>([^<]*)<\/title>/)?.[1]||'';
    receipt.hasBootstrap=html.includes('__DSH_BOOT__');receipt.htmlBytes=Buffer.byteLength(html);
    const assets=[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match=>match[1].replaceAll('&amp;','&'));
    receipt.scriptAssets=[];
    for(const asset of assets){
     const assetUrl=new URL(asset,url+'/');
     if(assetUrl.origin===url){
      const assetRes=await fetch(assetUrl,{headers:{cookie},signal:AbortSignal.timeout(2000)});
      receipt.scriptAssets.push({path:assetUrl.pathname,status:assetRes.status,bytes:(await assetRes.arrayBuffer()).byteLength});
     }
    }
    receipt.ready=receipt.hasBootstrap&&receipt.scriptAssets.length>0&&receipt.scriptAssets.every(asset=>asset.status===200);break;
   }
   receipt.lastHttpStatus=res.status;
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 if(receipt.ready){await new Promise(resolve=>setTimeout(resolve,1200));receipt.remainedRunning=!exited;receipt.ready=receipt.ready&&receipt.remainedRunning;}
} finally {
 if(!exited){child.kill('SIGTERM');await Promise.race([ended,new Promise(resolve=>setTimeout(resolve,5000))]);}
 if(!exited){try{process.kill(-child.pid,'SIGKILL');}catch{} await ended;}
 receipt.exitCode=exitCode;receipt.exitSignal=exitSignal;
 receipt.cleanedUp=exited;
 receipt.stderrBytes=Buffer.byteLength(stderr);
 receipt.meshDbCreated=fs.existsSync(path.join(project,'.hello-cc','mesh.db'));
 try{await fetch(url,{signal:AbortSignal.timeout(500)});receipt.portClosed=false;}catch{receipt.portClosed=true;}
 fs.writeFileSync(path.join(sandbox,'stdout.log'),stdout);fs.writeFileSync(path.join(sandbox,'stderr.log'),stderr);fs.writeFileSync(path.join(sandbox,'page.html'),html);fs.writeFileSync(path.join(sandbox,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify(receipt,null,2));
 if(!receipt.ready||!receipt.portClosed){
  process.exitCode=1;
  console.error(stderr.slice(-10000)||'Official dsh Web readiness or cleanup did not pass; see the saved receipt and logs.');
 }
}
