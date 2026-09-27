// lib.rs
// Tauri 应用入口（lib 供测试引用）

pub mod config;
pub mod engine;
pub mod hardware;
pub mod resource_scope;
pub mod server;
pub mod win_proc;

use config::ConfigStore;
use engine::EngineCoordinator;
use hardware::{DriverComplianceService, HardwareDetector};
use server::proxy::ProxyState;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconEvent};
use tauri::Manager;

use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

/// 获取当前 Axum HTTP 服务实际绑定的端口
#[tauri::command]
async fn get_server_port(coordinator: tauri::State<'_, Arc<EngineCoordinator>>) -> Result<u16, String> {
    let port = *coordinator.active_port.lock().await;
    port.ok_or_else(|| "服务启动中，暂未分配端口".to_string())
}

/// 弹出系统原生目录选择对话框
#[tauri::command]
async fn select_directory(default_path: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(ref dp) = default_path {
        let p = std::path::Path::new(dp);
        if p.exists() {
            dialog = dialog.set_directory(p);
        }
    }
    let folder = dialog.set_title("选择模型存储目录").pick_folder().await;
    Ok(folder.map(|f| f.path().to_string_lossy().to_string()))
}

/// 显示并聚焦主窗口（托盘打开 / 双击 / open-ui 共用）
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        warn!("未找到主窗口，无法显示");
    }
}

/// 给托盘图标挂载「打开 / 退出」菜单并绑定事件。
///
/// `tauri.conf.json` 的 `trayIcon` 只负责图标与 tooltip，菜单项必须在运行时组装，
/// 否则托盘点开是空菜单。
/// 同时绑定左键双击直接唤起主窗口（menuOnLeftClick=false，避免单击弹菜单抢走双击）。
fn setup_tray_menu(app: &tauri::AppHandle) {
    let open_item = match MenuItem::with_id(app, "open", "打开", true, None::<&str>) {
        Ok(item) => item,
        Err(e) => {
            warn!("创建托盘菜单项「打开」失败: {}", e);
            return;
        }
    };
    let separator = match PredefinedMenuItem::separator(app) {
        Ok(item) => item,
        Err(e) => {
            warn!("创建托盘菜单分隔线失败: {}", e);
            return;
        }
    };
    let quit_item = match MenuItem::with_id(app, "quit", "退出", true, None::<&str>) {
        Ok(item) => item,
        Err(e) => {
            warn!("创建托盘菜单项「退出」失败: {}", e);
            return;
        }
    };
    let menu = match Menu::with_items(app, &[&open_item, &separator, &quit_item]) {
        Ok(menu) => menu,
        Err(e) => {
            warn!("组装托盘菜单失败: {}", e);
            return;
        }
    };

    let Some(tray) = app.tray_by_id("firefly-ai-engine-tray") else {
        warn!("未找到托盘图标（id=firefly-ai-engine-tray），跳过菜单挂载");
        return;
    };

    if let Err(e) = tray.set_menu(Some(menu)) {
        warn!("挂载托盘菜单失败: {}", e);
        return;
    }

    // 菜单点击：打开主窗口 / 优雅退出
    let app_handle = app.clone();
    tray.on_menu_event(move |tray_app, event| {
        match event.id().as_ref() {
            "open" => {
                show_main_window(tray_app);
            }
            "quit" => {
                info!("收到托盘「退出」请求，准备优雅关闭...");
                let handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    // 先停掉 llama-server 子进程，再退出（对齐 /api/engine/shutdown）
                    if let Some(coordinator) = handle.try_state::<Arc<EngineCoordinator>>() {
                        let _ = coordinator.guard.stop().await;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                    std::process::exit(0);
                });
            }
            _ => {}
        }
    });

    // 左键单击/双击托盘图标：均直接唤起主窗口（菜单仅右键弹出，见 menuOnLeftClick=false）
    tray.on_tray_icon_event(|tray_app, event| {
        let is_left_activate = matches!(
            event,
            TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            }
        );
        if is_left_activate {
            info!("托盘图标左键点击，显示主窗口");
            show_main_window(tray_app.app_handle());
        }
    });
}

