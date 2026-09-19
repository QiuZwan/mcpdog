//! 系统托盘。菜单结构对齐组织内两个先例（MCP-DB-Tools TrayHost / ssh-mcp-server tray.rs）：
//! 打开管理页 / 关于 / 重启服务 / 退出，双击图标同样打开管理页。
//! 纯托盘模式 —— 无 WebView 主窗口，管理页一律在系统默认浏览器中打开。

use crate::supervisor;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

/// 用系统默认浏览器打开管理页；失败只记日志不阻断（对齐先例）
pub fn open_admin() {
    match supervisor::admin_url() {
        Some(url) => {
            if let Err(e) = tauri_plugin_opener::open_url(url, None::<&str>) {
                eprintln!("[tray] 打开管理页失败: {e}");
            }
        }
        None => eprintln!("[tray] daemon 未就绪，无法打开管理页"),
    }
}

/// 触发软重启：关掉当前 daemon 子进程后由守护线程重新拉起
fn restart_service() {
    supervisor::request_restart();
}

fn quit(app: &AppHandle) {
    supervisor::shutdown();
    app.exit(0);
}

pub fn mcp_menu(app: &AppHandle) -> tauri::Result<()> {
    let ver = app.package_info().version.clone();
    let open = MenuItem::with_id(app, "open-admin", "打开管理页", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let about_label = format!("关于 MCPDog  v{ver}");
    let about = MenuItem::with_id(app, "about", about_label.as_str(), true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启服务", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &sep, &about, &restart, &quit_item])?;

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip(format!("MCPDog v{ver}"))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open-admin" => open_admin(),
            "about" => show_about(app),
            "restart" => restart_service(),
            "quit" => quit(app),
            _ => {}
        })
        // 双击托盘图标 → 系统浏览器打开管理页
        .on_tray_icon_event(|_tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                open_admin();
            }
        })
        .build(app)?;

    Ok(())
}

/// "关于"弹窗：版本 + 管理页与 MCP 地址
fn show_about(app: &AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let ver = app.package_info().version.clone();
    let detail = match (supervisor::admin_base(), supervisor::mcp_url()) {
        (Some(base), Some(mcp)) => {
            format!("MCPDog v{ver}\n\n管理页: {base}\nMCP:    {mcp}")
        }
        _ => format!("MCPDog v{ver}\n\n（服务未就绪）"),
    };

    app.dialog()
        .message(detail)
        .title("关于 MCPDog")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

/// 启动时检查残留的 CLI 自启脚本：只提示，不代替用户删除
pub fn warn_cli_autostart_if_present() {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    if !supervisor::has_cli_autostart_script() {
        return;
    }

    let path = supervisor::cli_autostart_vbs_path()
        .map(|p| p.display().to_string())
        .unwrap_or_default();

    tauri::async_runtime::spawn(async move {
        let Some(app) = supervisor::app_handle() else {
            return;
        };
        let confirmed = app
            .dialog()
            .message(format!(
                "检测到 CLI 版开机自启脚本：\n{path}\n\n桌面版会自行管理开机自启，两者同时存在会在登录时启动两个 daemon。\n是否删除该脚本？"
            ))
            .title("MCPDog")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show();
        if confirmed {
            if let Some(p) = supervisor::cli_autostart_vbs_path() {
                let _ = std::fs::remove_file(p);
            }
        }
    });
}
