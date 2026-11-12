# 原生 Windows 支持设计

日期：2026-11-12  
状态：用户已确认完整原生方案；实施中，尚未实现 Windows 支持  
基线：`7bf52fce07cb3a6613d2d6311bf014688153e2a3`  
开发分支：`codex/windows-native-support`

## 目标与验收边界

使用户能够在原生 PowerShell / cmd 中安装、启动和使用 hello-cc，不依赖 WSL、Git Bash 或 tmux。首批目标为 Windows 10 22H2 / Windows 11 x64、Node.js 24+、本地 NTFS 项目目录；当前实机是 Windows 11 x64。Windows 10 的支持声明必须有独立验收证据，不能由 Windows 11 或 Windows Server CI 结果替代。

交付范围包括：

- npm 安装后直接执行 `hcc` / `hello-cc`，支持带空格和中文的安装、用户与项目路径。
- 初始化、状态查询、数据库体检、任务、消息、锁与交接。
- Web 启停、项目选择、文件浏览/预览/状态查询、文本编辑、上传与上下文文件搜索。
- 后台 Agent 的启动、投递、中断、关闭与历史恢复；按 provider 分别报告实际通过情况。
- 原生受管终端的创建、输入、调整大小、退出、浏览器重连、本地连接、分离与重新连接。
- Web 重启后能够连接原先存活的受管终端；明确关闭终端时清理其拥有的进程树。
- Windows hooks/shims 的安装、状态检查、更新与卸载；保留无关配置。
- Linux/macOS 的现有接口、终端行为和安全约束保持回归通过。

本次不承诺接管任意已经打开的 PowerShell/Windows Terminal 窗口；只管理 HCC 创建并持有所有权证据的终端。ARM64、UNC/网络盘、非 NTFS、其他用户的会话和系统级 Windows Service 安装不属于首批支持声明。启动检查必须对不支持的情况给出明确原因。

Node.js 22 的兼容性不纳入本次工作；开发验证使用独立 Node.js 24，避免替换用户其他项目正在使用的 Node.js。

## 已确认的阻碍

1. `lib/web/startup.mjs` 和 `lib/web/runtime-main.mjs` 强制要求 tmux；会话选择默认进入 tmux。
2. `lib/process/pinned-cwd.mjs` 明确拒绝 win32，并依赖 POSIX 目录描述符与 `process.execve`。
3. `lib/process/identity.mjs` 只为 Linux/macOS 返回完整进程身份；当前 Windows 活进程仍为 unknown。
4. `lib/runtime/private-state.mjs` 依赖 uid、POSIX 权限和 no-follow 操作；`project-trust.mjs` 依赖 Unix ACL 检查。
5. 文件读写除了平台检查，还依赖固定目录中的子进程和相对文件操作，不能仅删除拒绝 Windows 的判断。
6. provider 命令发现、参数引用、hooks、shims 和 npm 更新存在 Bash/Unix 假设。
7. 当前 node-pty 1.2.0-beta.15 已带 Windows 预编译组件，但 PID 异步就绪、`kill(signal)` 不受支持，部分操作等待首个输出。当前 PTY 发布与关闭代码不能直接复用。
8. Windows CI 目前主要验证文件访问被明确拒绝，不能证明完整运行能力。

## 方案比较与选择

| 方案 | 收益 | 代价及限制 |
| --- | --- | --- |
| 直接启用现有 Web 进程内 PTY | 改动较少，可尽早看到终端 | Web 重启会终止终端，仍需解决目录、状态、进程身份与关闭问题，不满足完整目标 |
| 平台接口 + 独立 Windows 终端服务（推荐） | 保留分离、重连及 Web 重启后的终端；复用现有产品流程 | 需要原生文件/进程组件和明确的终端服务生命周期 |
| 每个终端启动一个独立宿主 | 单会话故障隔离直接 | 进程、认证与恢复记录更多；仍然需要相同的原生基础组件 |

采用第二种。业务层使用平台能力和受管终端接口；Linux/macOS 继续由现有 tmux 实现提供服务，Windows 由独立终端服务提供服务。避免在各业务路径中分散增加 Windows 特例。

## Windows 平台基础组件

新增窄接口的 Windows 原生组件，构建为预编译 Node-API 模块，随 npm 包交付。将文件句柄、进程句柄与 Job Object 等操作集中在该组件；安装用户不需要编译器。组件缺失、架构不匹配或协议版本不兼容时明确失败。

JS 适配层负责参数校验、错误码映射、能力检测和生命周期管理；原生层负责实际 Windows 系统调用。每项能力必须先通过实机合约测试，再接入业务层。原生代码按文件、权限、进程拆分，不能形成一个不受约束的“任意系统命令”入口。

### 文件、身份与私有状态

