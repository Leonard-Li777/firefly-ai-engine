// lib.rs
// Tauri 应用入口（lib 供测试引用）

pub mod config;
pub mod engine;
pub mod hardware;
pub mod server;

use config::ConfigStore;
use engine::EngineCoordinator;
use hardware::{DriverComplianceService, HardwareDetector};
use server::proxy::ProxyState;
use tauri::Manager;

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

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

            // 初始化硬件检测器（以 app_dir 为 bin 搜索起点）
            let app_install_dir = app_handle
                .path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let hardware = Arc::new(HardwareDetector::new(app_install_dir.clone()));

            // 初始化驱动合规服务
            let compliance = DriverComplianceService::new();

            let proxy_state = ProxyState::new();

            // 初始化引擎协调器
            let bin_dir = app_install_dir.join("bin");
            let coordinator = EngineCoordinator::new(
                hardware.clone(),
                compliance,
                bin_dir,
                config.clone(),
                proxy_state.clone(),
            );

            let coordinator_clone = coordinator.clone();
            let proxy_state_clone = proxy_state.clone();

            // 在后台启动 Axum HTTP 服务器
            tauri::async_runtime::spawn(async move {
                match server::start_server(base_port, coordinator_clone.clone(), proxy_state_clone).await {
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
