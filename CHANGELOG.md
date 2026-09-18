# 更新日志

本项目所有显著变更都会记录在此文件中。

## [1.1.0] - 2026-09-18

- **新增**：daemon 内建 StreamableHTTP `/mcp` 端点，与 dashboard 同端口（默认 38881）。客户端改用 URL 接入常驻服务，无需为每次会话拉起子进程；配置热更新后会向已连接的会话推送 `notifications/tools/list_changed`，支持该通知的客户端无需重启即可刷新工具清单。
- **变更（破坏性，需用户注意）**：dashboard 与 `/mcp` 仅监听 `127.0.0.1`，不再允许局域网访问（此前 dashboard 可被同网段其他机器打开）。如需远程访问请自建反向代理，**且代理必须把 `Host` 改写成 `127.0.0.1`**：Host/Origin 校验只接受回环取值，转发原始 `Host` 会被直接回 403 且响应里没有诊断信息（表现为反代后一律 403）。
- **变更（破坏性，需用户注意）**：`mcpdog proxy --transport streamable-http` 与 `mcpdog --transport streamable-http` 已移除，执行时打印改用 `daemon start` 的指引并以非零码退出。
- **变更（破坏性，需用户注意）**：`mcpdog start --mcp-http-port` 弃用（告警并忽略，`/mcp` 固定与 dashboard 同端口），`mcpdog start --http-only` 移除（`/mcp` 与 dashboard 同端口，无法只开 HTTP 传输）。
- **变更（破坏性，需用户注意）**：`mcpdog config mcp-config --json` 的输出结构改变。旧结构为 `{absolutePath, workingDirectory}`，新结构为 `{note, recommended, compatible}`（`recommended` 为 HTTP URL 接入，`compatible` 为 stdio 代理接入）。**外部脚本若解析这两个旧键会直接拿不到值**，需按新键调整。
- **变更**：接入配置生成改为 HTTP URL 形态——`mcpdog config mcp-config`（含 `--json`）与 Web 界面「连接 MCPDOG」弹窗均改以 URL 接入为主推方案，stdio 降为兼容路径。Web 弹窗默认选中 HTTP 页签，URL 由当前页面 origin 推导（改端口自动跟随，`localhost` 会改写为 `127.0.0.1` 以匹配仅回环监听的 daemon）；CLI 生成的是固定默认端口 `http://127.0.0.1:38881/mcp`，并在输出中注明该端口仅为默认值（38881 被占用时 daemon 会自动顺延，需按实际端口替换），以及 daemon 带 `MCPDOG_AUTH_TOKEN` 启动时需自行补 `headers.Authorization`。
- **修复**：删除会在同一进程内重复拉起全部子服务器的旧 HTTP 实现（`mcpdog start` 路径上可复现），HTTP 传输统一由 daemon 的 `/mcp` 端点提供。

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

