import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { CliError } from '../shared/errors.mjs';
import { shellQuoteArg } from '../format.mjs';
import { createCodexAppCooperation } from './codex-app-cooperation.mjs';

// Produces a local marketplace using the installed App's public plugin layout.
// Installation and hook trust remain explicit App settings; no trust bypass,
// private endpoint, account configuration, or App restart is involved.
export function writeCodexCooperationPlugin({ root, directory, initialRootIdentity = null,
  cliPath = fileURLToPath(new URL('../../bin/hcc.mjs', import.meta.url)), nodePath = process.execPath } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new CliError('BAD_ARGS', '--plugin-dir must be a new absolute directory');
  const service = createCodexAppCooperation({ root, initialRootIdentity });
  const parent = fs.realpathSync(path.dirname(directory));
  const destination = path.join(parent, path.basename(directory));
  fs.mkdirSync(destination, { mode: 0o700 });
  try {
    const pluginDirectory = path.join(destination, 'plugin');
    const installationId = createHash('sha256').update(service.ctx.root).digest('hex').slice(0, 8) + '-' + randomUUID().slice(0, 8);
    const marketplaceName = 'hello-cc-local-' + installationId, pluginName = 'hcc-cooperation-' + installationId;
    const write = (relative, value) => {
      const file = path.join(destination, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    };
    const prefix = [fs.realpathSync(nodePath), fs.realpathSync(cliPath), '--root', service.ctx.root];
    write('.agents/plugins/marketplace.json', { name: marketplaceName, interface: { displayName: 'HCC Local Cooperation' },
      plugins: [{ name: pluginName, source: { source: 'local', path: './plugin' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }] });
    write('plugin/.codex-plugin/plugin.json', { name: pluginName, version: '1.0.0',
      description: 'Coordinate this project from the original Codex App session. Explicit session capabilities; no idle wakeup.',
      author: { name: 'hello-cc' }, hooks: './hooks/hooks.json' });
    write('plugin/.mcp.json', { mcpServers: { hcc_cooperation: { command: prefix[0], args: [...prefix.slice(1), 'app', 'codex', 'mcp'],
      cwd: service.ctx.root } } });
    write('plugin/hooks/hooks.json', { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command',
      command: [...prefix, 'app', 'codex', 'hook'].map(shellQuoteArg).join(' '), timeout: 5 }] }] } });
    service.enable();
    return { root: service.ctx.root, marketplaceDirectory: destination, marketplaceName, pluginDirectory, pluginName,
      enabled: true, installedInApp: false, hooksTrustedInApp: false, automaticIdleWakeup: false,
      sessionCommand: [...prefix, '--json', 'app', 'codex', 'session'].map(shellQuoteArg).join(' ') };
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
