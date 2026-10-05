// Opt-in acceptance of a locally installed HCC package through its public CLI.
// All projects, provider homes and processes are test-owned. No package install
// or publication occurs here; --run-live uses existing provider authentication.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeRequest } from '../lib/runtime/native/client.mjs';
import { readNativePointer, nativePaths } from '../lib/runtime/native/store.mjs';
import { stabilityOptions, assertStabilityEvidence, stabilityPayload } from './native-stability-checks.mjs';
import { redactSecrets } from '../lib/shared/redact.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (!args.includes('--run-live')) {
  console.log('Usage: node scripts/native-installed-acceptance.mjs --run-live --codex-bin PATH --dsh-bin PATH [--archive FILE] [--browser] [--task] [--stability [--stability-only]] [--output FILE]');
  console.log('Install the HCC archive and optional Claude SDK first. Browser checks need HCC_ACCEPTANCE_PLAYWRIGHT; models consume existing provider quota.');
  process.exit(0);
}
const stabilityConfig = stabilityOptions(args);
const stabilityOnly = args.includes('--stability-only');
const repo = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const cli = path.join(repo, 'bin/hcc.mjs');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function sourceHashes(dir = path.join(repo, 'lib')) {
  return Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(sourceHashes(file)) : entry.name.endsWith('.mjs') ? [[path.relative(repo, file), digest(file)]] : [];
  }));
}
const initialSources = sourceHashes();
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-installed-native-')));
fs.chmodSync(sandbox, 0o700);
const root = path.join(sandbox, 'project');
const ctx = { root, cwd: root, dbPath: path.join(root, '.hello-cc/mesh.db') };
const output = path.resolve(option('--output', path.join(sandbox, 'receipt.json')));
const report = { startedAt: new Date().toISOString(), scope: 'installed public CLI, authenticated lifecycle, cross-provider messages, optional browser, bounded coding task and opt-in sustained stability',
  package: { directory: repo, version: JSON.parse(fs.readFileSync(path.join(repo, 'package.json'))).version,
    ...(option('--archive') ? { archiveSha256: digest(path.resolve(option('--archive'))) } : {}) },
  node: process.version, sandbox, providers: {}, checks: [], cleanup: {}, sourceFiles: initialSources,
  acceptanceMode: stabilityOnly ? 'stability-only' : 'full', factoryInjected: false, queryInjected: false, authentication: 'existing route copied into test-owned private homes', screenshots: [], pageErrors: [], consoleErrors: [], limitations: [] };
