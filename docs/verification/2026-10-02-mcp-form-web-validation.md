# MCP 标准表单 Web 接手验收

本轮已补齐 Codex MCP 标准表单的 Web 填写和 CLI 应答。Web-owned App Server 与 HCC native worker 两条接手路径，现在都能显示字段、校验输入，并把原字段名和原类型的答复送回对应的请求。既有空表单确认、拒绝和取消继续可用。

文件名沿用 UTC 日期 `2026-10-02`。全回归和浏览器检查的执行时间为 2026-10-02 17:20–17:28 UTC，对应 Asia/Shanghai 的 2026-10-03 01:20–01:28。本记录描述本地源码和浏览器验证；本轮未执行新的真实模型调用、发布、部署、员工设备安装或业务任务验收。

机器可读总回执：[2026-10-02-mcp-form-web-validation.json](2026-10-02-mcp-form-web-validation.json)。此前接手、审批和真实模型证据保留在 [2026-10-02-web-local-task-handoff.md](2026-10-02-web-local-task-handoff.md)，各回执只覆盖各自记录的源码版本。

## 已实现的行为

- 标准 `mcpServer/elicitation/request` 的 `form` 模式支持平面字符串、数值、安全整数、布尔值、字符串枚举单选和多选。单选兼容 `enum`/`enumNames` 和带标题的 `oneOf`；多选兼容字符串枚举、`anyOf` 和官方类型里的 `oneOf` 表达。
- 显示标题、说明、默认建议值、必填标记和约束。字符串校验长度和常用 `email`/`uri`/`date`/`date-time` 格式；数值校验类型及上下限；多选校验成员身份、唯一性与选择数量。默认值也须符合请求约束。
- 布尔值须明确选择是或否。可选字段有独立填写开关，只有用户勾选填写才发送；显示的默认建议值不会隐式成为可选字段答复。数值 `0` 和布尔值 `false` 保留原类型。
- Web 前端与应答后端使用同一个校验器。标签、说明和选项经过转义；界面选项使用索引映射回原值。`__proto__`、`constructor` 等合法字段名保持为自身属性。
- 非法输入保持请求待处理，可以修改后重试。不支持或截断的请求说明原因并禁用接受，仍保留拒绝/取消入口。所有应答继续验证执行器、thread、turn、request 和当前控制权，旧窗口及重复应答不能重放；JSON-RPC 请求 ID `0` 可正常应答。
- 执行状态刷新保留页面内的草稿；页面重载、提交完成、请求移除和会话切换清除草稿。草稿不会进入浏览器持久存储。直接答复不会通过 HCC 交互应答路径写入状态快照、事件或投递回执。此约束不改变 provider 自有历史和模型输出的既有保存行为。
- 桌面及手机可填写和提交，拒绝与取消分开显示。CLI `--response-file` 接受 `content` 对象，走相同的后端校验和原请求路由。

结构限制为最多 50 个字段、每字段最多 100 个选项、每个字符串最多 8192 个 UTF-16 单元；结构与应答内容的 JSON 字符长度各最多 65536。未知 schema 关键字、嵌套对象、任意数组、无效或不可满足的约束和默认值会被拒绝。长度限制是字符口径，不是 UTF-8 字节数。

接受结果为 `{ "action": "accept", "content": { ... } }`，拒绝和取消只发送对应的 `action`。本轮未添加 session/always 授权或应答元数据。

## 协议基线与代码路径

已核对的安装版 Codex 为 `0.144.6`，通过 `codex app-server generate-ts --experimental --out TEMP` 在隔离目录生成协议类型；该命令未调用模型。

官方源码基线为仓库提交 `14a477ea89712071944244022e8a10142845456e` 的 `codex-rs/app-server-protocol/src/protocol/v2/mcp.rs`，SHA-256 为 `b11ab3c2d5844ff27061e3be43d3d595731a16c9e29078bec51cc383aa460e69`。已检查标准 schema 定义、请求模式及应答的 `action`/`content`。此处是固定版本的协议比对，不作官方最新版本声明；本轮没有成功取得官方文档页面正文。

