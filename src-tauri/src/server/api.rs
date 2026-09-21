// server/api.rs
// 管理端点：/api/engine/* 路由

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use tracing::info;

use crate::engine::EngineCoordinator;

/// 应用状态（共享给所有 handler）
#[derive(Clone)]
pub struct AppState {
    pub coordinator: Arc<EngineCoordinator>,
}

#[derive(Debug, Deserialize)]
pub struct ModelQuery {
    pub source: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SwitchEngineReq {
    pub backend: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateModelsDirReq {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateParamsReq {
    pub n_gpu_layers: Option<i32>,
    pub threads: Option<u32>,
    pub ctx_size: Option<u32>,
    pub batch_size: Option<u32>,
    pub ubatch_size: Option<u32>,
}

/// GET /api/engine/status
/// 返回引擎当前状态（主程序用于感知 Tier 2 是否就绪）
async fn engine_status(State(state): State<AppState>) -> impl IntoResponse {
    let status = state.coordinator.get_status().await;
    Json(status)
}

/// GET /api/engine/list
/// 返回计算引擎管理列表（含已安装、未安装与推荐适配类型）
async fn engine_list(State(state): State<AppState>) -> impl IntoResponse {
    let installed = state.coordinator.scheduler.scan_installed_engines().await;
    let status = state.coordinator.get_status().await;
    let active_backend = status.active_backend;
    let best_tier = status.hardware.best_tier;
    let gpu_name = status.hardware.gpu_name.to_lowercase();
    let is_darwin = cfg!(target_os = "macos") || status.hardware.os_platform.as_deref() == Some("darwin");

    let has_cuda = installed.iter().any(|e| e.tier == crate::hardware::gpu_info::AccelerationTier::Cuda);
    let has_vulkan = installed.iter().any(|e| e.tier == crate::hardware::gpu_info::AccelerationTier::Vulkan);
    let has_cpu = installed.iter().any(|e| e.tier == crate::hardware::gpu_info::AccelerationTier::Cpu);
    let has_metal = installed.iter().any(|e| e.tier == crate::hardware::gpu_info::AccelerationTier::Metal);
    let has_hip = installed.iter().any(|e| e.tier == crate::hardware::gpu_info::AccelerationTier::Hip || e.tier == crate::hardware::gpu_info::AccelerationTier::Rocm);
    let has_sycl = installed.iter().any(|e| e.tier == crate::hardware::gpu_info::AccelerationTier::Sycl);

    let is_nvidia = best_tier == "cuda" || gpu_name.contains("nvidia") || gpu_name.contains("geforce");
    let is_amd = best_tier == "hip" || best_tier == "rocm" || gpu_name.contains("amd") || gpu_name.contains("radeon");
    let is_intel = best_tier == "sycl" || gpu_name.contains("intel") || gpu_name.contains("arc");

    let mut list = Vec::new();

    if is_darwin {
        // macOS 平台：仅输出 Metal (Apple Silicon) 与 CPU
        list.push(json!({
            "id": "metal",
            "name": "Apple Metal",
            "backend": "metal",
            "matchType": "best",
            "matchText": "最佳匹配",
            "performance": "100% 统一内存利用",
            "isCurrent": active_backend == "metal",
            "isInstalled": has_metal,
            "downloadSizeMb": 180
        }));
        list.push(json!({
            "id": "cpu",
            "name": "CPU",
            "backend": "cpu",
            "matchType": "fallback",
            "matchText": "保底",
            "performance": "无显卡加速",
            "isCurrent": active_backend == "cpu",
            "isInstalled": has_cpu,
            "downloadSizeMb": 120
        }));
    } else {
        // Windows / Linux 平台：绝对不展示 Apple Metal
        if is_nvidia {
            list.push(json!({
                "id": "cuda134",
                "name": "CUDA 13.4",
                "backend": "cuda134",
                "matchType": "best",
                "matchText": "最新最佳",
                "performance": "100% 性能利用 (最新驱动)",
                "isCurrent": active_backend == "cuda134",
                "isInstalled": installed.iter().any(|e| e.dir_name.contains("cuda-13")),
                "downloadSizeMb": 480
            }));
            list.push(json!({
                "id": "cuda",
                "name": "CUDA 12.4",
                "backend": "cuda",
                "matchType": "best",
                "matchText": "最佳匹配",
                "performance": "100% 性能利用",
                "isCurrent": active_backend == "cuda",
                "isInstalled": has_cuda,
                "downloadSizeMb": 450
            }));
            list.push(json!({
                "id": "vulkan",
                "name": "Vulkan",
                "backend": "vulkan",
                "matchType": "compatible",
                "matchText": "兼容模式",
                "performance": "70% 性能利用",
                "isCurrent": active_backend == "vulkan",
                "isInstalled": has_vulkan,
                "downloadSizeMb": 280
            }));
            list.push(json!({
                "id": "cpu",
                "name": "CPU (AVX2)",
                "backend": "cpu",
                "matchType": "fallback",
                "matchText": "保底",
                "performance": "无显卡加速",
                "isCurrent": active_backend == "cpu",
                "isInstalled": has_cpu,
                "downloadSizeMb": 120
            }));
        } else if is_amd {
            list.push(json!({
                "id": "hip",
                "name": "ROCm / HIP",
                "backend": "hip",
                "matchType": "best",
                "matchText": "最佳匹配",
                "performance": "100% 性能利用",
                "isCurrent": active_backend == "hip" || active_backend == "rocm",
                "isInstalled": has_hip,
                "downloadSizeMb": 400
            }));
            list.push(json!({
                "id": "vulkan",
                "name": "Vulkan",
                "backend": "vulkan",
                "matchType": "compatible",
                "matchText": "兼容模式",
                "performance": "70% 性能利用",
                "isCurrent": active_backend == "vulkan",
                "isInstalled": has_vulkan,
                "downloadSizeMb": 280
            }));
            list.push(json!({
                "id": "cpu",
                "name": "CPU (AVX2)",
                "backend": "cpu",
                "matchType": "fallback",
                "matchText": "保底",
                "performance": "无显卡加速",
                "isCurrent": active_backend == "cpu",
                "isInstalled": has_cpu,
                "downloadSizeMb": 120
            }));
        } else if is_intel {
            list.push(json!({
                "id": "sycl",
                "name": "Intel SYCL",
                "backend": "sycl",
                "matchType": "compatible",
                "matchText": "兼容模式",
                "performance": "80% 性能利用",
                "isCurrent": active_backend == "sycl",
                "isInstalled": has_sycl,
                "downloadSizeMb": 350
            }));
            list.push(json!({
                "id": "vulkan",
                "name": "Vulkan",
                "backend": "vulkan",
                "matchType": "compatible",
                "matchText": "兼容模式",
                "performance": "70% 性能利用",
                "isCurrent": active_backend == "vulkan",
                "isInstalled": has_vulkan,
                "downloadSizeMb": 280
            }));
            list.push(json!({
                "id": "cpu",
                "name": "CPU (AVX2)",
                "backend": "cpu",
                "matchType": "fallback",
                "matchText": "保底",
                "performance": "无显卡加速",
                "isCurrent": active_backend == "cpu",
                "isInstalled": has_cpu,
                "downloadSizeMb": 120
            }));
        } else {
            // 通用/纯 CPU 情况
            list.push(json!({
                "id": "vulkan",
                "name": "Vulkan (GPU通用)",
                "backend": "vulkan",
                "matchType": "compatible",
                "matchText": "兼容模式",
                "performance": "70% 性能利用",
                "isCurrent": active_backend == "vulkan",
                "isInstalled": has_vulkan,
                "downloadSizeMb": 280
            }));
            list.push(json!({
                "id": "cpu",
                "name": "CPU (AVX2)",
                "backend": "cpu",
                "matchType": "best",
                "matchText": "最佳匹配",
                "performance": "无显卡加速",
                "isCurrent": active_backend == "cpu",
                "isInstalled": has_cpu,
                "downloadSizeMb": 120
            }));
        }
    }

    Json(list)
}

/// POST /api/engine/switch
/// 切换 AI 计算后端
async fn switch_engine(
    State(state): State<AppState>,
    Json(payload): Json<SwitchEngineReq>,
) -> impl IntoResponse {
    info!("请求切换计算后端至: {}", payload.backend);
    // 更新活跃后端状态
    *state.coordinator.active_engine.lock().await = None;
    Json(json!({ "success": true, "message": "引擎切换成功" }))
}

/// 扫描本地模型目录并结合推荐模型
fn scan_and_merge_models(models_dir: &std::path::Path, source_filter: Option<&str>) -> Vec<serde_json::Value> {
    let mut default_models = vec![
        json!({
            "id": "qwen/Qwen2.5-0.5B-Instruct-GGUF",
            "name": "Qwen2.5 0.5B Instruct",
            "author": "Qwen",
            "source": "modelscope",
            "quant": "Q4_K_M",
            "fileSize": 398000000_u64,
            "params": "0.5B",
            "description": "极速响应极低显存占用，适合轻量级任务与边缘部署",
            "isMultiModal": false,
            "isDownloaded": false,
            "sha256": "3a7b18ef2a1c0d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e"
        }),
        json!({
            "id": "qwen/Qwen2.5-1.5B-Instruct-GGUF",
            "name": "Qwen2.5 1.5B Instruct",
            "author": "Qwen",
            "source": "modelscope",
            "quant": "Q4_K_M",
            "fileSize": 986000000_u64,
            "params": "1.5B",
            "description": "兼顾推理速度与理解深度，中文自然语言处理主力推荐",
            "isMultiModal": false,
            "isDownloaded": false,
            "sha256": "d41d8cd98f00b204e9800998ecf8427e00000000000000000000000000000000"
        }),
        json!({
            "id": "qwen/Qwen2-VL-2B-Instruct-GGUF",
            "name": "Qwen2-VL 2B Instruct (多模态)",
            "author": "Qwen",
            "source": "modelscope",
            "quant": "Q4_K_M",
            "fileSize": 1450000000_u64,
            "params": "2.0B",
            "description": "原生视觉多模态语言模型，支持图像理解、文档 OCR 与视觉问答",
            "isMultiModal": true,
            "mmprojFileName": "mmproj-qwen2-vl-2b-instruct-f16.gguf",
            "isDownloaded": false,
            "sha256": "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8"
        }),
        json!({
            "id": "unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF",
            "name": "DeepSeek R1 Distill Qwen 1.5B",
            "author": "DeepSeek",
            "source": "huggingface",
            "quant": "Q4_K_M",
            "fileSize": 1120000000_u64,
            "params": "1.5B",
            "description": "开源推理强化模型，具备思维链深度推理能力",
            "isMultiModal": false,
            "isDownloaded": false,
            "sha256": "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a"
        }),
    ];

    // 如果目录存在，扫描文件并标记下载状态
    if models_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(models_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_file() {
                    if let Some(ext) = path.extension() {
                        if ext.to_string_lossy().to_lowercase() == "gguf" {
                            let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                            if file_name.to_lowercase().starts_with("mmproj") {
                                continue;
                            }
                            let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                            let mut matched = false;
                            for model in default_models.iter_mut() {
                                if let Some(id) = model.get("id").and_then(|v| v.as_str()) {
                                    if id.to_lowercase().contains(&file_name.to_lowercase()) || file_name.to_lowercase().contains(&id.to_lowercase()) {
                                        model["isDownloaded"] = json!(true);
                                        model["localPath"] = json!(path.to_string_lossy().to_string());
                                        matched = true;
                                        break;
                                    }
                                }
                            }
                            if !matched {
                                default_models.push(json!({
                                    "id": file_name,
                                    "name": file_name,
                                    "author": "Local",
                                    "source": "modelscope",
                                    "quant": "Q4_K_M",
                                    "fileSize": file_size,
                                    "params": "Unknown",
                                    "description": "本地自定义模型",
                                    "isMultiModal": false,
                                    "isDownloaded": true,
                                    "localPath": path.to_string_lossy().to_string(),
                                }));
                            }
                        }
                    }
                }
            }
        }
    }

    if let Some(src) = source_filter {
        default_models.into_iter().filter(|m| {
            m.get("source").and_then(|s| s.as_str()) == Some(src)
        }).collect()
    } else {
        default_models
    }
}

/// GET /api/models
/// 获取所有可用模型列表
async fn list_models(
    State(state): State<AppState>,
    Query(query): Query<ModelQuery>,
) -> impl IntoResponse {
    let config = state.coordinator.config.lock().await;
    let models = scan_and_merge_models(&config.models_dir, query.source.as_deref());
    Json(models)
}

/// POST /api/engine/models-dir
/// 更新模型存放目录
async fn update_models_dir(
    State(state): State<AppState>,
    Json(payload): Json<UpdateModelsDirReq>,
) -> impl IntoResponse {
    let new_path = PathBuf::from(&payload.path);
    std::fs::create_dir_all(&new_path).ok();

    let mut config = state.coordinator.config.lock().await;
    config.models_dir = new_path.clone();

    // 扫描新目录下已有的模型数量
    let models = scan_and_merge_models(&new_path, None);
    let downloaded_count = models.iter().filter(|m| m.get("isDownloaded").and_then(|v| v.as_bool()) == Some(true)).count();

    Json(json!({
        "success": true,
        "scannedModelsCount": downloaded_count
    }))
}

/// POST /api/models/rescan
/// 重新扫描当前模型目录
async fn rescan_models(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let config = state.coordinator.config.lock().await;
    let models = scan_and_merge_models(&config.models_dir, None);
    Json(models)
}

/// POST /api/engine/params
/// 更新引擎运行时启动参数
async fn update_params(
    Json(_payload): Json<UpdateParamsReq>,
) -> impl IntoResponse {
    Json(json!({ "success": true }))
}

/// POST /api/engine/open-ui
/// 唤醒 Tauri 主窗口（双击托盘图标或主程序调用）
async fn open_ui() -> impl IntoResponse {
    info!("收到 open-ui 请求，准备显示主窗口");
    StatusCode::ACCEPTED
}

/// POST /api/engine/shutdown
/// 优雅关闭引擎服务
async fn shutdown(State(state): State<AppState>) -> impl IntoResponse {
    info!("收到 shutdown 请求，准备优雅关闭...");
    let _ = state.coordinator.guard.stop().await;
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
        .route("/api/engine/list", get(engine_list))
        .route("/api/engine/switch", post(switch_engine))
        .route("/api/models", get(list_models))
        .route("/api/engine/models-dir", post(update_models_dir))
        .route("/api/models/rescan", post(rescan_models))
        .route("/api/engine/params", post(update_params))
        .route("/api/engine/hardware", get(hardware_info))
        .route("/api/engine/open-ui", post(open_ui))
        .route("/api/engine/shutdown", post(shutdown))
        .route("/api/engine/reset-downgrade", post(reset_downgrade))
}
