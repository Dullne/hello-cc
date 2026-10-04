# Native workers

Native mode runs background workers that HCC creates and owns. HCC keeps the
shared peer, task, message, lock, and handoff model; each provider adapter owns
its execution connection and reports structured lifecycle events.

| Provider | Connection | Session identity | Busy-worker input |
| --- | --- | --- | --- |
| Codex | Owned `codex app-server` over stdio JSON-RPC | Codex thread ID | Adapter supports `turn/steer` with the active turn precondition |
| Claude | Optional Claude Agent SDK, persistent streaming input | Claude session ID confirmed by SDK initialization | One submission at a time; steering is unsupported |
| DeepSeek Harness | Owned `dsh --profile acp` process | ACP session ID | One submission at a time; steering is unsupported |

The HCC host currently dispatches one inbox message at a time to each worker,
including for Codex. Adapter support for steering does not mean the host sends
multiple pending inbox messages into the same turn. ACP resume and session close
depend on the extensions the provider advertises. HCC does not claim that an ACP
resume replays the original conversation transcript.

## Requirements

Use Node.js 24 or later and a provider installed and authenticated in the same
environment as HCC. Native mode preserves authentication configuration and does
not rewrite accounts, provider settings, or the user's home directory.

Codex needs an app-server-compatible CLI. DeepSeek Harness uses its ACP profile;
the implementation targets `@deepseek-ai/dsh-acp@0.2.0-rc.2`. This mode does not
connect to a running dsh Web service.

Claude's SDK remains optional and is loaded only when a Claude worker opens.
For a checkout of this repository, install the documented SDK version explicitly:

```sh
npm install --no-save --package-lock=false @anthropic-ai/claude-agent-sdk@0.3.287
```

For a global HCC installation, install that version into the same npm prefix:

```sh
npm install -g @anthropic-ai/claude-agent-sdk@0.3.287
```

Alternatively, install the optional SDK in the worker's project:

```sh
cd /absolute/path/to/worker-project
npm install --no-save --package-lock=false @anthropic-ai/claude-agent-sdk@0.3.287
```

The default loader first checks HCC's installation, then the worker project's
node_modules, so a global HCC can use a project-local SDK. HCC never installs
packages automatically. Missing SDKs produce installation guidance; errors from
a found SDK's exports or dependencies retain their original cause. A separate
real Web approval receipt (source checkout: `docs/verification/2026-10-02-native-web-claude-default-sdk.json`)
exercises this default project lookup without injecting a query function. It
does not verify a published package or an employee installation.

## Start from Web

Run `hcc web`, select the project, and choose **New Agent**. Codex, Claude and
DeepSeek Harness default to **Background Agent**, which creates a native worker
and starts or reuses the project's independent native runtime. You do not need
to run `hcc native start` first; the provider requirements above still apply.

**Settings** can save the project default provider plus a model and an in-project
working directory for each provider. **New Agent** prefills these values; when no
directory is configured it uses the project root. The worker continues to share the selected
project's HCC task and message bus. Select or add another project to work outside
that root. **Model (optional)** can stay empty to use the provider's configured
default; any supplied value must be supported by that provider. **Name (optional)**
can stay empty for a generated peer name.

These defaults live in the selected HCC project database and apply only to future
Web native creations. They do not change running workers, history resume, CLI
launches or provider account files. Concurrent saves use revision checks; reload
and review the latest values after a conflict. Clearing the model in the creation
form explicitly chooses the provider's own default for that one worker.

**New Agent** creates a new native session. **History → HCC retained history**
browses saved native workers and explicitly resumes workers recorded as closed.
Resume keeps the peer and provider session ID, rechecks ownership, and starts a
new executor. CLI resume remains available. **Advanced options** keeps the terminal
CLI and Codex App Server paths, including their existing history controls. Shell
uses a terminal; DeepSeek Harness uses a background worker.

After creation, send prompts and inspect receipts or approvals in the same Web
session. Creating a worker does not by itself complete a model task. Closing
the page or stopping Web preserves the independent native runtime and worker;
explicitly close the worker when it is no longer needed. The dated acceptance
records below do not establish real-model or release acceptance of this new
creation or history/resume entries. See the [Web guide](web-handoff.zh-CN.md).

