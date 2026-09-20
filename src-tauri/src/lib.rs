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
            let config = config_store.load().unwrap_or_default();
            let models_dir = config.models_dir.clone();

            // 确保模型目录存在
            std::fs::create_dir_all(&models_dir).ok();

            let config = Arc::new(Mutex::new(config));

            // 初始化硬件检测器（以 app_dir 为 bin 搜索起点）
            let app_install_dir = app_handle
                .path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let hardware = Arc::new(HardwareDetector::new(app_install_dir.clone()));

            // 初始化驱动合规服务
            let compliance = DriverComplianceService::new();

            // 初始化引擎协调器
            let bin_dir = app_install_dir.join("bin");
            let coordinator = EngineCoordinator::new(
                hardware.clone(),
                compliance,
                bin_dir,
                config.clone(),
            );

            let coordinator_clone = coordinator.clone();
            let proxy_state = ProxyState::new();
            let proxy_state_clone = proxy_state.clone();

            // 读取基准端口
            let base_port = {
                let rt = tokio::runtime::Handle::current();
                rt.block_on(async { config.lock().await.base_port })
            };

            // 在后台启动 Axum HTTP 服务器
            let app_handle_clone = app_handle.clone();
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

            // 检查是否 --silent 启动（不显示窗口）
            let args: Vec<String> = std::env::args().collect();
            let is_silent = args.contains(&"--silent".to_string()) || args.contains(&"--tray".to_string());

            if !is_silent {
                // 显示主窗口
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            } else {
                info!("以静默模式启动（--silent），主窗口保持隐藏");
            }

            Ok(())
        })
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
