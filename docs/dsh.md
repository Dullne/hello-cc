# DeepSeek Harness Integration

English | [中文](dsh.zh-CN.md)

DeepSeek Harness (`dsh`) shares hello-cc project tasks, messages, advisory locks and handoffs with Claude Code and Codex. The integration has three entry points: the official hooks bridge, a native Cordis collaboration plugin, and HCC-owned ACP workers.

The tested runtime is `@deepseek-ai/dsh@0.2.0-rc.2`, with matching plugin versions. Use Node.js 24+ on `PATH` as well as for the parent CLI: the dsh executable uses `/usr/bin/env node`. This preview ships Web/headless/SDK/ACP profiles and no built-in TUI.

Supported hosts are Linux and macOS; on Windows use WSL. Native Windows shells are not supported. Device acceptance must be recorded separately from container verification.

This integration has been included since hello-cc 1.0.2 on the normal npm `latest` channel. With Node.js 24+, install it using `npm install -g @logicseek/hello-cc`. To test a source checkout instead, use:

```bash
node /absolute/path/to/hello-cc/bin/hcc.mjs --root /path/to/project dsh setup --mode cordis
node /absolute/path/to/hello-cc/bin/hcc.mjs --root /path/to/project dsh status
node /absolute/path/to/hello-cc/bin/hcc.mjs --root /path/to/project dsh web -- --port 8080
```

Below, `hcc` means a CLI containing these changes. An older global installation may not include them.

## Choose An Entry Point

| Entry | Use | Lifecycle owner |
| --- | --- | --- |
| `hcc dsh web --mode cordis` | Converse in Harness Web; the model uses `hcc_*` tools | Harness, with multiple independent Agents/workspaces per service |
| `hcc dsh web --mode hooks` | Use the official Claude hooks bridge and identity-bound CLI commands | Harness; the default compatibility mode |
| `hcc native start --provider dsh` | Submit prompts, inspect receipts, interrupt and close through HCC CLI/Web | One dedicated ACP process per HCC worker |

Use one collaboration injector per session. Native workers have their own scoped MCP capability and lifecycle; do not additionally mount the Cordis/hooks collaboration injector in that process.

## Harness Web And Cordis

Configure Harness credentials first. The launcher preserves an existing `DEEPSEEK_API_KEY` and provider-routing environment. Use your installed dsh, or install the tested preview yourself:

```bash
npm install -g @deepseek-ai/dsh@0.2.0-rc.2
cd /path/to/project
hcc dsh setup --mode cordis
hcc dsh status
hcc dsh web -- --port 8080
```

Open the URL printed by Harness and create a real Agent using the project as its workspace. Starting the service alone creates no Agent peer. Start `hcc web --local` separately for the HCC dashboard; its dsh filter shows raw session IDs and lets you inspect state and send project messages.

The Cordis plugin awaits `agent/created`, delegates the `agent/pre-step` decision chain, observes Agent status/disposal and tool events, and fixes each execution's authority from `exec.agent`. It never borrows service-level `HCC_PEER` identity.

| Tools | Purpose |
| --- | --- |
| `hcc_state`, `hcc_task_list`, `hcc_inbox` | Read project state, tasks and this peer's inbox |
| `hcc_task_next` | Continue an owned task or claim pending work; never complete it automatically |
| `hcc_message_send` | Send a project message as this Agent |
| `hcc_handoff` | Record a handoff for an owned task |
| `hcc_lock_acquire`, `hcc_lock_release` | Acquire/release this peer's scoped locks |
| `hcc_result_list`, `hcc_result_record` | Read/record local verification evidence, without claiming publication or business acceptance |

The plugin reuses CLI/MCP transactions and task/lock ownership rules. Context and tool output are each bounded to 16,000 characters by default. Truncation is explicit; incompletely delivered messages remain unread. The shared service also validates argument bounds and authority. ACK occurs only when Harness commits the exact context as a `user/message`; rejected admission, preparation failure and cancellation do not ACK early.

`next()` delegation preserves deny/ask policy. Closing an Agent expires only its own peer. Unloading removes listeners/tool registrations and revokes stale authority; an existing Agent initializes again at its next awaited pre-step after reload. After an unclean exit, the same session can recover its Cordis owner only when the recorded process is verified dead or its PID has been reused. Live or unverifiable owners and conflicting hooks/native bindings remain protected. A project message does not wake an indefinitely idle Harness conversation. It enters at the next model step, or at an active turn's stop boundary.

## Modes, Arguments And Routing

```text
hcc dsh setup [--mode hooks|cordis|off]
hcc dsh status [--dsh-bin PATH]
hcc dsh web [--mode hooks|cordis|off] [--dsh-bin PATH] [--dsh-home PATH] -- [dsh arguments]
```

First setup defaults to `hooks`; later invocations without `--mode` retain the saved mode. Status verifies managed content and the executable without making a model request.

```bash
hcc dsh setup --mode hooks
hcc dsh setup --mode cordis
hcc dsh setup --mode off
hcc dsh web --dsh-bin '/opt/harness/bin/dsh' --dsh-home '/path/to/dsh-home' -- --port 8080 --no-open
hcc dsh web --help       # HCC wrapper help
hcc dsh web -- --help    # Harness Web help
```

`--dsh-bin` selects an executable file. `--dsh-home` sets child `DSH_HOME`; relative paths resolve from the invoking directory. Harness arguments go after `--` and retain order and values, including extra overlays. Mode changes apply to subsequent launches: close your owned runtime and relaunch. Existing hooks/native sessions are not forcibly rebound to Cordis; use a new session when switching and retain old collaboration records.

