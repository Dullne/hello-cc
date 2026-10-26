# Codex host extensions

Since 1.1.4, `createCodexAdapter` and `createCodexAppServer` accept optional
in-process `dynamicTools` and `refreshAuthTokens` callbacks. The default CLI and
Web UI continue using provider-managed authentication and scoped HCC MCP.

`dynamicTools` is an array of `{ name, namespace?, description, inputSchema,
readOnly, handler }`. Names use 1–64 ASCII letters, digits, underscores or
hyphens. Each handler validates its own object arguments against its declared
schema and checks authorization before performing work. The host must explicitly
declare `readOnly: true` or `false`; a read-only thread excludes mutating tools.
The `readOnly` declaration is trusted host policy, not an OS sandbox for callback
code. Namespace groups and function specs use the official experimental schema.

The handler receives `(arguments, { executorId, sessionId, turnId, callId,
requestId, sandbox, signal })`. It returns `{ success, contentItems }`, where
each content item currently has `{ type: 'inputText', text }`. JSON inputs and
outputs are limited to 64 KiB, with at most 32 output items. Unknown tools,
foreign/expired turns, conflicting call IDs and late results fail closed.
Identical call IDs execute once per adapter lifetime; the adapter never
automatically replays a call after transport loss. Hosts must honor `signal`
and preserve their own idempotency receipts for effects that can outlive a
cancelled callback. A new model-issued call ID is a separate request.

Tools are declared on `thread/start`. Official resume/fork restore the provider's
saved declarations; HCC does not inject unsupported parameters into those
methods. A restored tool still needs a registered handler on this executor.
Callbacks are bounded by `extensionTimeoutMs` (default 30000, range 1–30000).

`refreshAuthTokens({ reason, previousAccountId }, { executorId, signal })` is only
for embedding hosts that already own an external-token lifecycle. It returns
`{ accessToken, chatgptAccountId, chatgptPlanType? }` directly to the original
server RPC. The previous account, when supplied, must match; simultaneous
requests coalesce only for that account. Credentials, account identifiers and
callback errors never enter HCC approval cards, snapshots or extension events.
Close/timeout invalidates pending results. HCC neither initiates external-token
login nor rewrites global authentication. The embedded CLI marks that login
method internal/unstable; this callback does not make it a supported public
login flow. Routine native use requires no external-token callback.

These are host SDK extension points; browser clients and message senders cannot
register executable callbacks or upload tokens. Protocol tests exercise refresh
with fake credentials, not a real account-expiry event. Actual registration of
a dynamic tool can be verified through installed acceptance with `--extensions`.

Sources: [OpenAI Docs App Server](https://learn.chatgpt.com/docs/app-server) and
experimental schemas exported from the installed Codex CLI. This integration
does not change the separately version-gated original-App queue dispatcher.
