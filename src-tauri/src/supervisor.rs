//! daemon 子进程守护。
//!
//! 与 CLI 的关系：壳不重复实现 daemon 逻辑，只负责「确保有一个 daemon 在跑」。
//! 因此启动前必须先探测既有实例 —— 用户可能先用 `mcpdog daemon start` 起过一个，
//! 此时壳应当接管监控而不是再起一个（两个 daemon 会争同一组端口与 PID 文件）。

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// 默认 dashboard 端口，与 `daemon start` 的默认值一致（/mcp 与它同端口）
pub const DEFAULT_WEB_PORT: u16 = 38881;
/// 默认 IPC 端口
const DEFAULT_IPC_PORT: u16 = 9999;

const PROBE_TIMEOUT: Duration = Duration::from_millis(600);
const READY_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESTART_ATTEMPTS: u32 = 5;

static SHOULD_RUN: AtomicBool = AtomicBool::new(false);
static RESTARTS: AtomicU32 = AtomicU32::new(0);
static CHILD: Mutex<Option<Child>> = Mutex::new(None);
static EXTERNAL_PID: Mutex<Option<u32>> = Mutex::new(None);
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);
/// 上次 spawn 内嵌 daemon 的时刻，用于判断「稳定运行过」并复位重启计数
static LAST_SPAWN: Mutex<Option<Instant>> = Mutex::new(None);
/// 「停旧 + 起新」整段的互斥量：守护循环与 shutdown/request_restart 若交错，
/// 会各起一个 daemon 去争同一组端口 —— 正是本模块要防的状态。
static SUPERVISOR: Mutex<()> = Mutex::new(());
/// 守护线程句柄（Task 5 的 shutdown_and_wait 要靠它等线程收敛）
static SUPERVISE_THREAD: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
/// 壳是否已进入退出流程。置位后不再接受重启请求 —— 否则「退出」途中被点「重启服务」
/// 会 spawn 一个无人监管的 daemon（在退避窗口内即可触发）。
/// 单向闩：只由 shutdown_and_wait 置位，此后进程即将退出，没有复位场景。
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PidFileInfo {
    pub pid: u32,
    pub version: Option<String>,
}

/// 解析 PID 文件。兼容两种格式：
/// 新格式 `{"pid":123,"version":"1.1.0"}`、旧格式纯数字。
pub fn parse_pid_file(content: &str) -> Option<PidFileInfo> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.starts_with('{') {
        let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
        let pid = value.get("pid")?.as_u64()? as u32;
        let version = value
            .get("version")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        return Some(PidFileInfo { pid, version });
    }

    trimmed
        .parse::<u32>()
        .ok()
        .map(|pid| PidFileInfo { pid, version: None })
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn mcpdog_dir() -> PathBuf {
    home_dir().join(".mcpdog")
}

fn pid_file_path() -> PathBuf {
    mcpdog_dir().join("mcpdog.pid")
}

fn config_path() -> PathBuf {
    mcpdog_dir().join("mcpdog.config.json")
}

fn resource_dir() -> Option<PathBuf> {
    let app = APP.lock().ok()?.clone()?;
    app.path().resource_dir().ok()
}

fn node_exe() -> Option<PathBuf> {
    Some(resource_dir()?.join("node").join("node.exe"))
}

fn cli_entry() -> Option<PathBuf> {
    Some(
        resource_dir()?
            .join("app")
            .join("dist")
            .join("cli")
            .join("cli-main.js"),
    )
}

/// 读取 PID 文件里的进程号（文件不存在或格式非法返回 None）
fn read_pid_file() -> Option<PidFileInfo> {
    let content = std::fs::read_to_string(pid_file_path()).ok()?;
    parse_pid_file(&content)
}

/// 端口是否可连 —— PID 存在不等于 daemon 活着（Windows 重启后 PID 会被复用）
fn port_listening(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).is_ok()
}

