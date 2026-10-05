# 桌面 Agent 通信：本地候选验证

日期：2026-10-05。基线：`002a2df016dee3d1a504a1e85b42204c8b6a922c`，包版本保留 `1.1.0-rc.4`。本轮没有合并、发布、安装或升级已安装 App。工作树：`/Users/xf02163/.codex/worktrees/app-agent-bridge/hello-cc`。

实现范围与步骤见 [接入计划](../plans/2026-10-05-app-agent-bridge.zh-CN.md)，操作方式见 [中文说明](../app-bridge.zh-CN.md)。CLI 自有 worker 不作为已有桌面会话的替代验收对象。

## 实现与边界

| 对象 | 已实现 | 当前证据 | 未完成 |
| --- | --- | --- | --- |
| DSH | 原 live Agent 空闲唤醒、忙碌步骤收件、提交后 ACK、取消与热重载防重复 | 官方 DSH 0.2.0-rc.2 的 Cordis 运行时＋localhost 确定性模型 | 已安装 Desktop UI 和真实模型端到端验收 |
| Claude Desktop Code | 单会话 Mod、私有认证 HTTP 桥、总线接入、关联完成、事务 ACK／回复、Hooks 共存 | Mod API fixture、真实本地 HTTP、SQLite 协作与故障测试 | 官方插件静态校验成功回执、新版 Desktop 实机验收 |
| Codex App | 显式 UDS 只读探测、元数据清理、连接生命周期保护 | 26 项临时模拟服务测试 | 证明端点归属 Desktop 的公开附着入口和向已有会话发消息 |

DSH 的 ACK 表示对应消息已提交到上下文；Claude 的 ACK 等待匹配主回合完成。二者均不单独证明真实业务任务通过验收。

## 验证记录

验证日志目录：`/Users/xf02163/Documents/Codex/artifacts/app-agent-bridge-2026-10-05/local-sjzyzfre`。

| 检查 | 结果 |
| --- | --- |
| 静态标识符审计 | 通过 |
| 全量单测 | 1827 项：1825 通过、0 失败、2 跳过 |
| 完整回归 | 13/13，`FULL_REGRESSION_OK`，包括原最小消息 schema |
| 官方 DSH 隔离验收 | 5/5，`completed:true`，2 次 localhost 模型请求、0 次真实模型请求，子进程已清理 |
| npm 包内容检查 | 通过；新增 Mod 模板、三个适配模块、CLI 和验收脚本均包含在清单内 |
| 差异格式检查 | `git diff --check` 通过 |

两项跳过分别为跨 UID 父目录替换测试和 Linux `/proc` 伪文件测试；当前 Mac 未提供这两项的通过证据。测试使用 Node.js 24、临时 HOME、私有项目和独立 tmux socket，不使用用户账号或既有聊天。

归档包含 `summary.json`、`source-manifest.json`、`candidate.patch`、最终检查日志与 DSH 运行时回执。首次失败日志保留为历史记录；最终状态取修复后的检查，不把旧失败隐藏为通过。

DSH 验收检查：空闲无消息不调用模型、总线消息唤醒原 Agent 并提交／ACK／回复、跨项目隔离、拒绝准入保持未读且不循环、已销毁 Agent 不再唤醒。ACP 只用于创建和清理测试 Agent，不发送 `session/prompt`。模型响应由 localhost fixture 生成，真实模型调用为 0。

本地复现命令（Node.js 24+，从本工作树执行，并隔离 HOME）：

```sh
npm run test:audit
npm run test:unit
npm run test:regression
node scripts/dsh-inbox-acceptance.mjs --dsh-install /absolute/path/to/official-install
npm pack --dry-run --json
```

## 失败记录与修正

- 初次单测的容量故障 mock 使用普通 `Error`，与生产桥接的 `CliError` 不同；已修正 fixture，保留错误码断言。
- 完整回归发现默认 `queryInbox` 查询不必要地引用 App 投递用的 `meta` 表。修复为仅在显式启用 `excludeAppDeliveries` 时使用该过滤；普通查询继续支持原最小 schema，Hooks 仍过滤已投递而结果不明的消息。
- 静态扫描器不能正确处理模板表达式内部的 SQL 字符串；将固定 SQL 片段提取为局部常量后审计通过，没有加入扫描豁免。
- Claude 官方校验器未取得：`claude.ai/install.sh` 返回区域不可用页面；npm 官方 `@anthropic-ai/claude-code-darwin-arm64@2.1.289` 的 100,425,358 字节包在 105 秒内仅下载 7,385,166 字节，`curl (28)` 超时。未执行部分下载内容，临时插件和下载已清理。

## 后续验收门槛

1. **DSH**：在明确选定的隔离 Desktop 会话加载候选插件，发送真实任务；验收空闲唤醒、审批、回复、ACK 和 App 显示一致性。
2. **Claude**：将目标 Desktop 的内嵌引擎更新到 2.1.287+，先取得 `claude plugin validate <pluginDirectory> --strict` 成功回执，再在单个隔离 Code 会话显式加载插件，测试完成、取消、断线和 Hooks 共存。当前设备查得 CLI 2.1.204、Desktop 1.24012.1 内嵌 pin 2.1.217；更新 CLI 不等于更新 Desktop。
3. **Codex**：确认官方支持的桌面端点归属及原子附着条件。公开 `thread/resume` 可冷恢复会话，当前不能据此保证只驱动原桌面执行器，所以发送路径未实现。现有 probe 始终返回 `writable:false`、`desktopEndpointVerified:false`。
4. **交付**：后续合并、发布、设备安装和真实业务验收分别记录，绑定最终候选提交／包哈希；本记录不作为这些阶段的完成证明。
