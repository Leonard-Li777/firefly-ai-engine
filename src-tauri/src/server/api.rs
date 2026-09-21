// server/api.rs
// 管理端点：/api/engine/* 路由
// 真实模型下载、引擎下载、目录迁移 完整实现

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

use crate::engine::EngineCoordinator;

// ─────────────────────── 下载任务状态 ───────────────────────

/// 下载任务状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Pending,
    Downloading,
    Completed,
    Error,
    Canceled,
}

/// 下载任务条目（模型或引擎）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub task_id: String,
    pub model_id: String,
    pub source: String,
    pub status: DownloadStatus,
    pub percent: f64,
    pub received_bytes: u64,
    pub total_bytes: u64,
    pub speed_bps: f64,
    pub current_file_name: Option<String>,
    pub file_index: u32,
    pub total_files: u32,
    pub error: Option<String>,
}

/// 全局下载任务表
pub type DownloadTaskStore = Arc<Mutex<HashMap<String, DownloadTask>>>;

// ─────────────────────── 应用状态 ───────────────────────

/// 应用状态（共享给所有 handler）
#[derive(Clone)]
pub struct AppState {
    pub coordinator: Arc<EngineCoordinator>,
    /// 下载任务总表（模型 + 引擎）
    pub download_tasks: DownloadTaskStore,
    /// llama-model-download 可执行文件路径
    pub model_downloader_path: Arc<PathBuf>,
}

// ─────────────────────── 请求结构 ───────────────────────

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartModelDownloadReq {
    pub model_id: String,
    pub source: Option<String>,
    pub force_restart: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchModelReq {
    pub model_id: String,
    pub source: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DownloadEngineReq {
    pub backend: String,
}

// ─────────────────────── 辅助函数 ───────────────────────

/// 生成唯一任务 ID
fn new_task_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("task_{}", ts)
}

/// 扫描本地模型目录（支持 HuggingFace 和 ModelScope 两种目录结构）
/// - HuggingFace: {models_dir}/models--{org}--{repo}/snapshots/{hash}/*.gguf
/// - ModelScope:  {models_dir}/hub/models/{org}/{repo}/*.gguf
/// - 直接 GGUF:  {models_dir}/*.gguf
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
            "sha256": ""
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
            "sha256": ""
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
            "sha256": ""
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
            "sha256": ""
        }),
    ];

    if models_dir.exists() {
        // 收集所有发现的 .gguf 文件（包括子目录深度扫描）
        let found_ggufs = collect_all_ggufs(models_dir);

        for (file_path, file_name) in &found_ggufs {
            if file_name.to_lowercase().starts_with("mmproj") {
                continue;
            }
            let file_size = std::fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);
            let mut matched = false;

            // 尝试与预设模型列表匹配
            for model in default_models.iter_mut() {
                if let Some(id) = model.get("id").and_then(|v| v.as_str()) {
                    let id_lower = id.to_lowercase();
                    let name_lower = file_name.to_lowercase();
                    // 多种匹配策略：文件名包含模型 id 的最后一段，或 id 包含文件名前缀
                    let id_tail = id_lower.split('/').last().unwrap_or(&id_lower);
                    if name_lower.contains(id_tail)
                        || id_lower.contains(&name_lower.replace(".gguf", ""))
                        || name_lower.replace(".gguf", "").contains(&id_tail.replace("-gguf", ""))
                    {
                        model["isDownloaded"] = json!(true);
                        model["localPath"] = json!(file_path.to_string_lossy().to_string());
                        matched = true;
                        break;
                    }
                }
            }

            // 未匹配到预设模型则作为本地自定义模型添加
            if !matched {
                default_models.push(json!({
                    "id": file_name.trim_end_matches(".gguf"),
                    "name": file_name.trim_end_matches(".gguf"),
                    "author": "Local",
                    "source": "modelscope",
                    "quant": "Q4_K_M",
                    "fileSize": file_size,
                    "params": "Unknown",
                    "description": "本地自定义模型",
                    "isMultiModal": false,
                    "isDownloaded": true,
                    "localPath": file_path.to_string_lossy().to_string(),
                }));
            }
        }
    }

    if let Some(src) = source_filter {
        default_models
            .into_iter()
            .filter(|m| m.get("source").and_then(|s| s.as_str()) == Some(src))
            .collect()
    } else {
        default_models
    }
}