- 用 Windows 用户 SID 和 ACL 验证替代 uid/chmod。私有状态放在用户自己的 `.hello-cc` 下，由当前用户及必要的系统/管理员主体访问；不通过修改项目目录 ACL 来获得权限。
- 项目与文件身份使用带版本的 Windows 身份方案，包含卷身份、文件 ID 与必要的生成证据；持久化字段必须区分 POSIX 与 Windows。未知或不兼容身份不能被当作匹配。
- 大小写、盘符、长路径和根目录别名的规范化集中处理；同一对象不得因路径大小写不同而进入两套锁或状态目录。
- 对实际打开的每个组件检查长文件名，避免 8.3 短名绕过私有文件过滤；区分默认大小写不敏感目录和显式大小写敏感的 NTFS 目录。
- 私有目录和文件创建时即设置受限 DACL，再写入 token 或清单；保留 authority 标记、替换目录的新 generation、拒绝历史状态串用和私有状态损坏时禁止回退的规则。
- 文件操作逐级使用句柄相对打开并拒绝路径内部的重解析点。保留私有文件过滤、大小限制、硬链接限制、文件版本冲突和不确定写入结果语义。
- Windows 特殊路径必须拒绝，包括设备路径、备用数据流、保留设备名、尾随点/空格别名及目录穿越。HTTP 路径仍使用项目相对的正斜杠形式。
- 保存采用同目录临时文件与受控发布，保留 BOM、CRLF、内容 revision 和“可能已写入但结果无法确认”的状态；不得自动重试不确定写入。
- 保存需明确保留目标 DACL/基本属性，上传必须通过句柄相对的独占发布。authority 发布必须有 Windows 专属的刷盘与中断恢复合约，不能将文件 FlushFileBuffers 等同于 POSIX 目录 fsync。
- SQLite 位于已验证的私有目录，必须验收 WAL/SHM 创建、并发连接和退出清理，不依赖虚假的 POSIX mode 值。

### 固定工作目录是首个放行条件

现有产品要求所选目录被替换后，子进程不能静默启动到替换目录。Windows 的 `CreateProcessW` 接收路径，没有直接等价于 POSIX `fchdir` 的公开启动接口。

首个实施阶段必须用原生合约实验确定固定目录启动能否维持这一要求。候选实现采用已验证的本地 NTFS 目录、受信任的非重解析祖先、持有的目录句柄、可信启动器与启动回执；测试必须覆盖祖先及根目录替换、junction 原地变更、已有写句柄和启动窗口竞争。必须包括空目录上仅带 FILE_WRITE_ATTRIBUTES 的重解析变更，以及捕获目录前已经打开的此类句柄。

仅持有不允许删除的目录句柄，或仅做启动前后 stat，均不足以证明正确；Windows 的部分属性/重解析操作不受希望中的共享访问限制。不得把未经证实的句柄锁当作完整保证，也不得依赖未公开的子进程 PEB 结构读取工作目录句柄。

放行标准是：启动的进程确实进入选定目录，或在执行用户/provider 代码前失败；绝不能先执行错误目录中的代码，再由事后检查报告错误。若公开 API 方案无法通过测试，保留阻断，记录具体反例并修订实现或支持范围，不能继续把该路径标记为 Windows 可用。

## 进程启动、识别与关闭

- 身份观测通过进程句柄取得创建时间与程序身份；无法查询时返回 unknown。权限不足与确实不存在必须区分。
- 受管进程在挂起状态下创建，先归属 Job Object，再恢复执行。归属失败必须终止并回收，不能留下未受管进程。
- 正常关闭先走 provider 协议的取消/EOF，再按超时终止拥有的 Job，最后确认进程与输出流都结束。关闭句柄、发送信号和真实退出是不同结果。
- 避免基于保存的 PID 调用 `taskkill /T`；所有破坏性操作必须绑定仍然持有的进程/Job 所有权。
- 现有 native daemon 使用认证的本机 HTTP，可以保留。启动锁、runtime 指针和所有权 generation 使用相同的 Windows 身份规则。
- 后台服务启动不弹出额外控制台窗口。用户明确连接终端时才建立交互连接。
- CLI 提供可执行文件加参数数组；provider 默认路径不经过 shell 字符串拼接。统一处理 Path/PATH 和 PATHEXT。
- npm 安装的已知 provider 优先解析到真实 JS/EXE 入口；`.cmd`、`.bat`、`.ps1` 使用明确的适配器并做参数逐字往返测试。未知包装器给出可操作的诊断。
- Claude SDK 单独验收其子进程所有权：如 SDK 不提供合适的启动接口，将 SDK 放入 HCC 拥有的辅助进程及 Job 中，不能假定 `close()` 已清理全部后代。

## 持久受管终端

新增后端接口，业务调用使用 `create / list / attach / detach / input / resize / snapshot / terminate`。协议返回终端实例、项目 generation、进程身份与能力信息。新增字段和终端类型保持向后兼容，现有 tmux API 参数在 POSIX 上继续工作。

Windows 终端服务按用户启动，使用认证的 loopback 通信；私有凭据不出现在命令行或日志中。服务持有 ConPTY、进程 Job、会话代次和有界输出状态，与 Web runtime 分开运行。宿主崩溃时其 Job 负责清理自己创建的进程；Web runtime 崩溃不终止终端。

