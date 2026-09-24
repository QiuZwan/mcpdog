//! 系统托盘。菜单结构对齐组织内两个先例（MCP-DB-Tools TrayHost / ssh-mcp-server tray.rs）：
//! 打开管理页 / 关于 / 检查更新 / 重启服务 / 退出，双击图标同样打开管理页。
//! 纯托盘模式 —— 无 WebView 主窗口，管理页一律在系统默认浏览器中打开。

use crate::supervisor;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

/// 托盘图标 id。状态刷新要靠它从 AppHandle 找回托盘实例 —— 不设 id 就取不回来，
/// 托盘提示只能停在构建时的那一个字符串（spec §8.3 要求显示运行状态）。
pub const TRAY_ID: &str = "mcpdog-tray";

/// 按当前 daemon 状态刷新托盘提示。supervisor 在状态变化时调用。
pub fn refresh_tooltip(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let ver = app.package_info().version.clone();
    let tip = format!("MCPDog v{ver} · {}", supervisor::state().label());
    if let Err(e) = tray.set_tooltip(Some(tip.as_str())) {
        eprintln!("[tray] 更新托盘提示失败: {e}");
    }
}

/// 用系统默认浏览器打开管理页；失败必须让用户看见。
///
/// 发布构建 `windows_subsystem = "windows"` 没有控制台，旧实现只写 stderr ——
/// daemon 未就绪时点「打开管理页」等于什么都没发生。改为弹原生错误对话框。
pub fn open_admin() {
    match supervisor::admin_url() {
        Some(url) => {
            if let Err(e) = tauri_plugin_opener::open_url(url, None::<&str>) {
                eprintln!("[tray] 打开管理页失败: {e}");
                supervisor::show_error_dialog("MCPDog", &format!("打开管理页失败：\n{e}"));
            }
        }
        None => {
            eprintln!("[tray] daemon 未就绪，无法打开管理页");
            supervisor::show_error_dialog(
                "MCPDog",
                &format!(
                    "daemon 尚未就绪（端口 {} 无响应），暂时无法打开管理页。\n当前状态：{}",
                    supervisor::DEFAULT_WEB_PORT,
                    supervisor::state().label()
                ),
            );
        }
    }
}

/// 触发软重启：关掉当前 daemon 子进程后由守护线程重新拉起。
///
/// 不能在菜单回调线程上直接调用：`request_restart` 全程持 `SUPERVISOR` 锁，而锁内
/// 既有 `terminate_tree`（等进程消失最长 30s）又有 `ensure_running_locked` 的端口轮询
/// （最长 15s），直接调用会让托盘冻结数十秒。投递到独立线程后菜单立刻恢复响应。
fn restart_service() {
    std::thread::spawn(supervisor::request_restart);
}

/// 退出：等 daemon 真正退出后再结束壳。
///
/// 等待同样必须放在独立线程（原因同 `restart_service`）。注意 `timeout` **不是**这次调用
/// 总时长的上界：先要取 `SUPERVISOR` 锁（等待无界，锁内可能正在 `terminate_tree` 的
/// 30s 轮询），锁内还要 `stop_process` 等 child 消失（又最长 30s），最后才是等守护线程
/// 收敛的 `timeout`。最坏可达分钟级，只有离线程才能不冻住托盘。
/// `AppHandle::exit` 可从任意线程调用 —— 它只投递退出请求，所以等完再请求退出是安全的。
fn quit(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if !supervisor::shutdown_and_wait(std::time::Duration::from_secs(15)) {
            eprintln!("[tray] daemon 未在 15s 内退出，仍然退出壳");
        }
        app.exit(0);
    });
}

