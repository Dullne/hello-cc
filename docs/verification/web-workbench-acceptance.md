# Web 工作台验收与发布门槛

本文件描述可重复执行的检查与完成标准。每次验收应保存对应源码、包哈希、日志和回执；历史结果不能代替当前候选包的验证。

## 架构决定

- 浏览器使用原生 ESM；主入口为 `/assets/web/browser/core.mjs`。传输协议、共享读取、UI 面板和展示工具采用独立模块。服务端模板仅保留 HTML/CSS 及首屏偏好初始化，后者继续受 CSP nonce 保护，避免主题闪烁。
- 使用 JSDoc 与 `lib/web/browser/contracts.d.ts` 表达数据契约。现有模块仍是可直接被 Node 和浏览器解析的 JavaScript；本轮没有声称完成全仓 TypeScript 静态类型检查。
- 当前不引入 React、Vite 或 SSR：现有应用有独立的终端/会话生命周期及可用面板，迁移组件框架不能直接解决全量状态重复传输。先将协议、数据请求和视图解耦；未来可逐面板替换，控制凭证与生命周期接口保持独立。
- 只公开显式列出的本地模块及纯校验器，沿用登录 cookie、API 版本、同源写入及 pane 边界。npm 包携带 `lib/` 中的源码资产，安装后不执行前端构建。
- 主页面与同源分屏共享 `/api/projects`、`/api/sessions`、`/api/detected`、`/api/state` 的短期只读结果和进行中的请求。缓存按项目、peer、认证及版本分隔；每个消费者得到独立副本。写请求、WS 控制权、epoch、草稿与选择不经过共享缓存。
- 所有 API 调用有超时和取消。项目代际变化后迟到响应不能落入新视图；页面隐藏时降低轮询频率，恢复可见时及时刷新，无重叠轮询。重连采用有限退避和抖动，保留原有控制权重新认领语义，不自动重发输入/批准操作。

## 常规本地/CI 检查

要求 Node.js 24、tmux、项目锁定依赖以及 Playwright Chromium；也可通过 `HCC_ACCEPTANCE_CHROME` 指定本机浏览器。

```sh
npm ci
npx playwright install --with-deps chromium
npm run release:check
npm test
npm run test:web
npm run test:web:installed
node scripts/benchmark-session-sync.mjs
```

`test:web` 不调用真实模型：使用隔离 HOME、项目和 tmux socket，实际经过 SQLite、native service、HTTP、WebSocket 和浏览器。覆盖长历史、阅读位置、断线恢复、显式重新认领控制权、观察者、分屏、390px/1024px/桌面、语言和主题，并记录源码哈希、DOM/响应预算、截图及资源回读哈希。

`test:web:installed` 先 `npm pack`，在临时前缀安装，再运行安装包的公共 CLI 和同一浏览器套件。回执包含 tgz SHA256、包版本与安装后实际资源证据。不会覆盖用户的全局 hcc。

GitHub Actions 工作流：`.github/workflows/web-workbench.yml`。这是无需凭据的模型模拟验收；本地成功不等于 GitHub 执行成功，也不等于已发布。

`.github/workflows/dsh-acceptance.yml` 区分候选包与发布归档：普通分支和 PR 打包、安装当前 checkout，并独立校验既有发布归档的完整性；标签或手动选择 `release` 时，要求当前源码与该版本的发布清单完全一致，再安装清单指定的归档 tgz。开发候选包沿用基础版本号时不代表重新发布该版本，候选回执必须记录 commit 和 tgz SHA256。

## 真实模型验收（显式执行）

这些脚本使用当前可用账号，会产生短模型调用。要求本机已有对应 CLI/SDK；通过隔离项目及 provider home 保护日常会话，输出中不应包含账号配置正文或密钥。Claude 可用 `--claude-package` 指定已安装的官方 SDK。

```sh
node scripts/native-bounded-live-acceptance.mjs --run-live --provider all
node scripts/web-native-interaction-acceptance.mjs --run-live --provider all
node scripts/web-native-model-acceptance.mjs --run-live
```

- 短回合：真实回复、关联 ACK、提交幂等、同会话记忆及自有会话关闭/恢复。
- Web 交互：在原始执行器/轮次处理真实请求，批准只针对临时测试文件，拒绝后文件不存在，并释放 Web 控制权后通过本地接口继续。
- 连续任务：Codex 在同一 PID/provider session 执行本地→Web→关闭 Web 后本地的 JSON 文件任务；仅调用项目范围的只读 HCC 状态工具。
- 实际业务项目、公司设备安装、远程 CI、npm 发布/部署分别需要各自证据，不能由这些临时项目结果推断。

## 发布检查单

1. 冻结 `bin/`、`lib/` 与打包依赖，保存源码哈希；运行完整检查后确认无漂移。
2. 核对版本、发布说明及候选包 SHA256；不得把旧版本的安装回执替代当前包验证。
3. 模拟浏览器、安装包与真实模型结果分别记录；任何失败保留失败回执及修复原因。
4. 执行远程发布时另存 registry/tag/部署回执及安装后的回读；没有这些证据时状态保持“本地候选包已验收”。
5. 回退只针对本次文件补丁或已冻结候选包，不重置共享工作区。协议支持未协商客户端继续全量快照；终端字节流保留既有路径。
