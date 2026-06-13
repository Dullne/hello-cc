import fs from 'node:fs';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { CliError } from './errors.mjs';
import { shellQuoteArg } from './format.mjs';

export function runTmux(args, opts = {}) {
  const result = spawnSync('tmux', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input: opts.input || ''
  });
  if (result.error) {
    throw new CliError('TMUX_ERROR', `tmux failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim() || `tmux ${args.join(' ')} failed`;
    throw new CliError('TMUX_ERROR', message);
  }
  return result.stdout || '';
}

function tmuxInstallHint() {
  if (process.platform === 'darwin') return 'Install tmux with: brew install tmux';
  if (process.platform === 'linux') {
    if (fs.existsSync('/etc/debian_version')) return 'Install tmux with: sudo apt-get update && sudo apt-get install -y tmux';
    if (fs.existsSync('/etc/alpine-release')) return 'Install tmux with: sudo apk add tmux';
    if (fs.existsSync('/etc/arch-release')) return 'Install tmux with: sudo pacman -S --noconfirm tmux';
    if (fs.existsSync('/etc/fedora-release')) return 'Install tmux with: sudo dnf install -y tmux';
    return 'Install tmux with your system package manager.';
  }
  return 'Install tmux and make sure it is on PATH.';
}

function commandExists(name) {
  return spawnSync('sh', ['-lc', `command -v ${shellQuoteArg(name)} >/dev/null 2>&1`], {
    stdio: ['ignore', 'ignore', 'ignore']
  }).status === 0;
}

function runInstallCommand(command) {
  const result = spawnSync('sh', ['-lc', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000
  });
  return {
    ok: result.status === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  };
}

export function tryInstallTmux() {
  if (process.env.HCC_NO_AUTO_INSTALL_TMUX === '1') {
    return { ok: false, output: 'automatic tmux installation disabled by HCC_NO_AUTO_INSTALL_TMUX=1' };
  }
  const sudo = typeof process.getuid === 'function' && process.getuid() === 0 ? '' : (commandExists('sudo') ? 'sudo ' : '');
  if (process.platform === 'darwin' && commandExists('brew')) {
    return runInstallCommand('brew install tmux');
  }
  if (process.platform === 'linux') {
    if (commandExists('apt-get')) {
      const update = runInstallCommand(`${sudo}apt-get update`);
      if (!update.ok) return update;
      return runInstallCommand(`${sudo}apt-get install -y tmux`);
    }
    if (commandExists('dnf')) return runInstallCommand(`${sudo}dnf install -y tmux`);
    if (commandExists('yum')) return runInstallCommand(`${sudo}yum install -y tmux`);
    if (commandExists('apk')) return runInstallCommand(`${sudo}apk add tmux`);
    if (commandExists('pacman')) return runInstallCommand(`${sudo}pacman -S --noconfirm tmux`);
  }
  return { ok: false, output: 'no supported package manager found' };
}

export function ensureTmuxAvailable({ autoInstall = true } = {}) {
  if (spawnSync('tmux', ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status === 0) return;
  let install = { ok: false, output: '' };
  if (autoInstall) {
    install = tryInstallTmux();
    if (install.ok && spawnSync('tmux', ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status === 0) return;
  }
  const detail = install.output ? `\n\nAutomatic install failed:\n${install.output}` : '';
  throw new CliError('TMUX_REQUIRED', `tmux is required for browser-controllable local terminals. ${tmuxInstallHint()}${detail}`);
}

export function tmuxHasSession(sessionName) {
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return result.status === 0;
}

export function tmuxSessionHasClients(sessionName) {
  const result = spawnSync('tmux', ['list-clients', '-t', sessionName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) return false;
  return Boolean((result.stdout || '').trim());
}

export function tmuxKillSession(sessionName) {
  const result = spawnSync('tmux', ['kill-session', '-t', sessionName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0 && !String(result.stderr || result.stdout || '').includes('can\'t find session')) {
    const message = (result.stderr || result.stdout || '').trim() || `tmux kill-session -t ${sessionName} failed`;
    throw new CliError('TMUX_ERROR', message);
  }
}

export function tmuxSessionEnvironmentValue(sessionName, key) {
  const result = spawnSync('tmux', ['show-environment', '-t', sessionName, key], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) return null;
  const line = (result.stdout || '').trim();
  if (!line || line.startsWith('-')) return null;
  const prefix = `${key}=`;
  return line.startsWith(prefix) ? line.slice(prefix.length) : null;
}

export function tmuxPaneInfo(targetPane = null) {
  const pane = targetPane || process.env.TMUX_PANE;
  if (!pane) throw new CliError('BAD_ARGS', 'Missing --pane and current terminal is not inside tmux');
  const format = '#{pane_id}\t#{pane_current_path}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}';
  const out = runTmux(['display-message', '-p', '-t', pane, format]).trimEnd();
  const [paneId, currentPath, pid, currentCommand, paneDead] = out.split('\t');
  if (!paneId) throw new CliError('TMUX_ERROR', `Cannot resolve tmux pane: ${pane}`);
  return {
    pane: paneId,
    cwd: currentPath || '',
    pid: Number.parseInt(pid || '0', 10) || null,
    command: currentCommand || 'tmux',
    dead: paneDead === '1'
  };
}

export function tmuxCapturePane(pane) {
  // No -J (join): keep one captured line per physical pane row so the web
  // terminal's row count matches tmux exactly, which is required for accurate
  // cursor placement. Strip the single trailing newline tmux appends so the
  // line count is exactly scrollback+height (no phantom bottom row in xterm).
  const out = runTmux(['capture-pane', '-p', '-e', '-S', '-2000', '-t', pane]);
  return out.endsWith('\n') ? out.slice(0, -1) : out;
}

// Read the real cursor cell + screen geometry from tmux so the browser mirror
// can draw the input cursor at the right place. Returns null if unavailable.
export function tmuxCursorInfo(pane) {
  try {
    const out = runTmux(['display-message', '-p', '-t', pane,
      '#{cursor_x},#{cursor_y},#{cursor_flag},#{history_size},#{pane_height}']);
    const [x, y, flag, hist, height] = out.trim().split(',').map((n) => Number.parseInt(n, 10));
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      visible: flag !== 0,
      history: Number.isFinite(hist) ? hist : 0,
      height: Number.isFinite(height) && height > 0 ? height : 1
    };
  } catch {
    return null;
  }
}

// Map tmux's cursor (relative to the visible pane) onto the web terminal's
// viewport row, accounting for captured scrollback and capture-pane's trailing
// blank-line stripping. Returns { row, col, visible } in viewport coordinates.
export function tmuxCursorPayload(captured, info) {
  if (!info) return null;
  const height = info.height;
  const scrollback = Math.min(2000, info.history);
  const lineCount = captured ? captured.split('\n').length : 0;
  const viewportTop = Math.max(0, lineCount - height);
  let row = scrollback + info.y - viewportTop;
  if (row < 0) row = 0;
  if (row > height - 1) row = height - 1;
  return { row, col: info.x, visible: info.visible };
}

function tmuxSendKeys(pane, keys) {
  if (!keys.length) return;
  runTmux(['send-keys', '-t', pane, ...keys]);
}

function tmuxSendRawLiteral(pane, text) {
  if (!text) return;
  // A tmux argument consisting solely of ';' is swallowed as a command
  // separator even after '--', so a typed lone semicolon would vanish. Paste
  // such runs through a buffer (which is parsed as data, not command args).
  if (/^;+$/.test(text)) {
    tmuxPasteBuffer(pane, text, { raw: true });
    return;
  }
  runTmux(['send-keys', '-t', pane, '-l', '--', text]);
}

function tmuxInCopyMode(pane) {
  try {
    const out = runTmux(['display-message', '-p', '-t', pane, '#{pane_in_mode}']);
    return out.trim() === '1';
  } catch { return false; }
}

function tmuxExitCopyMode(pane) {
  try {
    runTmux(['send-keys', '-t', pane, '-X', 'cancel']);
  } catch {}
}

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

function tmuxPasteBuffer(pane, text, opts = {}) {
  if (!text) return;

  // Cancel copy-mode so input isn't swallowed
  if (tmuxInCopyMode(pane)) {
    tmuxExitCopyMode(pane);
  }

  // paste-buffer handles all special characters safely (including $ ` " ' \ | ; ~ # and multi-byte UTF-8)
  const bufferName = `hcc-tmux-${pane.replace(/[%\\/]/g, '')}-${Date.now()}`;
  try {
    runTmux(['load-buffer', '-b', bufferName, '-'], { input: text });
    const args = ['paste-buffer'];
    if (opts.bracketed) args.push('-p');
    if (opts.raw) args.push('-r');
    args.push('-t', pane, '-b', bufferName);
    runTmux(args);
  } finally {
    try { runTmux(['delete-buffer', '-b', bufferName], { silent: true }); } catch {}
  }
}

function readTmuxEscapeSequence(text, start) {
  let i = start + 1;
  if (i >= text.length) return text.slice(start, i);
  const marker = text[i];
  if (marker === '[') {
    i += 1;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      i += 1;
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return text.slice(start, i);
  }
  if (marker === 'O') {
    return text.slice(start, Math.min(text.length, start + 3));
  }
  if (marker === ']') {
    i += 1;
    while (i < text.length) {
      if (text.charCodeAt(i) === 0x07) return text.slice(start, i + 1);
      if (text.charCodeAt(i) === 0x1b && text[i + 1] === '\\') return text.slice(start, i + 2);
      i += 1;
    }
    return text.slice(start, i);
  }
  return text.slice(start, Math.min(text.length, start + 2));
}

function isTmuxRawControlChar(ch) {
  const code = ch.charCodeAt(0);
  return (code < 0x20 && ch !== '\r' && ch !== '\n' && ch !== '\b') ||
    (code >= 0x80 && code <= 0x9f);
}

export function tmuxSendLiteral(pane, text) {
  if (!text) return;
  const chunks = [];
  let current = '';
  for (let i = 0; i < text.length;) {
    const codePoint = text.codePointAt(i);
    const ch = String.fromCodePoint(codePoint);
    const width = ch.length;
    if (ch === '\r' || ch === '\n') {
      if (current) { chunks.push({ type: 'literal', text: current }); current = ''; }
      chunks.push({ type: 'key', key: 'Enter' });
      i += width;
    } else if (ch === '\x7f' || ch === '\b') {
      if (current) { chunks.push({ type: 'literal', text: current }); current = ''; }
      chunks.push({ type: 'key', key: 'BSpace' });
      i += width;
    } else if (text.startsWith(BRACKETED_PASTE_START, i)) {
      if (current) { chunks.push({ type: 'literal', text: current }); current = ''; }
      const end = text.indexOf(BRACKETED_PASTE_END, i + BRACKETED_PASTE_START.length);
      if (end >= 0) {
        chunks.push({
          type: 'paste',
          text: text.slice(i + BRACKETED_PASTE_START.length, end)
        });
        i = end + BRACKETED_PASTE_END.length;
      } else {
        const sequence = readTmuxEscapeSequence(text, i);
        chunks.push({ type: 'raw', text: sequence });
        i += sequence.length;
      }
    } else if (ch === '\x1b') {
      if (current) { chunks.push({ type: 'literal', text: current }); current = ''; }
      const sequence = readTmuxEscapeSequence(text, i);
      chunks.push({ type: 'raw', text: sequence });
      i += sequence.length;
    } else if (isTmuxRawControlChar(ch)) {
      if (current) { chunks.push({ type: 'literal', text: current }); current = ''; }
      chunks.push({ type: 'raw', text: ch });
      i += width;
    } else {
      current += ch;
      i += width;
    }
  }
  if (current) chunks.push({ type: 'literal', text: current });

  // Typed characters must arrive as real key presses, not clipboard pastes:
  // send-keys -l is ~3x cheaper than the load-buffer/paste-buffer/delete-buffer
  // cycle (one tmux spawn vs three) and the target program sees keystrokes
  // rather than paste events — which bracketed-paste-aware TUIs (claude, codex)
  // otherwise mishandle. paste-buffer is reserved for genuine bracketed pastes.
  // Exit copy-mode once up front so send-keys isn't interpreted as copy commands.
  if (tmuxInCopyMode(pane)) tmuxExitCopyMode(pane);

  let pendingText = '';
  for (const chunk of chunks) {
    if (chunk.type === 'literal') {
      pendingText += chunk.text;
    } else {
      if (pendingText) { tmuxSendRawLiteral(pane, pendingText); pendingText = ''; }
      if (chunk.type === 'key') tmuxSendKeys(pane, [chunk.key]);
      else if (chunk.type === 'paste') tmuxPasteBuffer(pane, chunk.text, { bracketed: true, raw: true });
      else tmuxSendRawLiteral(pane, chunk.text);
    }
  }
  if (pendingText) tmuxSendRawLiteral(pane, pendingText);
}