/// Windows 下用 tasklist 判断进程是否存活（比 std::process 更省事，且跨 Windows 版本稳定）
fn process_alive(pid: u32) -> bool {
    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .creation_flags_no_window()
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

/// 读取进程命令行，用于接管前核对身份。
///
/// 读不到（进程已退出、权限不足、PowerShell 不可用）一律返回 None —— 调用方必须按
/// 「无法确认身份」处理，不得据此接管、结束进程或另起一个。
fn process_command_line(pid: u32) -> Option<String> {
    let script = format!("(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine");
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags_no_window()
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

/// 命令行是否属于我们的 daemon。
///
/// 为什么必须核对：PID 会被系统复用。仅凭「PID 文件里的 pid 存活」+「端口有人监听」
/// 这两个互不关联的条件就认定它是 daemon，一旦 PID 文件陈旧且该 pid 已被无关进程复用，
/// 这个 pid 就会被记入 EXTERNAL_PID，最终交给 `taskkill /T /F` 杀掉一个我们从未启动的进程。
///
/// 只认 `cli-main.js` 这一个信号：两种真实布局的命令行都含它 —— npx 安装版以
/// `@keysqiu/mcpdog/dist/cli/cli-main.js` 结尾，内嵌版以
/// `resources/app/dist/cli/cli-main.js` 结尾。不认更宽的关键字（如裸 `mcpdog`）：
/// 任何从 MCPDog 目录启动的进程都会命中它，而本函数的唯一目的是「无法确证就不接管」。
/// 若将来打包改了入口文件名，这里会判为不匹配 → 拒绝接管并记日志；对一个
/// 「判错就会杀掉别人进程」的检查来说，失败方向朝「拒绝」才是对的。
fn looks_like_our_daemon(command_line: &str) -> bool {
    command_line.to_lowercase().contains("cli-main.js")
}

/// 探测既有 daemon 的结果。三种状态必须分开：
/// 只有身份核对通过的才允许被接管；否则既不能杀它，也不能再起一个去抢端口。
#[derive(Debug, PartialEq, Eq)]
enum ExistingDaemon {
    /// PID 文件指向的进程存活、端口可连、且命令行确认是我们的 daemon
    Ours(u32),
    /// 端口被占用，但占用者不是我们的 daemon（身份不符或无法确认）
    Foreign,
    /// 没有可接管的 daemon：无 PID 文件 / 进程已死 / 进程在但端口不通
    Absent,
}

/// 探测既有 daemon：进程存活 + 端口握手 + 身份核对，三者都通过才算在跑
fn detect_existing_daemon(web_port: u16) -> ExistingDaemon {
    let Some(info) = read_pid_file() else {
        return ExistingDaemon::Absent;
    };
    if !process_alive(info.pid) {
        return ExistingDaemon::Absent;
    }
    if !port_listening(web_port) {
        // 进程在但端口不通 → PID 被复用或 daemon 半死，不认；
        // 端口空着，起一个新的不会和谁抢。
        return ExistingDaemon::Absent;
    }

    match process_command_line(info.pid) {
        Some(cmdline) if looks_like_our_daemon(&cmdline) => ExistingDaemon::Ours(info.pid),
        Some(cmdline) => {
            eprintln!(
                "[supervisor] 端口 {web_port} 被占用，但 PID {} 的命令行不是我们的 daemon（{cmdline}）",
                info.pid
            );
            ExistingDaemon::Foreign
        }
        None => {
            eprintln!(
                "[supervisor] 无法读取 PID {} 的命令行，按「无法确认身份」处理",
                info.pid
            );
            ExistingDaemon::Foreign
        }
    }
}

fn embedded_version() -> Option<String> {
    let resources = resource_dir()?;
    std::fs::read_to_string(resources.join("VERSION"))
        .ok()
        .map(|s| s.trim().to_string())
}

pub fn init(app: &AppHandle) {
    if let Ok(mut guard) = APP.lock() {
        *guard = Some(app.clone());
    }
    SHOULD_RUN.store(true, Ordering::SeqCst);

    let handle = std::thread::spawn(|| {
        ensure_running();
        supervise_loop();
    });
    // 保留句柄：Task 5 的 shutdown_and_wait 要靠它等守护线程收敛（丢掉就只能干等）
    if let Ok(mut guard) = SUPERVISE_THREAD.lock() {
        *guard = Some(handle);
    }
}

/// 确保有一个 daemon 在跑：能接管就接管，否则 spawn。
/// 自行取 supervisor 锁 —— 持锁的调用方请改用 `ensure_running_locked()`，否则自锁。
fn ensure_running() {
    let _guard = match SUPERVISOR.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    ensure_running_locked();
}

/// `ensure_running` 的主体。**调用方必须已持有 `SUPERVISOR`。**
///
/// 整段（探测 → 停旧 → spawn）都在锁内，`spawn_daemon` 里的重复启动守卫也因此在
/// 同一把锁下判定 —— 全模块只有这一条「起 daemon」的路径，没有第二套同步机制。
fn ensure_running_locked() {
    match detect_existing_daemon(DEFAULT_WEB_PORT) {
        ExistingDaemon::Ours(pid) => {
            let running_version = read_pid_file().and_then(|i| i.version);
            let our_version = embedded_version();

            if running_version == our_version {
                eprintln!("[supervisor] 接管既有 daemon (PID {pid}, v{running_version:?})");
                if let Ok(mut guard) = EXTERNAL_PID.lock() {
                    *guard = Some(pid);
                }
                return;
            }

            eprintln!(
                "[supervisor] 既有 daemon 版本不一致（{running_version:?} vs {our_version:?}），先停旧的"
            );
            stop_process(pid);
        }
        ExistingDaemon::Foreign => {
            // 端口被非本程序的进程占着：接管是错的（会误杀），启动也是错的（抢不到端口，
            // 只会白起一个进程）。明确记日志后停在这里，等端口释放。
            eprintln!(
                "[supervisor] 端口 {DEFAULT_WEB_PORT} 被非 MCPDog 进程占用，不接管也不启动内嵌 daemon"
            );
            return;
        }
        ExistingDaemon::Absent => {}
    }

    spawn_daemon();
}

/// 启动内嵌 daemon。**只能从 `ensure_running_locked()` 调用（即已持有 `SUPERVISOR`）。**
///
/// 为什么守卫放在这里：已经有一个我们起的、仍在运行的 daemon 时不再起第二个。
/// 退避窗口内用户点「重启服务」会让守护循环与重启各走一次探测，而新 daemon 写出
/// PID 文件之前探测不到它 —— 第二次探测就会报 `Absent` 并重复 spawn，两个 daemon
/// 去争 38881/9999。这里是唯一的 spawn 出口，守在这里最省事；因为调用方恒持有
/// `SUPERVISOR`，这个守卫与「停旧 + 起新」共用同一把锁，不是独立的第二套机制。
fn spawn_daemon() {
    if let Ok(mut guard) = CHILD.lock() {
        let live = match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        };
        if live {
            let pid = guard.as_ref().map(|c| c.id());
            eprintln!("[supervisor] 已有受管 daemon (PID {pid:?}) 在运行，跳过重复启动");
            return;
        }
        // 已退出或无法查询：回收句柄后继续启动新的
        let _ = guard.take();
    }

    let Some(node) = node_exe() else {
        eprintln!("[supervisor] 找不到内嵌 node.exe，无法启动 daemon");
        return;
    };
    let Some(cli) = cli_entry() else {
        eprintln!("[supervisor] 找不到内嵌 cli-main.js，无法启动 daemon");
        return;
    };

    std::fs::create_dir_all(mcpdog_dir()).ok();

    // 把内嵌 Node 目录前置到 PATH：子服务器配置里普遍是 `npx ...`，
    // 不前置的话它们会去找系统 Node，用户没装就直接失败。
    let mut path_entries: Vec<std::ffi::OsString> = Vec::new();
    if let Some(node_dir) = node.parent() {
        path_entries.push(node_dir.as_os_str().to_os_string());
    }
    if let Some(existing) = std::env::var_os("PATH") {
        path_entries.extend(std::env::split_paths(&existing).map(|p| p.into_os_string()));
    }
    // 拼接失败时绝不设 PATH：设成空串会把继承的 PATH 整个抹掉，
    // 子服务器连 npx 都找不到。宁可沿用继承值（少了个前置，但不至于全废）。
    let joined_path = match std::env::join_paths(path_entries) {
        Ok(p) => Some(p),
        Err(e) => {
            eprintln!("[supervisor] 拼接内嵌 Node PATH 失败（{e}），沿用继承的 PATH");
            None
        }
    };

    let mut cmd = Command::new(&node);
    cmd.arg(&cli)
        .arg("daemon")
        .arg("start")
        .arg("--config")
        .arg(config_path())
        // 显式给出 PID 文件：内容才决定打谁，位置无关，但显式传可消除
        // 「Rust 的 home_dir() 与 Node 的 os.homedir() 各自算默认路径」的隐式耦合。
        .arg("--pid-file")
        .arg(pid_file_path())
        .arg("--web-port")
        .arg(DEFAULT_WEB_PORT.to_string())
        .arg("--daemon-port")
        .arg(DEFAULT_IPC_PORT.to_string())
        // 壳的身份：daemon 据此把自启写成「指向壳」而不是「指向 daemon」
        .env(
            "MCPDOG_SHELL_EXE",
            std::env::current_exe().unwrap_or_default(),
        )
        .creation_flags_no_window();
    if let Some(path) = joined_path {
        cmd.env("PATH", path);
    }

    match cmd.spawn() {
        Ok(child) => {
            let pid = child.id();
            eprintln!("[supervisor] 已启动内嵌 daemon (PID {pid})");
            if let Ok(mut guard) = CHILD.lock() {
                *guard = Some(child);
            }
            if let Ok(mut guard) = EXTERNAL_PID.lock() {
                *guard = None;
            }
            if let Ok(mut guard) = LAST_SPAWN.lock() {
                *guard = Some(Instant::now());
            }
            wait_until_ready(DEFAULT_WEB_PORT, pid);
        }
        Err(e) => {
            eprintln!("[supervisor] 启动 daemon 失败: {e}");
        }
    }
}

/// 等端口就绪。
///
/// 「端口有人监听」不等于「我们刚起的 child 就绪」—— 端口可能被别的进程占着
/// （此时必然误报就绪）。至少要把「child 已经退出」排除掉：进程都没了，
/// 后面再等下去也没有意义。
fn wait_until_ready(port: u16, pid: u32) {
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if !process_alive(pid) {
            eprintln!("[supervisor] 内嵌 daemon (PID {pid}) 已退出，停止等待端口 {port}");
            return;
        }
        if port_listening(port) {
            eprintln!("[supervisor] daemon 端口 {port} 就绪");
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    eprintln!("[supervisor] 等待 daemon 端口 {port} 超时（继续守护）");
}

fn supervise_loop() {
    loop {
        if !SHOULD_RUN.load(Ordering::SeqCst) {
            return;
        }

        // 托管子进程：等它退出，然后按需重启
        let exited = {
            let mut guard = match CHILD.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => Some((Some(status.code()), child.id())),
                    Ok(None) => None,
                    Err(_) => Some((None, child.id())),
                },
                None => {
                    // 外部接管状态下，监控那个 PID
                    let external = EXTERNAL_PID.lock().ok().and_then(|g| *g);
                    match external {
                        Some(pid) if !process_alive(pid) => Some((None, pid)),
                        Some(_) => None,
                        None => None,
                    }
                }
            }
        };

        match exited {
            Some((code, pid)) => {
                if let Ok(mut guard) = CHILD.lock() {
                    *guard = None;
                }
                if let Ok(mut guard) = EXTERNAL_PID.lock() {
                    *guard = None;
                }

                if !SHOULD_RUN.load(Ordering::SeqCst) {
                    return;
                }

                // 上次 spawn 后存活够久说明失败因素已消失，计数复位；
                // 否则偶发崩溃会累计到上限，让守护永久停摆
                let lived_long_enough = LAST_SPAWN
                    .lock()
                    .ok()
                    .and_then(|g| *g)
                    .map(|t| t.elapsed() > Duration::from_secs(60))
                    .unwrap_or(false);
                if lived_long_enough {
                    RESTARTS.store(0, Ordering::SeqCst);
                }

                let attempt = RESTARTS.fetch_add(1, Ordering::SeqCst) + 1;
                if attempt > MAX_RESTART_ATTEMPTS {
                    // 放弃重试就必须让状态诚实：SHOULD_RUN 若仍为 true，
                    // 之后一次 request_restart() 会 spawn 出一个无人监管的 daemon。
                    eprintln!("[supervisor] daemon (PID {pid}) 连续退出 {attempt} 次，停止重试");
                    SHOULD_RUN.store(false, Ordering::SeqCst);
                    return;
                }
                let backoff = match attempt {
                    1 => Duration::from_secs(1),
                    2 => Duration::from_secs(2),
                    3 => Duration::from_secs(4),
                    4 => Duration::from_secs(8),
                    _ => Duration::from_secs(30),
                };
                eprintln!(
                    "[supervisor] daemon (PID {pid}) 退出 (code {code:?})，{backoff:?} 后重启（第 {attempt} 次）"
                );
                std::thread::sleep(backoff);

                // sleep 之前那次复查管不到这里：用户可能在退避窗口内点了「退出」或
                // 「重启服务」。这里与 stop_process/ensure_running 共用同一把锁，
                // 保证「停旧 + 起新」整段与停机/重启不会交错。
                let _guard = match SUPERVISOR.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                if !SHOULD_RUN.load(Ordering::SeqCst) {
                    return;
                }
                ensure_running_locked();
            }
            None => {}
        }

        std::thread::sleep(Duration::from_millis(1000));
    }
}

