# 更新日志

本项目所有显著变更都会记录在此文件中。

## [1.1.8] - 2026-09-24

- **验证版**：本版用于实机验证 1.1.7 引入的静默自更新全链路（托盘「检查更新」→ 确认 → 自动停服务、下载、静默安装、自动重启，自启设置保持不变）。无功能变更。

## [1.1.7] - 2026-09-24

- **新增（静默自更新）**：托盘「检查更新」确认后不再跳浏览器手动装——自动停止服务、下载并验签、以静默模式运行安装器（/UPDATE），装完自动重启壳并恢复 daemon。静默更新走 NSIS 的 UpdateMode，模板在此模式下保留 Run 键，**开机自启设置不再丢失**，全程无需人工干预。更新失败时弹窗说明原因并提示可用托盘「重启服务」先恢复服务。
- **新增（自启设置保留）**：安装器卸载钩子抢在模板删除 Run 键之前把自启值备份到 `~/.mcpdog/autostart.bak`；安装时发现 Run 键缺失且备份存在则原样恢复（含引号与参数，已按 NSIS ReadINIStr 语义实机等效验证逐字符一致）。手动「卸载→重装」也不再需要重新设置自启。

## [1.1.6] - 2026-09-24

- **修复（1.1.5 的更新钩子未命中实际占用路径）**：实机更新仍弹「无法打开要写入的文件: <安装目录>
ode
ode.exe」。两处原因：tauri 资源映射 `resources/node` → `node`，实际落盘是 `$INSTDIR
ode\` 而钩子里写的是 `resources
ode\`；钩子 PowerShell 用的 `$dir` 在 NSIS 里无值（展开为空串会让过滤失真）。改为按 `$INSTDIR` 任意层级过滤（覆盖新旧两种布局），变量改用 NSIS 内建 `$INSTDIR`。已在实机以真实安装目录等效验证：过滤命中 daemon、强杀后 `node.exe` 镜像锁释放，且不触及系统 Node 进程。
- 提示：从 1.1.5 升级本版时仍可能弹一次占用（旧安装器的钩子不带本次修复），点「忽略」完成安装即可，之后的更新不再需要人工干预。

## [1.1.5] - 2026-09-24

- **修复（桌面壳更新时 node.exe 被占用）**：更新覆盖安装必弹「文件被占用」需手动忽略。根因是 daemon 以安装目录内嵌 `resources
ode
ode.exe` 为进程镜像，而被「接管」的 daemon（EXTERNAL_PID）不在 MCPDog.exe 进程树内，NSIS 的 taskkill /T 杀不到它，壳的既有停机路径也刻意不停它。现在托盘「检查更新」确认后先 `stop_for_update()`（优雅 `daemon stop` + 超时后经身份复核强杀兜底）再打开下载链接；`INTENTIONAL_STOP` 标志保证更新停机期间守护循环不自动拉起；NSIS 新增 PREINSTALL/PREUNINSTALL 钩子按安装目录前缀精确清理残留 node 进程（不误杀系统 Node）。
- **修复（桌面壳单测加载即死）**：测试二进制内任何代码触达 `resource_dir()`（tauri 资源解析链）即 `STATUS_ENTRYPOINT_NOT_FOUND`。改为 daemon spawn 成功时缓存 node/cli 实际路径（`EMBEDDED_PATHS`），停机复用缓存，缓存为 None 时优雅停机自动跳过走强杀兜底。
- **清理（npm 包瘦身）**：删除从未被 import 的 `@modelcontextprotocol/server-puppeteer`、`@playwright/mcp`、`@modelcontextprotocol/server-filesystem` 三个依赖（仅以 npx 字符串引用，运行时由子服务器自行拉取），用户安装体积减少约 12MB；删除 7 个早期原型孤儿模块约 2200 行；`config list` 的工具数假占位改为 `-`。
- **修复（stdio 协议流污染）**：`mcpdog-server`/`tool-router`/`daemon-client` 共 10 处 `console.log` 日志改走 stderr——stdio 直连模式下这些日志会混进 stdout 的 NDJSON 协议流导致 MCP 客户端解析失败。新增 `stdio-stdout-purity` 回归守卫测试。

## [1.1.4] - 2026-09-21

- **修复（关键，stdio 迟到的旧进程 exit 会打断新连接的在途请求）**：1.1.3 引入的进程身份校验被写在了 exit 处理器的「拒绝所有在途请求」**之后** —— 于是迟到的旧进程 exit 仍会拿旧进程的退出原因去拒绝**新连接**的握手/请求。表现是重连时新进程以「子进程已退出 (signal=SIGTERM)」失败，该服务器连不上；Linux 上稳定复现（CI 闸门即因此变红），Windows 时序较快才没暴露。进程身份校验必须是处理器的第一件事，任何对共享状态的改动都排在它之后。测试也改为**确定性**复现：在新连接有在途请求时投递旧进程的 exit，并已做负向对照。
- **说明**：1.1.3 的 npm 包在发版闸门失败的情况下已先行发布（`publish-npm` job 与闸门并行，不依赖它），因此 1.1.3 仍含上述缺陷；本版为其修复。1.1.3 的 GitHub Release 因闸门失败未产出 npm tarball 与发版说明，仅有 Windows 安装包。

## [1.1.3] - 2026-09-20

### 安全

- **修复（关键，管理 API 鉴权可被大小写绕过）**：Express 的 `app.use('/api', …)` 按大小写不敏感匹配挂载前缀，而鉴权中间件用大小写敏感的 `req.path.startsWith('/api/')` 判断「是否 API 请求」。于是 `GET /API/config` 被归入「静态资源」直接放行 —— 本机任意进程不带任何令牌即可拿到完整配置（含下游 `env` 与 `apiKey`）。仅监听回环不构成防线。现统一用大小写不敏感的 `isApiPath()`。

### 修复

- **修复（关键，建连失败的服务器永久离线）**：HTTP+SSE 适配器的重连排期此前分散在多处，且重建前的 teardown 会顺手清掉驱动重试的定时器 —— 于是「首次建连失败」或「重连失败一次」之后重试链就断了，该服务器永久离线（`connectAll` 只把失败计入计数、不会重排），只有改配置才会回来。现收敛为唯一的 `scheduleReconnect()`，集中保证「定时器句柄」与 `isReconnecting` 同真同假，并由 `connect()` 的失败路径统一负责续排；`cleanup()` 拆出只关流的 `closeEventStream()`，让重连前的 teardown 不再误清自己的定时器。另：握手窗口内掉线此前会被记成「建连失败」而不排重试，现同样纳入统一排期。
- **修复（关键，stdio 写入 EPIPE 拖垮整个 daemon）**：`stdin` 是独立于 `child_process` 的 socket，向已退出进程写入时错误以**异步** `'error'` 事件到达（`EPIPE`），`try/catch` 接不住。此前既无监听也无回调，该事件成为进程级 `uncaughtException`，而 CLI 的 handler 是 `process.exit(1)` —— 一个下游进程死掉会把整个 daemon 连同所有会话一起带走。现所有写入统一走 `writeToStdin()`，把失败交回请求方（实测 8/8 轮不再产生进程级错误）。
- **修复（关键，非数字的 `--timeout`/`--retries` 会写出 `null` 并让界面永久存不了盘）**：CLI 用 `parseInt` 解析这两个选项且不校验，`parseInt('abc')` 得到 `NaN`，而 `JSON.stringify(NaN)` 写出的是 `null` —— 落盘后 `PUT /api/config` 校验整份配置时会一直 400（正是上一条想防的那件事）。`validateConfig` 也没拦住：`typeof NaN === 'number'` 通过，而 `NaN <= 0`、`NaN < 0` 都是 false，类型与范围两道检查同时漏过。现 CLI 侧统一走带 NaN 判定的解析函数（非法值直接报错退出），`validateConfig` 显式拒绝 NaN。
- **修复（界面清空超时/重试是静默空操作）**：与 env/headers 同一类问题 —— 输入框清空时把字段设为 `undefined`，`JSON.stringify` 丢掉该键，服务端按合并处理便保留旧值，界面回「保存成功」实际没改。现清空时写回文档默认值（30000 / 3），与运行时代码的默认一致，不再是静默空操作。
- **修复（界面比后端更严，导致带点号的环境变量名存不了盘）**：后端已放宽为与 Node 一致（只禁 `=` 与 NUL），但 `ServerPanel`/`AddServerModal` 仍用「字母/下划线开头且仅字母数字下划线」的旧正则，保存时直接弹窗拦下 —— 从 Claude 配置导入一个带点号的名称后就编辑不了该服务器。现界面与后端同一判据；并移除后端那个已无调用方的旧严格校验，避免日后被误用而重现该缺陷。
- **修复（局部更新被「无关的既有字段」拦住）**：`PUT /api/servers/:name` 会校验合并后的整条配置，于是一条手工编辑遗留了 `enabled:"yes"` 的条目，连只改 `description` 都会被 400。现只拒绝**本次更新新引入**的问题（先算出既有配置的错误集合再过滤），既放行无关的局部更新，也仍能抓住「切换传输却没给 url」这类由本次更新造成的问题。
- **修复（运行时状态被写进配置文件）**：界面会把整个 `/api/servers` 对象回传（含 `connected`/`toolCount`/`tools` 等运行时字段与完整 `inputSchema`），而更新处理函数原样合并落盘 —— 实测配置从 96B 膨胀到 1255B，且写入的是每次都变的连接状态。现按配置字段白名单过滤后再更新，这些字段没有任何读者。
- **修复（`ServerPanel`/`AddServerModal` 源码里混入裸 NUL 字节）**：上一轮放宽 env 名校验时，`' '` 被写成了**字面 NUL 字节**而非转义序列 —— 语义正确，但文件因此被当作二进制，`grep`/`rg` 静默跳过、编辑器与检索工具读不到，任何人按名搜索都会漏掉这两个文件。现改回转义序列（文件恢复为 UTF-8 文本，可被正常检索）。
- **修复（关键，`mcpdog config update` 可写出永久加载不了的配置）**：这是唯一能改 `transport` 的 CLI 路径，而 `updateServer` 在切换传输时会清掉不适用字段（改成 http 删 `command`、改成 stdio 删 `url`）—— 它此前不校验就落盘。于是 `config update <name> --transport bogus` 以 exit 0 报「更新成功」并写下一个永久加载不了的条目；`--transport streamable-http` 不给 `url` 也一样（连它自己的 `config validate` 都会报错）。更糟的是此后 `PUT /api/config` 校验整份配置时会一直 400，界面再也存不了盘。现先快照、用 `updateServer` 自己的合并语义取结果校验，不合规则回滚并以非零码退出。
- **修复（界面比后端更严，导致带点号的环境变量名存不了盘）**：后端已放宽为与 Node 一致（只禁 `=` 与 NUL），但 `ServerPanel`/`AddServerModal` 仍用「字母/下划线开头且仅字母数字下划线」的旧正则，保存时直接弹窗拦下 —— 从 Claude 配置导入一个带点号的名称后就编辑不了该服务器。现界面与后端同一判据；并移除后端那个已无调用方的旧严格校验，避免日后被误用而重现该缺陷。
- **修复（界面删掉最后一个环境变量/请求头后保存是静默空操作）**：`ServerPanel` 在 map 清空时把该字段设为 `undefined`，而 `JSON.stringify` 会丢掉这个键，服务端按「合并」处理便保留旧值 —— 界面回「保存成功」，实际什么都没改（子进程仍用旧环境变量启动）。现改为发送显式空对象，服务端据此真正清空。
- **修复（关键，导入一次 Claude 配置后界面再也存不了盘）**：`POST /api/import/claude` 直写配置、不过校验，而 `PUT /api/config`（界面的保存按钮）会用 `validateConfig` 校验**整份**配置 —— 一个导入进来却过不了校验的条目，会让此后每一次保存都 400，界面看着正常却再也存不下任何改动。根因有两处：导入路径未校验；且 `validateEnvironmentVariables` 比 Node 实际约束更严（拒绝数字值 `{"PORT":3000}` 与带点号的名称 `my.var`，而 `spawn` 两者都接受，daemon 自己也为它们建过 adapter）。现导入路径走同一份校验（不合规的条目跳过并回报原因），env 值在导入时归一为字符串，名称/值判据与 Node 实际约束对齐（只禁 `=` 与 NUL）。
- **修复（字段类型未校验导致死条目）**：`validateConfig` 只查 name/transport/command/url 与 timeout/retries 的数值范围，不查类型。`AddServerModal` 会把粘贴的 JSON 原样展开，于是 `{"command":"npx","args":"-y pkg"}`（args 写成字符串）被接受并落盘，启用时在 `this.config.args?.join(' ')` 处抛 `join is not a function`，该服务器永久连不上。现校验 `args`（字符串数组）、`cwd`（字符串）、`env`（对象）、`enabled`（布尔）、`timeout`/`retries`（数字）、`toolsConfig`（对象）。
- **修复（配置写入 API 的存在性与校验顺序）**：`PUT /api/servers/:name` 对**不存在的**服务器做局部更新时，合并结果只有请求体里那几个字段、必然缺 `name`/`transport`，于是回的是 400「Transport type is required」而不是应有的 404（存在性检查此前排在校验之后）。现先判存在性再校验。
- **修复（`PUT /api/config` 未校验条目内容）**：它只检查每个 `servers` 条目「是不是对象」，不校验 transport 与必填字段 —— `transport:"bogus"` 或缺 `url` 的条目会被接受并落盘，而该服务器在加载时必然抛错。现与 `POST`/`PUT /api/servers` 共用同一份 `AdapterFactory.validateConfig`。
- **修复（写入配置的入口统一校验）**：`POST /api/servers`、`PUT /api/servers/:name`、`PUT /api/config` 与 `config add` 此前只检查「是不是对象」，不校验 transport 与必填字段；`AdapterFactory.validateConfig` 的 `switch` 也缺 `default`，未知 transport 被判为合法。于是 `transport:"bogus"`、缺 `command` 或缺失 `url` 的条目被写进配置并回报「成功」，而该服务器在加载时必然抛错 —— 界面上多一个永久连不上的死条目。现所有写入端统一走 `validateConfig`（含新增的未知 transport 分支）。
- **修复（结构非法但可解析的配置拖垮 daemon）**：`loadConfig` 只做 `JSON.parse`、不做结构校验。`{"servers":null}` 或 `{"servers":{"x":null}}` 能解析通过，但会让 `getEnabledServers`/`reinitializeAdapters` 抛错 —— 经文件监听热加载后 `/api/status` 与 `/api/servers` 持续 500，且没有自愈路径（只能手工改回文件）。现拒绝这类文件并保留内存中的既有配置。
- **修复（CLI `--json` 模式失败时无任何输出）**：`CLIUtils.error` 在 JSON 模式下直接 return，配合各命令的 `process.exit(1)`，机器消费者拿到的是「退出码 1 + stdout 空 + stderr 空」，完全不知道哪里失败。现输出 `{"success":false,"error":"…"}`，与 `config add` 既有契约一致。
- **修复（`StreamableHttpAdapter` 把被取代的建连报成成功）**：握手期间被 `disconnect()` 取代时此前是正常 `return`，于是 `ToolRouter.connectAll` 把这次算作「连接成功」，日志与计数里出现一个并不存在的连接（`isConnected` 实际为 false）。现改为抛出，让调用方看到真实结果。
- **修复（关键，下游会话失效后该子服务器永久不可用）**：`StreamableHttpAdapter` 收到 404（会话已不存在）时只清空 `sessionId`，**从不重新握手**。清空之后请求不再带 `Mcp-Session-Id`，下游对「无会话的非 initialize 请求」回 4xx —— 而该状态码不在任何恢复分支里，于是此后每一次调用都失败；同时 `isConnected` 仍为 `true`，`connectAll` 又认为该 adapter 无需重连，**没有任何一层会来修它**。线上表现为 ssh-server / publish-tools 两组工具全部报 422。现把 404、以及「手里已无会话却被下游拒绝（422/400）」都判定为会话失效，立即重新 initialize 换新会话，并在同一次调用内重试一次（换新请求 id，避免与上一次迟到的响应串号）。会话重建不走 `connect()`/`disconnect()`（失败的是会话而非连接，摘挂工具路由会让在途调用平白失败），并发失败经单飞闩合流。
- **修复（关键，`mcpdog stop` / `restart` 可能终止无关进程）**：强杀兜底会 `taskkill /F /T`（POSIX 上 SIGKILL）一个按 PID 取到的进程，但 stop/restart 此前不校验该 PID 是否真是我们的 daemon。PID 文件在非正常终止时不会被清理，重启后该 PID 很容易被别的程序复用。现新增严格判定的 `isConfirmedOurDaemon`（读不到命令行时按「不能确认」处理，不做终止）；`readProcessCommandLine` 补上 POSIX 的 `ps` 分支（此前非 Windows 恒返回 null，调用方把 null 当「是我们的」，既可能永久拒绝启动也可能 SIGKILL 无关进程）。
- **修复（关键，`mcpdog config enable/disable/remove/update` 报成功却什么都没做）**：`ConfigManager` 的变更方法只改内存并 emit，落盘由调用方负责，而这几个命令都没调用 `saveConfig()` —— 每个 CLI 都是独立进程，改动在退出时静默丢失。现全部落盘，并检查 `toggleServer` 的布尔返回值（不存在的服务器此前也回「已启用」）。
- **修复（关键，`PUT /api/config` 用空 body 即可清空全部配置）**：`express.json()` 对「无 body / 无 Content-Type」的请求给出 `{}`，而处理函数直接把它落盘并回 200 —— 一个 `curl -X PUT` 就能删掉所有下游服务器定义。现校验请求体必须是含 `servers` 对象的 JSON，且每个服务器条目本身必须是对象（`{servers:{x:null}}` 此前会让 `/api/status`、`/api/servers` 持续 500），顶层字段改为合并（此前只带 `servers` 的请求体会把 `version`/`logging`/`web` 从磁盘抹掉）。
- **修复（关键，未命中的 `/api/*` 请求永久挂起）**：SPA 兜底路由 `app.get('*')` 匹配上之后 Express 不再发它自己的 404，而处理函数对 `/api` 路径不写任何响应 —— 连接被一直挂着，客户端只能等自己超时。现对未命中的 API 路径立即回 404。
- **修复（一个坏请求会终止整个 daemon）**：IPC 消息处理 `handleClientMessage` 是 async 却以 fire-and-forget 调用，内部抛错（如 `reload-config` 读到写坏/半截的配置文件）会成为 process 级 unhandledRejection，而 CLI 的 handler 是 `process.exit(1)` —— 一个客户端的坏请求把整个 daemon 连同所有会话一起带走。现就地捕获。IPC `listen` 补 `error` 监听并让 Promise 能 reject（此前端口被占用是 uncaughtException，且外层的启动失败提示永远走不到）。
- **修复（stdio 代理自杀，导致它自己的自愈路径不可达）**：`DaemonClient.scheduleReconnect` 的重连定时器回调从不把 `this.reconnectTimer` 置回 `undefined`，而该字段正是「已有重连在排队」的防重入判据 —— 回调触发后它仍是一个 truthy 的已完成对象，下一次调度被直接短路，**重连只跑一轮就再也不试**，proxy 的「连续多次失败就自拉起 daemon」阈值永远达不到；同时回调里裸调用 `connect()`，失败即 unhandledRejection → `process.exit(1)`。现回调首行复位自身、接住 rejection 并续排下一轮。
- **修复（在途请求永久挂起）**：`DaemonClient` 的连接关闭 / 主动断开都不了结 `pendingRequests`，等待方（`await sendMCPRequest`）永远拿不到结果，`stdio-proxy` 又是 silent 模式连日志都没有。现在关闭与断开都会以明确错误拒绝所有在途请求；未连接时 `sendMCPRequest` 立即失败而不是登记一个永远不会有响应的请求。
- **修复（转发失败被误报成报文格式错误）**：`stdio-proxy` 的 catch 对所有异常统一回 `-32700 Parse error`，把连接问题说成 JSON 格式问题，排查方向被带偏。现在只有真正的 `JSON.parse` 失败才是 Parse error，其余回 `-32603` 并带上真实原因。
- **修复（`daemon stop()` 挂起、只能强杀）**：`DELETE` 请求被 SDK 校验拒绝时，SDK 会在**关闭 transport 之前**就 `return`（不抛异常），而处理函数用 `finally` 无条件删除会话条目 —— 这一删，transport 与它持有的 SSE 流再没人能碰到（不在表里，空闲回收与 `close()` 都够不着），`http.close()` 的回调永不触发，停机于是挂住。现仅在 SDK 确实关闭了 transport 时才移除条目，否则兜底关闭。
- **修复（配置落盘与变更语义）**：`saveConfig` 改为原子写（同目录临时文件 + rename，临时名每次唯一 —— 只用进程号时并发保存会因共用临时文件而随机失败成 500）；配置重载失败此前只 `emit('configError')` 而全仓无监听方，等于静默吞掉（内存与磁盘长期分叉），现同时打日志；`toggleTool` 原是无条件 `return true` 的空实现，现真实写入并返回真实结果；`detectConfigProtocol` / `auditAllServerProtocols` 原先把每个服务器都硬编码报告成 `stdio`（`mcpdog detect`、`diagnose`、`audit` 的结论与打分全部失真），现据实回报。
- **修复（`mcpdog detect` / `diagnose` 崩溃并写坏配置）**：上述检测函数的返回字段必须与调用方读取的字段一致（`detected` / `confidence` / `recommendations` / `current` / `needsUpdate`）—— 调用方会在 `detected !== server.transport && confidence > 70` 时把它写回配置，返回 `undefined` 会把 `transport` 覆盖成 `undefined`。现按契约返回，并保证 `detected` 永远是合法取值。
- **修复（`--auto-detect` 是空实现却报成功）**：`config add --auto-detect` 整段逻辑被注释掉，仍然打印「检测完成」并回 `{"success":true}`；同处还有两行调试 `console.log` 无条件污染 stdout（破坏 `--json` 消费方，并把 `--headers` 里的凭据打进日志）。现接上真实可用的 `AutoConfigGenerator`，移除调试输出。
- **修复（工具管控可被绕过）**：被禁用的工具此前只是不出现在 `tools/list` 里，客户端只要知道名字（或持有配置热更新前的旧清单）就能照常调用。现在 `callTool` 同样拒绝，且错误信息里不再泄漏被禁用工具的名字。
- **修复（路由键不稳定，客户端手里的名字会失效或指向别的工具）**：路由键的取名规则在 `refreshToolRoutes`（先到者占裸名）与 `getAllTools`（跨服务器计数）里不一致，会产生重名条目与不可达工具；且取名依赖**下游 tools/list 的顺序**，同一批工具换个次序就会让名字指向不同的下游工具（静默误执行）；掉线清缓存还会让其他服务器的同名工具在 `alpha-x` 与裸名 `x` 之间反复跳变。现由单一 `allocateRouteKeys()` 统一取名（两轮分配：先给首选名，落选者再追加前缀直到唯一），结果只取决于「服务器名 → 工具名集合」，与顺序无关；掉线不再清缓存（对外可见性由 `getAllTools` 只遍历已连接 adapter、以及 `callTool` 的「Server not connected」保证）。
- **修复（调用时按前缀反推下游工具名）**：`callTool` 原先用 `startsWith(serverName + '-')` 反推真实工具名。服务器若自带一个形如 `<本服务器名>-xxx` 的真实工具（如 `files` 有 `files-read`），反推会把它改成 `read` 再发出去 —— 若该服务器恰好也有 `read`，就会以调用方参数静默执行另一个工具。现每个路由显式记录 `originalToolName`。
- **修复（工具开关判定两处不一致）**：`ToolRouter` 只认 `toolSettings`，而 Web 界面还会看 `enabledTools` / `disabledTools`，两边语义相反 —— 界面显示启用、客户端拿不到工具。现两边使用同一套判定（逐工具开关优先，其后按模式取数组）。
- **修复（HTTP+SSE 适配器状态机）**：`disconnect()` 因 `!isConnected` 早退，导致「已请求停机」的服务器在重连退避窗口里自己连回来（且 `isReconnecting` 卡 true 会永久屏蔽后续重连）；重连路径可能先关掉一条活流再空转返回、然后谎报「重连成功」；`disable()` 不关底层 `EventSource`，移除适配器后库自身的重试仍在打下游；握手期的 `notifications/initialized` 因 `isConnected` 尚未置位被静默丢掉。现逐一修正，并引入连接代数让「停止」在握手进行中也生效、并发 `connect()` 经单飞闩合流。
- **修复（HTTP+SSE 握手期掉线导致适配器永久僵死）**：onopen 之后、`isConnected` 置位之前有 ≥1s 窗口，其间掉线会进入掉线重连分支（置 `isReconnecting` 并挂定时器），而随后「握手期间流已死」分支调用的 `cleanup()` 又把定时器清掉，标志位却无人复位 —— 结果是 `isReconnecting=true` 且无定时器，此后所有掉线被 `if (this.isReconnecting) return` 永久忽略，适配器在一条死流上保持 `isConnected=true`（工具调用全部超时，`connectAll` 还认为它无需重连）。现按「本次握手是否由重连发起」区分处理：普通 `connect()` 失败清干净重连状态，重连发起的 `connect()` 失败保留该状态以续排下一轮退避重试（这两件事此前互为张力，任取其一都会踩另一个）。
- **修复（HTTP+SSE 建连卡住后实例再也连不上）**：对端接受 TCP 却不回响应头时，库会把在飞的 fetch abort 掉且不派发任何事件，`connectSSE` 的 Promise 永不 settle —— `connectPromise` 永久占位，此后每一次 `connect()` 都直接返回那个永不 settle 的 Promise。现为其登记 settle 出口，由 `cleanup()`/`disconnect()` 了结，并在 `disconnect()` 里显式释放。
- **修复（stdio 迟到的旧进程 exit 打回新连接）**：`cleanup()` 用异步 `taskkill`／延迟 `SIGKILL` 杀旧进程后立刻把 `this.process` 置空，而恢复只等 1s 就拉起新进程 —— 旧进程的 `exit` 常在新进程已连接之后才送达，该事件此前不校验「是不是当前进程」，于是把健康的新连接标成断开、发出 `disconnected`（工具从 `tools/list` 消失），还会再排一轮恢复把新进程也杀掉：一次「重启该服务器」变成 3 个进程、连接跌落约 2s。现忽略非当前进程的 `exit`。
- **修复（stdio 子进程树未杀干净）**：`cleanup()` 只向 `this.process` 发信号，而全局安装的 npx/npm 型子服务器经 `cmd.exe` shim 启动，`this.process` 是 `cmd.exe`、真正的服务进程是它的子进程 —— 实测 shim 已死而 node 子进程在 1s/3s/6s 后仍存活成孤儿。现于 Windows 用 `taskkill /T /F` 按进程树终止。
- **修复（`forceReconnect()` 静默空操作）**：`disconnect()` 会置位「放弃恢复」标记（为阻止停机后又被自动拉起），而 `forceReconnect()` 紧接着调用恢复流程 → 被该标记直接挡回，永远不会重新拉起进程。现于主动重连前清除该标记。
- **修复（配置落盘在 Windows 上随机失败）**：原子落盘用的 `rename` 覆盖已存在目标时，Windows 会间歇性抛 `EPERM`/`EBUSY`（实测串行 200 次失败 2~6 次、并发 10 次失败 3~4 次，重试一次即成功）。该失败会一路冒泡成 HTTP 500，前端表现为「随机保存失败」。现对这类瞬时错误退避重试。
- **修复（stdio 适配器）**：`disconnect()` 同样会跳过退避窗口中的适配器（恢复定时器不受管理，断开后进程仍会被拉起），且黑名单只在进程退出时重新求值 —— 拉黑期间 `connect()` 直接抛错、不会有新的退出事件，过期判断永远不再执行，一次拉黑就是整个进程生命周期内永久不可连；`notifications/initialized` 也因 `isConnected` 判据被丢弃；`attemptRecovery` 在 1s 等待结束后不复查是否已被停机。现全部修正。
- **修复（`MCPDogServer.stop()` 后再 `start()` 失效）**：stop 只断开不移除 adapter，再次 start 会在 `addAdapter` 处撞「already exists」，新配置的 adapter 被丢弃、只有旧实例被复用 —— 停机期间改过的连接参数不生效。现 stop 会移除全部 adapter。
- **修复（Web API 的一批假成功与静默破坏）**：`PUT` 与 `DELETE /api/servers/:name` 对不存在的服务器回 200「已更新」/「已删除」（底层返回 false 被忽略）；`DELETE` 后 adapter 仍活着、工具照旧可列可调（依赖 `toggleServer` 触发移除，而条目已删、该调用是 no-op），现直接摘除；`PUT /api/servers/:name/tools` 无 body 会静默清空用户的逐工具设置并回成功，现校验；`PUT /api/servers/:name` 接受数组 body 会写入 `"0"`/`"1"` 这类数字键污染配置，且接受 `AdapterFactory` 不支持的 transport（落盘后该服务器永久不可加载），现校验；`POST /api/servers` 在校验前就落盘，失败时留下残缺条目且下次启动仍被当作启用，现先校验后落盘。
- **修复（`mcpdog start` 的两个守卫形同虚设）**：`isDaemonRunning` 用的 PID 文件路径与 daemon 实际写入的不一致（按 cwd 找），且用 `parseInt` 解析 JSON 格式内容恒得 `NaN`。现与 daemon 使用同一路径与同一解析器，并补上进程身份校验（此前一个被复用的 PID 会让启动被永久拒绝）。
- **修复（端口探测查错地址）**：可用性探测绑 `localhost`，而 dashboard 实际绑定 `127.0.0.1` —— Node 把 `localhost` 先解析到 `::1`，于是一个已被占用的 `127.0.0.1:port` 会被判为可用，随后绑定必然 `EADDRINUSE`。现探测与真实绑定地址一致。
- **修复（通知链路从未打通）**：`notifyToolsChanged()` 的守卫读 `clientCapabilities.supportsNotifications`，而它按 `params.capabilities?.notifications !== undefined` 计算 —— MCP 的 `ClientCapabilities` 没有 `notifications` 字段，该值恒为 false 且被首个客户端锁死，于是 `initialize` 响应里宣告了 `tools.listChanged` 却永远不发通知。现只要求已 initialize，并把通知补全到 stdio 客户端（daemon 此前没有监听 `'notification'`，`stdio-proxy` 也没有把它写回客户端）。
- **修复（仓库污染）**：`shouldAutoCreateConfig` 用相对路径 `./test-write-<ts>` 在进程 CWD（CLI 与测试下即项目根目录）做可写探测，写入还是 fire-and-forget，任何提前退出都会把文件永久留下；且 `return true` 写在 Promise 之外，探测本身不成立。现改为在目标目录同步探测并保证清理。

### 测试

- 新增 `src/adapters/streamable-http-adapter.session.test.ts`（会话失效后自愈并可持续工作、无会话时撞 4xx 同样自愈、并发只重建一次、`sessionMode: 'disabled'` 不误触发、`initialize` 自身失败不递归）
- 新增 `src/adapters/http-sse-adapter.reconnect.test.ts`（9 条：重连成功后标志位必须复位、掉线能重连且重连后仍能检测下一次掉线、**第一次重连失败后必须继续重试直到下游恢复**、**握手窗口内掉线不得把重连标志闩死**、**建连卡住时 disconnect 必须了结 connectPromise 且实例仍可再用**、`disconnect` 后不自己连回来、首次建连失败标志位干净、建连失败后仍能连上）—— 该适配器此前**没有任何测试**
- 新增 `src/utils/test-safe-port.ts`：取 fetch 可用端口。`listen(0)` 可能落到 WHATWG 阻止端口（Node 的 fetch 直接以 `bad port` 失败，而端口本身可绑定），会让 endpoint 测试随机挂
- `src/adapters/stdio-adapter.exit.test.ts` 增补：**迟到的旧进程 exit 不得打回新连接的状态**
- `src/config/config-manager.contract.test.ts` 增补：**并发 saveConfig 不得随机失败**（覆盖 Windows rename 的瞬时 EPERM）
- 新增 `src/router/tool-router.conflict.test.ts`（自带前缀风格的工具名不被误剥、跨服务器重名两侧都带前缀、展示名与路由键一致、某服务器消失后其余路由键回退、被禁用工具不可调用、下游重复工具名不产出重名条目、下游删空工具后不再提供、**路由键与下游 tools/list 顺序无关**）
- 新增 `src/daemon/daemon-client.reconnect.test.ts`（连不上时持续重试而非只试一次、重连期间 daemon 恢复后能连上）
- 新增 `src/daemon/mcp-http-endpoint.delete.test.ts`（DELETE 失败路径不泄漏 SSE 流、正常 DELETE 后 `close()` 能立即完成）
- 新增 `src/cli/commands/config-commands.update.test.ts`（未知 transport 必须失败且不改文件、切到 http 缺 url 必须失败、合法局部更新与合法传输切换必须成功）
- 新增 `src/daemon/config-api.integration.test.ts`（16 条，端到端覆盖配置写入 API：合法配置必须被接受、非法配置必须 400 且不落盘、局部更新不得被误拒、空 body 不得清空既有配置、不存在的服务器必须 404、`PUT /api/config` 必须保留顶层 `version`/`logging`/`web`）—— 这组接口此前**没有任何测试**
- 新增 `src/config/config-manager.contract.test.ts`（检测返回契约、`toggleTool` 真实生效、原子落盘不留临时文件、坏配置不冲掉内存配置）
- 上述新用例均做过负向对照：在修复前的实现上运行，失败项与诊断出的缺陷一一对应。

## [1.1.2] - 2026-09-20

- **修复（关键，桌面版下所有靠 PATH 解析的子服务器都连不上）**：桌面版壳把内嵌 Node 目录以 Windows 扩展长度前缀（`\\?\`）写进 daemon 的 PATH —— 前缀来自 Tauri 的 `resource_dir()`，Rust 与 Node 都接受它，但 **cmd.exe 不接受**：cross-spawn 用 PATH 解析 `npx` 时把这个前缀带进了命令路径，cmd 执行它时报「系统找不到指定的路径。」并以 1 退出。线上表现为 playwright（`command: npx`）反复连接失败、`initialize` 等满 30s 超时后重连，形成循环；绝对路径命令（如 `codegraph`）不受影响。现于壳侧剥离 `\\?\` 与 `\\?\UNC\` 前缀（剥离后超 MAX_PATH 时保留前缀不动），`node_exe()`、`cli_entry()` 与 PATH 前置项都拿到 cmd 可用的路径。附带修正：PATH 前置内嵌 Node 的本意是「用户不必自装 Node」，此前因该前缀被 cmd 跳过而实际从未生效。
- **修复（可观测性，正是上面那条极难排查的原因）**：下游 stdio 子进程退出时，在途请求不立即失败，只能各自等满超时（默认 30s），失败原因被记成「Request timeout」——而子进程往往已经把真正的原因说出来了。现在进程一退出就用「退出码 + 它最后的 stderr」拒绝所有在途请求，例如 `子进程已退出 (code=1, signal=null)；最后的 stderr：系统找不到指定的路径。`
- **修复（可观测性）**：下游 stdio 子进程的 stderr 原先无条件按 UTF-8 解码，中文 Windows 下 cmd 及其他工具的 GBK/OEM 输出会全变成替换字符，**原始字节永久丢失**（本次诊断的时间几乎都花在这上面）。现改为按字节缓冲、按行解码：先试严格 UTF-8，失败则按系统 OEM 代码页（探测 `chcp`，936→GBK、950→Big5 等）解码，仍失败再以宽松 UTF-8 兜底；超长无换行输出不会让缓冲无界增长。
- **测试**：新增 `src/utils/child-output.test.ts`（含线上那条 cmd 报错的原始字节 `cfb5…a1a3` → `系统找不到指定的路径。`，以及 Node 型子服务器的 UTF-8 stderr 不被按 GBK 弄坏）、`src/adapters/stdio-adapter.exit.test.ts`（退出即失败并带退出码与 stderr；上一个进程的 stderr 不得污染下一次的失败原因，该条已做负向对照——撤掉清理后确实失败）与 `src-tauri/src/supervisor.rs` 中 4 条 `strip_extended_prefix` 用例（含超长路径必须保留前缀）。

## [1.1.1] - 2026-09-20

- **修复（关键，桌面版重启后 daemon 起不来）**：`daemon start` 的「已在运行」判定只检查 PID 文件里的 PID 是否存活，不检查该 PID 是否**真的是我们的 daemon**。daemon 被非正常终止（重启、强杀）时不会清理 PID 文件，而重启后该 PID 很容易被别的程序复用 —— 此时判定会误认为「已在运行」：版本相同就直接退出（daemon 在整个登录会话里都起不来，桌面版则表现为壳重试 5 次后放弃），版本不同更糟，会去强杀一个无关进程。现改为读取该 PID 的命令行并确认含 `cli-main.js` 才认定在运行；明确不是我们的进程时按陈旧记录处理，清理后继续启动。读不到命令行时按「无法确认」保守处理并记日志。
- **修复（可观测性，正是上面那条难以排查的原因）**：`daemon start` 的文件日志开启时机排在「已在运行」判定**之后**，所以被该判定拒绝的启动一行日志都不会留下。现提前到判定之前，任何启动尝试都有据可查。
- **修复（可观测性）**：桌面版壳把 daemon 子进程的 stdout/stderr 落盘到 `~/.mcpdog/shell-daemon.log`。发布构建无控制台，而 daemon 自身的文件日志覆盖不到启动早期失败，此前那段输出完全无处可看。
- **修复**：`mcpdog proxy` 的 PID 文件解析原先用 `parseInt` 读 `{"pid":N,"version":"x"}`，恒得 `NaN` → 每次都判定「daemon 未运行」并去拉起一个注定失败的子进程，「daemon 已在运行」的检测形同虚设。现与 daemon 侧共用同一解析器（新增 `src/utils/pid-file.ts`）。

## [1.1.0] - 2026-09-18

- **新增**：daemon 内建 StreamableHTTP `/mcp` 端点，与 dashboard 同端口（默认 38881）。客户端改用 URL 接入常驻服务，无需为每次会话拉起子进程；配置热更新后会向已连接的会话推送 `notifications/tools/list_changed`，支持该通知的客户端无需重启即可刷新工具清单。
- **变更（破坏性，需用户注意）**：dashboard 与 `/mcp` 仅监听 `127.0.0.1`，不再允许局域网访问（此前 dashboard 可被同网段其他机器打开）。如需远程访问请自建反向代理，**且代理必须把 `Host` 改写成 `127.0.0.1`**：Host/Origin 校验只接受回环取值，转发原始 `Host` 会被直接回 403 且响应里没有诊断信息（表现为反代后一律 403）。
- **变更（破坏性，需用户注意）**：`mcpdog proxy --transport streamable-http` 与 `mcpdog --transport streamable-http` 已移除，执行时打印改用 `daemon start` 的指引并以非零码退出。
- **变更（破坏性，需用户注意）**：`mcpdog start --mcp-http-port` 弃用（告警并忽略，`/mcp` 固定与 dashboard 同端口），`mcpdog start --http-only` 移除（`/mcp` 与 dashboard 同端口，无法只开 HTTP 传输）。
- **变更（破坏性，需用户注意）**：`mcpdog config mcp-config --json` 的输出结构改变。旧结构为 `{absolutePath, workingDirectory}`，新结构为 `{note, recommended, compatible}`（`recommended` 为 HTTP URL 接入，`compatible` 为 stdio 代理接入）。**外部脚本若解析这两个旧键会直接拿不到值**，需按新键调整。
- **变更**：接入配置生成改为 HTTP URL 形态——`mcpdog config mcp-config`（含 `--json`）与 Web 界面「连接 MCPDOG」弹窗均改以 URL 接入为主推方案，stdio 降为兼容路径。Web 弹窗默认选中 HTTP 页签，URL 由当前页面 origin 推导（改端口自动跟随，`localhost` 会改写为 `127.0.0.1` 以匹配仅回环监听的 daemon）；CLI 生成的是固定默认端口 `http://127.0.0.1:38881/mcp`，并在输出中注明该端口仅为默认值（38881 被占用时 daemon 会自动顺延，需按实际端口替换），以及 daemon 带 `MCPDOG_AUTH_TOKEN` 启动时需自行补 `headers.Authorization`。
- **修复**：删除会在同一进程内重复拉起全部子服务器的旧 HTTP 实现（`mcpdog start` 路径上可复现），HTTP 传输统一由 daemon 的 `/mcp` 端点提供。

### 桌面版（Windows）

- **新增**：Windows 桌面版（NSIS 安装包）：纯托盘常驻，内嵌 Node 运行时，无需用户自装 Node。
- **新增**：桌面版接管开机自启（HKCU Run），此时 `mcpdog service install` 会提示已被接管。
- **新增**：更新检查（GitHub Releases + minisign 验签）：托盘新增「检查更新」，读取 Release 上的 `latest.json` 与本地版本比对，有新版本时弹窗提示版本号并可直接打开安装包下载链接；检查失败（网络不通、端点 404、验签不通过）会把原因显示在弹窗里。**当前仅做检查与提示，不会自动安装** —— 需手动运行下载到的安装包。
- **已知限制**：托盘图标目前是生成的占位图标，尚待替换为正式品牌图标。

## [1.0.9] - 2026-09-14

- **修复（关键）**：下游 stdio server 进程异常退出后重连失效。`sendRequest` 判定进程已死并调用 `connect()`，但 `connect()` 顶部的 `isConnected` 守卫在标志位陈旧时直接 `return`（且只 `console.error`、不写日志管理器，界面上看不到），调用方随即无条件记录「Reconnection successful」——**日志说重连成功，请求却被写进已断开的管道，最终要等 30 秒超时才失败**。根因是 `isConnected` 与进程 `'exit'` 事件之间存在时序窗口（`exitCode` 在 libuv 回调里同步置位，`'exit'` 事件要等 nextTick 才发出）。现改为以进程实况（`process`/`stdin`/`killed`/`exitCode`）作为唯一权威判据，标志位陈旧时复位并清理后走重连，重连后再复核一次进程可用性，不再假报成功。
- **修复（关键）**：`cleanup()` 的延迟强杀会杀掉**新**进程。定时器 2 秒后读的是 `this.process` 的**当前值**而非它当时要杀的那个进程，若期间已完成重连，刚 spawn 的新进程会被 SIGKILL——这正是线上日志里「刚连上就 `Process exited ... signal SIGKILL`」的成因。现改为捕获当时的进程引用。
- **修复**：任一下游 server 配置变更会触发**全部** server 断连重连。文件监听路径广播的 `config-updated` 不带 context，必然落到 `handleConfigUpdate` 的全量重建分支，改一个 server 会让其他所有 server（外部 MCP 工具会话、SSH 连接等）一并被打断。现按配置内容比对，只重建「新增 / 连接参数变化 / 已删除」的 server；仅工具开关（`toolsConfig`）变化只刷新工具路由；无连接相关变化则完全不动已有连接。连接维度用显式字段白名单比较，避免被 `tools`/`connected`/`toolCount` 等会被回写的易变字段误判。
- **优化**：`initialize()` 不再走「死进程重连」分支（新增 `sendRequest` 的 `reconnect` 选项），切断 `connect → initialize → sendRequest → connect` 相互递归。
- **优化**：`connect()` 增加进行中握手合流（`connectingPromise`），避免多个并发调用各自 spawn 出一个子进程、后一个覆盖 `this.process` 使前一个成为无人回收的孤儿。
- **测试**：新增 `src/adapters/stdio-adapter.test.ts`（死进程标志位陈旧时必须真正重连、重连仍不可用时快速失败）与 `src/core/mcpdog-server.test.ts`（首次初始化、只改一个 server 只重建它、只改工具开关不重连、移除 server 只摘它），两组用例均已确认在修复前的代码上失败。

## [1.0.8] - 2026-09-09

- **新增**：Web 管理界面「连接 MCPDOG」旁新增「一键导入 Claude MCP」按钮，读取 `C:\Users\<用户名>\.claude.json` 顶层的用户级 `mcpServers` 批量导入到 MCPDog。先预览「将导入 / 将跳过」清单再确认；同名冲突跳过、名称不合规或缺 `command`/`url` 的条目跳过并注明原因，`disabled` 条目按禁用状态导入；导入成功的启用服务器自动连接。读取与转换在 daemon 本机完成（浏览器无法直接访问用户主目录文件），导入逻辑抽离为纯函数模块 `claude-mcp-importer` 并补齐单测。

## [1.0.7] - 2026-09-09

- **修复（关键）**：直接编辑 `~/.mcpdog/mcpdog.config.json` 后 daemon 永不重载。配置文件 watch 曾发出 `configChanged` 事件，而 daemon / 核心服务监听的是 `config-updated`（该事件此前从未被发出），事件名不匹配导致文件级配置变更被静默忽略。现统一为 `config-updated`，并处理编辑器常用的"临时文件 + rename"式保存（此前仅响应 change 事件），加 300ms 防抖合并同一次保存的多次变更事件。
- **修复**：`MCPDogServer.stop()` 未重置 `isStarted` 防重入标记，stop→start 序列中 start 被跳过，所有适配器断开后无人重连，daemon 瘫痪。
- **优化**：`tools/list` 实时拉取由串行改为并行（`Promise.allSettled`，单 server 仍保留 8 秒超时上限）。总耗时由各 server 超时之和降为最大单值，多个下游同时异常时不再累计突破 MCP 客户端 30 秒连接超时。
- **新增**：daemon 启动即把 stdout/stderr 同步落盘到 `~/.mcpdog/daemon-YYYYMMDD.log`。daemon 通常以 detached + stdio ignore 方式拉起，此前运行日志全部丢弃，排障无据可查。
- **优化**：配置全量重载统一由 `MCPDogServer` 的 reinitializeAdapters 执行（增量重建 + 后台连接），移除 daemon 层重复的 stop/start 全量重建路径，避免适配器被拆除重建两次。
- Web 管理界面 favicon 更换为 🐕。

## [1.0.6] - 2026-09-05

- **新增**：`mcpdog service install/uninstall/status` 命令，一键注册/取消 daemon 开机自启（Windows 启动文件夹 VBS 隐藏窗口启动、macOS LaunchAgent、Linux systemd user unit），使 38881 dashboard 与 IPC 9999 的生命周期与 MCP 会话彻底解耦——重启电脑后不再需要新开会话才能访问管理界面。
- **新增**：长会话自愈。daemon 意外退出后，stdio proxy 被动重连连续 3 次被拒（30 秒冷却）时自动重新拉起 daemon，会话内 MCP 工具自动恢复。
- **修复**：proxy 判断 daemon 是否运行仅凭 `kill(pid, 0)`，Windows 重启后 PID 被无关进程复用时会误判"daemon 在运行"而跳过拉起，导致 MCP 连接失败；现增加 daemon IPC 端口握手双重校验。
- **优化**：proxy 自动拉起 daemon 后由固定等待 2 秒改为轮询端口就绪（至多 15 秒），避免 npx 冷启动较慢时首次连接失败导致 proxy 直接退出。

## [1.0.5] - 2026-09-04

- **新增**：daemon 版本更新自动接管。PID 文件现在记录 daemon 版本号，`daemon start` 检测到已有实例运行且版本不同（或为无版本信息的旧格式 PID 文件）时，自动停止旧实例并以新版本启动——版本更新后重跑一次启动命令即可完成升级，不再被 "Daemon is already running" 挡住导致老版本继续伺服。版本相同时仍拒绝重复启动。
- **新增**：`mcpdog daemon restart` 命令，等价于 stop + start。

## [1.0.4] - 2026-09-04

- **新增**：Web 管理界面顶部 Header 栏，展示版本号、当前配置文件路径（`/api/system/info` 新增接口）、主题切换与 GitHub 仓库入口。
- **新增**：服务详情操作区新增"重试连接"按钮（删除/启用开关左侧），首次连接失败后可一键重连，复用启用开关的重连机制（禁用移除旧适配器→启用重建连接）。
- **优化**：服务器列表选中态样式加强：整圈主题色描边 + 服务器名高亮加粗 + 主题色背景。
- **优化**：整页锁定视口高度不再整页滚动，左侧服务器列表与右侧内容区改为独立滚动容器，服务详情标题栏与 tab 栏固定。
- **优化**：运行日志显示区由固定高度改为自适应填满面板剩余高度。
- **优化**：顶部统计数字分色显示（总计/已启用/已连接/已启用工具），颜色与工具面板统计卡片错开；移除与 Header 重复的页面标题；顶部操作栏去除外侧主题切换按钮。
- **优化**：工具面板"关于工具控制"说明移至列表表头上方，便于操作前查看。
- **修复**："连接 MCPDOG"弹窗 STDIO 配置的 npm 包名修正为 `@keysqiu/mcpdog`（原 `mcpdog` 在 registry 上并非本项目）。

## [1.0.3] - 2026-09-04

- **修复（关键）**：MCP 客户端（Claude Code 等）连接 mcpdog 后 `tools/list` 超时（`connected · tools fetch failed`）的问题。proxy 与 daemon 间自定义 TCP 行协议的解析不做跨 chunk 缓冲，聚合工具数较多时 `tools/list` 响应（约 112KB）超过单个 TCP 分片（约 64KB），被拆分后各片段 `JSON.parse` 必然失败，且 stdio proxy 为 silent 模式错误被静默吞掉，请求方一直等到超时。现改为跨 chunk 拼接后再按行切分。该缺陷继承自原版（npm `mcpdog@2.2.6` 同样存在），工具数量少、响应未超过单个分片时不触发。
- **修复**：daemon 侧解析客户端请求存在同款隐患（如 `tools/call` 携带大参数时），同步增加每连接独立的分片缓冲。

## [1.0.2] - 2026-09-03

- **修复**：Windows 上 stdio 子服务器经 `cmd.exe` 启动时会弹出大量可见 CMD 窗口的问题。子进程 spawn 增加 `windowsHide: true`，后台静默启动，stdio 管道通信不受影响。

## [1.0.1] - 2026-09-03

与 1.0.0 内容一致（1.0.0 因 registry 版本记录清理未对外保留，此版本为团队维护版实际首发版本）。

### 团队维护版首个发布

- **修复（关键）**：Windows 平台下 stdio 子服务器全部连接超时的问题。原版本用 Node 原生 `child_process.spawn`（`shell: false`）启动子进程，Windows 上 `npx`、`npm` 等全局命令实为 `.cmd` 批处理脚本，无法被直接启动，导致进程未运行即 `initialize` 握手 30 秒超时。现改用 `cross-spawn`（与官方 `@modelcontextprotocol/sdk` 同方案），Windows 自动经 `cmd.exe` 解析启动。
- **新增**：Web 管理界面全面汉化。
- **新增**：服务器配置支持 `adminUrl` 字段，可在主界面直接跳转子 MCP 服务器自带的管理页面。
- **修复**：传输类型切换时残留字段未清理的问题。
- **修复**：工具名前缀剥离逻辑——此前对带连字符的工具名（如 `browserman-local-x_post`）会错误剥离前缀，现改为先校验完整服务器前缀再剥离。
- **调整**：工具名冲突分隔符由冒号改为连字符，提升客户端兼容性。
- **调整**：Web 界面默认端口由 3000 改为 38881。
- **仓库迁移**：代码迁移至 SIE 运维团队组织仓库维护，npm 包名调整为 `@keysqiu/mcpdog`。

## 上游历史

上游开源项目（2.2.6 及更早）的变更记录请参考其官方仓库。