终端先进入 starting，只有真实 PID、进程身份、目录与宿主回执均确认后才发布 running。启动早退、静默子进程、取消和超时必须形成可核查结果。不能把 node-pty 的初始 PID 0 写入运行记录。

优先复用 node-pty 的 ConPTY 传输，但必须通过静默启动取消、Job 归属和进程清理合约测试。如果公开接口无法支持这些保证，则在同一后端接口内实现原生 ConPTY 传输；不得通过依赖的未公开字段伪造完成。

浏览器与本地 CLI 连接复用现有控制租约。断开连接和显式分离保留会话；明确 terminate 才关闭该会话及其进程树。Web 正常退出只分离终端连接，重启后以宿主实例和会话 generation 核对、恢复连接。

重连需要可恢复的终端屏幕状态和有序输出尾部，不能只截取一段可能从 ANSI 转义序列中间开始的字符串。输入、resize 和关闭动作也必须核对当前控制租约及会话代次。

不扫描和接管任意 Windows 控制台。`hcc peer start/attach` 和 `hcc run` 通过该宿主创建或连接受管终端；普通 provider 命令通过 Windows shim 加入已初始化的项目。

## 用户入口与能力展示

- 默认 Windows 终端优先 PowerShell 7，未安装时使用系统 Windows PowerShell 5.1；支持显式 cmd。真实路径、参数和 Unicode 分别验收。
- 为 Windows 提供薄 `.cmd` / `.ps1` 入口，核心逻辑放在共享 JS；避免复制整份 Bash shim。
- hook 生成显式 Node 调用，并遵循 provider 实际使用的 Windows 执行方式。安装/卸载以标记和精确匹配识别 HCC 配置。
- Web 展示通用“终端”，按后端能力启用创建、连接和管理操作，不让用户选择不存在的 tmux。
- `doctor` 的环境检查可在项目尚未初始化时工作，报告 Node、系统/架构、原生组件、权限、终端后端和 provider；运行数据库体检仍保持只读。
- 安装文档区分“支持的目标”“已实测的平台”和“已验证的 provider”。不能把某一台机器上的通过写成所有 Windows 配置都已通过。

## 实施顺序与阶段出口

1. **原生基础合约与可行性**：独立 Node 24；文件身份/ACL、进程身份、Job 清理、固定目录启动测试。固定目录无法满足原有约束时，此处停止扩大功能并记录反例。
2. **CLI 与私有状态**：初始化、数据库、任务/消息/锁、进程启动及 daemon、环境诊断。验收普通用户、不带 Bash、中文空格路径和并发启动。
3. **文件完整流程**：浏览、预览、搜索、保存、上传、冲突与重解析竞争。所有当前安全回归形成对应 Windows 用例。
4. **后台 Agent 与安装集成**：统一命令解析，Codex/dsh 协议与 Claude SDK 隔离，hooks/shims/update/uninstall。假 provider 与真实 provider 分开计证据。
5. **持久终端与产品接入**：终端服务、CLI/Web 连接、屏幕恢复、重启续接、控制租约与进程树清理。
6. **完整安装验收和回归**：从 npm 候选包全新安装；Windows 本机与 CI；Linux/macOS 回归；文档与支持矩阵。

阶段是实施顺序，不是缩减总目标。只有全部适用出口通过后才声明完整 Windows 支持。发布到 npm、推送或合并仍按后续明确授权处理。

## 必须保留的验收证据

- Windows 实机版本、CPU 架构、Node 版本、文件系统、实际 provider 版本。
- 无 Git Bash/WSL 的 PowerShell 和 cmd 新安装测试。
- 真实 Windows 文件、ACL、junction、大小写别名、被替换目录测试；不以模拟 `process.platform` 代替系统行为。
- 创建/发送/中断/恢复/关闭的后台 Agent 协议测试，以及各 provider 的真实验收结果。
- 有子孙进程与继承输出管道的关闭测试；静默子进程、宿主崩溃、启动取消、拒绝访问和身份未知。
- 终端输入/中文/resize/多客户端控制/浏览器重连/显式分离/本地连接/Web 重启恢复/自然退出/明确终止。
- 文件编辑的 BOM/CRLF、内容冲突、不确定写入，上传重名与临时文件清理。
- 原生组件 PE 架构、接口版本和来源校验；从打包产物安装后重复关键测试。
- Linux/macOS 现有测试与发布包校验；Windows 专属 tmux 替代测试不得用大量平台跳过掩盖缺失功能。

## 参考与设计依据

- Microsoft ConPTY 生命周期：https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session
- Windows Job Objects：https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- 进程创建时间：https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes
- Windows 文件打开语义：https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
- 重解析操作权限：https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4aeefef8-92c3-4abc-af7a-a610caf8a165
- Node 子进程平台差异：https://nodejs.org/api/child_process.html

这些资料支持系统 API 的选择，不替代本项目的对抗测试和安装验收。