/// 结束整棵进程树并等它真的消失。
///
/// 统一走 `/T`：Windows 没有 job object，只结束父进程不会带走它拉起的 `npx`
/// 子服务器，重启时会留下一堆孤儿。
fn terminate_tree(pid: u32) {
    Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags_no_window()
        .output()
        .ok();

    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if !process_alive(pid) {
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    eprintln!("[supervisor] PID {pid} 未在 30s 内退出");
}

/// 停掉一个进程：先结束整棵进程树，再等它消失
fn stop_process(pid: u32) {
    // 句柄优先：PID 会被系统复用，只有 Child 句柄能证明这个 pid 确实是我们 spawn 的，
    // 所以「我们起的」这一支必须先用句柄核对归属，再交给 taskkill。
    let ours = if let Ok(mut guard) = CHILD.lock() {
        if matches!(guard.as_ref(), Some(child) if child.id() == pid) {
            guard.take()
        } else {
            None
        }
    } else {
        None
    };

    terminate_tree(pid);

    if let Some(mut child) = ours {
        // terminate_tree 已确认进程消失，这里只是回收句柄；若它没退出就不 wait，
        // 否则会在这里无限期挂住。
        if !process_alive(pid) {
            let _ = child.wait();
        }
    }
}

pub fn request_restart() {
    // 壳已进入退出流程时不再重启：否则「退出」途中被点「重启服务」会 spawn 一个
    // 无人监管的 daemon（在退避窗口内即可触发）。这里先做一次无锁快速判断 ——
    // 停机段会持 SUPERVISOR 到 stop_process 结束，没必要为此白等。
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        eprintln!("[supervisor] 壳正在退出，忽略重启请求");
        return;
    }

    // 与守护循环互斥：否则循环的 ensure_running 与本函数的 stop_process + ensure_running
    // 会交错，各起一个 daemon 去争同一组端口。
    let _guard = match SUPERVISOR.lock() {
        Ok(g) => g,
        Err(_) => return,
    };

    // 取锁后再复查一次：上面那次判断与这里之间，退出流程可能刚好置位。
    // 与守护循环「退避 sleep 之后再复查 SHOULD_RUN」是同一个模式。
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        eprintln!("[supervisor] 壳正在退出，忽略重启请求");
        return;
    }

    let pid = CHILD
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|c| c.id()))
        .or_else(|| EXTERNAL_PID.lock().ok().and_then(|g| *g));

    if let Some(pid) = pid {
        stop_process(pid);
    }

    RESTARTS.store(0, Ordering::SeqCst);
    SHOULD_RUN.store(true, Ordering::SeqCst);
    ensure_running_locked();
}