const credentials = [];
const originalCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const protectedFiles = ['config.toml', 'auth.json'].map(name => path.join(originalCodexHome, name)).filter(file => fs.existsSync(file));
const protectedHashes = protectedFiles.map(file => [file, digest(file)]);
let env, db, browser, runtimeStarted = false, webStarted = false;
const homes = {};
const binaries = { codex: option('--codex-bin', '/opt/homebrew/bin/codex'), dsh: option('--dsh-bin', 'dsh') };
const tmux = process.env.HCC_ACCEPTANCE_TMUX || '/opt/homebrew/bin/tmux';
const socket = `hcc-installed-${randomUUID()}`;
const terminal = new Set(['completed', 'failed', 'uncertain']);
function check(name, details = {}) { report.checks.push({ name, passed: true, ...details }); console.log(JSON.stringify({ check: name, ...details })); }
function flush() { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(redactSecrets(report), null, 2) + '\n', { mode: 0o600 }); }
function privateDir(name) { const dir = path.join(sandbox, name); credentials.push(dir); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
function hcc(...params) {
  const result = spawnSync(process.execPath, [cli, '--root', root, '--json', ...params], { cwd: root, env, encoding: 'utf8', timeout: 45000 });
  if (result.status !== 0) throw new Error(`Installed CLI ${params.slice(0, 2).join(' ')} failed: ${redactSecrets(result.stderr || result.stdout)}`);
  if (!result.stdout.trim()) return null;
  if (params[0] !== 'native') return { output: result.stdout.trim() };
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.ok, true, 'CLI response must confirm success');
  return reply.data;
}
const api = (method, route, body = null) => nativeRequest(ctx, method, route, body, { timeoutMs: 45000 });
const observedEvents = new Map();
const eventCursors = new Map();
async function state(peer) {
  const current = await api('GET', `/workers/${encodeURIComponent(peer)}/state?after=${eventCursors.get(peer) || 0}`);
  const collected = [...(observedEvents.get(peer) || []), ...current.events].slice(-500);
  if (current.events.length) eventCursors.set(peer, current.events.at(-1).id);
  observedEvents.set(peer, collected);
  return { ...current, events: collected };
}
async function until(predicate, label, timeoutMs = 150000) {
  const deadline = Date.now() + timeoutMs; let nextNotice = Date.now() + 25000;
  while (Date.now() < deadline) {
    const result = await predicate(); if (result) return result;
    if (Date.now() >= nextNotice) { console.log(JSON.stringify({ waiting: label })); nextNotice += 25000; }
    await delay(150);
  }
  throw new Error(`Timed out: ${label}`);
}
function message(peer, body, from = 'acceptance-local') {
  report.providers[peer.slice(8)].userSubmissions++;
  return hcc('native', 'send', '--peer', peer, '--from', from, '--body', body);
}
async function finish(peer, sent, handleApproval) {
  const receipt = await until(async () => {
    const current = await state(peer);
    for (const request of current.snapshot.pendingApprovals || []) {
      assert.ok(handleApproval, `Unexpected approval ${request.method}`);
      await handleApproval(request, current);
    }
    const row = current.deliveries.find(value => value.message_id === sent.message_id);
    return terminal.has(row?.state) ? row : null;
  }, `${peer} message ${sent.message_id}`);
  assert.equal(receipt.state, 'completed', JSON.stringify(redactSecrets(receipt.detail || receipt.evidence || receipt)));
  const reply = db.prepare("SELECT * FROM messages WHERE reply_to=? AND kind='reply'").get(sent.message_id);
  assert.ok(reply, 'successful request must write a reply');
  assert.equal(reply.thread_id, sent.message_id);
  assert.ok(db.prepare('SELECT read_at FROM message_reads WHERE peer=? AND message_id=?').get(peer, sent.message_id));
  return { receipt, reply };
}
function respond(peer, request, decision = 'decline') {
  return hcc('native', 'respond', '--peer', peer, '--request', String(request.requestId), '--decision', decision);
}
async function start(provider, resume = false) {
  return hcc('native', 'start', '--peer', `install-${provider}`, '--provider', provider,
    ...(provider === 'claude' ? [] : ['--binary', binaries[provider]]), ...(resume ? ['--resume', 'last'] : []));
}
async function lifecycle(provider) {
  const peer = `install-${provider}`;
  const result = report.providers[provider] = { status: 'running', userSubmissions: 0, launcher: 'installed public hcc native start CLI' };
  await start(provider);
  result.version = provider === 'claude' ? report.claudeSdk.version : execFileSync(binaries[provider], ['--version'], { env, encoding: 'utf8', timeout: 10000 }).trim();
  const nonce = `HCC_INSTALLED_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const body = `Remember ${nonce} in this conversation. Reply with only ${nonce}. Do not use tools or read files.`;
  const first = message(peer, body);
  const duplicate = await api('POST', '/send', { peer, from: 'acceptance-local', body, submissionId: first.submission_id });
  assert.equal(duplicate.message_id, first.message_id);
  assert.equal((await finish(peer, first)).reply.body.trim(), nonce);
  result.sessionId = (await state(peer)).snapshot.sessionId; assert.ok(result.sessionId);
  check(`${provider}: installed CLI real reply, correlation, ACK, submission deduplication`);
  const second = message(peer, 'Without tools, return only the full original test marker from the earlier conversation, including its HCC_INSTALLED_ prefix and the original hexadecimal suffix.');
  assert.equal((await finish(peer, second)).reply.body.trim(), nonce);
  check(`${provider}: continuing turn retains context`);
  hcc('native', 'close', '--peer', peer); await start(provider, true);
  const resumed = message(peer, 'Without tools, return only the full original test marker from the earlier conversation, including its HCC_INSTALLED_ prefix and the original hexadecimal suffix.');
  assert.equal((await finish(peer, resumed)).reply.body.trim(), nonce);
  assert.equal((await state(peer)).snapshot.sessionId, result.sessionId);
  check(`${provider}: installed close/resume retains session identity and history`);
  const long = message(peer, 'No tools. Immediately write the numbers 1 through 100000, one per line. Continue until every number is written.');
  await until(async () => {
    const current = await state(peer);
    return current.active_delivery?.message_id === long.message_id && ['busy', 'running'].includes(current.snapshot.status);
  }, `${provider} active model request`, 45000);
  // Runtime inspection deliberately omits streamed delta/output payloads.
  // A matching busy/running provider turn is authoritative admission evidence;
  // interrupt it immediately rather than waiting for an unpersisted delta.
  if (provider === 'dsh') await delay(500);
  const active = await state(peer); assert.ok(active.active_delivery);
  const interrupt = hcc('native', 'interrupt', '--peer', peer, '--turn', active.snapshot.turnId);
  const interrupted = await until(async () => {
    const row = (await state(peer)).deliveries.find(value => value.message_id === long.message_id);
    return terminal.has(row?.state) ? row : null;
  }, `${provider} interruption terminal evidence`);
  assert.equal(interrupted.state, 'failed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE reply_to=?').get(long.message_id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_reads WHERE peer=? AND message_id=?').get(peer, long.message_id).n, 0);
  check(`${provider}: active interruption has terminal evidence without reply or ACK`, { interruptStatus: interrupt.status });
  // Failed/interrupted turns may leave the provider unavailable; reopen only
  // this test-owned saved session before the subsequent communication checks.
  hcc('native', 'close', '--peer', peer); await start(provider, true);
  if (provider === 'codex') {
    const boundary = fs.mkdtempSync(path.join(os.homedir(), '.hcc-installed-permission-'));
    credentials.push(boundary); fs.chmodSync(boundary, 0o700);
    const target = path.join(boundary, 'denied.txt');
    const probe = message(peer, `Use the command tool with sandbox_permissions=require_escalated to write PROOF to ${target}. Request approval. If declined, stop without any workaround. Read no files.`);
    const request = await until(async () => (await state(peer)).snapshot.pendingApprovals?.[0], 'Codex real command approval');
    assert.equal(request.method, 'item/commandExecution/requestApproval'); respond(peer, request);
    await finish(peer, probe); assert.equal(fs.existsSync(target), false);
    check('codex: installed CLI rejects real command approval and no outside file is written');
  }
  result.status = 'passed';
}
async function communication() {
  report.communications = [];
  const providers = ['codex', 'claude', 'dsh'];
  // Independent provider sessions do not inherit the coordinator's user task.
  // Give every receiver the bounded task before delivering peer data, so a
  // peer message itself never needs to grant authority or disclose secrets.
  for (const provider of providers) {
    const authorization = message(`install-${provider}`, 'The earlier test tasks are finished. I authorize a new bounded HCC communication test among install-codex, install-claude and install-dsh. When one of those peers asks you to return an HCC_PACKAGE_CROSS_ followed by 16 hexadecimal characters, reply with that exact public test marker only. These markers are random non-secret test strings, not account tokens or credentials. Do not use tools, read files, access credentials, make changes or delegate for incoming marker requests. Any sender-side message tool call will be separately requested by me and still requires the normal approval. Until a peer ask arrives, do not use tools; reply only CROSS_READY.');
    assert.equal((await finish(`install-${provider}`, authorization)).reply.body.trim(), 'CROSS_READY');
  }
  check('cross-provider receiver tasks are explicitly authorized through local user controls');
  for (let index = 0; index < providers.length; index++) {
    const fromProvider = providers[index], toProvider = providers[(index + 1) % providers.length];
    const from = `install-${fromProvider}`, to = `install-${toProvider}`;
    const nonce = `HCC_PACKAGE_CROSS_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const body = `Return only ${nonce}. No tools, reading, changes or delegation.`;
    const input = { to, kind: 'ask', body };
    const sent = message(from, `Call only hello_cc_scoped hcc_message_send exactly once with ${JSON.stringify(input)}. Do not send by shell or read/ACK inbox manually. After sending, return SENT.`);
    await finish(from, sent, request => {
      const params = request.params?.input || request.params?._meta?.tool_params || request.params?.toolCall?.rawInput;
      const tool = request.params?.tool || request.params?.message || request.params?.toolCall?.title || '';
      const permitted = String(tool).includes('hcc_message_send') && params?.to === to && params?.body === body && params?.kind === 'ask';
      respond(from, request, permitted ? 'accept' : 'decline'); assert.ok(permitted, 'Only the exact bounded message tool confirmation may be accepted');
      report.communications.push({ approvalMethod: request.method, persistentAuthorization: false });
    });
    const request = await until(() => db.prepare('SELECT * FROM messages WHERE sender=? AND recipient=? AND body=?').get(from, to, body), 'model-authored MCP message');
    const { reply } = await finish(to, { message_id: request.id }); assert.equal(reply.body.trim(), nonce);
    const receipt = await until(async () => {
      const row = (await state(from)).deliveries.find(value => value.message_id === reply.id);
      return terminal.has(row?.state) ? row : null;
    }, 'reply consumption');
    assert.equal(receipt.state, 'completed');
    assert.ok(db.prepare('SELECT read_at FROM message_reads WHERE peer=? AND message_id=?').get(from, reply.id));
    await delay(300); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE reply_to=?').get(reply.id).n, 0);
    report.communications.push({ fromProvider, toProvider, sentByModel: true, replyConsumed: true, noReplyLoop: true });
    check(`${fromProvider} -> ${toProvider}: installed model MCP send, reply, ACK, no loop`);
  }
}
async function stability() {
  const providers = ['codex', 'claude', 'dsh'];
  const begun = Date.now();
  const run = report.stability = { config: stabilityConfig, startedAt: new Date().toISOString(),
    completed: false, cycles: [], probes: [], recoveries: [], samples: [], failures: [], automaticReplay: false };
  const markers = new Map(), previous = new Map(), sessions = new Map();
  const observedPids = new Set();
  function sample(label) {
    const pointer = readNativePointer(ctx);
    assert.ok(pointer?.pid, 'stability runtime must remain available');
    const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8', timeout: 10000 });
    const rows = result.status === 0 ? result.stdout.split('\n').flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), executable: match[4] }] : [];
    }) : [];
    const owned = new Set([pointer.pid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
    }
    const processes = rows.filter(row => owned.has(row.pid));
    for (const row of processes) observedPids.add(row.pid);
    run.samples.push({ at: new Date().toISOString(), elapsedMs: Date.now() - begun, label,
      daemonPid: pointer.pid, generation: pointer.generation, processes,
      totalRssKiB: processes.reduce((total, row) => total + row.rssKiB, 0),
      resourceDataAvailable: result.status === 0,
      meshDbBytes: fs.statSync(ctx.dbPath).size, nativeDbBytes: fs.statSync(nativePaths(ctx).db).size });
    flush();
  }
  async function probe(provider, prompt, expected, kind) {
    const peer = `install-${provider}`;
    const item = { provider, kind, startedAt: new Date().toISOString(), expected, passed: false };
    run.probes.push(item); flush();
    try {
      const sent = message(peer, prompt); Object.assign(item, { messageId: sent.message_id, submissionId: sent.submission_id });
      const { receipt, reply } = await finish(peer, sent);
      const current = await state(peer);
      Object.assign(item, { state: receipt.state, actual: reply.body.trim(), replyId: reply.id,
        replyCount: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE reply_to=? AND kind='reply'").get(sent.message_id).n,
        ackCount: db.prepare('SELECT COUNT(*) AS n FROM message_reads WHERE peer=? AND message_id=?').get(peer, sent.message_id).n,
        replyThread: reply.thread_id, sessionId: current.snapshot.sessionId, owner: current.owner, turnId: receipt.turn_id });
      item.contextPayload = stabilityPayload(item.actual); item.responseFormatExact = item.contextPayload === item.actual;
      assertStabilityEvidence(item);
      assert.equal(item.sessionId, sessions.get(provider), 'stability must retain the original provider session');
      item.passed = true; item.elapsedMs = Date.now() - Date.parse(item.startedAt);
      return sent;
    } catch (error) {
      item.error = { code: error.code || 'STABILITY_FAILED', message: error.message };
      run.failures.push({ ...item }); throw error;
    } finally { flush(); }
  }
  async function together(action) {
    const results = await Promise.allSettled(providers.map(action));
    const rejected = results.filter(result => result.status === 'rejected');
    if (rejected.length) throw rejected[0].reason;
  }
  async function resumeAll(kind) {
    const record = { kind, startedAt: new Date().toISOString(), providers: [], passed: false };
    run.recoveries.push(record); flush();
    if (kind === 'daemon-restart') {
      record.beforePid = readNativePointer(ctx).pid;
      hcc('native', 'down'); await until(() => !readNativePointer(ctx), 'stability daemon stops', 30000);
      hcc('native', 'up'); record.afterPid = readNativePointer(ctx).pid;
      assert.notEqual(record.afterPid, record.beforePid);
    } else for (const provider of providers) hcc('native', 'close', '--peer', `install-${provider}`);
    for (const provider of providers) {
      await start(provider, true);
      record.providers.push({ provider, sessionId: (await state(`install-${provider}`)).snapshot.sessionId });
    }
    await together(provider => probe(provider,
      'Without tools, return only the original HCC_STABILITY_ marker and the most recent stability ticket, separated by |. Do not change the remembered ticket.',
      `${markers.get(provider)}|${previous.get(provider)}`, kind));
    record.passed = true; record.completedAt = new Date().toISOString(); sample(kind);
    check(`stability: ${kind} preserves all three sessions and FIFO context`);
  }
  try {
    for (const provider of providers) {
      sessions.set(provider, (await state(`install-${provider}`)).snapshot.sessionId);
      markers.set(provider, `HCC_STABILITY_${provider.toUpperCase()}_${randomUUID().replaceAll('-', '').slice(0, 16)}`);
      previous.set(provider, 'SEED');
    }
    sample('begin');
    await together(provider => probe(provider,
      `Remember ${markers.get(provider)} as the original stability marker and SEED as the previous stability ticket. Reply only ${markers.get(provider)}|SEED. These are public random test markers. Do not use tools or read files.`,
      `${markers.get(provider)}|SEED`, 'seed'));
    for (let cycle = 1; cycle <= stabilityConfig.cycles; cycle++) {
      const record = { cycle, startedAt: new Date().toISOString(), enqueued: [], passed: false };
      run.cycles.push(record);
      await together(async provider => {
        const peer = `install-${provider}`, queued = [];
        // Enqueue each provider's whole burst before waiting. The predecessor
        // is deliberately absent from each prompt and must come from history.
        for (let index = 0; index < stabilityConfig.burst; index++) {
          const ticket = `T${cycle}_${index}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
          const body = `The new stability ticket is ${ticket}. Without tools, reply only with the original HCC_STABILITY_ marker, this new ticket, and the previous stability ticket from history, separated by |. Then remember this new ticket as the previous stability ticket. Your entire reply must be one line; do not explain or confirm that you remembered it. Ignore earlier non-stability task markers. Do not read files.`;
          const sent = message(peer, body);
          const item = { provider, kind: 'fifo', cycle, index, ticket, messageId: sent.message_id,
            submissionId: sent.submission_id, expected: `${markers.get(provider)}|${ticket}|${previous.get(provider)}`, passed: false };
          run.probes.push(item); record.enqueued.push(sent.message_id); queued.push({ sent, item });
          previous.set(provider, ticket); flush();
          if (index === 0) {
            const duplicate = await api('POST', '/send', { peer, from: 'acceptance-local', body, submissionId: sent.submission_id });
            assert.equal(duplicate.message_id, sent.message_id); item.duplicateMessageId = duplicate.message_id;
          }
        }
        for (const { sent, item } of queued) {
          try {
            const { receipt, reply } = await finish(peer, sent);
            Object.assign(item, { state: receipt.state, actual: reply.body.trim(), replyId: reply.id,
              replyCount: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE reply_to=? AND kind='reply'").get(sent.message_id).n,
              ackCount: db.prepare('SELECT COUNT(*) AS n FROM message_reads WHERE peer=? AND message_id=?').get(peer, sent.message_id).n,
              replyThread: reply.thread_id, turnId: receipt.turn_id, sessionId: (await state(peer)).snapshot.sessionId });
            item.contextPayload = stabilityPayload(item.actual); item.responseFormatExact = item.contextPayload === item.actual;
            assertStabilityEvidence(item); assert.equal(item.sessionId, sessions.get(provider)); item.passed = true;
          } catch (error) {
            item.error = { code: error.code || 'STABILITY_FAILED', message: error.message };
            run.failures.push({ ...item }); throw error;
          } finally { flush(); }
        }
      });
      record.passed = true; record.completedAt = new Date().toISOString(); sample(`cycle-${cycle}`);
      check(`stability: cycle ${cycle} completes ${providers.length * stabilityConfig.burst} queued turns in order with one reply/ACK each`);
      if (cycle % stabilityConfig.resumeEvery === 0) await resumeAll('worker-close-resume');
      if (cycle === Math.ceil(stabilityConfig.cycles / 2)) await resumeAll('daemon-restart');
      const idleUntil = Date.now() + stabilityConfig.idleMs;
      while (Date.now() < idleUntil) {
        await delay(Math.min(10000, idleUntil - Date.now()));
        for (const provider of providers) {
          const current = await state(`install-${provider}`);
          assert.equal(current.snapshot.sessionId, sessions.get(provider)); assert.equal(current.active_delivery, null);
          assert.equal(current.snapshot.pendingApprovals?.length || 0, 0);
        }
        sample(`cycle-${cycle}-idle`);
      }
    }
    const nativeDb = new DatabaseSync(nativePaths(ctx).db, { readOnly: true });
    try {
      run.databaseAudit = {
        meshQuickCheck: db.prepare('PRAGMA quick_check').get().quick_check,
        nativeQuickCheck: nativeDb.prepare('PRAGMA quick_check').get().quick_check,
        eventRows: nativeDb.prepare('SELECT COUNT(*) AS n FROM provider_events').get().n,
        unfinished: nativeDb.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state NOT IN ('completed','failed','uncertain')").get().n
      };
      assert.equal(run.databaseAudit.meshQuickCheck, 'ok'); assert.equal(run.databaseAudit.nativeQuickCheck, 'ok');
      assert.ok(run.databaseAudit.eventRows <= 2001, 'persisted diagnostic events must stay bounded');
      assert.equal(run.databaseAudit.unfinished, 0);
      for (const item of run.probes) {
        const delivery = nativeDb.prepare('SELECT * FROM deliveries WHERE peer=? AND message_id=?').get(`install-${item.provider}`, item.messageId);
        assert.equal(delivery?.state, 'completed'); assert.equal(delivery.submission_id, item.submissionId);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE reply_to=? AND kind='reply'").get(item.replyId).n, 0, 'no automatic reply loop');
      }
    } finally { nativeDb.close(); }
    run.completed = true; check('stability: all persisted deliveries, database integrity, bounded events and no reply loops verified');
  } catch (error) {
    run.error = { code: error.code || 'STABILITY_FAILED', message: error.message };
    run.failureState = [];
    for (const provider of providers) {
      try {
        const current = await state(`install-${provider}`);
        run.failureState.push({ provider, snapshot: current.snapshot, activeDelivery: current.active_delivery,
          recentDeliveries: current.deliveries.slice(0, 8), recentEvents: current.events.slice(-16) });
      } catch (failure) { run.failureState.push({ provider, error: failure.message }); }
    }
    throw error;
  } finally {
    run.elapsedMs = Date.now() - begun; run.completedAt = new Date().toISOString(); run.observedOwnedPids = [...observedPids];
    report.limitations.push('Stability is a bounded authenticated workload and idle observation, not a 24-hour soak or a concurrency capacity benchmark. Resource samples are measurements, not proof of no leak.');
    flush();
  }
}

async function browserFlow() {
  assert.ok(process.env.HCC_ACCEPTANCE_PLAYWRIGHT, 'Set HCC_ACCEPTANCE_PLAYWRIGHT to the installed Playwright entry');
  hcc('up', '--no-discover', '--no-guidance');
  const port = await new Promise(resolve => { const listener = net.createServer(); listener.listen(0, '127.0.0.1', () => { const value = listener.address().port; listener.close(() => resolve(value)); }); });
  hcc('web', '--local', '--port', String(port), '--no-discover', '--no-guidance'); webStarted = true;
  const { chromium } = await import(process.env.HCC_ACCEPTANCE_PLAYWRIGHT);
  browser = await chromium.launch({ headless: true, ...(process.env.HCC_ACCEPTANCE_CHROME ? { executablePath: process.env.HCC_ACCEPTANCE_CHROME } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') report.consoleErrors.push(entry.text()); });
  page.on('dialog', dialog => dialog.accept());
  const url = `http://127.0.0.1:${port}`;
  await page.goto(url + '/?token=' + env.HCC_WEB_TOKEN);
  assert.deepEqual(report.pageErrors, [], 'Browser initialization must succeed');
  assert.deepEqual(report.consoleErrors, [], 'Installed browser assets must load');
  await page.waitForFunction(() => window.hccHandoff?.sessions?.some(value => value.type === 'native'));
  const title = await page.title(); assert.ok(/hello|hcc/i.test(title));
  assert.ok((await page.locator('body').innerText()).length > 100);
  const session = await page.evaluate(() => window.hccHandoff.sessions.find(value => value.type === 'native' && value.id === 'install-claude')?.id);
  assert.ok(session);
  if (await page.evaluate(() => window.hccHandoff.active) !== session) await page.locator(`#sessions [data-id="${session}"] .session-select`).click();
  await page.waitForFunction(id => window.hccHandoff?.session?.id === id && Boolean(window.hccHandoff.actionToken), session);
  if (!await page.evaluate(() => window.hccHandoff.canControl)) await page.locator('#claimControlBtn').click();
  await page.waitForFunction(() => window.hccHandoff.canControl);
  const identity = (await state('install-claude')).snapshot.sessionId;
  const target = path.join(root, 'web-proof.txt');
  const before = (await state('install-claude')).deliveries.map(value => value.message_id);
  await page.locator('#nativeDraft').fill(`Use Write to write exactly HCC_INSTALLED_WEB_OK to ${target}. Wait for permission. Do not use Bash or workaround. End with WEB_OK.`);
  await page.locator('#nativeSend').click(); report.providers.claude.userSubmissions++;
  const delivery = await until(async () => (await state('install-claude')).deliveries.find(value => !before.includes(value.message_id)), 'Web submission');
  const request = await until(async () => {
    const current = await state('install-claude');
    const approval = current.snapshot.pendingApprovals?.[0];
    if (approval) return approval;
    const row = current.deliveries.find(value => value.message_id === delivery.message_id);
    assert.ok(!terminal.has(row?.state), 'Web task finished without the required Write approval: ' + (db.prepare('SELECT body FROM messages WHERE reply_to=?').get(delivery.message_id)?.body || row?.detail || row?.state));
    return null;
  }, 'Web Write approval');
  assert.equal(request.method, 'claude/canUseTool'); assert.equal(request.params.tool, 'Write'); assert.equal(request.params.input.file_path, target);
  await page.locator('#nativeApprovals button[data-decision="accept"]').waitFor({ timeout: 15000 });
  const approvalShot = path.join(sandbox, 'web-approval.png'); await page.screenshot({ path: approvalShot }); report.screenshots.push(approvalShot);
  await page.locator('#nativeApprovals button[data-decision="accept"]').click();
  // A DOM click dispatches the async Web action; wait for the exact permission
  // request to be resolved before asserting that no further approvals remain.
  await until(async () => !(await state('install-claude')).snapshot.pendingApprovals?.some(value => value.requestId === request.requestId), 'Web approval response confirmation', 30000);
  await finish('install-claude', delivery);
  assert.equal(fs.readFileSync(target, 'utf8').trim(), 'HCC_INSTALLED_WEB_OK');
  assert.equal((await state('install-claude')).snapshot.sessionId, identity);
  await page.locator('#nativeRead').click();
  await page.waitForFunction(id => {
    const expected = '#' + id + ' · ' + window.hccHandoff.tr('native.delivery.completed', 'completed');
    return [...document.querySelectorAll('#nativeReceipts strong')].some(element => element.textContent.trim() === expected);
  }, delivery.message_id);
  const screenshot = path.join(sandbox, 'web-completed.png'); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileShot = path.join(sandbox, 'web-mobile.png'); await page.screenshot({ path: mobileShot }); report.screenshots.push(mobileShot);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#releaseControlBtn').click(); await page.waitForFunction(() => !window.hccHandoff.canControl);
  await browser.close(); browser = null;
  hcc('down'); webStarted = false;
  const followup = message('install-claude', 'Without tools, return only INSTALLED_LOCAL_RETURN_OK.');
  assert.equal((await finish('install-claude', followup)).reply.body.trim(), 'INSTALLED_LOCAL_RETURN_OK');
  assert.equal((await state('install-claude')).snapshot.sessionId, identity);
  assert.equal((await api('GET', '/status')).workers.filter(value => value.owned).length, 3);
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
  report.browser = { implementation: 'Browser plugin not available; installed Chrome with Playwright', url, title, viewports: ['1440x1000', '390x844'], realApproval: true, providerSessionRetained: true, independentWorkersSurviveWebShutdown: true };
  check('installed Web: actual message, Write approval, file result, receipts and local return on the same session');
}
async function codingTask() {
  const moduleFile = path.join(root, 'invoice.mjs');
  const testFile = path.join(root, 'invoice.test.mjs');
  fs.writeFileSync(testFile, `import { strict as assert } from 'node:assert';\nimport { test } from 'node:test';\nimport { invoiceTotal } from './invoice.mjs';\ntest('empty invoice', () => assert.deepEqual(invoiceTotal([], 0), { subtotalCents: 0, taxCents: 0, totalCents: 0 }));\ntest('multiple lines and tax rounding', () => assert.deepEqual(invoiceTotal([{ unitCents: 199, quantity: 3 }, { unitCents: 500, quantity: 2 }], 825), { subtotalCents: 1597, taxCents: 132, totalCents: 1729 }));\ntest('half-cent rounds up', () => assert.equal(invoiceTotal([{ unitCents: 1, quantity: 1 }], 5000).taxCents, 1));\ntest('reject fractional/negative values', () => { for (const line of [{unitCents: -1, quantity: 1}, {unitCents: 10, quantity: 0}, {unitCents: 1.5, quantity: 1}]) assert.throws(() => invoiceTotal([line], 0)); assert.throws(() => invoiceTotal([], 10001)); });\ntest('reject total overflow', () => assert.throws(() => invoiceTotal([{ unitCents: Number.MAX_SAFE_INTEGER, quantity: 2 }], 0)));\n`);
  const contractSha256 = digest(testFile);
  const spec = `Implement invoice.mjs exporting invoiceTotal(lines, taxBasisPoints). All money is integer cents. unitCents is a nonnegative safe integer, quantity a positive safe integer, taxBasisPoints an integer 0..10000. Throw on invalid inputs or safe-integer overflow. Return {subtotalCents,taxCents,totalCents}. Tax rounds the subtotal times basis points divided by 10000 to nearest cent, halves up; use exact integer arithmetic. Read invoice.test.mjs but do not modify it. Only write invoice.mjs using the file edit/apply_patch tool. If only a command tool is exposed, you may invoke apply_patch through it to create invoice.mjs; this is the only permitted write command. You may read invoice.test.mjs with a file read tool or one cat command; do not run tests or any other commands. End with IMPLEMENTED.`;
  const submitted = message('install-codex', spec);
  await finish('install-codex', submitted, request => {
    const files = request.params?.changes || request.params?.toolCall?.rawInput;
    const allowed = request.method === 'item/fileChange/requestApproval' && JSON.stringify(files || request.params).includes('invoice.mjs');
    respond('install-codex', request, allowed ? 'accept' : 'decline'); assert.ok(allowed, 'Unexpected implementation approval');
  });
  assert.ok(fs.existsSync(moduleFile));
  assert.equal(digest(testFile), contractSha256, 'Model must not change the independent contract tests');
  const test = spawnSync(process.execPath, ['--test', testFile], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  report.task = { name: 'bounded invoice implementation with independent contract tests and cross-provider review', firstTestExitCode: test.status, testLog: redactSecrets(test.stdout + test.stderr), changedFile: 'invoice.mjs', moduleSha256: digest(moduleFile) };
  assert.equal(test.status, 0, report.task.testLog);
  const reviewFile = path.join(root, 'review.json');
  const reviewBody = `Review invoice.mjs against invoice.test.mjs. Read only these project files. Use Write to create review.json with JSON {"passed":true,"reviewer":"claude","issues":[]} only if the arithmetic, validation, overflow and tests satisfy the contract; otherwise record passed:false and concrete issues. Do not modify implementation/tests or run commands. Return REVIEWED.`;
  const delegation = message('install-claude', `I authorize a bounded review task in this project. When install-codex asks you to review invoice.mjs against invoice.test.mjs, read those two files and write review.json only, waiting for explicit Write approval. Do not modify implementation/tests or run commands. Until the handoff arrives, do not use tools; reply only REVIEW_READY.`);
  assert.equal((await finish('install-claude', delegation)).reply.body.trim(), 'REVIEW_READY');
  const input = { to: 'install-claude', kind: 'ask', body: reviewBody };
  const handoff = message('install-codex', `Implementation is complete. Send it for independent review using only hello_cc_scoped hcc_message_send exactly once with ${JSON.stringify(input)}. Return REVIEW_SENT. No other tools.`);
  const allowedReview = request => {
    const target = typeof request.params?.input?.file_path === 'string' ? path.resolve(root, request.params.input.file_path) : null;
    const allowed = request.method === 'claude/canUseTool' && ((request.params.tool === 'Write' && target === reviewFile) || (request.params.tool === 'Read' && [moduleFile, testFile].includes(target)));
    respond('install-claude', request, allowed ? 'accept' : 'decline'); assert.ok(allowed, 'Only the two authorized Read paths and review.json Write may be accepted');
  };
  const handed = await until(async () => {
    for (const request of (await state('install-codex')).snapshot.pendingApprovals || []) {
      const values = request.params?.input || request.params?._meta?.tool_params || request.params?.toolCall?.rawInput;
      assert.deepEqual(values, input); respond('install-codex', request, 'accept');
    }
    for (const request of (await state('install-claude')).snapshot.pendingApprovals || []) allowedReview(request);
    return db.prepare('SELECT * FROM messages WHERE sender=? AND recipient=? AND body=?').get('install-codex', 'install-claude', reviewBody);
  }, 'real implementation-review handoff');
  await finish('install-codex', handoff);
  const { reply: reviewReply } = await finish('install-claude', { message_id: handed.id }, allowedReview);
  // Finish the handoff in both directions before cleanup. A completed review
  // file alone does not prove the originating worker consumed its reply.
  const consumed = await until(async () => {
    const row = (await state('install-codex')).deliveries.find(value => value.message_id === reviewReply.id);
    return terminal.has(row?.state) ? row : null;
  }, 'implementation worker consumes the final review reply');
  assert.equal(consumed.state, 'completed');
  assert.ok(db.prepare('SELECT read_at FROM message_reads WHERE peer=? AND message_id=?').get('install-codex', reviewReply.id));
  await delay(300);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE reply_to=?').get(reviewReply.id).n, 0);
  report.task.reviewReplyConsumed = true; report.task.reviewReplyAcked = true; report.task.noReplyLoop = true;
  const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8')); assert.deepEqual(review, { passed: true, reviewer: 'claude', issues: [] });
  assert.equal(digest(testFile), contractSha256, 'Review must preserve the independent contract tests');
  assert.equal(digest(moduleFile), report.task.moduleSha256); assert.equal(spawnSync(process.execPath, ['--test', testFile], { env, cwd: root }).status, 0);
  report.task.review = review; report.task.crossProviderHandoff = true; report.task.finalTestsPassed = 5; report.task.contractTestsUnchanged = true; report.task.contractSha256 = contractSha256;
  const artifact = path.join(sandbox, 'task-artifacts'); fs.mkdirSync(artifact);
  for (const file of [moduleFile, testFile, reviewFile]) fs.copyFileSync(file, path.join(artifact, path.basename(file)));
  report.task.artifactDirectory = artifact;
  check('installed coding task: model implementation passes five independent tests and receives model-authored cross-provider review');
}
try {
  fs.mkdirSync(root, { mode: 0o700 });
  for (const provider of ['codex', 'claude', 'dsh']) homes[provider] = privateDir(`${provider}-home`);
  const configFile = path.join(originalCodexHome, 'config.toml');
  if (fs.existsSync(configFile)) {
    let section = '';
    const config = fs.readFileSync(configFile, 'utf8').split('\n').filter(line => {
      const heading = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/);
      if (heading) section = heading[1].split('.')[0].replaceAll('"', '').replaceAll("'", '');
      return section ? section === 'model_providers' : /^\s*(?:model(?:_provider|_reasoning_effort|_reasoning_summary|_verbosity|_catalog_json)?|cli_auth_credentials_store)\s*=/.test(line);
    }).join('\n');
    // Keep HCC's global registry isolated while allowing the caller's existing
    // credential commands to resolve their HOME-bound account state. Only the
    // private copy is rewritten; the model process retains the isolated HOME.
    const quoteAuth = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const authCommands = privateDir('credential-commands');
    let authSection = '', wrappedCommands = 0;
    const isolatedConfig = config.split('\n').map(line => {
      const heading = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/);
      if (heading) authSection = heading[1];
      const command = authSection.endsWith('.auth') && line.match(/^\s*command\s*=\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'))\s*(?:#.*)?$/);
      if (!command) return line;
      const original = command[1].startsWith("'") ? command[1].slice(1, -1) : JSON.parse(command[1]);
      const wrapper = path.join(authCommands, `command-${++wrappedCommands}`);
      fs.writeFileSync(wrapper, `#!/bin/sh\nexport HOME=${quoteAuth(os.homedir())}\nexec ${quoteAuth(original)} "$@"\n`, { mode: 0o700 });
      return `command = ${JSON.stringify(wrapper)}`;
    }).join('\n');
    report.authenticationHelperHomePreserved = wrappedCommands > 0;
    fs.writeFileSync(path.join(homes.codex, 'config.toml'), isolatedConfig + '\n', { mode: 0o600 });
  }
  const auth = path.join(originalCodexHome, 'auth.json');
  if (fs.existsSync(auth)) { fs.copyFileSync(auth, path.join(homes.codex, 'auth.json')); fs.chmodSync(path.join(homes.codex, 'auth.json'), 0o600); }
  const installedRequire = createRequire(path.join(repo, 'package.json'));
  const sdkEntry = installedRequire.resolve('@anthropic-ai/claude-agent-sdk');
  const sdkPackage = JSON.parse(fs.readFileSync(path.join(path.dirname(sdkEntry), 'package.json')));
  report.claudeSdk = { version: sdkPackage.version, defaultResolution: sdkEntry, entrySha256: digest(sdkEntry), queryInjected: false };
  const userHome = privateDir('user-home');
  const bin = privateDir('bin');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nexec ${quote(tmux)} -L ${quote(socket)} "$@"\n`, { mode: 0o700 });
  env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HCC_')));
  Object.assign(env, { PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, CODEX_HOME: homes.codex, CLAUDE_CONFIG_DIR: homes.claude,
    HOME: userHome, DSH_HOME: homes.dsh, DSH_TELEMETRY_DISABLED: '1', HCC_SHIM_ENSURED: '1', HCC_SHIM_NO_ATTACH: '1', HCC_NO_AUTO_INSTALL_TMUX: '1', HCC_WEB_TOKEN: randomUUID() });
  report.hccGlobalHomeIsolated = true;
  hcc('native', 'up'); runtimeStarted = true;
  db = new DatabaseSync(ctx.dbPath, { readOnly: true });
  check('locally installed package starts its own native daemon through the public CLI', { runtimePid: readNativePointer(ctx)?.pid });
  if (stabilityOnly) {
    for (const provider of ['codex', 'claude', 'dsh']) {
      const peer = `install-${provider}`;
      report.providers[provider] = { status: 'running', userSubmissions: 0, launcher: 'installed public hcc native start CLI' };
      await start(provider);
      report.providers[provider].version = provider === 'claude' ? report.claudeSdk.version : execFileSync(binaries[provider], ['--version'], { env, encoding: 'utf8', timeout: 10000 }).trim();
      await finish(peer, message(peer, 'Without tools, reply only STABILITY_READY. This is a bounded public stability test.'));
      report.providers[provider].sessionId = (await state(peer)).snapshot.sessionId;
      assert.ok(report.providers[provider].sessionId);
      report.providers[provider].status = 'passed';
      check(`${provider}: stability-only real session bootstrap`);
    }
    report.limitations.push('Stability-only skips the baseline interruption, command approval and model MCP communication scenarios; their evidence must be reviewed separately.');
  } else {
    for (const provider of ['codex', 'claude', 'dsh']) await lifecycle(provider);
    await communication();
  }
  if (stabilityConfig) await stability();
  if (args.includes('--browser')) await browserFlow();
  if (args.includes('--task')) await codingTask();
  assert.deepEqual(sourceHashes(), initialSources); report.sourceUnchangedDuringRun = true;
  report.completed = true;
} catch (error) {
  report.completed = false; report.error = { code: error.code || 'ACCEPTANCE_FAILED', message: error.message }; process.exitCode = 1;
  console.error(JSON.stringify(redactSecrets({ acceptanceFailure: report.error })));
  report.failureState = [];
  for (const provider of Object.keys(report.providers)) {
    try {
      const current = await state(`install-${provider}`);
      report.failureState.push({ provider, snapshot: current.snapshot, activeDelivery: current.active_delivery,
        recentDeliveries: current.deliveries.slice(0, 8), recentEvents: current.events.slice(-20) });
    } catch (failure) { report.failureState.push({ provider, error: failure.message }); }
  }
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) {
    try { const file = path.join(sandbox, 'browser-failure.png'); await page.screenshot({ path: file }); report.screenshots.push(file); } catch {}
  }
} finally {
  await browser?.close().catch(() => {});
  if (webStarted) { try { hcc('down'); } catch {} }
  if (runtimeStarted) {
    try { hcc('native', 'down'); await until(() => !readNativePointer(ctx), 'native daemon shutdown', 30000); report.cleanup.runtimeStopped = true; }
    catch (error) { report.cleanup.runtimeStopped = false; report.cleanup.error = error.message; process.exitCode = 1; report.completed = false; }
  } else report.cleanup.runtimeStopped = !readNativePointer(ctx);
  db?.close();
  spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  report.cleanup.protectedConfigUnchanged = protectedHashes.every(([file, hash]) => fs.existsSync(file) && digest(file) === hash);
  for (const directory of credentials) fs.rmSync(directory, { recursive: true, force: true });
  report.cleanup.temporaryCredentialsRemoved = credentials.every(directory => !fs.existsSync(directory));
  const finalSources = sourceHashes();
  report.sourceChangesDuringRun = Object.keys({ ...initialSources, ...finalSources }).filter(file => initialSources[file] !== finalSources[file]);
  report.sourceUnchangedDuringRun = report.sourceChangesDuringRun.length === 0;
  if (!Object.values(report.cleanup).every(value => value === true) || !report.sourceUnchangedDuringRun) { process.exitCode = 1; report.completed = false; }
  report.limitations.push('Local package installation was exercised; no npm publication or employee-device rollout was performed.');
  report.limitations.push('The coding task uses an independent test project and contract tests; it is not stakeholder acceptance of a production business workflow.');
  report.completedAt = new Date().toISOString(); flush();
}
console.log(JSON.stringify({ receipt: output, completed: report.completed, cleanup: report.cleanup }));
