import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packages = Object.freeze({
  'xterm.js': '@xterm/xterm',
  'xterm.css': '@xterm/xterm',
  'addon-fit.js': '@xterm/addon-fit',
  'addon-search.js': '@xterm/addon-search'
});

// npm may place dependencies above the HCC package directory. Resolve from
// this module's installation rather than assuming a nested node_modules.
export function terminalAssetPath(name) {
  if (!Object.hasOwn(packages, name)) throw new TypeError('Unknown terminal asset');
  const entry = require.resolve(packages[name]);
  return name === 'xterm.css' ? path.resolve(path.dirname(entry), '..', 'css', name) : entry;
}