| 路径 | 作用 |
| --- | --- |
| `lib/integrations/mcp-elicitation.mjs` | 自包含结构解析和类型/约束校验器 |
| `lib/integrations/codex-interactions.mjs` | 标准交互解析、原请求身份校验和应答结构 |
| `lib/web/ui-interactions.mjs` | 共享字段显示、草稿和浏览器校验 |
| `lib/web/ui-native.mjs`、`lib/web/ui-codex.mjs` | 两种接手界面的填写、提交和拒绝/取消控件 |
| `lib/web/codex-app-server.mjs` | Web-owned 原 JSON-RPC 请求及等待输入状态 |
| `lib/web/codex-sessions.mjs`、`lib/web/native-sessions.mjs` | 会话应答内容转发 |
| `lib/cli/commands/native.mjs` | CLI 响应文件解析和应答 |
| `scripts/web-mcp-form-acceptance.mjs` | 可复现的隔离浏览器验收 |

本轮增加或更新了交互、共享 UI、App Server、native Codex、Web 会话和 native CLI 测试，覆盖格式、默认值、边界、字段身份、过时/重复应答、内容转发与 HCC 应答路径不持久化。

## 验证结果与源码范围

| 验证 | 结果 | 源码范围/证据 |
| --- | --- | --- |
| 完整回归快照 `fFH8UZ` | 64 个 factory 模块审计通过；928 项测试中 927 通过、1 跳过；13 阶段回归全部通过，输出 `FULL_REGRESSION_OK` | [全回归回执](2026-10-02-mcp-form-regression-snapshot.json) |
| 后续完整单测快照 `cHBHKN` | 64 个模块审计通过；932 项测试中 931 通过、1 跳过、0 失败 | [复验回执](2026-10-02-mcp-form-postcheck-snapshot.json)；保存 287 个源码、测试、脚本及 package 文件摘要 |
| 浏览器验收 | 19 项检查通过；页面错误、控制台警告/错误均为空；执行时源码无变更 | [浏览器回执](2026-10-02-mcp-form-browser.json)；源码摘要与 `cHBHKN` 完全一致 |
| 后续单个测试文件复验 | `test/task-results.test.mjs` 当前版本 14 项通过、0 失败 | 总回执的 `lateWorkspaceChanges`；日志 `/tmp/hcc-mcp-form-late-task-results.log` |
| 打包清单 | `npm pack --dry-run --json` 的 221 文件清单包含 10 个预期实现/验收路径，缺失项为 0 | 总回执的 `package`；仅 dry-run |

全回归快照在验证过程中未发生源码变化。之后工作区的 `lib/runtime/native/service.mjs` 提示文案、`test/task-results.test.mjs` 额外测试和 `scripts/native-installed-acceptance.mjs` 修改由 `cHBHKN` 的完整审计/单测及同源码浏览器验收另行覆盖；13 阶段回归只代表 `fFH8UZ`，不宣称针对这三项后续变更重新执行。复验后仅 `test/task-results.test.mjs` 又有变更，当前 14 项文件级测试全部通过；最终轻量核对确认所有生产文件及 MCP 实现/验收文件仍与 `cHBHKN` 摘要一致。14 项与前述测试有重叠，不累计为独立测试总数。

唯一跳过项为 macOS 上的 Linux `/proc` 伪文件目标检查。浏览器使用已安装 Chrome、独立 profile 和 Playwright，运行于本机隔离端口；本会话没有 Browser plugin，因此采用 Playwright。请求由模拟 provider 产生，经过生产 HTTP、SQLite、native runtime、Web App Server 和实际浏览器界面，无模型推理。

19 项检查同时覆盖既有审批/问题路径与新表单路径：观察者禁用审批、预览转义、权限子集与有效期、未回答保持待处理、草稿保留、无效表单修正、原类型应答、可选默认值省略、不支持 URL/schema 的拒绝或取消、控制权接管、桌面/手机布局和请求 ID `0`。模拟 provider RPC 日志仅含验收的合成数据，不含用户真实答复。

