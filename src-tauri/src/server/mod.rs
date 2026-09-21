// server/mod.rs
// Axum HTTP 服务器：管理端点 + 反向代理
// 端口：38400~38419 滑动探测

pub mod api;
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

    // 初始化下载任务管理器
    let download_tasks = Arc::new(Mutex::new(HashMap::new()));

    // 查找 llama-model-download 可执行文件路径
    let model_downloader_path = Arc::new(resolve_model_downloader());
    info!("llama-model-download 路径: {:?}", model_downloader_path);

    let app_state = AppState {
        coordinator: coordinator.clone(),
        download_tasks,
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
        .route("/v1/*path", any(proxy_handler).with_state(proxy_state.clone()))
        // 根路径健康探测
        .route("/health", axum::routing::get(|| async { "ok" }))
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(&addr).await?;

    info!("Firefly AI Engine HTTP 服务已启动: http://{}", addr);

    axum::serve(listener, app).await?;

    Ok(port)
}