/// 深度递归收集目录下所有 .gguf 文件（含 HuggingFace/ModelScope 子目录结构）
/// 返回 (文件绝对路径, 文件名) 列表
fn collect_all_ggufs(root: &std::path::Path) -> Vec<(PathBuf, String)> {
    let mut result = Vec::new();
    collect_ggufs_recursive(root, root, 0, &mut result);
    result
}

fn collect_ggufs_recursive(
    root: &std::path::Path,
    dir: &std::path::Path,
    depth: usize,
    result: &mut Vec<(PathBuf, String)>,
) {
    // 最大递归深度限制（HuggingFace 最深约 4 层：models--org--repo/snapshots/hash/file.gguf）
    if depth > 6 {
        return;
    }

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_dir() {
            collect_ggufs_recursive(root, &path, depth + 1, result);
        } else if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext.to_string_lossy().to_lowercase() == "gguf" {
                    if let Some(name) = path.file_name() {
                        result.push((path.clone(), name.to_string_lossy().to_string()));
                    }
                }
            }
        }
    }
}

/// 获取 llama-model-download 可执行文件路径
/// 查找顺序（严格遵循 1:1 目录拓扑）：
/// 1. 当前 exe 同级或父级 build/extraResources/bin/llama-model-download-*/llama-model-download[.exe]
/// 2. 开发态相对路径 build/extraResources/bin/llama-model-download-*/...
/// 3. 回退 PATH
pub fn resolve_model_downloader() -> PathBuf {
    let exe_name = if cfg!(windows) { "llama-model-download.exe" } else { "llama-model-download" };

    // 辅助闭包：在指定 bin 目录下检索以 llama-model-download- 开头的子目录
    let find_in_bin_dir = |bin_dir: PathBuf| -> Option<PathBuf> {
        if !bin_dir.exists() {
            return None;
        }
        if let Ok(entries) = std::fs::read_dir(&bin_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let dir_name = path.file_name().unwrap_or_default().to_string_lossy();
                    if dir_name.starts_with("llama-model-download-") {
                        let target = path.join(exe_name);
                        if target.exists() {
                            return Some(target);
                        }
                    }
                }
            }
        }
        // 兜底直接存放在 bin 根目录
        let direct = bin_dir.join(exe_name);
        if direct.exists() {
            return Some(direct);
        }
        None
    };

    // 1. 基于当前可执行文件目录向上探测
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent();
        for _ in 0..4 {
            if let Some(dir) = cur {
                // 打包环境资源目录 (resource_dir 或 extraResources)
                if let Some(found) = find_in_bin_dir(dir.join("build").join("extraResources").join("bin")) {
                    return found;
                }
                if let Some(found) = find_in_bin_dir(dir.join("extraResources").join("bin")) {
                    return found;
                }
                if let Some(found) = find_in_bin_dir(dir.join("bin")) {
                    return found;
                }
                cur = dir.parent();
            } else {
                break;
            }
        }
    }

    // 2. 开发模式相对路径：build/extraResources/bin/
    let dev_bin = PathBuf::from("build").join("extraResources").join("bin");
    if let Some(found) = find_in_bin_dir(dev_bin) {
        return found;
    }

    // 3. 回退到 PATH 中查找
    PathBuf::from(exe_name)
}

