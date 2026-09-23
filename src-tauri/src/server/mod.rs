// server/mod.rs
// Axum HTTP 服务器：管理端点 + 反向代理
// 端口：38400~38419 滑动探测

pub mod api;
pub mod custom_model;
pub mod proxy;

use anyhow::Result;
use axum::{
    Router,
    routing::any,
};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;

use crate::config::find_available_port;
use crate::engine::EngineCoordinator;

use self::api::{management_routes, resolve_model_downloader, AppState};
use self::proxy::{ProxyState, proxy_handler};

/// 启动 Axum HTTP 服务
/// 返回实际绑定的端口
pub async fn start_server(
    base_port: u16,
    coordinator: Arc<EngineCoordinator>,
    proxy_state: ProxyState,
) -> Result<u16> {
    let port = find_available_port(base_port).await;
    // 立即记录实际绑定的端口，确保 IPC 在 serve 阻塞前就能返回该端口
    *coordinator.active_port.lock().await = Some(port);

    // 初始化下载任务管理器与活跃进程 PID 表
    let download_tasks = Arc::new(Mutex::new(HashMap::new()));
    let active_child_pids = Arc::new(Mutex::new(HashMap::new()));

    // 查找 llama-model-download 可执行文件路径
    let model_downloader_path = Arc::new(resolve_model_downloader());
    info!("llama-model-download 路径: {:?}", model_downloader_path);

    let app_state = AppState {
        coordinator: coordinator.clone(),
        download_tasks,
        active_child_pids,
        model_downloader_path,
    };

    // CORS 配置（允许主程序前端跨域调用）
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // 合并路由：管理端点 + 反代
    let app = Router::new()
        // 管理端点
        .merge(management_routes().with_state(app_state))
        // 透明反代 /v1/*
        .route("/v1/{*path}", any(proxy_handler).with_state(proxy_state.clone()))
        // 根路径健康探测
        .route("/health", axum::routing::get(|| async { "ok" }))
        // 兜底：其余所有路径（/、/index.html 等 llama-server WebUI 资源）
        // 全部转发给内部 llama-server，使网关端口即可直接访问聊天 WebUI
        .fallback(any(proxy_handler).with_state(proxy_state.clone()))
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(&addr).await?;

    info!("Firefly AI Engine HTTP 服务已启动: http://{}", addr);

    axum::serve(listener, app).await?;

    Ok(port)
}
