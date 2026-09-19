//! daemon 子进程的守护。Real 实现见 Task 4；此处先给出被托盘引用的最小接口。

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::AppHandle;

/// 默认 dashboard 端口，与 `daemon start` 的默认值一致
pub const DEFAULT_WEB_PORT: u16 = 38881;

/// init 时存入的 AppHandle，供托盘/异步任务等非命令上下文取用
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

pub fn init(app: &AppHandle) {
    if let Ok(mut g) = APP.lock() {
        *g = Some(app.clone());
    }
}

pub fn shutdown() {}

pub fn request_restart() {}

pub fn admin_base() -> Option<String> {
    None
}

pub fn admin_url() -> Option<String> {
    admin_base().map(|base| format!("{base}/"))
}

pub fn mcp_url() -> Option<String> {
    admin_base().map(|base| format!("{base}/mcp"))
}

/// CLI 自启脚本路径（对应 src/cli/commands/service-commands.ts 的 getWindowsVbsPath）
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
