# DeepSeek Harness 预览最终验收

日期：2026-10-03。候选 1.0.2-dsh.3，SHA256 `0e6a130fd7abbffb0ff781ba635b5b4508a7ad738765b3ac39a7398d590b3378`，216 文件。完整交付根目录：/Users/xf02163/Documents/Codex/artifacts/dsh-integration-2026-10-02。

本轮补齐冻结包遗漏的 Cordis 崩溃恢复；补齐关闭期间数据库故障后的可重试清理；修复 GitHub prerelease 标记和预览 CHANGELOG。包从冻结基线及两份固化修复输入生成，不包含混合工作区其他变化。内部计划及验收材料不进入 npm 包，公共文档中的内部链接改为源码目录标注。

| 验证 | 结果与边界 |
| --- | --- |
| 精确冻结包 | 17/17；SQLite 临时不可用后，替代 Agent 可恢复、旧 authority 保持失效 |
| macOS arm64 安装 | 11/11，使用真实 DeepSeek：官方插件 add/readd/remove、ACP 审批拒绝、订单任务与清理 |
| Linux arm64 容器 | 官方 rc.2，Node24.19.0，pnpm12.8.1；安装8/8、确定性协作7/7、216文件摘要一致 |
| 源码定向测试 | 127/127；仅运行时快照，工作区仍有并发修改 |
| 发布检查 | release:check、GitHub prerelease dry-run、npm publish dry-run 均通过 |
| 本机 CLI | hcc-dsh 更新到 1.0.2-dsh.3，项目 ready/cordis，216 文件核对 |
| 本机桌面安装 | 正常重启后已激活；216 文件匹配，六个既有会话保留、凭据及模型配置 patch 未变；原验收 session/peer 恢复，真实 hcc_state 和 hcc_message_send，turn 2 completed |
| CI | 新增 .github/workflows/dsh-acceptance.yml；仅本地语法/配置检查，未推送或远端触发 |

冻结包恢复回执：/Users/xf02163/Documents/Codex/artifacts/dsh-integration-2026-10-02/continuation-2026-10-03/recovery/v3/frozen-verification.json。
Mac回执：/Users/xf02163/Documents/Codex/artifacts/dsh-integration-2026-10-02/release/v3/mac-acceptance/dsh-installed-receipt.json。
Linux回执：/Users/xf02163/Documents/Codex/artifacts/dsh-integration-2026-10-03/linux/linux-manifest.json；专属容器已删除，私有 HOME/profile 清除。
桌面升级回执：/Users/xf02163/Documents/Codex/artifacts/dsh-integration-2026-10-02/release/v3/device/desktop-upgrade-receipt.json。

仍需：有效 npm 认证下的发布/读回/registry 安装；实际 WSL/员工设备及真实业务验收。认证记录已更新：最初 E403 和“未启用 2FA”已被后续证据取代；`release/v3/publication/preflight-2fa.json` 于 2026-10-02T17:29:32.885Z 记录 `auth-and-writes`、`pending=null`，随后发布遇到 EOTP 浏览器认证要求。2026-10-03 的默认 npm 认证复查返回 E401，公开 latest 仍为 1.0.1。因此当前缺口是恢复有效认证并完成发布，不能再要求重复开启已启用的 2FA。原生 Windows shell 不在支持范围。原 sub2api 的官方客户端限制并未修复。

之前 dsh.1/dsh.2 与 867 项全工作区测试回执属于各自历史快照，不代表当前冻结候选或最新工作区全量回归。

桌面激活回执：/Users/xf02163/Documents/Codex/artifacts/dsh-integration-2026-10-02/release/v3/device/activation/desktop-activation-receipt.json。