pub fn mcp_menu(app: &AppHandle) -> tauri::Result<()> {
    let ver = app.package_info().version.clone();
    let open = MenuItem::with_id(app, "open-admin", "打开管理页", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let about_label = format!("关于 MCPDog  v{ver}");
    let about = MenuItem::with_id(app, "about", about_label.as_str(), true, None::<&str>)?;
    let check = MenuItem::with_id(app, "check-update", "检查更新", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启服务", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &sep, &about, &check, &restart, &quit_item])?;

    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().unwrap().clone())
        // 初始提示就带上状态：发布构建无控制台，托盘提示是唯一常驻的运行状态出口
        .tooltip(format!("MCPDog v{ver} · {}", supervisor::state().label()))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open-admin" => open_admin(),
            "about" => show_about(app),
            "check-update" => check_update(app),
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

/// 「检查更新」：读远端 latest.json 与本地版本比对，结果一律用原生弹窗呈现。
///
/// 网络请求必须离开菜单回调线程（理由同 `restart_service` / `quit`）：GitHub 往返慢起来
/// 可达十几秒，直接在回调里 await 会把托盘冻住。
///
/// 失败必须弹窗而不是只 `eprintln!` —— 发布构建带 `windows_subsystem = "windows"`，
/// 没有控制台，写 stderr 用户什么都看不到。端点 404（例如 Release 里没有 latest.json）
/// 也会走到这里，这正是「静默永远报已是最新」那类故障的可见化出口。
///
/// 只检查与提示、不下载安装：`Update::download_and_install` 在 Windows 上会运行安装程序并以
/// `std::process::exit(0)` 结束本进程（绕过 `main` 末尾的 `supervisor::shutdown()`），
/// 那条路径需要真机端到端验证（计划 Task 6 的 Step 5.2）。因此文案如实说明不会自动安装。
fn check_update(app: &AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    use tauri_plugin_updater::UpdaterExt;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let current = app.package_info().version.to_string();

        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(e) => {
                show_check_error(&app, &e.to_string());
                return;
            }
        };

        match updater.check().await {
            // 远端没有更新的版本
            Ok(None) => {
                app.dialog()
                    .message(format!("当前已是最新版本 v{current}。"))
                    .title("检查更新")
                    .kind(MessageDialogKind::Info)
                    .buttons(MessageDialogButtons::Ok)
                    .show(|_| {});
            }
            // 有新版本：用户确认后静默更新 —— 停 daemon 释放内嵌 node.exe 的镜像锁
            // （见 doc/bug-diagnosis-node-exe-locked-during-update-20260924.md），
            // 然后 download_and_install：下载、验签、以 /S /UPDATE 静默运行 NSIS、
            // 装完 /R 自动重启本壳。/UPDATE 模式下模板保留 Run 键自启值，
            // 因此开机自启不丢，全程无浏览器、无安装向导。
            // 重活全部离开当前线程：stop_for_update 持 SUPERVISOR 锁（最长分钟级），
            // 下载在异步运行时做，安装的 ExecWait 由 updater 插件自己管理。
            Ok(Some(update)) => {
                let target = update.version.clone();
                app.dialog()
                    .message(format!(
                        "发现新版本 v{target}（当前 v{current}）。\n\n\
                         点「确定」后将自动完成更新：\n\
                         1. 停止 MCPDog 服务（期间 MCP 客户端暂时不可用）；\n\
                         2. 下载并静默安装新版本（无需手动操作）；\n\
                         3. 安装完成后自动重启并恢复服务，开机自启设置保持不变。"
                    ))
                    .title("检查更新")
                    .kind(MessageDialogKind::Info)
                    .buttons(MessageDialogButtons::OkCancel)
                    .show(move |confirmed| {
                        if !confirmed {
                            return;
                        }
                        let app = app.clone();
                        std::thread::spawn(move || {
                            if !supervisor::stop_for_update() {
                                eprintln!("[tray] 更新前停机有残留进程，由安装器钩子兜底");
                            }
                            // download_and_install 需要在 async 上下文执行：
                            // 回到 tauri 异步运行时做下载与安装（壳随后会被安装器结束）
                            tauri::async_runtime::spawn(async move {
                                let updater = match app.updater() {
                                    Ok(u) => u,
                                    Err(e) => {
                                        show_silent_update_error(&app, &format!("updater 初始化失败: {e}"));
                                        return;
                                    }
                                };
                                // 重新 check 拿到待装对象：确认弹窗期间远端可能已变化
                                let update = match updater.check().await {
                                    Ok(Some(u)) if u.version == target => u,
                                    Ok(Some(u)) => {
                                        show_silent_update_error(
                                            &app,
                                            &format!("远端版本已变化（{} != {target}），请重新检查更新", u.version),
                                        );
                                        return;
                                    }
                                    Ok(None) => {
                                        show_silent_update_error(&app, "远端已无此版本，请重新检查更新");
                                        return;
                                    }
                                    Err(e) => {
                                        show_silent_update_error(&app, &format!("下载前检查失败: {e}"));
                                        return;
                                    }
                                };
                                eprintln!("[tray] 静默更新：开始下载 v{} ...", update.version);
                                if let Err(e) = update
                                    .download_and_install(
                                        |_chunk, _total| {},
                                        || eprintln!("[tray] 静默更新：下载完成，验签并安装..."),
                                    )
                                    .await
                                {
                                    // 安装失败壳还活着：弹窗说明，daemon 可用托盘「重启服务」拉回
                                    show_silent_update_error(&app, &format!("下载/安装失败: {e}"));
                                    return;
                                }
                                // 成功路径不会走到这里：updater 在 Windows 上运行静默安装器
                                // 并结束本进程，由安装器 /R 重启新版本
                                eprintln!("[tray] 静默更新安装完成");
                            });
                        });
                    });
            }
            // 失败原因必须让用户看见（网络不通 / endpoint 404 / 验签不通过都走到这里）
            Err(e) => show_check_error(&app, &e.to_string()),
        }
    });
}

/// 检查更新失败的弹窗：带上原因，不静默
fn show_check_error(app: &AppHandle, reason: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    app.dialog()
        .message(format!("检查更新失败：\n{reason}"))
        .title("检查更新")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

/// 静默更新失败的弹窗。此时 daemon 已被停掉：文案必须告诉用户怎么把服务拉回来。
fn show_silent_update_error(app: &AppHandle, reason: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    app.dialog()
        .message(format!(
            "自动更新失败：\n{reason}\n\n\
             服务当前已停止：可在托盘菜单点「重启服务」恢复；\n\
             也可到 Releases 页面手动下载安装包更新。"
        ))
        .title("MCPDog 更新")
        .kind(MessageDialogKind::Error)
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
