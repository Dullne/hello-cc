# hello-cc

<p align="center">
  <img src="assets/logo.svg" width="160" alt="hello-cc logo">
</p>

<p align="center">
  <a href="https://github.com/Dullne/hello-cc"><img src="https://img.shields.io/github/stars/Dullne/hello-cc?style=flat-square&color=40c4aa" alt="GitHub stars"></a>
  <a href="https://www.npmjs.com/package/@logicseek/hello-cc"><img src="https://img.shields.io/npm/v/@logicseek/hello-cc?style=flat-square&color=40c4aa" alt="npm version"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen?style=flat-square" alt="node >=24"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="license Apache 2.0"></a>
</p>

<p align="center"><b>English</b> | <a href="README.zh-CN.md">中文</a></p>

`hello-cc` is a local multi-agent workbench for Claude Code, Codex, and DeepSeek
Harness. Start background Agents from the browser or continue managed local
terminal sessions, with a shared project task board, mailbox, lock table, and
handoffs.

<p align="center">
  <img src="assets/screenshots/web-console.png" width="900" alt="hello-cc 1.1.0 Web workbench showing background Agents, a structured conversation, tool activity, and shared project state">
</p>

<p align="center">
  <em>One local workbench for Claude, Codex, and DeepSeek Harness: conversations, tools, approvals, and project coordination. Screenshot uses demo data.</em>
</p>

It is built for developers who run multiple AI coding agents in the same repo
and need them to coordinate instead of guessing what the other sessions are
doing.

## v1 Compatibility And Trust Model

Version 1.0.0 upgrades project databases to schema v7 after creating a verified
pre-migration backup; downgrading that database is unsupported. Provider peer
IDs now hash the full provider session value and old IDs are not remapped.
Runtime API v2 and per-connection terminal action tokens are required.

Version 1.1.0 also binds project state, managed launches, and verified Codex
history to the selected directory's filesystem identity. Stable, trusted
projects can use `<project>/.hello-cc/mesh.db`; projects requiring private state
use `~/.hello-cc/projects/<canonical-root-hash>/mesh.db`, with separate generations
for replacement directories. Existing private v1 bindings require a reviewed
offline upgrade. See [project identity and private state](docs/private-state.md)
before migrating or recovering an existing store.

Liveness follows tmux/non-tmux process evidence: sleep or detachment does not
kill a live session, and only unknown evidence receives the bounded 120-second
grace. `hcc gc` retains history unless `--history` is explicit. `--tls` encrypts
the console; `--trust-proxy` requires a fixed `--proxy-origin`. Two risks remain
intentional: the default listener is plaintext HTTP on `0.0.0.0` for trusted
LANs, and an authenticated browser may select any existing server directory.

## Highlights

- **Background Agents**: create Codex, Claude, and DeepSeek Harness workers
  directly from Web; save a default provider, model, and working directory per
  project.
- **Structured conversations**: follow messages, tool activity, delivery receipts,
  and supported approval or user-input requests in the same session.
- **Local and Web workflows**: continue the same native worker through CLI and
  Web, or attach to a managed local tmux pane. Advanced options also offer Codex
  App Server sessions.
- **Project files**: browse and preview files and generated artifacts, upload new
  files, and edit supported text with version checks.
- **Shared project memory**: peers, tasks, messages, locks, handoffs, and events
  live in the project's SQLite bus, separate from other projects.
- **Live agent coordination**: hooks and scoped MCP tools expose project tasks
  and inboxes to connected agents; DeepSeek Harness also supports hooks and
  Cordis integration.
- **Conflict avoidance**: advisory locks and handoffs make multi-agent editing
  explicit.
- **Explicit team splits**: `hcc team plan/start/status` turns one parallel
  task into auditable child tasks without hidden auto-spawning.
- **Resume-friendly identity**: resumed Claude/Codex sessions map back to
  stable peers when provider session ids are available.
- **One console, many projects**: one local Web runtime can switch between
  registered project roots.

## Install And Manage

hello-cc supports Linux and macOS on arm64 and x64. Node.js 24 or newer is
required. `hcc web` requires `tmux`, including when you plan to create background
Agents from Web. Native Windows shells are not currently supported; use WSL
and install the dependencies inside it.

Linux has richer process auto-discovery through `/proc`. On macOS, use
hello-cc shims or `hcc peer start` for reliable tmux-managed terminal sessions.

Install Node.js 24 or newer from the official Node.js packages or a Node
version manager. Then install `tmux` for your platform:

```bash
# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y tmux
# Fedora / RHEL
sudo dnf install -y tmux
# Older RHEL / CentOS
sudo yum install -y tmux
# Alpine
sudo apk add tmux
# Arch Linux
sudo pacman -S --needed tmux
# openSUSE
sudo zypper install tmux
# macOS only
brew install tmux
```

On Linux, use the distribution package manager; Homebrew is only the macOS
command above. Root shells can omit `sudo`. In WSL, run the matching Linux
distribution commands inside WSL. Then install and verify hello-cc:

```bash
npm install -g @logicseek/hello-cc
node --version
npm --version
tmux -V
hcc --version
hcc --help
```

