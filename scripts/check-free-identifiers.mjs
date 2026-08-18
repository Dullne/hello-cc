// Static free-identifier audit for create*() factory modules.
//
// A factory module (lib/**) receives every external value through its deps
// parameter. Any identifier used inside the factory body that is not a
// local declaration, a parameter, an import, or a JS language construct is
// a latent ReferenceError on the code path that touches it — the exact
// class of bug the cmdWeb extraction shipped twice (requestActorPeer,
// inspectProviderProcess) because the surrounding try/catch swallowed it.
//
// This scanner strips comments and string/template literals first, so
// identifiers mentioned in prose or error messages do not produce noise.
// It reports free identifiers per module and exits non-zero on findings.
//
// Usage: node scripts/check-free-identifiers.mjs [file...]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── lexer: blank out comments and string/template contents ─────────────────
// Template literals keep their ${ } expression regions scannable; literal
// text is blanked. Regex literals are blanked conservatively (a `/` that
// follows a non-identifier token and pairs with a closing `/`).
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let prevMeaningful = '';   // last non-space char emitted
  const last = () => prevMeaningful;
  const push = (ch) => { out += ch; if (!/\s/.test(ch)) prevMeaningful = ch; };
  const blank = (ch) => { out += ch === '\n' ? '\n' : ' '; };

  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && source[i] !== '\n') { blank(source[i]); i += 1; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      blank(c); blank(c2); i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { blank(source[i]); i += 1; }
      blank('*'); blank('/'); i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      blank(c); i += 1;
      while (i < n && source[i] !== c) {
        if (source[i] === '\\') { blank(source[i]); i += 1; if (i < n) { blank(source[i]); i += 1; } continue; }
        if (source[i] === '\n') { out += '\n'; i += 1; continue; }
        blank(source[i]); i += 1;
      }
      if (i < n) { blank(c); i += 1; }
      continue;
    }
    if (c === '`') {
      blank(c); i += 1;
      while (i < n && source[i] !== '`') {
        if (source[i] === '\\') { blank(source[i]); i += 1; if (i < n) { blank(source[i]); i += 1; } continue; }
        if (source[i] === '$' && source[i + 1] === '{') {
          // keep the expression: emit as-is, track brace depth to its close
          push('$'); push('{'); i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            const ch = source[i];
            if (ch === '{') depth += 1;
            if (ch === '}') { depth -= 1; if (depth === 0) { push('}'); i += 1; break; } }
            out += ch; if (!/\s/.test(ch)) prevMeaningful = ch;
            i += 1;
          }
          continue;
        }
        if (source[i] === '\n') { out += '\n'; i += 1; continue; }
        blank(source[i]); i += 1;
      }
      if (i < n) { blank('`'); i += 1; }
      continue;
    }
    if (c === '/' && !/[)\w$]/.test(last()) && last() !== '') {
      // potential regex literal — find an unescaped closing /
      let j = i + 1;
      let closed = false;
      let inClass = false;
      while (j < n && source[j] !== '\n') {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) { closed = true; break; }
        j += 1;
      }
      if (closed) {
        blank(c);
        i += 1;
        while (i <= j) { blank(source[i] === '\n' ? '\n' : ' '); i += 1; }
        // flags
        while (i < n && /[a-z]/.test(source[i])) { blank(source[i]); i += 1; }
        continue;
      }
      // not a regex; fall through as division
    }
    push(c);
    i += 1;
  }
  // Blank object-literal keys (identifier before ':' directly after '{' or
  // ','). Shorthand `{ key }` is a real use and stays intact (no colon).
  out = out.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, (full, lead, ident) =>
    lead + " ".repeat(ident.length + 1));
  return out;
}

