# Executor-scoped MCP coordination

Web-owned Codex App Server executors and HCC-hosted Codex/Claude/dsh native workers receive a dedicated stdio MCP server. Its temporary capability binds the project root, database, peer, worker owner and live runtime process identity. Configuration is passed through the provider session API; it does not modify global provider configuration, authentication or trust settings.

Tools expose coordination state, tasks, inbox, message sending, handoff, owned resource locks and local result records. They reuse the existing business commands. Model arguments cannot change the project/database/peer, force another peer's lock, or record publication/business acceptance. Task claiming, handoff and evidence recording never mark a task done automatically.

The internal entry point is `hcc --root PROJECT --db DATABASE mcp serve --peer PEER`. A private executor-issued capability is required; `--peer` alone grants no authority. Every call verifies the live executor and its database binding, and writes check ownership again in their business transaction. Closing the executor revokes and removes its capability. Unix permissions are 0700 for the temporary directory and 0600 for the capability file.

Native workers acquire the scoped capability before startup and revoke it before shutdown or failed-start cleanup. Codex uses thread config, Claude uses SDK mcpServers and dsh uses ACP session mcpServers. Arbitrary external CLI/TUI processes do not receive this capability automatically. See [the Chinese tool reference](mcp.zh-CN.md) for individual tools, [native workers](native.md) for provider approval behavior, and [Web handoff](web-handoff.zh-CN.md) for result review and lifecycle boundaries.
