import test from 'node:test';
import assert from 'node:assert/strict';
import * as tmux from '../lib/terminal/tmux.mjs';

const available = (...names) => (name) => names.includes(name);
const noFiles = () => false;
const tmuxInstallPlan = (...args) => {
  assert.equal(typeof tmux.tmuxInstallPlan, 'function', 'tmuxInstallPlan must be exported');
  return tmux.tmuxInstallPlan(...args);
};
const tmuxInstallHint = (...args) => {
  assert.equal(typeof tmux.tmuxInstallHint, 'function', 'tmuxInstallHint must be exported');
  return tmux.tmuxInstallHint(...args);
};

test('Linux plans never use Homebrew', () => {
  for (const manager of ['apt-get', 'dnf', 'yum', 'apk', 'pacman', 'zypper']) {
    const plan = tmuxInstallPlan({
      platform: 'linux',
      commandAvailable: available(manager, 'sudo'),
      isRoot: false
    });
    assert.equal(plan.manager, manager);
    assert.doesNotMatch(plan.commands.join('\n'), /brew/);
  }
});

test('macOS uses Homebrew only when Homebrew is available', () => {
  assert.deepEqual(tmuxInstallPlan({
    platform: 'darwin', commandAvailable: available('brew'), isRoot: false
  }), { manager: 'brew', commands: ['brew install tmux'] });
  assert.equal(tmuxInstallPlan({
    platform: 'darwin', commandAvailable: available(), isRoot: false
  }), null);
});

test('Linux auto-install requires root or sudo', () => {
  assert.equal(tmuxInstallPlan({
    platform: 'linux', commandAvailable: available('apt-get'), isRoot: false
  }), null);
  assert.deepEqual(tmuxInstallPlan({
    platform: 'linux', commandAvailable: available('apt-get'), isRoot: true
  }), {
    manager: 'apt-get',
    commands: ['apt-get update', 'apt-get install -y tmux']
  });
});

test('Linux hints cover major package families and generic fallback', () => {
  assert.match(tmuxInstallHint({ platform: 'linux', pathExists: (p) => p === '/etc/debian_version' }), /apt-get/);
  assert.match(tmuxInstallHint({ platform: 'linux', pathExists: (p) => p === '/etc/alpine-release' }), /apk/);
  assert.match(tmuxInstallHint({ platform: 'linux', pathExists: (p) => p === '/etc/arch-release' }), /pacman/);
  assert.match(tmuxInstallHint({ platform: 'linux', pathExists: (p) => p === '/etc/fedora-release' }), /dnf/);
  assert.match(tmuxInstallHint({ platform: 'linux', pathExists: (p) => p === '/etc/SuSE-release' }), /zypper/);
  assert.match(tmuxInstallHint({ platform: 'linux', pathExists: noFiles }), /apt|dnf|yum|apk|pacman|zypper/);
  assert.doesNotMatch(tmuxInstallHint({ platform: 'linux', pathExists: noFiles }), /brew/);
});