/// 构建并运行 Tauri 应用
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化 tracing 日志
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "firefly_ai_engine_lib=info,tower_http=warn".parse().unwrap()),
        )
        .json()
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            let data_dir = app_handle
                .path()
                .app_data_dir()
                .expect("无法获取 AppData 目录");

            info!("Firefly AI Engine 数据目录: {:?}", data_dir);

            // 加载配置
            let config_store = ConfigStore::new(data_dir.clone());
            let loaded_config = config_store.load().unwrap_or_default();
            let base_port = loaded_config.base_port;
            let models_dir = loaded_config.models_dir.clone();

            // 确保模型目录存在
            std::fs::create_dir_all(&models_dir).ok();

            let config = Arc::new(Mutex::new(loaded_config));

            // 资源查找范围：仅自身安装目录（锚定 exe）与用户数据目录
            // 禁止使用可能解析到宿主 desktop 共享 extraResources 的 resource_dir 作为安装根
            let tauri_resource_dir = app_handle.path().resource_dir().ok();
            let install_bin_dirs =
                resource_scope::allowed_install_bin_dirs(tauri_resource_dir.as_deref());
            info!("资源查找安装目录 bin: {:?}", install_bin_dirs);
            let hardware = Arc::new(HardwareDetector::new(install_bin_dirs.clone()));

            // 初始化驱动合规服务
            let compliance = DriverComplianceService::new();

            let proxy_state = ProxyState::new();

            // 初始化引擎协调器
            let coordinator = EngineCoordinator::new(
                hardware.clone(),
                compliance,
                install_bin_dirs,
                config.clone(),
                proxy_state.clone(),
            );

            let coordinator_clone = coordinator.clone();
            let proxy_state_clone = proxy_state.clone();
            let app_handle_for_server = app_handle.clone();

            // 在后台启动 Axum HTTP 服务器（携带 AppHandle 以支持 open-ui 唤起窗口）
            tauri::async_runtime::spawn(async move {
                match server::start_server(
                    base_port,
                    coordinator_clone.clone(),
                    proxy_state_clone,
                    Some(app_handle_for_server),
                )
                .await
                {
                    Ok(actual_port) => {
                        info!("HTTP 服务绑定端口: {}", actual_port);
                        *coordinator_clone.active_port.lock().await = Some(actual_port);
                    }
                    Err(e) => {
                        tracing::error!("HTTP 服务启动失败: {}", e);
                    }
                }
            });

            app.manage(coordinator.clone());

            // 检查是否 --silent 启动（不显示窗口）
            let args: Vec<String> = std::env::args().collect();
            let is_silent = args.contains(&"--silent".to_string()) || args.contains(&"--tray".to_string());

            if let Some(window) = app_handle.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                {
                    // 为主窗口设置原生高清晰度图标（修复任务栏图标模糊问题）
                    if let Ok(hwnd) = window.hwnd() {
                        use windows_sys::Win32::Foundation::HWND;
                        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
                        use windows_sys::Win32::UI::WindowsAndMessaging::{
                            GetSystemMetrics, LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL,
                            IMAGE_ICON, LR_DEFAULTCOLOR, SM_CXICON, SM_CXSMICON, SM_CYICON,
                            SM_CYSMICON, WM_SETICON,
                        };

                        unsafe {
                            let hinstance = GetModuleHandleW(std::ptr::null());
                            // 32512 是 tauri-winres 注入的主应用图标资源 ID (IDI_APPLICATION)
                            let resource_id = 32512 as usize as *const u16;

                            // 1. 获取系统对于大图标的标准尺寸（通常为 32x32 或高 DPI 下的 48x48）
                            let cx_big = GetSystemMetrics(SM_CXICON);
                            let cy_big = GetSystemMetrics(SM_CYICON);
                            let hicon_big = LoadImageW(
                                hinstance,
                                resource_id,
                                IMAGE_ICON,
                                cx_big,
                                cy_big,
                                LR_DEFAULTCOLOR,
                            );
                            if !hicon_big.is_null() {
                                SendMessageW(hwnd.0 as HWND, WM_SETICON, ICON_BIG as usize, hicon_big as isize);
                            }

                            // 2. 获取系统对于小图标的标准尺寸（通常为 16x16 或高 DPI 下的 24x24）
                            let cx_small = GetSystemMetrics(SM_CXSMICON);
                            let cy_small = GetSystemMetrics(SM_CYSMICON);
                            let hicon_small = LoadImageW(
                                hinstance,
                                resource_id,
                                IMAGE_ICON,
                                cx_small,
                                cy_small,
                                LR_DEFAULTCOLOR,
                            );
                            if !hicon_small.is_null() {
                                SendMessageW(hwnd.0 as HWND, WM_SETICON, ICON_SMALL as usize, hicon_small as isize);
                            }
                        }
                    }
                }

                if !is_silent {
                    // 显示主窗口
                    let _ = window.show();
                    let _ = window.set_focus();
                } else {
                    info!("以静默模式启动（--silent），主窗口保持隐藏");
                }
            }

            // 托盘右键/左键菜单：打开主窗口 / 退出
            // （tauri.conf.json 仅声明托盘图标，菜单项需在此挂载并绑定事件）
            setup_tray_menu(app.handle());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_server_port, select_directory])
        .on_window_event(|window, event| {
            // 关闭窗口时最小化到托盘而不是退出
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}

#[cfg(test)]
mod acl_capability_tests {
    //! 校验主窗口的 ACL 能力声明（`src-tauri/capabilities/default.json`）。
    //!
    //! 背景：Desktop 通过 `POST /api/engine/open-ui` 深链唤起引擎面板时，Rust 侧以
    //! `window.emit("engine:ui-intent")` 通知前端。Tauri 2 对 webview 默认零权限，
    //! 缺少 `core:event:allow-listen` 时前端 `listen()` 会抛
    //! `event.listen not allowed`，表现为「只前置窗口、不切换面板」。
    //!
    //! 本模块直接对**编译期解析后的 runtime authority** 调用 `resolve_access`，
    //! 因此无需启动 WebView2 即可确证 ACL 是否生效——避免依赖真实浏览器运行时。

    use tauri::ipc::Origin;

    /// 主窗口（label = `main`）必须被授予事件监听 / 取消监听权限。
    #[test]
    fn main_window_can_listen_and_unlisten_events() {
        let mut ctx: tauri::Context<tauri::Wry> = tauri::generate_context!();
        let authority = ctx.runtime_authority_mut();

        for command in ["plugin:event|listen", "plugin:event|unlisten"] {
            assert!(
                authority
                    .resolve_access(command, "main", "main", &Origin::Local)
                    .is_some(),
                "主窗口 main 未被授予 {command} 权限；\
                 请检查 src-tauri/capabilities/default.json 是否声明 core:event:allow-listen"
            );
        }
    }

    /// 反向断言：能力声明限定 `windows: ["main"]`，未声明的 label 不应获得该权限。
    ///
    /// 若本断言失败，说明能力被误声明为全局（缺少 windows 约束），
    /// 会把事件监听权限扩散到所有窗口。
    #[test]
    fn undeclared_window_labels_are_not_granted_event_permissions() {
        let mut ctx: tauri::Context<tauri::Wry> = tauri::generate_context!();
        let authority = ctx.runtime_authority_mut();

        assert!(
            authority
                .resolve_access(
                    "plugin:event|listen",
                    "not-a-declared-window",
                    "not-a-declared-webview",
                    &Origin::Local,
                )
                .is_none(),
            "未声明的窗口 label 不应获得事件监听权限，能力声明可能缺少 windows 约束"
        );
    }
}