pub fn shutdown() {
    // 同一把锁：让「停机」不可能插进循环的「停旧 + 起新」中间。
    let _guard = match SUPERVISOR.lock() {
        Ok(g) => g,
        Err(_) => return,
    };

    SHOULD_RUN.store(false, Ordering::SeqCst);

    let pid = CHILD.lock().ok().and_then(|g| g.as_ref().map(|c| c.id()));

    if let Some(pid) = pid {
        stop_process(pid);
    }
    // 有意不动 EXTERNAL_PID：那是用户自己起的 daemon，壳退出不该把它带走。
}

/// 关闭 daemon 并等待其真正退出。返回是否在超时前退出。
/// 托盘「退出」必须走这个而不是 shutdown() —— 直接 exit(0) 会让 daemon 来不及清理
/// PID 文件与子服务器，下次启动会误判为半死实例。
///
/// 停机段与等待段分开，中间**必须放锁**：
/// 1. 停机段持 `SUPERVISOR`：否则与守护循环的退避重启交错，会出现「已退出又被拉起」
///    与两个 daemon 争端口 —— 那正是 R2 要消除的状态。
/// 2. 等待段不持锁：守护循环要走完 `return` 必须先取同一把锁。若一直握着，
///    `is_finished()` 恒为 false，等待永远等不到收敛，必然等满超时并打印**假的**
///    「未收敛」—— 那等于把「等循环真的停下」这件事做废。
///
/// 只停 `CHILD`，不含 `EXTERNAL_PID` —— 与 `shutdown()` 同一套策略（见其注释）：
/// 那是用户自己起的 daemon，壳退出不该把它带走。接管来的 PID 在杀之前也不再校验身份，
/// 一旦 PID 被复用，把它交给 `taskkill /T /F` 就是杀一个无关进程。
/// 代价：接管情形下点「退出」后那个 daemon 继续运行（用户可用 CLI 停它）；
/// 本函数要解决的「半死实例」只发生在我们自己 spawn 的 child 上。
///
/// `timeout` 只界定「等守护线程收敛」这一段，**不是**函数总时长的上界：
/// 前面的锁等待无界（循环在 `ensure_running_locked` 里最长持锁约 15s），
/// `stop_process` 里的 `terminate_tree` 另加最长 30s。所以调用方必须在别的线程上等。
pub fn shutdown_and_wait(timeout: Duration) -> bool {
    // 停机段：置标志 + 停自己的 child，整段在锁内，出作用域即释放锁
    let target = {
        let _guard = match SUPERVISOR.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };

        SHOULD_RUN.store(false, Ordering::SeqCst);
        SHUTTING_DOWN.store(true, Ordering::SeqCst);

        let pid = CHILD.lock().ok().and_then(|g| g.as_ref().map(|c| c.id()));
        if let Some(pid) = pid {
            stop_process(pid);
        }
        pid
    };

    let deadline = Instant::now() + timeout;

    // 等待段（不持锁）：守护线程在退避 sleep 中也能因 SHOULD_RUN=false 而退出，
    // 醒来后能取到锁、复查后 return —— 这里的收敛因此是真的
    let handle = SUPERVISE_THREAD.lock().ok().and_then(|mut g| g.take());
    if let Some(handle) = handle {
        while !handle.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        if handle.is_finished() {
            let _ = handle.join();
        } else {
            eprintln!("[supervisor] 守护线程未在超时内收敛，放弃等待（进程即将退出）");
        }
    }

    match target {
        Some(pid) => !process_alive(pid),
        None => true,
    }
}