Install and authenticate the provider you want to use in the environment that
runs hello-cc. Background Agents require an App Server-compatible Codex CLI,
the optional Claude Agent SDK for Claude, or DeepSeek Harness with ACP support
(the supported Harness baseline is `0.2.0-rc.2`). See
[Native worker requirements](docs/native.md#requirements) for setup, including
the Claude SDK installation command, and [DeepSeek Harness](docs/dsh.md) for its
integration modes.

If npm reports `EACCES`, use a Node version manager or a user-owned npm prefix;
do not work around it with `sudo npm install -g`.

Update an existing global install to the npm `latest` channel:

```bash
hcc update
```

Or run it without a global install:

```bash
npx @logicseek/hello-cc web
```

Remove hooks, shims, and the shell PATH entry from this machine:

```bash
hcc uninstall
```

Remove the global npm package:

```bash
npm uninstall -g @logicseek/hello-cc
```

## Quick Start

Run this inside the project you want agents to share:

```bash
cd /path/to/project
hcc web
```

Then open the printed URL. By default, `hcc web` listens on LAN interfaces and
requests `0.0.0.0:8787`, using a token generated for that runtime. If
port 8787 is already busy and you did not pass `--port`, it automatically tries
the next available port. The command prints both the LAN login URL and the local
loopback URL:

```text
open: http://<machine-ip>:8787/?token=<runtime-token>&project=/path/to/project
local: http://127.0.0.1:8787/?token=<runtime-token>&project=/path/to/project
```

Use `--local` to bind only to `127.0.0.1`, or `--port N` to request a specific
port. `hcc web` initializes the project bus, installs Claude/Codex hooks and
shims, starts or reuses the Web console, and returns the terminal to you.
`hcc web --local` is still Web mode; it only limits the listener to loopback.
Use `hcc up` when you want local coordination commands without the Web console
or shims.

### Start A Background Agent

1. Select the project in Web and click **New Agent**.
2. Choose Codex, Claude, or DeepSeek Harness; **Background Agent** is the default.
   The selected provider must already be installed and authenticated.
3. Keep the project root or choose a directory inside it. Leave the model empty
   to use the provider's configured default, then create the Agent.
4. Send a prompt, follow the conversation and tool activity, and explicitly
   respond to any supported approval or user-input requests.

**Settings** saves project defaults for future background Agents. **History**
browses retained workers and offers explicit resume for eligible closed workers.
Closing the page or stopping Web leaves the independent native runtime and
workers running; use **Close executor** or `hcc native close --peer <peer>`
when you want to close a worker. See [Native Workers](docs/native.md#start-from-web)
for lifecycle details.

### Continue A Managed Local Terminal

After the first shim install, open a new terminal or reload the rc file for
your shell:

- bash: `source ~/.bashrc`
- zsh: `source ~/.zshrc`
- fish: `source ~/.config/fish/config.fish`

Start normal Claude/Codex terminal sessions from the project:

```bash
claude
codex
claude --resume <session-id>
codex resume <session-id>
```

Those sessions become tmux-backed peers that can be seen and controlled from
Web while remaining usable from the local terminal. The shims only use the
runtime resolved for the current project, including its private state directory
when applicable. Without a current-project Web runtime, they fall back to the
real provider CLI; they do not use the global Web runtime to register unrelated
directories or create project databases.

Web controls HCC-managed workers and terminals. Cooperation with an existing
provider desktop App uses separate opt-in adapters; see
[Desktop Agent communication](docs/app-bridge.md) for the supported paths.

## Basic Workflow

```bash
hcc task create --title "Review router changes" --priority 20
hcc task next
hcc task running --id 1 --summary "Started"
hcc lock acquire --resource src/router --ttl 900 --reason "edit router"
hcc status
hcc handoff create --summary "Router change ready for review" --tests "npm test"
hcc task done --id 1 --summary "Done"
```

Ask an agent what is happening in the project:

```text
What are the other hello-cc sessions doing?
```

Attached Claude/Codex sessions should answer from live `hcc` state rather than
generic session-isolation assumptions.

## Documentation

- [Documentation Index](docs/README.md): all user and implementation docs.
- [User Guide](docs/guide.md): setup, Web console, workflows, coordination
  semantics, and environment behavior.
- [Command Reference](docs/commands.md): compact public command list.
- [Project directory identity and private state](docs/private-state.md): v2
  bindings, replacement generations, offline upgrades and verified Codex history.
- [DeepSeek Harness](docs/dsh.md): hooks/Cordis collaboration, ACP workers,
  project setup and Web launch, with real-model and local-package acceptance evidence.
- [Native Workers](docs/native.md): HCC-owned Codex, Claude SDK, and dsh ACP
  workers, delivery receipts, permissions, and saved-session ownership.
- [Web Workflows (Chinese)](docs/web-handoff.zh-CN.md): new Agents, project files,
  structured interactions, history, and local/Web handoffs.
- [Desktop Agent Communication](docs/app-bridge.md): opt-in cooperation with
  original provider Apps and their execution boundaries.
- [Changelog](CHANGELOG.md): release notes for published versions.
- [Design Notes](docs/design.md): product boundaries and coordination model.
- [Implementation Notes](docs/implementation.md): architecture and internal
  protocol.

## Testing

```bash
npm test
```

The regression suite uses temporary projects, fake Claude/Codex binaries,
temporary tmux sessions, and a temporary Web runtime to test the main flows.

## License

[Apache-2.0](LICENSE)

---

<p align="center">
  <a href="https://star-history.com/#Dullne/hello-cc&Date">
    <img src="https://api.star-history.com/svg?repos=Dullne/hello-cc&type=Date" width="600" alt="Star History Chart">
  </a>
</p>