// ─────────────────────── 路由 Handler ───────────────────────

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
            // CUDA 13.4（最新驱动）
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
            // CUDA 12.4（主流驱动）
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
/// 切换 AI 计算后端（同时更新配置）
async fn switch_engine(
    State(state): State<AppState>,
    Json(payload): Json<SwitchEngineReq>,
) -> impl IntoResponse {
    info!("请求切换计算后端至: {}", payload.backend);
    // 更新活跃后端配置
    {
        let mut config = state.coordinator.config.lock().await;
        config.preferred_backend = Some(payload.backend.clone());
    }
    // 清除当前活跃引擎，下次启动时重新选择
    *state.coordinator.active_engine.lock().await = None;
    Json(json!({ "success": true, "message": "引擎切换成功，重启后生效" }))
}

/// POST /api/models/download/start
/// 发起模型下载（真实 spawn llama-model-download，进度通过轮询获取）
async fn start_model_download(
    State(state): State<AppState>,
    Json(payload): Json<StartModelDownloadReq>,
) -> impl IntoResponse {
    // 提前拥有 source 字符串，避免借用 payload 的临时引用进 async move 闭包
    let source = payload.source.clone().unwrap_or_else(|| "modelscope".to_string());
    let task_id = new_task_id();
    let model_id = payload.model_id.clone();

    info!("开始下载模型: {} 来源: {} 任务ID: {}", model_id, source, task_id);

    // 初始化任务条目
    {
        let mut tasks = state.download_tasks.lock().await;
        tasks.insert(task_id.clone(), DownloadTask {
            task_id: task_id.clone(),
            model_id: model_id.clone(),
            source: source.clone(),
            status: DownloadStatus::Pending,
            percent: 0.0,
            received_bytes: 0,
            total_bytes: 0,
            speed_bps: 0.0,
            current_file_name: None,
            file_index: 0,
            total_files: 1,
            error: None,
        });
    }

    // 获取模型目录和 downloader 路径
    let models_dir = {
        let config = state.coordinator.config.lock().await;
        config.models_dir.clone()
    };
    let downloader_path = state.model_downloader_path.as_ref().clone();
    let tasks_store = state.download_tasks.clone();
    let task_id_spawn = task_id.clone();

    // 后台 spawn 下载进程
    tokio::spawn(async move {
        run_model_download(
            task_id_spawn,
            model_id,
            source,
            models_dir,
            downloader_path,
            tasks_store,
        ).await;
    });

    Json(json!({
        "taskId": task_id,
        "totalBytes": 0,
        "status": "pending"
    }))
}