/// 当前 daemon 的 base URL（未就绪返回 None）
pub fn admin_base() -> Option<String> {
    if port_listening(DEFAULT_WEB_PORT) {
        Some(format!("http://127.0.0.1:{DEFAULT_WEB_PORT}"))
    } else {
        None
    }
}

pub fn admin_url() -> Option<String> {
    admin_base().map(|base| format!("{base}/"))
}

pub fn mcp_url() -> Option<String> {
    admin_base().map(|base| format!("{base}/mcp"))
}

/// CLI 自启脚本路径（对应 src/cli/commands/service-commands.ts 的 getWindowsVbsPath）。
/// 由 Task 2 Step 8 引入；Task 4 重写本文件时必须保留 —— tray.rs 的
/// warn_cli_autostart_if_present() 依赖它，删掉会直接编译失败。
pub fn cli_autostart_vbs_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(
        PathBuf::from(appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Startup")
            .join("mcpdog-daemon.vbs"),
    )
}

/// 是否残留 CLI 自启脚本。两种自启同时存在会导致登录时起两个 daemon 争端口。
pub fn has_cli_autostart_script() -> bool {
    cli_autostart_vbs_path()
        .map(|p| p.exists())
        .unwrap_or(false)
}

/// 供托盘读取 AppHandle（init 时已存入）
pub fn app_handle() -> Option<AppHandle> {
    APP.lock().ok().and_then(|g| g.clone())
}

/// Windows 下不弹控制台窗口
trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

impl NoWindow for Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_pid_file_accepts_new_format() {
        let info = parse_pid_file(r#"{"pid":1234,"version":"1.1.0"}"#).unwrap();
        assert_eq!(info.pid, 1234);
        assert_eq!(info.version.as_deref(), Some("1.1.0"));
    }

    #[test]
    fn parse_pid_file_accepts_legacy_numeric_format() {
        let info = parse_pid_file("48196").unwrap();
        assert_eq!(info.pid, 48196);
        assert_eq!(info.version, None);
    }

    #[test]
    fn parse_pid_file_rejects_garbage() {
        assert!(parse_pid_file("not-a-pid").is_none());
        assert!(parse_pid_file("").is_none());
        assert!(parse_pid_file("{\"nope\":1}").is_none());
    }

    #[test]
    fn parse_pid_file_trims_whitespace_and_newlines() {
        let info = parse_pid_file("  98765 \r\n").unwrap();
        assert_eq!(info.pid, 98765);
    }
}
