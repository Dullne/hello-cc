# macOS 进程身份与升级

macOS 的 `kern.boottime` 是墙上时钟时间，同一次开机期间也可能因时钟校正改变。以它的秒、微秒字段识别进程，会把仍在运行的进程误判为新实例。

Darwin 身份改为 `darwin:<kern.bootsessionuuid>:<UTC/C ps lstart>`。开机 UUID 严格验证并统一小写；缺失、查询失败或格式错误时返回 `unknown`，不会退回 `kern.boottime`。进程开始时间仍前后读取两次，状态中的 zombie 仍视为已退出。PID、进程开始时间和命令摘要的所有权校验没有放宽。

旧版本保存的 `<boot 秒>:<boot 微秒>:<ps lstart>` 无法可靠转换成新标记。对同一存活 PID，旧、新格式之间返回 `unknown`，既不授予所有权，也不证明旧进程已经退出。其 runtime 指针不因超过普通未知状态宽限期而被回收；Cordis 恢复和 native 启动也必须保留仍存活的旧 owner。与真实进程退出或同格式 PID 复用有关的判定保持原有规则。

这种专用 `unknown` 同样保留 peer/binding、过期锁和缓冲文件，阻止过期任务被接管；它不会赋予 `live` 身份、续租或写权限。普通未知状态的超时策略不变。

早期 Web 工作台候选使用过 `mac:<boot UUID>:<ps lstart>` 前缀。它与正式的 `darwin:` 格式交叉比较时同样保留为 `unknown`，不因前缀变化回收仍存活的候选进程；需要由原版本正常关闭后再启动新版本。

升级前，先用原版本正常关闭所属 native worker/runtime，正常退出 Harness Desktop，再安装并启动新版本，使运行中的 owner 重新建立身份。保留账号配置、会话与协作数据库；不要手工改写旧身份、删除仍存活 runtime 的指针，或仅凭 PID 强行接管。若旧进程已经退出，OS 的死亡证据仍允许正常恢复。没有完整身份的其他未知状态继续使用原有策略。

回归覆盖同一次开机期间 `kern.boottime` 漂移、不同 boot UUID、错误和缺失 UUID、PATH 缺失时的固定系统路径、语言环境、PID 复用、exec、真实自有 zombie，以及跨格式 runtime 指针、native 启动和 Cordis 恢复边界。
