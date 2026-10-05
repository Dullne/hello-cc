# Desktop Agent communication

Message persistence, model context admission and completed replies are separate
states. HCC-owned native workers do not take over existing Desktop chats.

These commands are introduced in preview version `1.1.0-rc.5` and require
Node.js 24+. Use the existing `preview` installation channel. From this source
checkout, replace `hcc` below with `node ./bin/hcc.mjs`; older installed versions
do not include these commands. Codex in-session cooperation requires `1.1.0-rc.7`.

| Surface | Implementation | Evidence boundary |
| --- | --- | --- |
| DeepSeek Harness App / Web | Cordis tools and idle inbox wakeup on live Agents | Installed Desktop, official DSH 0.2.0-rc.2 and `deepseek-official/deepseek-flash`: idle bus delivery completed with no prompt API call, one reply and one ACK on 2026-10-06 |
| Claude Desktop Code tab | Opt-in Mod for one selected existing session, bus replies and correlated completion | Embedded Claude Code 2.1.287+; protocol tests and official 2.1.289 strict static validation passed; Desktop acceptance pending |
| Codex App | Original-session terminal cooperation and opt-in MCP plugin; separate read-only socket probe | Per-call thread capabilities; active inbox wait, not automatic idle wakeup. Plugin loading and hook trust require separate device verification |

## DeepSeek Harness

Use the existing [Cordis integration](dsh.md). `inboxPollMs` defaults to 1000,
accepts 100–60000, or 0 to disable idle polling. Set it in the Harness plugin
configuration, not HCC's integrity-checked managed files. Active-step tools and
context remain enabled.

Only complete unread messages from other peers trigger `Agent.followup()`.
Self messages cannot wake the Agent or starve later external input. Admission
and tool policies remain effective. Only exact committed context is ACKed.
Cancelled/rejected batches remain unread without automatic retry loops.
Unload removes only this plugin's queued input; reload rediscovers live Agents.
Ambiguous commits across a reload gap are not automatically replayed.

```sh
node scripts/dsh-inbox-acceptance.mjs --dsh-install /absolute/path/to/official-install
```

This isolated test uses ACP for Agent creation/cleanup but never calls
`session/prompt`. It uses localhost deterministic responses, no credentials,
and does not install or modify the user's App.

## Claude Desktop Code

Ordinary Chat and CLI Channels are different integrations. Check the embedded
Desktop engine, not only the independently installed CLI:

```sh
hcc app claude capability --version 2.1.287
hcc --root /absolute/project app claude serve --session-id EXISTING_SESSION_ID
```

The first command only checks the version prerequisite. The foreground bridge
prints a new private marketplace directory, plugin name, marketplace name and
peer ID. Explicitly load it in the original Desktop Code session:

```text
/plugin marketplace add <marketplaceDirectory>
/plugin install <pluginName>@<marketplace>
/reload-plugins
```

Desktop also supports **+ → Plugins → Add plugin**. Each generated marketplace
has a unique name/version. HCC does not install/upgrade plugins or modify global
settings/accounts. The generated `hcc-session-link` plugin and marketplace
both passed official Claude Code 2.1.289 `claude plugin validate <directory>
--strict`. This static check does not establish target Desktop compatibility
or replace device acceptance.

The target must not already have another HCC hooks/native/Mod owner. Once it
connects, send through the existing bus:

```sh
hcc --root /absolute/project msg send --from coordinator --to PRINTED_PEER_ID --body 'Review the current task results'
```

The Mod uses `$.prompt.submit()` with Mod provenance. Only the matching main
turn can complete the message; human turns and subagents cannot acknowledge
it. Reply and ACK commit atomically. Incoming replies never generate another
automatic reply. Queued/claimed/started do not mean completed. Aborts,
disconnects and uncertain restarts remain unread with durable intent records;
ordinary hooks also exclude those prior submissions from automatic context.
Normal inbox queries retain them for explicit inspection before another send.

Keep the command running. Ctrl-C removes this generated plugin and closes HCC's
bridge, preserving the App session. The 0700 directory/0600 files contain a
temporary local capability, not a Claude account credential: never publish or
commit them. Same-OS-user access is inside the local trust boundary, not
provider-attested identity.

