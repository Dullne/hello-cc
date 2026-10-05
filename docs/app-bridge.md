# Desktop Agent communication

Message persistence, model context admission and completed replies are separate
states. HCC-owned native workers do not take over existing Desktop chats.

These commands are introduced in preview version `1.1.0-rc.5` and require
Node.js 24+. Use the existing `preview` installation channel. From this source
checkout, replace `hcc` below with `node ./bin/hcc.mjs`; older installed versions
do not include these commands.

| Surface | Implementation | Evidence boundary |
| --- | --- | --- |
| DeepSeek Harness App / Web | Cordis tools and idle inbox wakeup on live Agents | Pinned official runtime with a deterministic localhost model, not installed Desktop/model acceptance |
| Claude Desktop Code tab | Opt-in Mod for one selected existing session, bus replies and correlated completion | Embedded Claude Code 2.1.287+; protocol tests and official 2.1.289 strict static validation passed; Desktop acceptance pending |
| Codex App | Read-only explicit app-server socket probe | No prompt/resume or verified Desktop endpoint ownership |

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

```sh
hcc --root /absolute/project --json app codex probe \
  --socket /absolute/path/to/known-control.sock --thread EXISTING_THREAD_ID
```

The probe only initializes, reads thread metadata without turns, and performs
bounded loaded-thread queries. It never scans sockets, starts a daemon,
resumes/starts/interrupts threads, or reads accounts. Closing affects only its
own connection. Provider preview/name/error contents are not reported.

`loaded: null` means unestablished. `writable` and `desktopEndpointVerified`
remain false even when loaded. Public `thread/resume` can cold-restore a thread
and has no atomic only-loaded precondition. An in-app tool is not automatically
a public external HCC API. References are the installed official CLI 0.144.6
help/schema snapshot and the official local source tree at
`d109393270432531ac0010542ae7973801e0d9d7`. An exact CLI-to-source build match
and online documentation recheck are not established. `app-server proxy`
tunnels WebSocket frames, not native stdio JSONL.