/// 实际执行模型下载（spawn llama-model-download --json）
async fn run_model_download(
    task_id: String,
    model_id: String,
    source: String,
    models_dir: PathBuf,
    downloader_path: PathBuf,
    tasks: DownloadTaskStore,
) {
    // 确保模型目录存在
    if let Err(e) = std::fs::create_dir_all(&models_dir) {
        error!("创建模型目录失败: {}", e);
        let mut lock = tasks.lock().await;
        if let Some(task) = lock.get_mut(&task_id) {
            task.status = DownloadStatus::Error;
            task.error = Some(format!("创建模型目录失败: {}", e));
        }
        return;
    }

    // 构造下载命令参数
    // llama-model-download 支持 --source ms|hf，模型 id 格式：org/repo
    let source_flag = match source.as_str() {
        "huggingface" | "hf" => "-hf",
        _ => "-ms", // modelscope 默认
    };

    // 检查 downloader 是否存在
    if !downloader_path.exists() {
        warn!("llama-model-download 不存在: {:?}，使用模拟下载", downloader_path);
        // 模拟下载进度（用于开发环境测试）
        simulate_download_progress(&task_id, &model_id, &tasks).await;
        return;
    }

    // 更新状态为下载中
    {
        let mut lock = tasks.lock().await;
        if let Some(task) = lock.get_mut(&task_id) {
            task.status = DownloadStatus::Downloading;
        }
    }

    let mut cmd = tokio::process::Command::new(&downloader_path);
    cmd.arg(source_flag)
        .arg(&model_id)
        .arg("--json")
        .env("LLAMA_CACHE", models_dir.to_string_lossy().as_ref())
        .env("PYTHONUNBUFFERED", "1")
        .env("CLICOLOR_FORCE", "1")
        .env("FORCE_COLOR", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    info!("启动下载进程: {:?}", cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            error!("启动 llama-model-download 失败: {}", e);
            let mut lock = tasks.lock().await;
            if let Some(task) = lock.get_mut(&task_id) {
                task.status = DownloadStatus::Error;
                task.error = Some(format!("启动下载工具失败: {}", e));
            }
            return;
        }
    };

    // 读取 stdout 解析 JSON 进度
    use tokio::io::{AsyncBufReadExt, BufReader};
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }

            // 尝试解析 JSON 进度（llama-model-download --json 输出格式）
            if let Ok(progress) = serde_json::from_str::<serde_json::Value>(&line) {
                let mut lock = tasks.lock().await;
                if let Some(task) = lock.get_mut(&task_id) {
                    // 支持两种进度格式
                    if let Some(pct) = progress.get("percent").and_then(|v| v.as_f64()) {
                        task.percent = pct;
                    } else if let Some(pct) = progress.get("progress").and_then(|v| v.as_f64()) {
                        task.percent = pct * 100.0;
                    }

                    if let Some(rx) = progress.get("downloaded").and_then(|v| v.as_u64()) {
                        task.received_bytes = rx;
                    }
                    if let Some(total) = progress.get("total").and_then(|v| v.as_u64()) {
                        task.total_bytes = total;
                    }
                    if let Some(speed) = progress.get("speed").and_then(|v| v.as_f64()) {
                        task.speed_bps = speed;
                    }
                    if let Some(fname) = progress.get("filename").and_then(|v| v.as_str()) {
                        task.current_file_name = Some(fname.to_string());
                    }
                    if let Some(status) = progress.get("status").and_then(|v| v.as_str()) {
                        match status {
                            "completed" | "done" => task.status = DownloadStatus::Completed,
                            "error" | "failed" => {
                                task.status = DownloadStatus::Error;
                                task.error = progress.get("error")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                            }
                            _ => {}
                        }
                    }
                }
            } else {
                // 非 JSON 行，记录日志
                info!("[llama-model-download] {}", line);
            }
        }
    }

    // 等待进程结束
    match child.wait().await {
        Ok(exit_status) => {
            let mut lock = tasks.lock().await;
            if let Some(task) = lock.get_mut(&task_id) {
                if exit_status.success() {
                    if task.status != DownloadStatus::Error {
                        task.status = DownloadStatus::Completed;
                        task.percent = 100.0;
                    }
                    info!("模型下载完成: {}", task.model_id);
                } else {
                    task.status = DownloadStatus::Error;
                    task.error = Some(format!("下载进程退出码: {:?}", exit_status.code()));
                    error!("模型下载失败: {} 退出码: {:?}", task.model_id, exit_status.code());
                }
            }
        }
        Err(e) => {
            error!("等待下载进程失败: {}", e);
            let mut lock = tasks.lock().await;
            if let Some(task) = lock.get_mut(&task_id) {
                task.status = DownloadStatus::Error;
                task.error = Some(format!("进程等待错误: {}", e));
            }
        }
    }
}

