// MCPDog 桌面壳（Windows，纯托盘）：托盘 / 单实例 / 自启 / 守护 Node daemon。
// 与组织内先例对齐 —— 菜单结构同 MCP-DB-Tools TrayHost 与 ssh-mcp-server tray.rs，
// 但本壳不承载业务：MCP 端点与聚合核心跑在被守护的 Node 进程里。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mcpdog_gui::{supervisor, tray};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {
            // 二次启动：无主窗口可前置，直接在系统浏览器打开管理页
            tray::open_admin();
        }))
        .setup(|app| {
            tray::mcp_menu(app.handle())?;
            supervisor::init(app.handle());
            tray::warn_cli_autostart_if_present();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("运行 MCPDog 桌面壳出错");

    supervisor::shutdown();
}