截图完整路径列于浏览器回执，包含 `native-mcp-form-desktop.png`、`native-mcp-form-mobile.png`、`native-mcp-form-mobile-submit.png`、`web-owned-mcp-form-desktop.png`。桌面与手机表单截图已进行视觉检查；最新截图使用相同的 UI 和校验源码。

本轮曾捕获两个并发工作区测试更新的失败检查点，原回执均保留：

- [pMBnLW](2026-10-02-mcp-form-failed-snapshot-pMBnLW.json)：dsh 所有权已转移后，旧测试清理仍无条件 dispose 原 owner。工作区后续 fixture 使用显式 unmanaged 对象并保留冲突拒绝断言；生产所有权检查未修改。
- [tZANij](2026-10-02-mcp-form-failed-snapshot-tZANij.json)：结果观察器已改用显式 live-event 参数，旧测试仍只把 start event 放入保留快照。工作区后续测试显式传事件，并保留拒绝历史快照的断言。

上述两项后续修复作为已有工作区变更保存，未归为本轮 MCP 表单实现。通过结果以表格中的固定快照为准。

## 复现

使用 Node `24.19.0`。验收脚本默认只打印帮助，显式 `--run-browser` 才执行浏览器检查。以下命令使用本机 bundled Playwright 与安装版 Chrome：

```sh
PATH=/Users/xf02163/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
HCC_ACCEPTANCE_PLAYWRIGHT=/Users/xf02163/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
HCC_ACCEPTANCE_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node scripts/web-mcp-form-acceptance.mjs --run-browser
```

CLI 响应文件示例（具体字段须以待处理请求的 schema 为准）：

```json
{"content":{"project":"demo","count":2,"enabled":false}}
```

```sh
hcc native respond --peer NAME --request ID --decision accept --response-file ./response.json
```

快照审计和单测分别使用 `npm run test:audit` 与 `npm run test:unit`；全回归使用 `npm run test:regression`。项目的 `npm test` 会通过 `pretest` 依次运行审计、单测，再运行回归。快照、日志路径及 SHA-256 均保存在总回执。测试 runtime、provider home、tmux socket、浏览器 profile 和 Git 元数据均隔离；验收结束已清理私有运行资源。原项目 Git index、provider 认证/账号、安装客户端和原 tmux 会话保持原状态，其他工作区修改保留。

## 原轮次边界与后续进展（2026-10-03 更新）

- MCP URL/device 身份认证、OpenAI 扩展表单模式、嵌套/任意 schema、动态工具和账号 token 刷新尚未接入。未知模式提供明确的不支持状态及拒绝/取消。
- 任意未托管 TUI 或普通终端的活动执行器迁移、私有 daemon endpoint 和完整版本兼容矩阵未实现；已托管 tmux 与 HCC native worker 路径沿用此前范围。
- 后续已完成“真实模型发起字段请求—Web 填写—同一任务继续”的 9 项检查：`/tmp/2026-10-03-mcp-form-live-final.json`（2026-10-03T04:09:23.878Z）。覆盖 native 与 Web-owned 两条路径、无效字段拦截、移动视口填写、同一 native PID/session 续接及关闭 Web 后本地继续；其冻结源码、配置保护和清理证据见该回执及 `/tmp/2026-10-03-mcp-form-live-workspace-final.json`。这补齐了旧记录中的真实表单缺口，但不自动覆盖此后新增 URL 认证或其他源码改动。
- Claude SDK 沿用已实现的可选加载路径，仍须安装可选依赖；本轮不新增 SDK 包装或设备验收证据。
- 本文原轮次未提交、推送、发布或部署。其他冻结包的安装回执应按各自版本和摘要单列；本轮模拟协议检查和后续真实表单回执均不构成员工设备或真实业务签收。
