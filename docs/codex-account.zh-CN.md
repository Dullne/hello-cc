# Codex 账号与限额

Web 专用 Codex App Server 和 HCC 托管的 Codex Native worker 都提供“账号与限额”折叠面板。打开对应会话后读取该执行器的账号状态，点击“刷新账号与限额”重新查询。观察窗口也可以读取；发送消息、中断或应答审批仍受当前控制权约束。Claude 和 dsh 没有此 Codex 面板。

## 状态怎么理解

- **需要在本地 Codex 登录**：请在运行该任务的电脑完成 Codex 登录，再刷新面板。手机或另一台电脑上的 Web 登录不等于原执行器已登录。
- **ChatGPT 已登录**：显示 App Server 报告的套餐及可获得的用量窗口、重置时间、可用额度状态。账号已识别不等于真实模型调用已经通过。
- **供应商自行管理认证**：当前模型供应商不要求 OpenAI 登录。HCC 无法通过此接口确认供应商凭据或剩余配额，需通过该供应商的实际任务验证。
- **暂不可用 / 此版本未提供限额**：数据缺失或接口不支持，不能理解成零用量或无限额度。API key 和自定义供应商不会显示推测的 ChatGPT 订阅配额。
- **历史状态，待刷新**：执行器断开或读取失败时，旧用量保留并明确标记，不能作为当前状态。账号变更则清除旧账号的配额，再读当前账号。

多个配额桶分别展示，缺失的窗口保持未知；已读取的 0% 用量会正常显示。界面同时标注账号和限额的读取时间。输出流、刷新和执行器替换不会让旧请求覆盖新状态；切走再返回后，过期响应被丢弃，刷新按钮可继续使用。

## 读取范围

两条公开入口都是需要 Web 认证的只读 GET；请求须携带现有 API 版本头 `X-HCC-API-Version: 2`：

| 会话 | 入口 | 必须匹配的身份 |
| --- | --- | --- |
| Web 专用 Codex | `/api/sessions/:id/codex/account` | `root`、当前 `executorId` |
| 原生 Codex worker | `/api/sessions/:id/native/account` | `root`、当前 `generation`、`owner`、`sessionId` |

身份都通过 query 参数传入。原执行器在查询期间被替换时，响应重新核对身份；旧页面不能借此查询新实例。刷新不提交 turn、task、消息或 mutation receipt，不需要控制租约 token/epoch。

底层仅调用 `account/read`（`refreshToken: false`），以及适用 ChatGPT 订阅时的 `account/rateLimits/read`。账号/限额通知更新当前执行器状态；登录完成通知仍需要读取当前账号后才能显示已登录。并发刷新合并为同一读取，账号变更与通知使旧响应失效。

HCC 投影只保留必要状态。邮箱、凭据 ID、token、额度余额/支出和原始账号错误不进入面板、账号事件或接口响应；账号数据不写入浏览器存储。此功能不提供登录、退出登录、设备码登录、凭据保存或外部 token 刷新。执行器本身的认证生命周期仍由 Codex 管理。

## 协议与验收边界

基线为已安装 Codex 0.144.6；升级检查覆盖 57 项交接契约，其中包含本功能的方法、通知和必要字段。账号 Schema 从官方生成物的 `json-schema/v2/` 读取。运行方式见 [Codex 协议升级检查](codex-protocol.md)。

真实安装版 App Server 已在隔离 HOME/CODEX_HOME 中分别验证 Web 和 Native 的未登录、自定义供应商状态，共 4 项；原执行器/会话保持不变，没有模型调用，也没有读取现有账号。桌面 1440×1000、手机 390×844 和观察窗口通过真实 HTTP/SQLite/JSON-RPC 的浏览器检查；ChatGPT 配额、多窗口、账号变更与不支持接口由模拟 provider 覆盖。这些结果不等于真实 ChatGPT 订阅限额或外部账号业务验收。

浏览器验收入口为 `scripts/web-codex-account-acceptance.mjs --run --output NEW_RECEIPT`，需要通过 `HCC_ACCEPTANCE_PLAYWRIGHT` 和 `HCC_ACCEPTANCE_CHROME` 指定现有 Playwright 模块和 Chrome 可执行文件。脚本使用隔离项目、tmux、HOME/CODEX_HOME 和模拟 App Server，不调用模型；默认仅显示帮助。截图与 JSON 回执写到源码目录之外。

官方接口参考：<https://developers.openai.com/codex/app-server/>。当前 HCC 未实现 `account/chatgptAuthTokens/refresh`；所验收的 0.144.6 生成 Schema 将 `chatgptAuthTokens` 登录模式标为内部使用，后续版本需按其实际生成协议重新评估。