References: [Mods](https://code.claude.com/docs/en/plugins/mods/overview),
[API](https://code.claude.com/docs/en/plugins/mods/api),
[installation](https://code.claude.com/docs/en/plugins/install).

## Codex App

Enable cooperation for the selected project and generate a local plugin marketplace:

```sh
hcc --root /absolute/project --json app codex setup --plugin-dir /absolute/new-marketplace
```

The command returns unique marketplace/plugin names. Add that local marketplace
and plugin in the App, then approve its `UserPromptSubmit` hook in App settings.
Generated configuration contains no session token. It uses the exact Node/HCC
paths that ran setup; regenerate after moving or upgrading that installation.
Setup does not claim that the App has loaded the plugin or trusted its hook.

The current App session can cooperate immediately through its terminal tool:

```sh
hcc --root /absolute/project --json app codex call --tool hcc_inbox
hcc --root /absolute/project --json app codex call --tool hcc_message_send \
  --arguments '{"to":"OTHER_PEER","body":"Please review the current change."}'
hcc --root /absolute/project --json app codex call --tool hcc_inbox_wait \
  --arguments '{"timeout_ms":45000}'
hcc --root /absolute/project --json app codex call --tool hcc_message_reply \
  --arguments '{"message_id":123,"receipt":"EXACT_RECEIPT_FROM_INBOX","body":"Review complete; local checks passed."}'
```

These commands use the current terminal invocation's `CODEX_THREAD_ID` and
require its `Codex Desktop` origin marker. They never start a CLI model, resume
a thread, or control another App session. Enrollment starts an unclaimed peer
as `idle`; subsequent reads preserve its task status. A capability alone is not
evidence that the model is currently running.

For MCP, run `app codex session` inside that same App session to obtain a private,
one-hour `session_token`. Each of the 13 tools requires that token and independently
checks the host-supplied `_meta.threadId`. A persistent MCP process's startup
environment is never used as per-call identity. `_meta.sessionId` and Hook
`session_id` are shared by a root thread and descendants, so the adapter does
not use them to select an inbox. The hook only supplies enrollment instructions.
Keep tokens out of replies and evidence. `app codex disable` revokes all project
capabilities; re-enabling never restores old tokens or another transport's owner.

`hcc_inbox` and `hcc_inbox_wait` retain unread messages. To confirm reading,
use `hcc_message_ack` with the exact message ID and receipt. `hcc_message_reply`
records a correlated reply and ACK in one transaction; identical retries reuse
the reply. Neither action completes a task. Replies are context, not a reason
to create automatic reply loops. Peer content does not grant user authorization.
The remaining tools share HCC's task, state, handoff, lock and local-evidence
rules. Same-connection waits allow concurrent sends and cancel when interrupted.

The wait is bounded to 45 seconds and works while the original App session is
actively calling it. It cannot wake an already idle chat. Official `Stop` hooks
can continue an existing turn, but are not an external idle-wakeup API. This
adapter leaves them unused rather than assigning a shared session ID to a child.

The separate endpoint diagnostic remains available:

```sh
hcc --root /absolute/project --json app codex probe \
  --socket /absolute/path/to/known-control.sock --thread EXISTING_THREAD_ID
```

The probe only initializes, reads thread metadata without turns, and performs
bounded loaded-thread queries. It never scans sockets, starts a daemon,
resumes/starts/interrupts threads, or reads accounts. Closing affects only its
own connection. Provider preview/name/error contents are not reported.

`loaded: null` means unestablished. `writable` and `desktopEndpointVerified`
remain false even when loaded. `thread/resume` can cold-restore a thread and
has no atomic only-loaded precondition. This does not rule out direct
`turn/start`: the inspected official handler gets an already-loaded thread
without resuming it, and can start or steer a turn. The unresolved requirement
for external sending is a supported endpoint known to belong to the original
App, plus its connection/subscription and authorization contract. An internal
App tool is not a public HCC interface.

Evidence on 2026-10-06 distinguishes Homebrew CLI 0.144.6 from installed App
26.930.21537 (12776), whose bundled CLI is 0.159.0-alpha.12.1. Both stable and
experimental schemas were generated offline from that bundled binary. Official
source was pinned separately at `823ea830c0fd418b09ff02d36cad9a1fff66465b`; an
exact source-to-binary build match is not claimed. See the official
[MCP per-call metadata implementation](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/core/src/mcp_tool_call.rs#L1395-L1428)
and [turn handler](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/request_processors/turn_processor.rs#L374-L388).
Official OpenAI documentation requests redirected from `developers.openai.com`
to `learn.chatgpt.com` and returned HTTP 403 there; their page contents remain
unverified. `app-server proxy` tunnels WebSocket bytes, not native stdio JSONL.
