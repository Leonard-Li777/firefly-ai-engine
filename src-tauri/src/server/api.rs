// server/api.rs
// 管理端点：/api/engine/* 路由

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use std::sync::Arc;
use tracing::info;

use crate::engine::EngineCoordinator;

/// 应用状态（共享给所有 handler）
#[derive(Clone)]
pub struct AppState {
    pub coordinator: Arc<EngineCoordinator>,
}

/// GET /api/engine/status
/// 返回引擎当前状态（主程序用于感知 Tier 2 是否就绪）
async fn engine_status(State(state): State<AppState>) -> impl IntoResponse {
    let status = state.coordinator.get_status().await;
    Json(status)
}

/// POST /api/engine/open-ui
/// 唤醒 Tauri 主窗口（双击托盘图标或主程序调用）
async fn open_ui() -> impl IntoResponse {
    // 通过 tauri 命令唤醒窗口（在 main.rs 中注册）
    info!("收到 open-ui 请求，准备显示主窗口");
    // 实际实现通过 Tauri 事件系统触发，此处返回 202 Accepted
    StatusCode::ACCEPTED
}

/// POST /api/engine/shutdown
/// 优雅关闭引擎服务
async fn shutdown(State(state): State<AppState>) -> impl IntoResponse {
    info!("收到 shutdown 请求，准备优雅关闭...");

    // 停止子进程
    let _ = state.coordinator.guard.stop().await;

    // 发送退出信号（实际退出在 main.rs 中处理）
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        std::process::exit(0);
    });

    Json(json!({ "status": "shutting_down" }))
}

/// GET /api/engine/hardware
/// 返回硬件信息（用于主程序跳过自己的硬件检测）
async fn hardware_info(State(state): State<AppState>) -> impl IntoResponse {
    match state.coordinator.hardware.detect(false).await {
        Ok(resources) => (StatusCode::OK, Json(serde_json::to_value(&resources).unwrap())),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// POST /api/engine/reset-downgrade
/// 清除降级记录（用户手动触发重试最高层级）
async fn reset_downgrade(State(state): State<AppState>) -> impl IntoResponse {
    state.coordinator.scheduler.reset_degradation().await;
    Json(json!({ "status": "ok" }))
}

/// 注册管理端点路由
pub fn management_routes() -> Router<AppState> {
    Router::new()
        .route("/api/engine/status", get(engine_status))
        .route("/api/engine/hardware", get(hardware_info))
        .route("/api/engine/open-ui", post(open_ui))
        .route("/api/engine/shutdown", post(shutdown))
        .route("/api/engine/reset-downgrade", post(reset_downgrade))
}
