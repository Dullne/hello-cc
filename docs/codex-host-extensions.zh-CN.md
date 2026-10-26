# Codex 宿主扩展

1.1.4 的 `createCodexAdapter` 与 `createCodexAppServer` 支持可选的进程内
`dynamicTools` 和 `refreshAuthTokens` callback。CLI 与 Web 默认继续使用 provider
原有登录和 HCC scoped MCP。

`dynamicTools` 数组每项包含 `{ name, namespace?, description, inputSchema,
readOnly, handler }`。名称使用 1–64 个 ASCII 字母、数字、下划线或连字符。
handler 必须校验对象参数是否符合声明的 schema，并检查执行权限。
`readOnly` 必须明确为布尔值；只读线程不注册或执行可变更工具。这是受信宿主的
声明，不是限制 callback 代码的 OS 沙箱。函数及 namespace 使用官方实验 schema。

handler 收到 `(arguments, { executorId, sessionId, turnId, callId, requestId,
sandbox, signal })`，返回 `{ success, contentItems }`；当前支持
`{ type: 'inputText', text }` 内容项。输入、输出 JSON 各限 64 KiB，输出最多 32 项。
工具名、原线程、活动 turn 与 call ID 均受校验；重复 call ID 只执行一次，冲突、
过期、未知调用和迟到结果返回失败。宿主应处理 `signal`，为可能在取消后仍完成的
副作用保留自己的幂等回执。模型另发的新 call ID 是独立请求；HCC 不在断线后重放。

工具只在 `thread/start` 声明。resume/fork 使用 provider 保留的工具声明，不添加
这些方法不支持的参数；恢复的工具仍需要当前执行器注册 handler。callback 超时
由 `extensionTimeoutMs` 控制，默认 30000，范围 1–30000 毫秒。

`refreshAuthTokens({ reason, previousAccountId }, { executorId, signal })`
仅面向已经拥有外部 token 生命周期的嵌入宿主，返回
`{ accessToken, chatgptAccountId, chatgptPlanType? }`，直回原 server RPC。
有明确前账号时必须匹配；并发请求只合并同一账号。凭据、账号标识与 callback 原始
错误不进入 HCC 审批、快照或扩展事件，关闭与超时后不接受迟到结果。HCC 不发起外部
token 登录、不改全局认证；当前内嵌 schema 将该登录方法标为内部不稳定能力，此
callback 不把它变成公共登录流程。普通 native 使用无需设置此 callback。

这些是宿主 SDK 扩展点，浏览器和消息发送方不能注册代码或上传 token。刷新协议
测试使用假凭据，不代表真实账号过期后的生产验收；动态工具实际注册可通过安装包验收的 `--extensions` 验证。依据：[OpenAI Docs App Server](https://learn.chatgpt.com/docs/app-server)
及已安装 CLI 导出的实验 schema。原 App 队列监听器仍有独立版本和平台门槛。