// ── scope approximation ─────────────────────────────────────────────────────
// Collect: imports, deps destructuring, and every identifier declared inside
// the factory body (function names, const/let/var, function parameters,
// destructuring patterns, class names, catch params, for-of heads). This is
// deliberately over-inclusive — we only report identifiers that are declared
// nowhere in the file, which keeps false positives near zero.
function collectBindings(stripped, factoryStart) {
  const bound = new Set();
  const body = stripped;

  // imports (whole file)
  for (const m of body.matchAll(/import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  for (const m of body.matchAll(/import\s*\{([^}]*)\}/g)) {
    for (const piece of m[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
    }
  }

  // deps destructuring: const { ... } = deps;
  const depsMatch = body.match(/const\s*\{([\s\S]*?)\}\s*=\s*deps\s*;/);
  if (depsMatch) {
    for (const piece of depsMatch[1].split(/[,\n]/)) {
      const name = piece.trim().split(/:\s*/).pop()?.split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
    }
  }

  // function declarations + their parameters
  for (const m of body.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
    if (m[1]) bound.add(m[1]);
    for (const p of m[2].split(',')) {
      const name = p.trim().split(/[=\s]/)[0].replace(/^\.\.\./, '');
      for (const leaf of destructLeaves(name)) bound.add(leaf);
    }
  }
  // const/let/var with destructuring or plain names
  for (const m of body.matchAll(/(?:^|[^.\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*|\{[^}]*\})\s*[=;]/g)) {
    const decl = m[1];
    if (decl.startsWith('{')) {
      for (const leaf of destructLeaves(decl)) bound.add(leaf);
    } else bound.add(decl);
  }
  // class declarations, catch params, labeled loop vars
  for (const m of body.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  for (const m of body.matchAll(/catch\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*\))?/g)) if (m[1]) bound.add(m[1]);
  for (const m of body.matchAll(/for\s*\(\s*(?:const|let|var)\s+([\w$,\s{}:]+?)\s+(?:of|in)\s/g)) {
    for (const leaf of destructLeaves(m[1])) bound.add(leaf);
  }
  // arrow function parameters: (a, b) => / single a =>
  for (const m of body.matchAll(/\(\s*([^()]*?)\s*\)\s*=>/g)) {
    for (const p of m[1].split(',')) {
      for (const leaf of destructLeaves(p.trim().split(/[=\s]/)[0].replace(/^\.\.\./, ''))) bound.add(leaf);
    }
  }
  for (const m of body.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) bound.add(m[1]);
  // object literal shorthand keys are uses of bindings, but `{ name }` in a
  // destructuring is a binding — covered above; literal method names are fine.

  return bound;
}

function destructLeaves(fragment) {
  const leaves = [];
  if (!fragment) return leaves;
  const inner = fragment.replace(/^\{|\}$/g, '');
  for (const piece of inner.split(',')) {
    // take the binding side of `key: value`, or the shorthand itself
    const side = piece.includes(':') ? piece.split(':').pop() : piece;
    const name = side.trim().split(/[=\s]/)[0].replace(/^\.\.\./, '');
    if (name && /^[A-Za-z_$][\w$]*$/.test(name)) leaves.push(name);
    else if (name && name.startsWith('{')) leaves.push(...destructLeaves(name));
  }
  return leaves;
}

const JS_GLOBALS = new Set(('globalThis global console process require module exports Buffer URL URLSearchParams'
  + ' Array Object String Number Boolean Math JSON Date Promise Symbol BigInt Map Set WeakMap WeakSet'
  + ' RegExp Error TypeError RangeError SyntaxError ReferenceError EvalError URIError AggregateError'
  + ' parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent'
  + ' undefined NaN Infinity setTimeout setInterval clearTimeout setImmediate clearImmediate queueMicrotask'
  + ' fetch structuredClone atob btoa performance setTimeoutAsyncOfTimersPromises'
  + ' if else for while do switch case default break continue return function const let var class extends'
  + ' new delete typeof instanceof in of try catch finally throw await async yield this super null true false void'
  + ' arguments export import from as default eval'
  + ' clearInterval setInterval clearTimeout setImmediate clearImmediate'
  + ' $ __filename __dirname atob btoa').split(/\s+/));

function auditFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const stripped = stripCommentsAndStrings(source);
  const bound = collectBindings(stripped);
  // identifiers used as: calls, property-less reads (word boundary), assignments
  const used = new Set();
  for (const m of stripped.matchAll(/(?<![.\w$'"])([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
  const free = [...used].filter((n) => !bound.has(n) && !JS_GLOBALS.has(n));
  return { file, free };
}

// ── main ────────────────────────────────────────────────────────────────────
function listFactoryModules() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mjs')) {
        const src = fs.readFileSync(full, 'utf8');
        if (/export function create\w+\(/.test(src)) found.push(full);
      }
    }
  };
  walk(path.join(repoRoot, 'lib'));
  return found;
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : listFactoryModules();

// Known scanner gaps (NOT code defects). Every entry below was triaged by
// hand: the identifier is bound through a pattern the regex approximation
// cannot see — destructured function parameters with defaults, for-of array
// heads, object keys surviving template `${}` regions, shorthand in nested
// option objects, or embedded worker source. Keep this list short: a new
// finding that is not clearly one of these classes is probably a REAL
// missing dep (four such bugs were found and fixed by this scanner:
// requestActorPeer, inspectProviderProcess, ACTIVE_PEER_TTL, CLI_NAME,
// shutdown/tlsCredentials, CliError — all on cold error paths).
const KNOWN_FALSE_POSITIVES = {
  'lib/cli/commands/coordination.mjs': ['Enter', 'and', 'input', 'locks', 'pressed', 'terminal'],
  'lib/cli/commands/doctor.mjs': ['connectReadOnly', 'k', 'v', 'wal'],
  'lib/cli/commands/gc.mjs': ['add', 'apply', 'dry', 'entries', 'gcCutoff', 'id', 'lock', 'run', 'to', 'yes'],
  'lib/cli/commands/install.mjs': ['cc', 'n'],
  'lib/cli/commands/peer.mjs': ['pid'],
  'lib/cli/commands/task.mjs': ['child'],
  'lib/cli/commands/team.mjs': ['assignee', 'count', 'owner', 'status'],
  'lib/coordination-state.mjs': ['reply'],
  'lib/core/coordination/gc-plan.mjs': ['GC', 'id', 'index'],
  'lib/core/coordination/tasks.mjs': ['OR', 'assignee', 'force', 'owner', 'reason'],
  'lib/core/peers/evidence-runtime.mjs': ['can', 'find', 'i', 'no', 'now', 'requested', 'running', 'server', 'session', 't'],
  'lib/core/peers/peer-helpers.mjs': ['now'],
  'lib/db/connection.mjs': ['now'],
  'lib/db/events.mjs': ['now'],
  'lib/runtime/buffer-gc-protocol.mjs': ['afterBatch', 'batchSize', 'collectEvidence', 'db', 'pendingCount', 'prepare', 'take'],
  'lib/runtime/fatal-shutdown.mjs': ['cleanup'],
  'lib/shared/file-lock.mjs': ['Atomics', 'Int32Array', 'SharedArrayBuffer', 'fn', 'nonblocking', 'retryMs', 'timeoutMs', 'withConfiguredFileLock', 'workerSource'],
  'lib/ui/help.mjs': ['helpAsk', 'helpBroadcast', 'helpDown', 'helpEnv', 'helpEvent', 'helpGc', 'helpHandoff', 'helpInject', 'helpInstallHooks', 'helpJoin', 'helpLock', 'helpMain', 'helpMsg', 'helpPeer', 'helpRun', 'helpShim', 'helpState', 'helpTask', 'helpTeam', 'helpTmux', 'helpUninstall', 'helpUp', 'helpUpdate', 'helpWeb'],
  'lib/web/buffer-gc-runtime.mjs': ['dryRun', 'entries', 'prepare'],
  'lib/web/cookie-auth.mjs': ['k', 'now', 'rest'],
  'lib/web/external-sessions.mjs': ['updateDatabase'],
  'lib/web/peer-actions.mjs': ['locks'],
  'lib/web/project-contexts.mjs': ['activity'],
  'lib/web/runtime-main.mjs': ['idSet'],
  'lib/web/session-serialize.mjs': ['sessions'],
  'lib/web/startup.mjs': ['log', 'n', 'n$', 'nLast', 'proxy', 'tls', 'trust', 'with'],
  'lib/web/tmux-stream.mjs': ['broadcast']
};

let failures = 0;
for (const file of files) {
  const rel = path.relative(repoRoot, file);
  const allow = new Set(KNOWN_FALSE_POSITIVES[rel] || []);
  const { free } = auditFile(file);
  const real = free.filter((n) => !allow.has(n));
  const tolerated = free.filter((n) => allow.has(n));
  if (real.length) {
    failures += 1;
    console.error(`✗ ${rel}: free identifiers → ${real.sort().join(', ')}`);
  } else {
    console.log(`✓ ${rel}${tolerated.length ? ` (${tolerated.length} known scanner gap(s))` : ''}`);
  }
}
if (failures) {
  console.error(`\n${failures} module(s) use identifiers that are neither imports, deps, nor local declarations.`);
  process.exit(1);
}
console.log(`\n${files.length} factory module(s) audited, no free identifiers.`);