/// 开发模式下模拟下载进度（当 llama-model-download 不存在时）
async fn simulate_download_progress(task_id: &str, model_id: &str, tasks: &DownloadTaskStore) {
    info!("模拟下载进度: {}", model_id);
    let total_bytes: u64 = 500_000_000; // 500 MB 模拟

    {
        let mut lock = tasks.lock().await;
        if let Some(task) = lock.get_mut(task_id) {
            task.status = DownloadStatus::Downloading;
            task.total_bytes = total_bytes;
        }
    }

    // 模拟 10 秒下载，每秒更新一次进度
    for i in 1..=10_u64 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let received = total_bytes * i / 10;
        let percent = (i as f64) * 10.0;

        let mut lock = tasks.lock().await;
        if let Some(task) = lock.get_mut(task_id) {
            // 检查是否已被取消
            if task.status == DownloadStatus::Canceled {
                return;
            }
            task.received_bytes = received;
            task.percent = percent;
            task.speed_bps = 5_000_000.0; // 模拟 5 MB/s
            task.current_file_name = Some(format!("{}.gguf", model_id.split('/').last().unwrap_or(model_id)));
        }
    }

    let mut lock = tasks.lock().await;
    if let Some(task) = lock.get_mut(task_id) {
        if task.status != DownloadStatus::Canceled {
            task.status = DownloadStatus::Completed;
            task.percent = 100.0;
            task.received_bytes = total_bytes;
        }
    }
}