The **Files** entry browses saved project files and artifacts without creating a
worker or sending file contents to a model. It provides bounded text, Markdown,
image, PDF and static HTML previews. Explicit uploads create new project files
without replacing existing names (up to 10 MiB); complete UTF-8 text files can be
edited and saved with a revision check (up to 1 MiB). Conflicts and uncertain write
results keep the draft for inspection. These actions do not attach files to a model
conversation. See the [project file guide](web-handoff.zh-CN.md#上传与编辑项目文件).

## CLI

Run commands from the project you want the workers to share, or select it with
the existing global `--root` and `--db` options.

```sh
hcc native up
hcc native start --peer codex-reviewer --provider codex
hcc native start --peer claude-reviewer --provider claude
hcc native start --peer dsh-reviewer --provider dsh
hcc native send --peer codex-reviewer --from coordinator --body "Review the current changes and report concrete findings."
hcc native status
hcc native deliveries --peer codex-reviewer
hcc native events --peer codex-reviewer --after 0
hcc native requests --peer codex-reviewer
hcc native respond --peer codex-reviewer --request REQUEST_ID --decision accept
hcc msg inbox --peer coordinator
```

`start` starts the project's native runtime when needed. Workers share its HCC
message bus even when `--cwd DIR` selects another working directory. `--model
MODEL` selects a provider-supported model. `--binary PATH` overrides the Codex
or dsh executable. Claude uses the SDK and rejects `--binary`.

| Command | Options / behavior |
| --- | --- |
| `hcc native up` | Start or reuse the project's background runtime |
| `hcc native status` | Inspect persisted worker state and runtime identity |
| `hcc native start` | Required `--peer NAME --provider codex\|claude\|dsh`; optional `--cwd DIR --model MODEL --resume last`; `--binary PATH` is available only for Codex and dsh |
| `hcc native send` | Required `--peer NAME --body TEXT`; optional `--from NAME --task ID`; returns a durable message/submission receipt |
| `hcc native deliveries` | Optional `--peer NAME`; inspect delivery receipts |
| `hcc native events` | Required `--peer NAME`; optional `--after ID`; inspect a bounded event history |
| `hcc native requests` | Requires `--peer NAME`; inspect pending requests bound to this executor, session and turn |
| `hcc native respond` | Requires `--peer NAME --request ID --decision accept\|decline\|cancel`; use `--response-file JSON` for permission subsets, answers or MCP form content |
| `hcc native interrupt` | Required `--peer NAME`; optional `--turn ID`; request interruption of the active turn |
| `hcc native close` | Required `--peer NAME`; close that worker's owned connection/process |
| `hcc native down` | Request worker closure and runtime shutdown; returns a stop-request receipt |

The `native down` receipt confirms the stop request, not completed shutdown.
Inspect `native status` to check the outcome. If provider shutdown fails, HCC
retains runtime ownership and reports the error in `status.shutdown_error`;
resolve the reported problem and retry `native down`.

Worker events retain semantic output and completion evidence; token deltas are
not persisted as delivery receipts. The runtime keeps local state under
`<project>/.hello-cc/native/` and coordination records in the selected HCC
database. Runtime control is a local authenticated API, separate from the
browser terminal transport. Treat its local runtime pointer and log as private
project state.

## Reading delivery receipts

A successful `native send` queues a message. It does not mean the provider has
read it, completed it, or returned a business result.

| State | Meaning |
| --- | --- |
| `queued` | Stored on HCC's message bus, waiting for dispatch |
| `dispatching` | HCC started handing the submission to its adapter; provider admission is still pending |
| `submitted` | The adapter queued/wrote the prompt, without a provider admission receipt |
| `accepted` | Provider-confirmed admission or matching provider output establishes that this submission/turn is being processed; work is still pending |
| `completed` | An authoritative matching main-turn result reports success; HCC acknowledges the message and can write an automatic reply for a non-reply message |
| `failed` | A definitive rejection or unsuccessful main-turn result; not a successful acknowledgement |
| `uncertain` | A timeout, lost process/connection, or runtime restart left the outcome unknown; automatic retry could duplicate work |

An SDK consuming an input iterator proves transport submission, not provider
acceptance or a completed model turn. Claude advances from `submitted` to
`accepted` after matching assistant output is observed. Claude reports its
actual session ID on initialization, so a freshly
opened worker can legitimately have a null session ID until its first prompt.
An interrupt request does not cancel an SDK input that is still queued and does
not itself complete a delivery. Only a matching main-turn result settles it.

An inbox message with `kind: 'reply'` is still delivered as context and
acknowledged after its main turn succeeds. Its output remains in `events`, but
HCC does not automatically generate another reply, preventing reply loops.
For other message kinds, a successful main turn with output writes an automatic
reply to the sender.

For an uncertain delivery, inspect `deliveries`, `events`, and provider state
before sending a replacement. HCC leaves uncertain deliveries out of automatic
retries. Runtime restart records in-flight work as uncertain rather than
pretending it failed or completed.

## Ownership, hooks, and permissions

Resume an HCC-owned saved session with the same peer and provider:

```sh
hcc native close --peer codex-reviewer
hcc native start --peer codex-reviewer --provider codex --resume last
```

An explicit saved ID is accepted only when it matches HCC's record for that peer
and provider. Resume restores a conversation through a newly owned connection;
it does not attach to an existing live TUI or desktop instance. HCC cannot prove
that an external application has independently opened the same saved session,
so do not open the same conversation concurrently outside the owned runtime.

New saved workers also retain the filesystem identity of their working
directory. Resume requires that identity to still match, even if the path
spelling is unchanged. Older workers without that evidence remain readable in
HCC history but are not automatically resumable; manual review and association
are not yet implemented. Web history marks these records as unavailable before
the native service rechecks at admission.

Native workers receive a worker-specific `HCC_ROOT`, `HCC_DB`, `HCC_PEER`, and
`HCC_NATIVE_OWNER`. A provider hook must match the peer's native transport owner.
Its native hook path only heartbeats that owner and renews its locks. It does
not change provider bindings or process identity, inject another copy of the
inbox, acknowledge messages, or block a Stop hook. Mismatched owner markers fail
without falling back to normal terminal-hook delivery.

Providers keep their permission checks. HCC-hosted workers wait for an explicit
response from the current Web controller or the local CLI when an operation
requires approval. Closing Web leaves both the worker and its pending requests
available to the local CLI. Requests expire when their turn ends, interruption
is accepted, the provider resolves them, or the worker closes. A late request
from an interrupted turn cannot reopen approval. Direct adapters without a
hosted responder retain conservative denial.

| Provider | Hosted interaction |
| --- | --- |
| Codex | Command/file approval, requested filesystem/network permission subsets with explicit turn/session duration, questions including freeform/secret input, one-call empty-form MCP tool approvals and common MCP form fields |
| Claude | SDK tool permission callback; approval grants the original tool input once without rewriting it |
| dsh ACP | Offered permission choices; approval selects only `allow_once`, never `allow_always` |

rc.2 may send only a tool-call ID in an ACP approval request. The adapter correlates same-session/turn tool updates to show the operation input. Missing or truncated input still allows rejection; acceptance returns `NATIVE_APPROVAL_CONTEXT_MISSING`. See dsh installed acceptance (source checkout: `docs/verification/2026-10-02-dsh-cordis-native.md`).

Native approval cards show the tool, command or target path and a content
preview before the decision. Full operation details can be expanded and stay
expanded across state refreshes. ACP approval is disabled when operation input
or a one-time option is missing; rejection remains available. Shortened
previews are identified, with complete parameters still available.

Hosted interactive Codex threads explicitly enable
`features.default_mode_request_user_input` and `features.request_permissions_tool`
in their private start/resume configuration. Web-owned start/resume/fork uses
the same switches. These experimental capabilities were exercised in Codex
0.144.6; they do not write global configuration or grant filesystem/network
permissions. Approval remains on-request with the user as reviewer.
Noninteractive direct adapters retain their defaults. The permission form
shows mirrored legacy and current path entries once, preserving distinct
access choices, original request indices and denial rules.

Claude keeps `permissionMode: 'default'`; tools already permitted by that mode
can run. Approval responses are fenced by the runtime generation, worker owner,
provider, session, turn and request ID. Web observers cannot submit responses;
a browser that loses control cannot answer with its old control epoch. Direct
answers, including secrets, are omitted from HCC snapshots, events, delivery
receipts and browser storage; form drafts remain in browser memory only.

For Codex permissions/questions, use a response file. These are separate
examples; paths, question IDs and answer labels must match the pending request:

```json
{"permissions":{"fileSystem":{"read":["/requested/read/path"]}},"scope":"turn"}
```

```json
{"answers":{"question-id":{"answers":["An offered label or permitted freeform answer"]}}}
```

```sh
hcc native respond --peer codex-reviewer --request REQUEST_ID --decision accept --response-file ./response.json
hcc native respond --peer codex-reviewer --request REQUEST_ID --decision cancel
```

Only `permissions`, `scope`, `answers` and `content` are accepted in that file. For MCP forms, use the original field names and types, for example `{"content":{"project":"demo","count":2,"enabled":false}}`. Permissions
can narrow the request but cannot add paths or network access; requested deny
entries must be retained when granting filesystem access. Answer every question
explicitly. Truncated requests can only be declined or cancelled. Nested schemas, dynamic tools and account-token refresh requests remain unsupported. Correlated MCP `url` requests are supported through the Web authorization entry described below.

## Current boundaries

- Existing Codex/Claude/dsh terminal sessions remain on their original transport;
  attaching to or taking over an existing TUI/Desktop session is not implemented.
- Web can create Codex, Claude and dsh native workers, and discovers existing
  workers in the same project. It exposes messages, delivery receipts,
  interruption, and explicit closure. History reads retained project events and
  explicitly resumes closed workers; it is not the provider's complete transcript.
  Active workers and workers without confirmed closure cannot resume from this
  entry. Closing the page or Web runtime
  preserves the independent native worker. Human responses are bound to the
  current executor and turn. See the [Web handoff guide](web-handoff.zh-CN.md).
- Codex, Claude and dsh native workers receive project- and peer-scoped HCC MCP
  configuration. Writes still require provider permission and HCC ownership checks.
- Provider-internal `SendMessage`, subagent/team discovery, and Codex delegation
  tools are not exposed as one cross-vendor protocol. HCC routes cross-provider
  messages through its own durable bus and adapters.
- Task claiming, file locks, handoffs, and completion checks remain explicit HCC
  coordination operations; successful prompt execution alone does not prove a
  task's business acceptance.
- Adapter tests cover protocol and interaction boundaries. The authenticated
  checks below provide separate evidence for model execution and scoped MCP;
  the installed-package harness below checks installation separately.
  Stakeholder acceptance of a production workflow remains a separate step.


## Authenticated acceptance on October 2, 2026

Independent temporary projects and provider state directories were used for real
model calls with Codex 0.144.6, Claude Agent SDK 0.3.287 and DSH 0.2.0-rc.2. The
session lifecycle receipt (source checkout: `docs/verification/2026-10-02-native-live-lifecycle.json`)
covers correlated replies and ACKs, idempotent queueing, continuing context,
owned close/resume and active interruption. A real Codex command approval was
declined, and its test write outside the allowed sandbox did not occur.

The cross-provider receipt (source checkout: `docs/verification/2026-10-02-native-live-communication.json`)
covers actual model calls to the scoped HCC MCP message tool along
`Codex → Claude → dsh → Codex`, receiver model replies, reply consumption and ACK,
and the absence of automatic reply loops. It also verifies discovery and sending
through the Web bridge, original provider binding preservation and worker
survival after closing that bridge. These receipts are separate source snapshots.

Codex MCP tool approvals use `mcpServer/elicitation/request`. HCC submits the
official action/content response for explicit tool confirmations without
persisting session/always authorization. Standard `form` requests support strings, numbers/integers, booleans, single-select and string-enum multi-select fields, with titles, descriptions, suggested defaults, required fields, length/numeric/selection limits and common mailbox/URI/date/date-time format checks. Optional fields are sent only when explicitly included, and booleans require a yes/no choice. Limits are 50 fields, 100 options per field, 8192 UTF-16 units per string and 65536 characters each for schema and response content.

Correlated MCP `url` requests display the authorization destination and an **Open authorization page** action. Only the current controller can submit it. HCC reserves a blank tab on the explicit click and navigates after the original executor accepts the exact request; stale requests close the blank tab. Popup blocking leaves the request pending. HTTPS and loopback HTTP are allowed; credentials in the URL, other schemes, missing elicitation identities and truncated requests block acceptance while retaining decline/cancel. The new tab has no opener or referrer. Loopback destinations require a browser on the executor computer; HCC does not proxy local login callbacks to another device.

Opening sends only `{ "action": "accept" }` and is not proof of successful authentication. Complete the external flow, then return to the task and follow the provider result. HCC does not invent a completion event or collect credentials in its form. URLs, device messages, opaque elicitation ids and metadata remain in the live pending request only; HCC interaction events and browser storage do not retain them. Provider-owned logs/history and the destination browser retain their existing behavior. Account login, token refresh, `openai/userVerification` and external-flow completion APIs remain separate unsupported capabilities.

State refresh keeps edits in page memory. Submission, request removal or session changes clear them; a full page reload does not recover answers. HCC browser storage, events and delivery receipts do not retain form responses through the interaction-response path. Provider-owned history and model output retain their existing behavior. The owning server revalidates types and constraints and preserves executor/session/turn/request fencing. Nested objects, unrestricted arrays, unknown constraints and OpenAI extended form modes remain visibly unsupported with decline/cancel available.

To reproduce browser acceptance, set `HCC_ACCEPTANCE_PLAYWRIGHT` to a Playwright module and run `node scripts/web-mcp-form-acceptance.mjs --run-browser`; optionally set `HCC_ACCEPTANCE_CHROME`. This uses simulated providers with the production HTTP/SQLite/native runtime and isolated browsers; it makes no model calls. See the source-checkout report `docs/verification/2026-10-02-mcp-form-web-validation.md`.

Installed-model acceptance uses `node scripts/web-mcp-form-live-acceptance.mjs --run-live` with `HCC_ACCEPTANCE_PLAYWRIGHT`; `HCC_ACCEPTANCE_CHROME`, `HCC_ACCEPTANCE_TMUX`, `--codex-bin PATH` and `--output NEW_FILE` are optional. Without the opt-in flag it only prints help. A live run consumes quota on the currently configured model/account. Installed Codex calls a disposable stdio MCP tool; actual Web interactions accept the tool confirmation and submit the field form. The harness checks typed responses, model-written results, continuation on the same native executor after Web shuts down, and a Web-owned App Server form. It injects neither model output nor App Server requests.

The HCC user directory, Codex home, project, tmux socket and browser profile are disposable. A configured external credential helper can retain its original user home for read-only credential retrieval; the original provider/model, login and configuration remain intact. Receipts include source hashes, checks, cleanup results and original config/auth/shell-config hash checks. Output paths must be new so existing receipts are preserved. Fixture logs contain synthetic form values only.


The local validation receipt (source checkout: `docs/verification/2026-10-02-native-live-validation.json`)
records the unit suite (785 passed, one platform-dependent skip), a 63-module
static audit, the 13-stage regression and offline harness failure cleanup.
Each check retains its own execution time and evidence digest.

The opt-in `scripts/native-live-acceptance.mjs` harness defaults to help. It calls
models and consumes the caller's provider quota only with `--run-live`:

```sh
node scripts/native-live-acceptance.mjs --run-live --provider all \
  --codex-bin /absolute/path/to/codex \
  --dsh-bin /absolute/path/to/dsh \
  --claude-sdk /absolute/path/to/claude-agent-sdk/sdk.mjs \
  --permission-probe --cross-provider \
  --output /absolute/path/to/receipt.json
```

Use `--communication-only` for the cross-provider test alone. The explicit SDK
entry was used for Claude acceptance; this does not prove repository-default SDK
resolution or package installation. The script installs no dependencies, never
attaches to existing conversations, and closes owned test processes and removes
credential copies on exit. Web evidence covers its service/bridge control layer,
not a full browser interaction or published-client acceptance. Real business task
acceptance remains a separate check.


For real model and browser interactions, use
`scripts/web-native-interaction-acceptance.mjs`. It defaults to help; only
`--run-live --provider codex|claude|dsh|all` invokes models. Set
`HCC_ACCEPTANCE_PLAYWRIGHT` and optionally `HCC_ACCEPTANCE_CHROME`.
`--claude-package DIR` links an installed SDK package into the isolated worker
project for default resolution, without injecting its query function. The
harness checks explicit approval and rejection and continuing the original
session. It uses existing authentication/quota, cleans test provider homes and
processes, and never attaches to existing user conversations.


`--provider dsh --dsh-bin /absolute/path/to/dsh` uses the installed public launcher
and existing `DEEPSEEK_API_KEY`. The harness adds an official `tools/pre-execute`
ask policy to a private ACP profile for only two acceptance-owned target files.
Permission requests come from real model tool calls; no ACP request injection is
used. It verifies an approved write, absence of a declined target, local return
to the same session, and desktop and 390px mobile approval controls. See the
dsh Web interaction receipt (source checkout: `docs/verification/2026-10-02-native-web-dsh-final-snapshot-interactions.json`).


## Installed-package acceptance

`scripts/native-installed-acceptance.mjs` tests an already installed HCC archive
through the public `hcc native` commands. Install the archive and the optional
Claude SDK into the same isolated npm prefix before running it. The script uses
the SDK's default package resolver; it does not inject an adapter or query
function. Running it without `--run-live` prints help and makes no model calls.

```sh
npm install --prefix /absolute/path/to/acceptance-prefix \
  /absolute/path/to/hello-cc.tgz @anthropic-ai/claude-agent-sdk

HCC_ACCEPTANCE_PLAYWRIGHT=file:///absolute/path/to/playwright/index.mjs \
HCC_ACCEPTANCE_CHROME=/absolute/path/to/chrome \
node /absolute/path/to/acceptance-prefix/node_modules/@logicseek/hello-cc/scripts/native-installed-acceptance.mjs \
  --run-live --codex-bin /absolute/path/to/codex \
  --dsh-bin /absolute/path/to/dsh --archive /absolute/path/to/hello-cc.tgz \
  --browser --task --output /absolute/path/to/receipt.json
```

The checks cover correlated replies and ACKs, duplicate submission, continuing
context, owned close/resume and interruption for all three installed providers.
A separate Codex check explicitly rejects a write outside the allowed sandbox. Each worker first receives a bounded task through the local user controls.
Models then send messages through MCP along `Codex → Claude → dsh → Codex`. The browser check verifies default SDK
loading, an explicit approved write, desktop/mobile rendering, released control
and local continuation of the same session after closing Web. `--task` adds an
independent file collaboration example: Codex implements invoice arithmetic,
five contract tests run, and Claude receives the model-authored handoff and
writes its review. This example is separate from stakeholder acceptance of a
production workflow.

Existing authentication and provider quota are used. HCC's global HOME, provider
homes, tmux server and project are private acceptance directories. A copied
Codex credential command preserves the caller's HOME only while retrieving
existing credentials; the original configuration is unchanged. Owned processes
and credential copies are removed on exit. The receipt records the archive
SHA-256, provider versions, source hashes, browser evidence and cleanup results.
The script neither publishes npm packages nor deploys to employee devices.

Requests submitted through authenticated native CLI/Web controls are recorded
as local user requests. Messages arriving through the shared HCC bus remain
peer coordination data, even if the sender calls itself `web` or `shell`.
Legacy deliveries retain peer origin during migration. This distinction does
not grant tool permissions: writes and other gated tools still require approval.
For delegated file work, first authorize the receiving agent's bounded task,
then send the peer handoff.

## Bounded stability acceptance

Add `--stability` to installed-package acceptance to run sustained work after
its lifecycle and cross-provider checks:

```sh
node /absolute/path/to/acceptance-prefix/node_modules/@logicseek/hello-cc/scripts/native-installed-acceptance.mjs \
  --run-live --codex-bin /absolute/path/to/codex --dsh-bin /absolute/path/to/dsh \
  --archive /absolute/path/to/hello-cc.tgz --stability \
  --stability-cycles 6 --stability-burst 2 --stability-idle-ms 30000 \
  --stability-resume-every 2 --output /absolute/path/to/stability-receipt.json
```

All three providers work concurrently. Each worker receives its whole burst
before the driver waits. Each reply must recall the original random marker
and the previous ticket from history, checking FIFO execution and retained
context. Duplicate submission IDs must yield exactly one reply and ACK.
Periodic worker close/resume and one normal owned-daemon restart preserve the
original sessions. Idle observation checks the control endpoint, pending
requests and identity. The final audit checks persisted deliveries, database
integrity, bounded event retention and absence of reply loops. Receipts retain
actual replies, failure state and owned-process memory samples. Failed work is
not replayed automatically or reclassified as successful after a retry.

Defaults are six cycles, two queued messages per worker per cycle, 30 seconds
of idle observation per cycle, and worker resume every two cycles. Limits are
1–24 cycles, 1–4 messages, 0–300000 idle milliseconds and a 1–24 cycle resume
interval. These options require `--stability`. This is bounded authenticated
work, not a 24-hour soak, capacity benchmark or proof of no memory leak. A
successful DSH resume alone does not explain earlier context fluctuations.

`--stability-only` requires `--stability`. It bootstraps three real sessions and
runs stability work while skipping the baseline interruption, command approval
and model MCP communication scenarios. The receipt records this scope; skipped
scenarios require separate evidence. On any failure, the driver captures current
session snapshots, recent deliveries and events before closing owned workers.