| Managed file | Purpose |
| --- | --- |
| `.hello-cc/dsh/hooks.json` | Dedicated HCC hooks for the five supported events |
| `.hello-cc/dsh/cordis.patch.yml` | Loads the selected injector only; off is an empty overlay |
| `.hello-cc/dsh/managed.json` | Mode, ownership, paths, baseline and SHA256 hashes |

Setup/disable/re-enable are idempotent. Re-run setup after moving/upgrading source to refresh absolute paths. Edited/foreign files, links and ownership conflicts are preserved and reported. Put custom configuration in a separate overlay. Setup does not install dsh, edit user homes, copy keys or import all Claude/Codex hooks.

The real session ID and absolute Agent cwd route to that workspace's `.hello-cc/mesh.db`, without searching parent projects. Raw non-UUID IDs remain intact. Hash collisions, aliases and another live transport's ownership are rejected. Hooks/Cordis peers cannot be stopped/restarted through detected-peer controls or converted to tmux terminals; a service-log pane remains an independent shell peer.

The rc.2 hooks bridge awaits SessionStart before the first turn. PreToolUse tracks activity; PostToolUse/Stop can deliver context. The official bridge does not consume PreToolUse additionalContext. Hook ACK follows successful hook output, while Cordis ACK follows the corresponding committed context record.

## ACP Workers

```bash
hcc native up
hcc native start --peer dsh-reviewer --provider dsh
hcc native send --peer dsh-reviewer --from coordinator --body 'Review the current diff and report verification evidence'
hcc native deliveries --peer dsh-reviewer
hcc native events --peer dsh-reviewer
hcc native interrupt --peer dsh-reviewer
hcc native close --peer dsh-reviewer
hcc native start --peer dsh-reviewer --provider dsh --binary /absolute/path/to/dsh --resume last
```

The default launcher is `dsh` on PATH; use `--binary /absolute/path/to/dsh` when necessary. A worker owns a dedicated `dsh --profile acp` process. Send returns an admission receipt; only authoritative prompt completion commits a delivery. Resume retains provider session identity and memory. ACP does not replay the full transcript or offer fork/steer. Use native Web controls and approval responses, rather than detected-peer registration actions. See [Native Workers](native.md).

## Bundle And Verification

The package declares `dsh.bundle`, ships `lib/integrations/dsh.bundle.yml` and `dsh-cordis.d.ts`, and declares `engines.dsh=0.2.0-rc.2`. The plugin also checks the actual agent/agent-loop/tools/session package versions before registration.

Project overlays work directly from source. The managed manifest records the Cordis module location, allowing setup to verify and migrate unedited overlays when switching between source and npm installation directories; edited files are preserved. For profile installation, generate a tarball containing these changes and use the official package-management entry point:

```bash
npm pack --ignore-scripts
dsh plugin --profile web add /absolute/path/to/logicseek-hello-cc-1.0.4.tgz
```

Harness requires explicit approval for native dependency builds. If add returns `ERR_PNPM_IGNORED_BUILDS`, merge the following into the selected profile's `pnpm-workspace.yaml` and rerun the same add command. The default path is `~/.dsh/profiles/web/pnpm-workspace.yaml`; use the configured DSH_HOME when different. Preserve existing settings and approve only the candidate's pinned native dependency:

```yaml
allowBuilds:
  node-pty@1.2.0-beta.15: true
```

Harness selects bundles through the profile's `dsh.profile.bundles`; do not also load the project Cordis/hooks overlay. Actual npm installation, official add/repeated add/remove, profile resolution and real-model collaboration calls have passed. The actual macOS desktop profile was installed and hot-loaded on 2026-10-02. Its paired ACP worker completed real collaboration calls using the existing DeepSeek route. The initially configured desktop sub2api model returned HTTP 403 because that account only accepts official Codex clients. After the desktop default was observed to have changed to official DeepSeek, a new session completed hcc_state, hcc_message_send and a real completed turn with that existing selection. The original sub2api route restriction remains. Maintenance releases use the normal npm latest channel. Harness manages profile package removal; project-overlay integration is disabled with `setup --mode off`.

See Cordis/native acceptance (source checkout: `docs/verification/2026-10-02-dsh-cordis-native.md`), bridge acceptance (source checkout: `docs/verification/2026-10-02-dsh-official-bridge.md`), and the integration plan (source checkout: `docs/plans/2026-10-02-dsh-integration.md`). Real-model checks used temporary projects and owned processes, without replacing existing user sessions. The isolated order fixture passed artifact/evidence/handoff/lock-release/task-completion checks. See the Mac device receipt (source checkout: `docs/verification/2026-10-02-dsh-device-install.md`). Publication, deployment, other-device installation and genuine business acceptance remain separate delivery stages.

The installed acceptance script performs npm installation, official `plugin add` / repeated add / remove, and runs the installed public CLI. `--run-live` retains the existing DeepSeek authentication to test ACP approval denial and an isolated order-summary workflow. Without it, no real model is called. All homes, profiles, projects and processes belong to the acceptance run.

```bash
node scripts/dsh-installed-acceptance.mjs /absolute/path/to/isolated-dsh-install \
  --run-live --output-dir /absolute/path/to/acceptance-output
```

The output contains a candidate tarball, its SHA256 and installation receipt, redacted command logs and the verified order report. The approval probe adds an ask policy for one test-owned file in a private profile, rejects the actual ACP request and verifies the file was not created. The fixture demonstrates a local task workflow; it does not establish genuine business acceptance.