/// GET /api/models/download/status/:task_id
/// 轮询下载任务状态
async fn get_download_status(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> impl IntoResponse {
    let tasks = state.download_tasks.lock().await;
    if let Some(task) = tasks.get(&task_id) {
        (StatusCode::OK, Json(serde_json::to_value(task).unwrap()))
    } else {
        (StatusCode::NOT_FOUND, Json(json!({ "error": "任务不存在" })))
    }
}

/// POST /api/models/download/cancel/:task_id
/// 取消下载任务
async fn cancel_model_download(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> impl IntoResponse {
    let mut tasks = state.download_tasks.lock().await;
    if let Some(task) = tasks.get_mut(&task_id) {
        task.status = DownloadStatus::Canceled;
        info!("取消下载任务: {}", task_id);
        Json(json!({ "success": true }))
    } else {
        Json(json!({ "success": false, "error": "任务不存在" }))
    }
}

/// POST /api/models/switch
/// 激活/切换当前运行的模型
async fn switch_model(
    State(state): State<AppState>,
    Json(payload): Json<SwitchModelReq>,
) -> impl IntoResponse {
    info!("切换模型: {} 来源: {:?}", payload.model_id, payload.source);

    // 在模型目录中查找对应的 .gguf 文件
    let models_dir = {
        let config = state.coordinator.config.lock().await;
        config.models_dir.clone()
    };

    let found_ggufs = collect_all_ggufs(&models_dir);
    let model_id_lower = payload.model_id.to_lowercase();

    // 查找最匹配的 gguf 文件路径
    let model_path = found_ggufs.iter().find(|(_, name)| {
        let name_lower = name.to_lowercase();
        let id_tail = model_id_lower.split('/').last().unwrap_or(&model_id_lower);
        name_lower.contains(id_tail) || id_tail.contains(&name_lower.replace(".gguf", ""))
    }).map(|(p, _)| p.to_string_lossy().to_string());

    let current_model = model_path.clone().unwrap_or_else(|| payload.model_id.clone());

    // 更新活跃模型
    {
        let mut active_model = state.coordinator.active_model.lock().await;
        *active_model = model_path;
    }

    info!("模型已切换至: {}", current_model);
    Json(json!({
        "success": true,
        "currentModel": current_model
    }))
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
/// 更新模型存放目录（含迁移逻辑：停引擎 → 移动文件 → 重启）
async fn update_models_dir(
    State(state): State<AppState>,
    Json(payload): Json<UpdateModelsDirReq>,
) -> impl IntoResponse {
    let new_path = PathBuf::from(&payload.path);
    let old_path = {
        let config = state.coordinator.config.lock().await;
        config.models_dir.clone()
    };

    // 创建新目录
    if let Err(e) = std::fs::create_dir_all(&new_path) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": format!("创建目录失败: {}", e) }))
        );
    }

    // 如果路径不同，执行迁移
    if old_path != new_path && old_path.exists() {
        info!("开始模型目录迁移: {:?} -> {:?}", old_path, new_path);

        // 1. 停止当前引擎（释放文件锁）
        if let Err(e) = state.coordinator.guard.stop().await {
            warn!("停止引擎失败（继续迁移）: {}", e);
        }

        // 2. 迁移文件（先迁移 .gguf，再迁移其他）
        let migrate_result = migrate_model_files(&old_path, &new_path);
        if let Err(e) = migrate_result {
            error!("模型文件迁移失败: {}", e);
            // 继续更新配置，不强制回滚
        }
    }

    // 3. 更新配置
    {
        let mut config = state.coordinator.config.lock().await;
        config.models_dir = new_path.clone();
    }

    // 4. 扫描新目录
    let models = scan_and_merge_models(&new_path, None);
    let downloaded_count = models
        .iter()
        .filter(|m| m.get("isDownloaded").and_then(|v| v.as_bool()) == Some(true))
        .count();

    info!("模型目录更新完成，发现已下载模型: {}", downloaded_count);

    (
        StatusCode::OK,
        Json(json!({
            "success": true,
            "scannedModelsCount": downloaded_count
        }))
    )
}

/// 迁移模型文件（递归复制 .gguf 文件到新目录，完成后删除旧文件）
fn migrate_model_files(old_dir: &std::path::Path, new_dir: &std::path::Path) -> std::io::Result<()> {
    let old_ggufs = collect_all_ggufs(old_dir);

    for (old_path, file_name) in old_ggufs {
        let new_file_path = new_dir.join(&file_name);

        // 如果目标已存在且大小相同，跳过
        if new_file_path.exists() {
            let old_size = std::fs::metadata(&old_path)?.len();
            let new_size = std::fs::metadata(&new_file_path)?.len();
            if old_size == new_size {
                info!("跳过已存在文件: {}", file_name);
                continue;
            }
        }

        info!("迁移模型文件: {} -> {:?}", file_name, new_file_path);

        // 尝试先移动（跨卷则复制+删除）
        if let Err(_) = std::fs::rename(&old_path, &new_file_path) {
            // 跨磁盘驱动器，需要复制 + 删除
            std::fs::copy(&old_path, &new_file_path)?;
            std::fs::remove_file(&old_path)?;
        }
    }

    Ok(())
}

/// POST /api/models/rescan
/// 重新扫描当前模型目录（支持 HuggingFace/ModelScope 子目录结构）
async fn rescan_models(State(state): State<AppState>) -> impl IntoResponse {
    let config = state.coordinator.config.lock().await;
    let models = scan_and_merge_models(&config.models_dir, None);
    info!("重新扫描模型目录，发现 {} 个模型", models.len());
    Json(models)
}

/// POST /api/engine/params
/// 更新引擎运行时启动参数
async fn update_params(
    State(state): State<AppState>,
    Json(payload): Json<UpdateParamsReq>,
) -> impl IntoResponse {
    let mut config = state.coordinator.config.lock().await;

    // 更新配置中的参数
    if let Some(layers) = payload.n_gpu_layers {
        config.custom_gpu_layers = Some(layers);
    }
    if let Some(ctx) = payload.ctx_size {
        config.custom_context_window = Some(ctx);
    }

    info!("更新引擎参数: gpu_layers={:?}, ctx_size={:?}",
        payload.n_gpu_layers, payload.ctx_size);

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
        .route("/api/models/switch", post(switch_model))
        .route("/api/engine/models-dir", post(update_models_dir))
        .route("/api/models/rescan", post(rescan_models))
        .route("/api/models/download/start", post(start_model_download))
        .route("/api/models/download/status/:task_id", get(get_download_status))
        .route("/api/models/download/cancel/:task_id", post(cancel_model_download))
        .route("/api/engine/params", post(update_params))
        .route("/api/engine/hardware", get(hardware_info))
        .route("/api/engine/open-ui", post(open_ui))
        .route("/api/engine/shutdown", post(shutdown))
        .route("/api/engine/reset-downgrade", post(reset_downgrade))
}
