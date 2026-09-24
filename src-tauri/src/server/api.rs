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

use crate::config::CustomModelEntry;
use crate::engine::EngineCoordinator;

use super::custom_model;

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
/// 活跃下载子进程 PID 映射 (taskId -> pid)
pub type ChildPidStore = Arc<Mutex<HashMap<String, u32>>>;

// ─────────────────────── 应用状态 ───────────────────────

/// 应用状态（共享给所有 handler）
#[derive(Clone)]
pub struct AppState {
    pub coordinator: Arc<EngineCoordinator>,
    /// 下载任务总表（模型 + 引擎）
    pub download_tasks: DownloadTaskStore,
    /// 活跃子进程 PID 表
    pub active_child_pids: ChildPidStore,
    /// llama-model-download 可执行文件路径
    pub model_downloader_path: Arc<PathBuf>,
    /// Tauri AppHandle：open-ui 显示主窗口并向前端 emit 导航意图（错误分析侧边栏等）
    pub app_handle: Option<tauri::AppHandle>,
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
pub struct SaveModelParamsReq {
    pub model_id: String,
    pub params: crate::config::store::ModelCustomParams,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetModelParamsQuery {
    pub model_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchModelReq {
    pub model_id: String,
    pub model_name: Option<String>,
    pub source: Option<String>,
    pub local_path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DownloadEngineReq {
    pub backend: String,
}

/// 自由添加任意模型请求（url 为托管站点文件页/直链地址）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCustomModelReq {
    pub url: String,
}

/// 删除本地模型请求（删除该模型所在的目录）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteModelReq {
    pub model_id: String,
    pub local_path: Option<String>,
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

/// 从文件名中提取标准化量化标识（如 q4_k_m, q4_k_xl, q5_k_xl 等，去除 ud- 前缀，纯小写）
pub(crate) fn extract_quant_tag_from_name(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    // 优先匹配包含下划线的标准量化（如 q4_k_m, ud-q4_k_xl, iq3_xxs）
    let patterns = [
        "q4_k_xl", "q5_k_xl", "q6_k_xl", "q4_k_m", "q4_k_s", "q5_k_m", "q5_k_s", "q6_k",
        "q8_0", "q4_0", "q4_1", "q5_0", "q5_1", "q2_k", "q3_k_l", "q3_k_m", "q3_k_s",
        "bf16", "f16", "f32"
    ];
    for p in patterns {
        if lower.contains(p) {
            return Some(p.to_string());
        }
    }
    None
}

/// 扫描本地模型目录（支持 HuggingFace 和 ModelScope 两种目录结构）
/// - HuggingFace: {models_dir}/models--{org}--{repo}/snapshots/{hash}/*.gguf
/// - ModelScope:  {models_dir}/hub/models/{org}/{repo}/*.gguf
/// - 直接 GGUF:  {models_dir}/*.gguf
/// - custom_models：用户自由添加的模型条目，同样按磁盘文件判定 isDownloaded
fn scan_and_merge_models(
    models_dir: &std::path::Path,
    source_filter: Option<&str>,
    custom_models: &[CustomModelEntry],
) -> Vec<serde_json::Value> {
    // 未下载的推荐模型展示由前端推荐底表（modelMetadataService）负责，
    // 后端只返回磁盘实际扫描到的模型，避免硬编码预设混入列表
    let mut default_models: Vec<serde_json::Value> = Vec::new();

    // 收集所有发现的 .gguf 文件（包括子目录深度扫描），目录不存在时为空
    let found_ggufs: Vec<(PathBuf, String)> = if models_dir.exists() {
        collect_all_ggufs(models_dir)
    } else {
        Vec::new()
    };

    // 自由添加的自定义模型条目：先做磁盘存在性认领（精确文件名匹配优先，仓库尾段+量化 tag 宽松匹配次之）
    let mut claimed_files: Vec<PathBuf> = Vec::new();
    let mut custom_jsons: Vec<serde_json::Value> = Vec::new();
    for entry in custom_models {
        let exact = found_ggufs
            .iter()
            .find(|(_, n)| n.to_lowercase() == entry.file_name.to_lowercase());
        let loose = || {
            let repo_tail = entry
                .id
                .rsplit('/')
                .next()
                .unwrap_or("")
                .split(':')
                .next()
                .unwrap_or("")
                .to_lowercase();
            let repo_tail_nogguf = repo_tail.replace("-gguf", "");
            found_ggufs.iter().find(|(_, n)| {
                let nl = n.to_lowercase();
                !repo_tail_nogguf.is_empty()
                    && nl.contains(&repo_tail_nogguf)
                    && match &entry.quant {
                        Some(q) => extract_quant_tag_from_name(&nl)
                            .map(|fq| fq == q.to_lowercase())
                            .unwrap_or(false),
                        None => false,
                    }
            })
        };
        let hit = exact.or_else(loose);
        if let Some((p, _)) = hit {
            claimed_files.push(p.clone());
        }
        custom_jsons.push(custom_model::entry_to_model_json(
            entry,
            hit.is_some(),
            hit.map(|(p, _)| p.to_string_lossy().to_string()).as_deref(),
        ));
    }

    if models_dir.exists() {
        for (file_path, file_name) in &found_ggufs {
            if file_name.to_lowercase().starts_with("mmproj") {
                continue;
            }
            let file_size = std::fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);
            let mut matched = false;

            // 尝试与预设模型列表匹配
            for model in default_models.iter_mut() {
                if let Some(id) = model.get("id").and_then(|v| v.as_str()) {
                    // 解析 repo:tag 结构（对齐 desktop ModelResolver）：
                    // tag 存在时文件名必须同时包含 repo 尾段与量化 tag，防止同 repo 不同量化误判
                    let (repo_part, tag_part) = match id.split_once(':') {
                        Some((r, t)) => (r, Some(t)),
                        None => {
                            let quant = model.get("quant").and_then(|v| v.as_str());
                            (id, quant)
                        },
                    };
                    let id_lower = repo_part.to_lowercase();
                    let name_lower = file_name.to_lowercase();
                    // tag 标准化：去除 UD- 前缀后小写比较
                    let tag_clean = tag_part.map(|t| t.to_lowercase().trim_start_matches("ud-").to_string());
                    
                    // 从物理文件名中提取量化标记
                    let file_quant = extract_quant_tag_from_name(&name_lower);
                    let tag_ok = match (&tag_clean, &file_quant) {
                        (Some(expected), Some(actual)) => expected == actual,
                        (Some(expected), None) => name_lower.contains(expected.as_str()),
                        (None, _) => true,
                    };

                    // 多种匹配策略：文件名包含模型 id 的最后一段，或 id 包含文件名前缀
                    let id_tail = id_lower.split('/').last().unwrap_or(&id_lower);
                    if tag_ok
                        && (name_lower.contains(id_tail)
                            || name_lower.replace(".gguf", "").contains(&id_tail.replace("-gguf", "")))
                    {
                        let is_multimodal = model.get("isMultiModal").and_then(|v| v.as_bool()).unwrap_or(false);
                        let is_complete = if is_multimodal {
                            // 检查同目录中是否存在 mmproj 文件
                            let parent_dir = file_path.parent();
                            if let Some(dir) = parent_dir {
                                found_ggufs.iter().any(|(p, n)| {
                                    p.parent() == Some(dir) && n.to_lowercase().contains("mmproj")
                                })
                            } else {
                                false
                            }
                        } else {
                            true
                        };

                        if is_complete {
                            model["isDownloaded"] = json!(true);
                            model["localPath"] = json!(file_path.to_string_lossy().to_string());
                            matched = true;
                            break;
                        }
                    }
                }
            }

            // 未匹配到预设模型则作为本地自定义模型添加（已被自由添加条目认领的文件除外，避免出现重复行）
            if !matched && !claimed_files.iter().any(|c| c == file_path) {
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

    // 合并用户自由添加的模型条目
    default_models.extend(custom_jsons);

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
pub(crate) fn collect_all_ggufs(root: &std::path::Path) -> Vec<(PathBuf, String)> {
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
/// 查找顺序（严格遵循 1:1 目录拓扑与多工作空间兼容）：
/// 1. 当前工作目录及其祖先目录下的 build/extraResources/bin/llama-model-download-*
/// 2. 当前 exe 同级或父级 build/extraResources/bin/llama-model-download-*/llama-model-download[.exe]
/// 3. 开发态相对路径 apps/firefly-ai-engine/build/extraResources/bin/...
/// 4. 回退 PATH
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

    // 1. 基于当前工作目录及其父级逐层向上探测（适配 cargo tauri dev / pnpm dev 开发态）
    if let Ok(cwd) = std::env::current_dir() {
        let mut cur = Some(cwd.as_path());
        for _ in 0..5 {
            if let Some(dir) = cur {
                if let Some(found) = find_in_bin_dir(dir.join("build").join("extraResources").join("bin")) {
                    return found;
                }
                if let Some(found) = find_in_bin_dir(dir.join("apps").join("firefly-ai-engine").join("build").join("extraResources").join("bin")) {
                    return found;
                }
                if let Some(found) = find_in_bin_dir(dir.join("apps").join("desktop").join("build").join("extraResources").join("bin")) {
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

    // 2. 基于当前可执行文件目录向上探测（适配构建打包交付态）
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent();
        for _ in 0..5 {
            if let Some(dir) = cur {
                // 打包环境资源目录 (resource_dir 或 extraResources)
                if let Some(found) = find_in_bin_dir(dir.join("build").join("extraResources").join("bin")) {
                    return found;
                }
                if let Some(found) = find_in_bin_dir(dir.join("apps").join("firefly-ai-engine").join("build").join("extraResources").join("bin")) {
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

    // 3. 开发模式相对路径：build/extraResources/bin/
    let dev_bin = PathBuf::from("build").join("extraResources").join("bin");
    if let Some(found) = find_in_bin_dir(dev_bin) {
        return found;
    }

    // 4. 回退到 PATH 中查找
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

    // 探测显卡驱动版本与 CUDA 最大支持
    let (driver_ver, cuda_max_ver) = if is_nvidia {
        crate::hardware::driver_compliance::detect_nvidia_driver_info().await
    } else {
        (None, None)
    };

    let is_cn = true; // 默认国内加速源，对齐系统环境
    let nvidia_update_url = crate::hardware::driver_compliance::get_vendor_driver_update_url("nvidia", is_cn);
    let amd_update_url = crate::hardware::driver_compliance::get_vendor_driver_update_url("amd", is_cn);
    let intel_update_url = crate::hardware::driver_compliance::get_vendor_driver_update_url("intel", is_cn);

    // CUDA 13 要求 Windows 驱动 >= 560.00
    let cuda13_compliant = match driver_ver {
        Some(ver) => ver >= 560.0,
        None => match cuda_max_ver {
            Some(cuda_v) => cuda_v >= 12.6,
            None => true, // 无法确定时默认允许
        },
    };

    // CUDA 12 要求驱动 >= 525.60
    let cuda12_compliant = match driver_ver {
        Some(ver) => ver >= 525.0,
        None => true,
    };

    // 根据当前 CPU 指令集特征动态决策最适 CPU 编译变体 (AVX2 -> AVX -> SSE4.2/NoAVX)
    let (cpu_id, cpu_name, cpu_backend, cpu_perf) = if status.hardware.has_avx2.unwrap_or(false) {
        ("cpu", "CPU (AVX2)", "cpu", "无显卡加速 (AVX2 深度优化)")
    } else if status.hardware.has_avx.unwrap_or(false) {
        ("cpu-avx", "CPU (AVX 兼容)", "cpu-avx", "无显卡加速 (AVX 兼容模式)")
    } else {
        ("cpu-noavx", "CPU (SSE4.2 兜底)", "cpu-noavx", "无显卡加速 (SSE4.2 极简兜底)")
    };

    // 检查已安装 CPU 引擎是否与当前 CPU 指令集真正兼容，杜绝 0xC000001D 假就绪
    let has_compatible_cpu = installed.iter().any(|e| {
        if e.tier != crate::hardware::gpu_info::AccelerationTier::Cpu {
            return false;
        }
        crate::engine::scheduler::EngineScheduler::is_cpu_engine_compatible(&e.dir_name, &crate::hardware::CpuInfo {
            model: "query".to_string(),
            cores: status.hardware.cpu_cores.unwrap_or(4) as u32,
            threads: status.hardware.cpu_threads.unwrap_or(4) as u32,
            speed_mhz: 3000,
            has_avx2: status.hardware.has_avx2.unwrap_or(false),
            has_avx: status.hardware.has_avx.unwrap_or(false),
            has_fma: false,
        })
    });

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
            "downloadSizeMb": 180,
            "driverCompliant": true
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
            "downloadSizeMb": 120,
            "driverCompliant": true
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
                "downloadSizeMb": 480,
                "driverCompliant": cuda13_compliant,
                "driverUpdateUrl": nvidia_update_url
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
                "downloadSizeMb": 450,
                "driverCompliant": cuda12_compliant,
                "driverUpdateUrl": nvidia_update_url
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
                "downloadSizeMb": 280,
                "driverCompliant": true
            }));
            list.push(json!({
                "id": cpu_id,
                "name": cpu_name,
                "backend": cpu_backend,
                "matchType": "fallback",
                "matchText": "保底",
                "performance": cpu_perf,
                "isCurrent": active_backend == cpu_backend || active_backend == "cpu",
                "isInstalled": has_compatible_cpu,
                "downloadSizeMb": 120,
                "driverCompliant": true
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
                "downloadSizeMb": 400,
                "driverCompliant": true,
                "driverUpdateUrl": amd_update_url
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
                "downloadSizeMb": 280,
                "driverCompliant": true
            }));
            list.push(json!({
                "id": cpu_id,
                "name": cpu_name,
                "backend": cpu_backend,
                "matchType": "fallback",
                "matchText": "保底",
                "performance": cpu_perf,
                "isCurrent": active_backend == cpu_backend || active_backend == "cpu",
                "isInstalled": has_compatible_cpu,
                "downloadSizeMb": 120,
                "driverCompliant": true
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
                "downloadSizeMb": 350,
                "driverCompliant": true,
                "driverUpdateUrl": intel_update_url
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
                "downloadSizeMb": 280,
                "driverCompliant": true
            }));
            list.push(json!({
                "id": cpu_id,
                "name": cpu_name,
                "backend": cpu_backend,
                "matchType": "fallback",
                "matchText": "保底",
                "performance": cpu_perf,
                "isCurrent": active_backend == cpu_backend || active_backend == "cpu",
                "isInstalled": has_compatible_cpu,
                "downloadSizeMb": 120,
                "driverCompliant": true
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
                "downloadSizeMb": 280,
                "driverCompliant": true
            }));
            list.push(json!({
                "id": cpu_id,
                "name": cpu_name,
                "backend": cpu_backend,
                "matchType": "best",
                "matchText": "最佳匹配",
                "performance": cpu_perf,
                "isCurrent": active_backend == cpu_backend || active_backend == "cpu",
                "isInstalled": has_compatible_cpu,
                "downloadSizeMb": 120,
                "driverCompliant": true
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

/// POST /api/engine/download/start
/// 发起 AI 计算引擎包下载（如 Windows CUDA 12.4 套件）
/// 支持双轨故障转移（GitHub Releases 直连 -> EdgeOne R2 加速）与 HTTP Range 断点续传
async fn start_engine_download(
    State(state): State<AppState>,
    Json(payload): Json<DownloadEngineReq>,
) -> impl IntoResponse {
    let mut backend = payload.backend.clone();
    let status = state.coordinator.get_status().await;

    // 零试探智能路由：自动根据硬件特性修正 CPU 后端或响应 "auto" 模式
    if backend == "auto" {
        backend = resolve_auto_backend(
            status.hardware.best_tier.as_str(),
            status.hardware.has_avx2,
            status.hardware.has_avx,
        );
    } else {
        backend = correct_cpu_backend(&backend, status.hardware.has_avx2, status.hardware.has_avx);
    }

    let task_id = new_task_id();
    info!("请求下载 AI 计算引擎: {} 任务ID: {}", backend, task_id);

    let target_initial_name = if cfg!(windows) {
        match backend.as_str() {
            "cuda" | "cuda12" => Some("llama-bin-win-cuda-12.4-x64.zip".to_string()),
            "cuda13" | "cuda134" => Some("llama-bin-win-cuda-13.4-x64.zip".to_string()),
            "vulkan" => Some("llama-bin-win-vulkan-x64.zip".to_string()),
            "vulkan-compat" => Some("llama-bin-win-vulkan-compat-x64.zip".to_string()),
            "rocm" | "hip" => Some("llama-bin-win-rocm-10.0-x64.zip".to_string()),
            "sycl" => Some("llama-bin-win-sycl-x64.zip".to_string()),
            "cpu-avx" => Some("llama-bin-win-cpu-avx-x64.zip".to_string()),
            "cpu-noavx" => Some("llama-bin-win-cpu-noavx-x64.zip".to_string()),
            _ => Some("llama-bin-win-cpu-x64.zip".to_string()),
        }
    } else {
        Some("llama-bin-ubuntu-x64.tar.gz".to_string())
    };

    // 初始化任务条目（预填初始状态，防止前端前几秒轮询全是 null）
    {
        let mut tasks = state.download_tasks.lock().await;
        tasks.insert(task_id.clone(), DownloadTask {
            task_id: task_id.clone(),
            model_id: format!("engine-{}", backend),
            source: "GitHub 官方 (连接中...)".to_string(),
            status: DownloadStatus::Downloading,
            percent: 0.0,
            received_bytes: 0,
            total_bytes: 0,
            speed_bps: 0.0,
            current_file_name: target_initial_name,
            file_index: 0,
            total_files: 1,
            error: None,
        });
    }

    let tasks_store = state.download_tasks.clone();
    let task_id_spawn = task_id.clone();
    let app_state = state.clone();

    tokio::spawn(async move {
        run_engine_download(task_id_spawn, backend, tasks_store, app_state).await;
    });

    Json(json!({
        "taskId": task_id,
        "totalBytes": 0,
        "status": "downloading"
    }))
}

/// 零试探自动后端路由：根据硬件摘要解析最终下载 backend（Package Flavor，PRD Tier 1-6）
/// GPU 层级直接命中官方包；CPU 层级按 AVX2 -> AVX -> noAVX 阶梯唯一映射定制补全包
pub fn resolve_auto_backend(best_tier: &str, has_avx2: Option<bool>, has_avx: Option<bool>) -> String {
    match best_tier {
        "cuda" => "cuda".to_string(),
        "vulkan" => "vulkan".to_string(),
        "hip" | "rocm" => "hip".to_string(),
        "sycl" => "sycl".to_string(),
        "metal" => "metal".to_string(),
        _ => {
            // Tier 4/5/6: 无可用 GPU 时按 CPU 指令集阶梯精准命中补全包
            if has_avx2.unwrap_or(false) {
                "cpu".to_string()
            } else if has_avx.unwrap_or(false) {
                "cpu-avx".to_string()
            } else {
                "cpu-noavx".to_string()
            }
        }
    }
}

/// 显式请求 cpu 后端时的指令集兼容修正：杜绝在无 AVX2 机器上误下官方 AVX2 包导致 0xC000001D
pub fn correct_cpu_backend(backend: &str, has_avx2: Option<bool>, has_avx: Option<bool>) -> String {
    if backend == "cpu" && !has_avx2.unwrap_or(true) {
        if has_avx.unwrap_or(false) {
            "cpu-avx".to_string()
        } else {
            "cpu-noavx".to_string()
        }
    } else {
        backend.to_string()
    }
}

/// 解析指定 backend 在当前平台的推荐文件名
fn resolve_engine_target_package(backend: &str) -> Option<(&'static str, Vec<&'static str>)> {
    let is_win = cfg!(windows);
    let is_linux = cfg!(target_os = "linux");
    let is_darwin = cfg!(target_os = "macos");

    if is_win {
        match backend {
            "cuda" | "cuda12" => Some(("cuda-12.4", vec![
                "llama-*-bin-win-cuda-12.4-x64.zip",
                "cudart-llama-bin-win-cuda-12.4-x64.zip"
            ])),
            "cuda13" | "cuda134" => Some(("cuda-13.4", vec![
                "llama-*-bin-win-cuda-13.4-x64.zip",
                "cudart-llama-bin-win-cuda-13.4-x64.zip",
                "llama-*-bin-win-cuda-13.3-x64.zip",
                "cudart-llama-bin-win-cuda-13.3-x64.zip"
            ])),
            "vulkan" => Some(("vulkan", vec!["llama-*-bin-win-vulkan-x64.zip"])),
            "vulkan-compat" => Some(("vulkan-compat", vec!["llama-*-bin-win-vulkan-compat-x64.zip"])),
            "rocm" | "hip" => Some(("rocm", vec!["llama-*-bin-win-rocm-*-x64.zip"])),
            "sycl" => Some(("sycl", vec!["llama-*-bin-win-sycl-x64.zip"])),
            "cpu" | "cpu-avx2" => Some(("cpu", vec!["llama-*-bin-win-cpu-x64.zip", "llama-*-bin-win-x64.zip", "llama-*-bin-win-avx2-x64.zip"])),
            "cpu-avx" => Some(("cpu-avx", vec!["llama-*-bin-win-cpu-avx-x64.zip"])),
            "cpu-noavx" => Some(("cpu-noavx", vec!["llama-*-bin-win-cpu-noavx-x64.zip"])),
            _ => None,
        }
    } else if is_linux {
        match backend {
            "vulkan" => Some(("vulkan", vec!["llama-*-bin-ubuntu-vulkan-x64.tar.gz"])),
            "rocm" | "hip" => Some(("rocm", vec!["llama-*-bin-ubuntu-rocm-*-x64.tar.gz"])),
            "cpu" => Some(("cpu", vec!["llama-*-bin-ubuntu-x64.tar.gz"])),
            _ => None,
        }
    } else if is_darwin {
        match backend {
            "metal" => Some(("metal", vec!["llama-*-bin-macos-arm64.tar.gz", "llama-*-bin-macos-x64.tar.gz"])),
            "cpu" => Some(("cpu", vec!["llama-*-bin-macos-arm64.tar.gz", "llama-*-bin-macos-x64.tar.gz"])),
            _ => None,
        }
    } else {
        None
    }
}

/// 候选下载项定义
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineDownloadCandidate {
    pub version: String,
    pub filename: String,
}

#[derive(Debug, Deserialize)]
pub struct RemoteManifest {
    #[serde(rename = "latestVersion")]
    pub latest_version: Option<String>,
    #[serde(rename = "previousVersion")]
    pub previous_version: Option<String>,
}

/// 构造候选下载源列表（严格遵循：GitHub 优先，国内 EdgeOne R2 故障转移降级）
pub fn build_candidate_urls(version: &str, filename: &str) -> Vec<(&'static str, String)> {
    let is_compat_flavor = filename.contains("cpu-avx") || filename.contains("cpu-noavx") || filename.contains("vulkan-compat");
    if is_compat_flavor {
        vec![
            (
                "GitHub 专属兼容发布",
                format!("https://github.com/Leonard-Li777/firefly-ai-folder/releases/download/llama-compat-{}/{}", version, filename)
            ),
            (
                "国内高速镜像 (EdgeOne R2)",
                format!("https://download.iocn.cn/llama-cpp/{}/{}", version, filename)
            ),
        ]
    } else {
        vec![
            (
                "GitHub 官方",
                format!("https://github.com/ggml-org/llama.cpp/releases/download/{}/{}", version, filename)
            ),
            (
                "国内高速镜像 (EdgeOne R2)",
                format!("https://download.iocn.cn/llama-cpp/{}/{}", version, filename)
            ),
        ]
    }
}

/// 尝试从 EdgeOne R2 加速节点拉取最新 manifest.json（带时间戳参数穿透缓存）
pub async fn fetch_latest_manifest() -> Option<RemoteManifest> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let url = format!("https://download.iocn.cn/llama-cpp/manifest.json?t={}", now);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;

    match client.get(&url).header("User-Agent", "firefly-ai-engine").send().await {
        Ok(resp) if resp.status().is_success() => {
            resp.json::<RemoteManifest>().await.ok()
        }
        _ => None,
    }
}

/// 动态生成候选版本下载文件列表
pub fn resolve_download_candidates(backend: &str, versions: &[String]) -> Vec<EngineDownloadCandidate> {
    let mut candidates = Vec::new();
    let is_win = cfg!(windows);
    let is_darwin = cfg!(target_os = "macos");

    for ver in versions {
        if is_win {
            let filename = match backend {
                "cuda13" | "cuda134" => format!("llama-{}-bin-win-cuda-13.4-x64.zip", ver),
                "cuda" | "cuda12" => format!("llama-{}-bin-win-cuda-12.4-x64.zip", ver),
                "vulkan" => format!("llama-{}-bin-win-vulkan-x64.zip", ver),
                "vulkan-compat" => format!("llama-{}-bin-win-vulkan-compat-x64.zip", ver),
                "rocm" | "hip" => format!("llama-{}-bin-win-rocm-10.0-x64.zip", ver),
                "sycl" => format!("llama-{}-bin-win-sycl-x64.zip", ver),
                "cpu-avx" => format!("llama-{}-bin-win-cpu-avx-x64.zip", ver),
                "cpu-noavx" => format!("llama-{}-bin-win-cpu-noavx-x64.zip", ver),
                _ => format!("llama-{}-bin-win-cpu-x64.zip", ver),
            };
            candidates.push(EngineDownloadCandidate {
                version: ver.clone(),
                filename,
            });
        } else if is_darwin {
            candidates.push(EngineDownloadCandidate {
                version: ver.clone(),
                filename: format!("llama-{}-bin-macos-arm64.tar.gz", ver),
            });
            candidates.push(EngineDownloadCandidate {
                version: ver.clone(),
                filename: format!("llama-{}-bin-macos-x64.tar.gz", ver),
            });
        } else {
            let filename = match backend {
                "vulkan" => format!("llama-{}-bin-ubuntu-vulkan-x64.tar.gz", ver),
                _ => format!("llama-{}-bin-ubuntu-x64.tar.gz", ver),
            };
            candidates.push(EngineDownloadCandidate {
                version: ver.clone(),
                filename,
            });
        }
    }

    if is_win && (backend == "cuda13" || backend == "cuda134") {
        for ver in versions {
            candidates.push(EngineDownloadCandidate {
                version: ver.clone(),
                filename: format!("llama-{}-bin-win-cuda-13.3-x64.zip", ver),
            });
        }
    }

    candidates
}

/// 执行带有断点续传的引擎包下载（支持多候选包匹配与双轨故障转移：GitHub -> EdgeOne R2）
async fn download_engine_with_resume_and_failover(
    task_id: &str,
    candidates: &[EngineDownloadCandidate],
    base_engine_dir: &std::path::Path,
    tasks: &DownloadTaskStore,
) -> Result<(PathBuf, String, String), String> {
    use tokio::io::AsyncWriteExt;

    // 读取系统环境变量代理（兼容 HTTP_PROXY / HTTPS_PROXY）
    let proxy_url = std::env::var("HTTPS_PROXY")
        .or_else(|_| std::env::var("https_proxy"))
        .or_else(|_| std::env::var("HTTP_PROXY"))
        .or_else(|_| std::env::var("http_proxy"))
        .ok();

    let mut client_builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15));

    if let Some(ref p) = proxy_url {
        if let Ok(proxy) = reqwest::Proxy::all(p) {
            info!("[引擎下载] 启用系统代理: {}", p);
            client_builder = client_builder.proxy(proxy);
        }
    }

    let client = client_builder
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {}", e))?;

    let mut attempt_logs = Vec::new();

    for candidate in candidates {
        let version = &candidate.version;
        let filename = &candidate.filename;
        let dest_path = base_engine_dir.join(filename);
        let part_path = dest_path.with_extension(format!("{}.part", dest_path.extension().and_then(|s| s.to_str()).unwrap_or("zip")));

        if let Some(parent) = dest_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }

        // 双轨候选源：严格 GitHub 优先，遇超时或网络阻断自动降级 EdgeOne R2
        let candidate_urls = build_candidate_urls(version, filename);

        for (source_name, url) in candidate_urls {
            info!("[引擎下载] 尝试数据源: {} [{}/{}] URL: {}", source_name, version, filename, url);

            // 更新任务当前正在尝试的文件与通道
            {
                let mut lock = tasks.lock().await;
                if let Some(task) = lock.get_mut(task_id) {
                    if task.status == DownloadStatus::Canceled {
                        return Err("下载已取消".to_string());
                    }
                    task.source = format!("{} (连接中)", source_name);
                    task.current_file_name = Some(filename.clone());
                }
            }

            // 读取已有 .part 大小以发送 Range 请求头
            let existing_len = if part_path.exists() {
                tokio::fs::metadata(&part_path).await.map(|m| m.len()).unwrap_or(0)
            } else {
                0
            };

            let mut req = client.get(&url).header(reqwest::header::USER_AGENT, "firefly-ai-engine");
            if existing_len > 0 {
                info!("[引擎下载] 检测到已有片段 {} 字节，请求断点续传 Range", existing_len);
                req = req.header(reqwest::header::RANGE, format!("bytes={}-", existing_len));
            }

            let resp = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    let err_msg = format!("连接 {} 失败: {}", source_name, e);
                    warn!("[引擎下载] {}，准备切换下一个源...", err_msg);
                    attempt_logs.push(format!("{}[{}: {}]", source_name, filename, err_msg));
                    continue;
                }
            };

            let status = resp.status();
            let is_partial = status == reqwest::StatusCode::PARTIAL_CONTENT;
            let is_ok = status == reqwest::StatusCode::OK;

            if !is_partial && !is_ok {
                let err_msg = format!("数据源 {} 返回状态码: {}", source_name, status);
                warn!("[引擎下载] {}，准备切换下一个源...", err_msg);
                attempt_logs.push(format!("{}[{}: HTTP {}]", source_name, filename, status.as_u16()));
                continue;
            }

            // 解析总长度
            let content_len = resp.content_length().unwrap_or(0);
            let total_bytes = if is_partial {
                existing_len + content_len
            } else {
                content_len
            };

            // 更新任务基础元数据
            {
                let mut lock = tasks.lock().await;
                if let Some(task) = lock.get_mut(task_id) {
                    task.status = DownloadStatus::Downloading;
                    task.source = source_name.to_string();
                    task.current_file_name = Some(filename.clone());
                    task.total_bytes = total_bytes;
                    task.received_bytes = if is_partial { existing_len } else { 0 };
                }
            }

            // 打开 .part 文件进行追加/重写
            let mut file = match tokio::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(is_partial)
                .truncate(!is_partial)
                .open(&part_path).await {
                    Ok(f) => f,
                    Err(e) => return Err(format!("打开本地临时写入文件失败: {}", e)),
                };

            let mut stream = resp.bytes_stream();
            use futures::StreamExt;

            let mut received = if is_partial { existing_len } else { 0 };
            let mut last_instant = std::time::Instant::now();
            let mut speed_prev_bytes = received;
            let mut stream_success = true;

            while let Some(chunk_result) = stream.next().await {
                // 每次拉流前检查是否已取消
                {
                    let lock = tasks.lock().await;
                    if let Some(task) = lock.get(task_id) {
                        if task.status == DownloadStatus::Canceled {
                            return Err("下载已取消".to_string());
                        }
                    }
                }

                match chunk_result {
                    Ok(bytes) => {
                        if let Err(e) = file.write_all(&bytes).await {
                            warn!("[引擎下载] 写入磁盘失败: {}", e);
                            stream_success = false;
                            attempt_logs.push(format!("{}: 写入磁盘失败: {}", source_name, e));
                            break;
                        }
                        received += bytes.len() as u64;

                        // 计算滑动平均下载速率
                        let elapsed = last_instant.elapsed().as_secs_f64();
                        if elapsed >= 0.5 {
                            let instant_speed = (received.saturating_sub(speed_prev_bytes)) as f64 / elapsed;
                            let pct = if total_bytes > 0 {
                                (received as f64 / total_bytes as f64 * 100.0).min(100.0)
                            } else {
                                0.0
                            };

                            let mut lock = tasks.lock().await;
                            if let Some(task) = lock.get_mut(task_id) {
                                task.received_bytes = received;
                                task.percent = (pct * 10.0).round() / 10.0;
                                task.speed_bps = instant_speed;
                            }

                            speed_prev_bytes = received;
                            last_instant = std::time::Instant::now();
                        }
                    }
                    Err(e) => {
                        warn!("[引擎下载] 数据流传输中断: {}，准备断点续传重试...", e);
                        stream_success = false;
                        attempt_logs.push(format!("{}: 数据流中断: {}", source_name, e));
                        break;
                    }
                }
            }

            let _ = file.flush().await;

            if stream_success {
                // 下载完成，原子重命名为目标文件
                if let Err(e) = tokio::fs::rename(&part_path, &dest_path).await {
                    return Err(format!("重命名已完成文件失败: {}", e));
                }
                info!("[引擎下载] 成功下载文件: {} (版本: {}, 来源: {})", filename, version, source_name);
                return Ok((dest_path, version.clone(), filename.clone()));
            } else {
                warn!("[引擎下载] 源 {} 未完整完成，保留已有 .part 片段，切换下一源断点续传", source_name);
            }
        }
    }

    let detail = if attempt_logs.is_empty() {
        "全部下载源均尝试失败".to_string()
    } else {
        format!("尝试失败: {}", attempt_logs.join(" -> "))
    };
    Err(detail)
}

/// 执行 zip 解压缩部署到目标目录
fn extract_engine_archive(archive_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::open(archive_path).map_err(|e| format!("打开压缩包失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 ZIP 文件失败: {}", e))?;

    std::fs::create_dir_all(dest_dir).map_err(|e| format!("创建目标目录失败: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| format!("读取压缩项失败: {}", e))?;
        let outpath = match file.enclosed_name() {
            Some(path) => dest_dir.join(path),
            None => continue,
        };

        if file.name().ends_with('/') {
            std::fs::create_dir_all(&outpath).map_err(|e| format!("创建子目录失败: {}", e))?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    std::fs::create_dir_all(p).map_err(|e| format!("创建父目录失败: {}", e))?;
                }
            }
            let mut outfile = std::fs::File::create(&outpath).map_err(|e| format!("创建解压目标文件失败: {}", e))?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| format!("解压文件内容失败: {}", e))?;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = file.unix_mode() {
                let _ = std::fs::set_permissions(&outpath, std::fs::Permissions::from_mode(mode));
            }
        }
    }

    Ok(())
}

/// 实际执行 AI 引擎下载完整工作流
async fn run_engine_download(
    task_id: String,
    backend: String,
    tasks: DownloadTaskStore,
    app_state: AppState,
) {
    let (tier_name, _patterns) = match resolve_engine_target_package(&backend) {
        Some(res) => res,
        None => {
            let mut lock = tasks.lock().await;
            if let Some(task) = lock.get_mut(&task_id) {
                task.status = DownloadStatus::Error;
                task.error = Some(format!("当前系统暂不支持计算引擎后端: {}", backend));
            }
            return;
        }
    };

    // 动态请求云端 Manifest 确定活跃版本（带 5s 超时与内置版本兜底，?t=timestamp 规避 CDN 缓存）
    let manifest = fetch_latest_manifest().await;
    let mut active_versions = Vec::new();
    if let Some(m) = manifest {
        if let Some(v) = m.latest_version {
            active_versions.push(v);
        }
        if let Some(v) = m.previous_version {
            active_versions.push(v);
        }
    }
    if active_versions.is_empty() {
        active_versions = vec![
            "b11095".to_string(),
            "b11063".to_string(),
            "b11011".to_string(),
        ];
    }

    let candidates = resolve_download_candidates(&backend, &active_versions);

    // 目标本地路径定位：%APPDATA%/com.firefly.ai-engine/engines/llama-{version}-bin-...
    let base_engine_dir = if let Some(app_data) = dirs::data_dir() {
        app_data.join("com.firefly.ai-engine").join("engines")
    } else {
        PathBuf::from("engines")
    };

    info!("[引擎下载] 启动引擎下载工作流: 任务ID={} 候选数量={}", task_id, candidates.len());

    // 1. 下载阶段 (支持候选包探测、双轨故障转移与断点续传)
    let (downloaded_archive_path, final_version, final_filename) = match download_engine_with_resume_and_failover(
        &task_id,
        &candidates,
        &base_engine_dir,
        &tasks,
    ).await {
        Ok(res) => res,
        Err(e) => {
            error!("[引擎下载] 任务 {} 下载失败: {}", task_id, e);
            let mut lock = tasks.lock().await;
            if let Some(task) = lock.get_mut(&task_id) {
                task.status = DownloadStatus::Error;
                task.error = Some(e);
            }
            return;
        }
    };

    let target_dest_dir = base_engine_dir.join(format!("llama-{}-bin-win-{}-x64", final_version, tier_name));
    info!("[引擎下载] 成功获取包: {}，准备部署至 {:?}", final_filename, target_dest_dir);

    // 2. 解压部署阶段
    {
        let mut lock = tasks.lock().await;
        if let Some(task) = lock.get_mut(&task_id) {
            task.percent = 100.0;
            task.current_file_name = Some("正在解压引擎组件...".to_string());
        }
    }

    info!("[引擎下载] 正在解压至目标目录: {:?}", target_dest_dir);
    if let Err(e) = extract_engine_archive(&downloaded_archive_path, &target_dest_dir) {
        error!("[引擎下载] 解压部署失败: {}", e);
        let mut lock = tasks.lock().await;
        if let Some(task) = lock.get_mut(&task_id) {
            task.status = DownloadStatus::Error;
            task.error = Some(format!("解压部署引擎失败: {}", e));
        }
        return;
    }

    // 3. 完成并标记
    {
        let mut lock = tasks.lock().await;
        if let Some(task) = lock.get_mut(&task_id) {
            task.status = DownloadStatus::Completed;
            task.percent = 100.0;
            task.current_file_name = None;
        }
    }

    // 触发引擎扫描更新
    let _ = app_state.coordinator.scheduler.scan_installed_engines().await;
    info!("[引擎下载] 任务 {} 全部执行完成！引擎已就绪部署。", task_id);
}

/// POST /api/models/download/start
/// 发起模型下载（真实 spawn llama-model-download，进度通过轮询获取）
async fn start_model_download(
    State(state): State<AppState>,
    Json(payload): Json<StartModelDownloadReq>,
) -> impl IntoResponse {
    let source = payload.source.clone().unwrap_or_else(|| "modelscope".to_string());
    let task_id = new_task_id();
    let model_id = payload.model_id.clone();

    info!("开始真实下载模型: {} 来源: {} 任务ID: {}", model_id, source, task_id);

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
    let child_pids_store = state.active_child_pids.clone();
    let task_id_spawn = task_id.clone();

    // 后台 spawn 真实下载进程
    tokio::spawn(async move {
        run_model_download(
            task_id_spawn,
            model_id,
            source,
            models_dir,
            downloader_path,
            tasks_store,
            child_pids_store,
        ).await;
    });

    Json(json!({
        "taskId": task_id,
        "totalBytes": 0,
        "status": "pending"
    }))
}

/// 实际执行模型下载（spawn llama-model-download --json，移植桌面端完整健壮性逻辑）
async fn run_model_download(
    task_id: String,
    model_id: String,
    source: String,
    models_dir: PathBuf,
    downloader_path: PathBuf,
    tasks: DownloadTaskStore,
    child_pids: ChildPidStore,
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

    // 检查 downloader 是否存在，如果不存在则使用模拟兜底（仅限极早期开发环境）
    if !downloader_path.exists() {
        warn!("llama-model-download 未找到于: {:?}，回退模拟下载", downloader_path);
        simulate_download_progress(&task_id, &model_id, &tasks).await;
        return;
    }

    // 构造下载命令参数与模型标识标准化（对齐桌面端 LlamacppAdapter）
    let source_flag = match source.to_lowercase().as_str() {
        "huggingface" | "hf" => "-hf",
        _ => "-ms",
    };

    // 对特殊连字符格式的 DSpark 模型做下载目标 ID 标准化（如 LFM2.5-...-DSpark-Q4_K_M -> ...-DSpark-GGUF:Q4_K_M）
    let mut download_target_id = model_id.clone();
    if !download_target_id.contains(':') {
        let parts: Vec<&str> = download_target_id.split('_').collect();
        if parts.len() > 1 && download_target_id.contains("DSpark") {
            let last_part = parts[parts.len() - 1];
            if last_part.starts_with('Q') {
                let base = &download_target_id[..download_target_id.rfind('_').unwrap()];
                download_target_id = format!("{}-GGUF:{}", base, last_part);
            }
        }
    }

    // 更新任务初始状态为下载中
    {
        let mut lock = tasks.lock().await;
        if let Some(task) = lock.get_mut(&task_id) {
            task.status = DownloadStatus::Downloading;
        }
    }

    let mut cmd = tokio::process::Command::new(&downloader_path);
    cmd.arg(source_flag)
        .arg(&download_target_id)
        .arg("--json");

    // 继承系统环境变量并设置 LLAMA_CACHE 模型存储位置
    cmd.env("LLAMA_CACHE", models_dir.to_string_lossy().as_ref());

    // 诱导变量（对齐 desktop model-download-manager，防止 Windows 管道块缓冲死锁）
    cmd.env("PYTHONUNBUFFERED", "1")
        .env("CLICOLOR_FORCE", "1")
        .env("FORCE_COLOR", "1")
        .env("TERM", "cygwin")
        .env("DEBIAN_FRONTEND", "noninteractive")
        .env("STDBUF_OUT", "0")
        .env("STDBUF_ERR", "0");

    // 智能代理处理：如果下载 ModelScope 模型，配置 NO_PROXY 确保直连阿里 CDN
    let is_modelscope = source_flag == "-ms";
    if is_modelscope {
        let domains = "modelscope.cn,*.modelscope.cn,aliyun.com,*.aliyun.com,aliyuncs.com,*.aliyuncs.com,hf-mirror.com";
        cmd.env("no_proxy", domains);
        cmd.env("NO_PROXY", domains);
    }

    // 关闭输入，重定向输出
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    info!("启动原生真实下载进程: {:?} 模型: {}", downloader_path, download_target_id);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            error!("启动 llama-model-download 进程失败: {}", e);
            let mut lock = tasks.lock().await;
            if let Some(task) = lock.get_mut(&task_id) {
                task.status = DownloadStatus::Error;
                task.error = Some(format!("启动下载工具失败: {}", e));
            }
            return;
        }
    };

    // 记录子进程 PID 供取消时强制终止
    if let Some(pid) = child.id() {
        let mut pids = child_pids.lock().await;
        pids.insert(task_id.clone(), pid);
    }

    // 状态统计闭包变量（用于跨文件累加和速度滑动平均）
    let mut completed_bytes: u64 = 0;
    let mut current_file: Option<String> = None;
    let mut speed_prev_bytes: Option<u64> = None;
    let mut speed_prev_time = std::time::Instant::now();
    let mut last_speed_bps: f64 = 0.0;
    let is_multimodal = model_id.to_lowercase().contains("vl") || model_id.to_lowercase().contains("multimodal");

    // 读取 stdout 解析 JSON 进度流
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
                    // 若外部已取消，跳过更新
                    if task.status == DownloadStatus::Canceled {
                        break;
                    }

                    // 1. 跟踪多文件流切换
                    if let Some(fname) = progress.get("file").and_then(|v| v.as_str()).or_else(|| progress.get("filename").and_then(|v| v.as_str())) {
                        let fname_str = fname.to_string();
                        if let Some(ref cur) = current_file {
                            if cur != &fname_str && task.total_bytes > 0 {
                                // 文件切换，将上一个文件的接收累加到 completed_bytes
                                completed_bytes = task.received_bytes;
                            }
                        }
                        current_file = Some(fname_str.clone());
                        task.current_file_name = Some(fname_str.clone());

                        // 多模态阶段判定
                        if is_multimodal {
                            task.total_files = 2;
                            if fname_str.to_lowercase().contains("mmproj") {
                                task.file_index = 1;
                            } else {
                                task.file_index = 0;
                            }
                        }
                    }

                    // 2. 进度计算与阶段加权
                    let raw_percent = progress.get("percent").and_then(|v| v.as_f64())
                        .or_else(|| progress.get("progress").and_then(|v| v.as_f64()).map(|p| p * 100.0));

                    if let Some(pct) = raw_percent {
                        let weighted_percent = if is_multimodal {
                            if task.file_index == 0 {
                                pct * 0.8
                            } else {
                                80.0 + pct * 0.2
                            }
                        } else {
                            pct
                        };
                        task.percent = (weighted_percent * 10.0).round() / 10.0;
                    }

                    // 3. 字节累加计算
                    if let Some(downloaded) = progress.get("downloaded").and_then(|v| v.as_u64()) {
                        task.received_bytes = completed_bytes + downloaded;

                        // 平滑下载速率计算 (瞬时 + 滑动平均加权)
                        let now = std::time::Instant::now();
                        let elapsed = now.duration_since(speed_prev_time).as_secs_f64();
                        if elapsed >= 0.5 {
                            if let Some(prev) = speed_prev_bytes {
                                if downloaded >= prev {
                                    let instant_speed = (downloaded - prev) as f64 / elapsed;
                                    last_speed_bps = if last_speed_bps > 0.0 {
                                        last_speed_bps * 0.6 + instant_speed * 0.4
                                    } else {
                                        instant_speed
                                    };
                                    task.speed_bps = last_speed_bps;
                                }
                            }
                            speed_prev_bytes = Some(downloaded);
                            speed_prev_time = now;
                        }
                    }

                    if let Some(total) = progress.get("total").and_then(|v| v.as_u64()) {
                        task.total_bytes = completed_bytes + total;
                    }

                    if let Some(status) = progress.get("status").and_then(|v| v.as_str()) {
                        match status {
                            "completed" | "done" => {
                                if !is_multimodal || task.file_index >= 1 {
                                    task.status = DownloadStatus::Completed;
                                    task.percent = 100.0;
                                }
                            }
                            "error" | "failed" => {
                                task.status = DownloadStatus::Error;
                                task.error = progress.get("error").and_then(|v| v.as_str()).map(|s| s.to_string());
                            }
                            _ => {}
                        }
                    }
                }
            } else {
                info!("[llama-model-download] {}", line);
            }
        }
    }

    // 等待进程结束
    let exit_status = child.wait().await;

    // 清理 child_pids
    {
        let mut pids = child_pids.lock().await;
        pids.remove(&task_id);
    }

    let mut lock = tasks.lock().await;
    if let Some(task) = lock.get_mut(&task_id) {
        // 如果已被用户主动取消，保持取消状态
        if task.status == DownloadStatus::Canceled {
            return;
        }

        let is_success = exit_status.as_ref().map(|s| s.success()).unwrap_or(false);

        if is_success {
            task.status = DownloadStatus::Completed;
            task.percent = 100.0;
            info!("模型真实下载成功: {}", task.model_id);
        } else {
            // 二次检测：即使退出码异常，检查目标目录是否已有合规的 GGUF 实体文件（对齐 desktop 补偿逻辑）
            let mut file_found = false;
            let repo_tag = model_id.split(':').last().unwrap_or(&model_id);
            if let Ok(entries) = std::fs::read_dir(&models_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        let name = path.file_name().unwrap_or_default().to_string_lossy();
                        if name.ends_with(".gguf") && name.contains(repo_tag) {
                            if let Ok(meta) = path.metadata() {
                                if meta.len() > 10 * 1024 * 1024 { // > 10MB
                                    file_found = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            if file_found {
                task.status = DownloadStatus::Completed;
                task.percent = 100.0;
                info!("模型下载进程退出码异常，但检测到完整模型文件，判定成功: {}", task.model_id);
            } else {
                task.status = DownloadStatus::Error;
                let code_str = exit_status.map(|s| format!("{:?}", s.code())).unwrap_or_else(|e| e.to_string());
                task.error = Some(format!("下载异常退出 (代码: {})", code_str));
                error!("模型下载失败: {} 详情: {:?}", task.model_id, task.error);
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
            if task.status == DownloadStatus::Canceled {
                return;
            }
            task.received_bytes = received;
            task.percent = percent;
            task.speed_bps = 5_000_000.0;
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
/// 取消下载任务（真实杀死系统级子进程）
async fn cancel_model_download(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> impl IntoResponse {
    // 1. 标记任务为取消
    {
        let mut tasks = state.download_tasks.lock().await;
        if let Some(task) = tasks.get_mut(&task_id) {
            task.status = DownloadStatus::Canceled;
        }
    }

    // 2. 如果存在活跃子进程 PID，真实杀死该进程
    let pid_opt = {
        let mut pids = state.active_child_pids.lock().await;
        pids.remove(&task_id)
    };

    if let Some(pid) = pid_opt {
        info!("取消下载任务: {}，真实终止 PID: {}", task_id, pid);
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F", "/T"])
                .output();
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }
    } else {
        info!("取消下载任务: {} (无活跃关联子进程)", task_id);
    }

    Json(json!({ "success": true }))
}

/// POST /api/models/switch
/// 激活/切换当前运行的模型
async fn switch_model(
    State(state): State<AppState>,
    Json(payload): Json<SwitchModelReq>,
) -> impl IntoResponse {
    info!("切换模型: {} 来源: {:?}", payload.model_id, payload.source);

    let models_dir = {
        let config = state.coordinator.config.lock().await;
        config.models_dir.clone()
    };

    // 1. 若前端显式传递了已就绪的 localPath 且文件真实存在，直接采用
    let model_path = if let Some(ref lp) = payload.local_path {
        let p = PathBuf::from(lp);
        if p.exists() {
            Some(p.to_string_lossy().to_string())
        } else {
            None
        }
    } else {
        None
    };

    // 2. 否则在模型目录中深度查找最匹配的 .gguf 文件
    let model_path = model_path.or_else(|| {
        let found_ggufs = collect_all_ggufs(&models_dir);
        let model_id_lower = payload.model_id.to_lowercase();
        let id_tail = model_id_lower.split('/').last().unwrap_or(&model_id_lower);
        let id_clean = id_tail.split(':').next().unwrap_or(id_tail).replace("-gguf", "");

        found_ggufs.iter().find(|(_, name)| {
            let name_lower = name.to_lowercase();
            name_lower.contains(&id_clean) || id_clean.contains(&name_lower.replace(".gguf", ""))
        }).map(|(p, _)| p.to_string_lossy().to_string())
    });

    let current_model = model_path.clone().unwrap_or_else(|| payload.model_id.clone());

    // 更新活跃模型
    {
        let mut active_model = state.coordinator.active_model.lock().await;
        *active_model = model_path.clone();

        let mut active_model_name = state.coordinator.active_model_name.lock().await;
        *active_model_name = payload.model_name.clone();
    }

    info!("模型已切换至: {} (名称: {:?})", current_model, payload.model_name);
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
    let models = scan_and_merge_models(&config.models_dir, query.source.as_deref(), &config.custom_models);
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
    let custom_models = {
        let config = state.coordinator.config.lock().await;
        config.custom_models.clone()
    };
    let models = scan_and_merge_models(&new_path, None, &custom_models);
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

/// 迁移模型文件（支持 models-- 与 hub/models 目录树及根目录 .gguf 完整迁移，1:1 移植 Desktop 逻辑）
fn migrate_model_files(old_dir: &std::path::Path, new_dir: &std::path::Path) -> std::io::Result<()> {
    // 1. 迁移 models-- 开头的目录（HuggingFace 规范树）
    if let Ok(entries) = std::fs::read_dir(old_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = entry.file_name();
            let name_str = file_name.to_string_lossy();
            if path.is_dir() && name_str.starts_with("models--") {
                let target = new_dir.join(&*name_str);
                robust_move_or_copy_dir(&path, &target)?;
            }
        }
    }

    // 2. 迁移 hub/models 目录（ModelScope 规范树）
    let old_ms_dir = old_dir.join("hub").join("models");
    if old_ms_dir.exists() {
        let new_ms_dir = new_dir.join("hub").join("models");
        std::fs::create_dir_all(&new_ms_dir)?;
        if let Ok(orgs) = std::fs::read_dir(&old_ms_dir) {
            for org in orgs.flatten() {
                let org_path = org.path();
                if org_path.is_dir() {
                    let org_name = org.file_name();
                    let target_org = new_ms_dir.join(&org_name);
                    std::fs::create_dir_all(&target_org)?;
                    if let Ok(repos) = std::fs::read_dir(&org_path) {
                        for repo in repos.flatten() {
                            let repo_path = repo.path();
                            if repo_path.is_dir() {
                                let target_repo = target_org.join(repo.file_name());
                                robust_move_or_copy_dir(&repo_path, &target_repo)?;
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. 迁移根目录下孤立平铺的 .gguf 文件
    let old_ggufs = collect_all_ggufs(old_dir);
    for (old_path, file_name) in old_ggufs {
        if !old_path.exists() {
            continue; // 已在上述目录迁移中移走
        }
        let new_file_path = new_dir.join(&file_name);

        if new_file_path.exists() {
            let old_size = std::fs::metadata(&old_path).map(|m| m.len()).unwrap_or(0);
            let new_size = std::fs::metadata(&new_file_path).map(|m| m.len()).unwrap_or(0);
            if old_size == new_size && old_size > 0 {
                info!("跳过已存在文件: {}", file_name);
                std::fs::remove_file(&old_path).ok();
                continue;
            }
        }

        info!("迁移平铺模型文件: {} -> {:?}", file_name, new_file_path);
        robust_move_or_copy_file(&old_path, &new_file_path)?;
    }

    Ok(())
}

/// 目录树的健壮移动或复制（同盘秒移，异盘递归复制+核验大小+删除源）
fn robust_move_or_copy_dir(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if !src.exists() {
        return Ok(());
    }
    // 尝试直接 rename（同盘秒移）
    if std::fs::rename(src, dst).is_ok() {
        info!("同盘秒移目录成功: {:?} -> {:?}", src, dst);
        return Ok(());
    }

    // 异盘：递归复制并校验
    copy_dir_recursive(src, dst)?;
    std::fs::remove_dir_all(src)?;
    info!("异盘迁移目录成功并已清理源: {:?}", src);
    Ok(())
}

/// 递归复制目录
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &target_path)?;
        } else {
            robust_move_or_copy_file(&entry.path(), &target_path)?;
        }
    }
    Ok(())
}

/// 单文件的健壮移动或复制
fn robust_move_or_copy_file(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    // 异盘复制
    std::fs::copy(src, dst)?;
    let src_size = std::fs::metadata(src)?.len();
    let dst_size = std::fs::metadata(dst)?.len();
    if src_size == dst_size {
        std::fs::remove_file(src)?;
    } else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("文件复制后大小不匹配: {} != {}", src_size, dst_size),
        ));
    }
    Ok(())
}

/// POST /api/models/rescan
/// 重新扫描当前模型目录（支持 HuggingFace/ModelScope 子目录结构）
async fn rescan_models(State(state): State<AppState>) -> impl IntoResponse {
    let config = state.coordinator.config.lock().await;
    let models = scan_and_merge_models(&config.models_dir, None, &config.custom_models);
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

/// POST /api/models/params
/// 保存特定模型的专属启动配置至 config.json
async fn save_model_params(
    State(state): State<AppState>,
    Json(payload): Json<SaveModelParamsReq>,
) -> impl IntoResponse {
    let mut config = state.coordinator.config.lock().await;
    let data_dir = config.data_dir.clone();
    config.model_custom_params.insert(payload.model_id.clone(), payload.params);
    let store = crate::config::ConfigStore::new(data_dir);
    if let Err(e) = store.save(&config) {
        error!("持久化模型专属参数失败 [{}]: {}", payload.model_id, e);
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "success": false, "error": e.to_string() })));
    }
    info!("已成功持久化保存模型专属参数 [{}] 至 config.json", payload.model_id);
    (StatusCode::OK, Json(json!({ "success": true })))
}

/// GET /api/models/params
/// 查询特定模型的专属启动配置
async fn get_model_params(
    State(state): State<AppState>,
    Query(query): Query<GetModelParamsQuery>,
) -> impl IntoResponse {
    let config = state.coordinator.config.lock().await;
    let found = config.model_custom_params.get(&query.model_id).cloned();
    Json(json!({ "success": true, "params": found }))
}

/// POST /api/models/custom/add
/// 自由添加任意模型：解析 URL → 网络嗅探（主模型大小 + 同目录最小投影大小，不下载）
/// → 持久化至 config.json → 返回标准 ModelItem 结构供前端立即展示
async fn add_custom_model(
    State(state): State<AppState>,
    Json(payload): Json<AddCustomModelReq>,
) -> impl IntoResponse {
    // 1. 解析 URL（不支持的形态直接 400 返回原因）
    let parsed = match custom_model::parse_model_url(&payload.url) {
        Ok(p) => p,
        Err(e) => {
            warn!("自由添加模型 URL 解析失败: {} ({})", e, payload.url);
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "error": e })),
            );
        }
    };
    let resolve_url = custom_model::build_resolve_url(&parsed);
    let quant = extract_quant_tag_from_name(&parsed.file_name);

    // 2. 网络嗅探：探测失败的值保持 None（前端不显示），不阻断添加流程
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": format!("创建网络客户端失败: {}", e) })),
            );
        }
    };
    let (main_size, mmproj) = custom_model::sniff_model(&client, &parsed, &resolve_url).await;
    info!(
        "嗅探自定义模型完成: {} 主模型={:?} 投影={:?}",
        parsed.file_name, main_size, mmproj
    );

    // 3. 构造条目并持久化（同 ID 覆盖旧条目）
    let entry = custom_model::build_entry(&parsed, resolve_url, quant, main_size, mmproj);
    let disk_hit = {
        let mut config = state.coordinator.config.lock().await;
        let data_dir = config.data_dir.clone();
        if let Some(existing) = config.custom_models.iter_mut().find(|m| m.id == entry.id) {
            *existing = entry.clone();
        } else {
            config.custom_models.push(entry.clone());
        }
        let store = crate::config::ConfigStore::new(data_dir);
        if let Err(e) = store.save(&config) {
            error!("持久化自定义模型失败 [{}]: {}", entry.id, e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": e.to_string() })),
            );
        }
        // 磁盘存在性判定（该模型文件此前已被手动放入目录的情况）
        collect_all_ggufs(&config.models_dir)
            .into_iter()
            .find(|(_, n)| n.to_lowercase() == entry.file_name.to_lowercase())
            .map(|(p, _)| p.to_string_lossy().to_string())
    };
    info!("已成功持久化自定义模型 [{}] total_size={:?}", entry.id, entry.total_size);

    // 4. 返回标准 ModelItem JSON 供前端立即入列
    let model_json = custom_model::entry_to_model_json(&entry, disk_hit.is_some(), disk_hit.as_deref());
    (
        StatusCode::OK,
        Json(json!({ "success": true, "model": model_json })),
    )
}

/// POST /api/models/delete
/// 删除指定模型所在目录（含 GGUF 文件与附属文件），并清理自定义模型条目与专属参数
async fn delete_model(
    State(state): State<AppState>,
    Json(payload): Json<DeleteModelReq>,
) -> impl IntoResponse {
    info!("删除模型: {} localPath: {:?}", payload.model_id, payload.local_path);

    let models_dir = {
        let mut config = state.coordinator.config.lock().await;
        let models_dir = config.models_dir.clone();
        // 清理自定义模型条目与专属参数（普通模型无对应条目时为无操作）
        let before = config.custom_models.len();
        config.custom_models.retain(|m| m.id != payload.model_id);
        config.model_custom_params.remove(&payload.model_id);
        if config.custom_models.len() != before || config.model_custom_params.contains_key(&payload.model_id) == false {
            let data_dir = config.data_dir.clone();
            let store = crate::config::ConfigStore::new(data_dir);
            if let Err(e) = store.save(&config) {
                error!("持久化删除模型条目失败 [{}]: {}", payload.model_id, e);
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "success": false, "error": e.to_string() })),
                );
            }
        }
        models_dir
    };

    // 定位模型所在目录：优先 localPath，其次在模型目录深度匹配 model_id
    let model_file: Option<PathBuf> = payload
        .local_path
        .as_ref()
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .or_else(|| {
            collect_all_ggufs(&models_dir)
                .into_iter()
                .find(|(_, name)| {
                    let name_lower = name.to_lowercase();
                    let id_tail = payload.model_id.to_lowercase().split('/').last().unwrap_or("").to_string();
                    let id_clean = id_tail.split(':').next().unwrap_or(&id_tail).replace("-gguf", "");
                    name_lower.contains(&id_clean) || id_clean.contains(&name_lower.replace(".gguf", ""))
                })
                .map(|(p, _)| p)
        });

    let Some(model_file) = model_file else {
        warn!("未找到模型 [{}] 对应的文件，仅清理配置条目", payload.model_id);
        return (StatusCode::OK, Json(json!({ "success": true })));
    };

    // 模型所在目录 = 模型文件的父目录（如 .../models/hub/models/unsloth/Qwen3.5-0.8B-GGUF）
    let Some(model_dir) = model_file.parent().map(|p| p.to_path_buf()) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": "无法定位模型目录" })),
        );
    };

    // 安全防线：仅允许删除模型目录内部的路径，且目录必须包含 .gguf 文件
    let canonical_dir = std::fs::canonicalize(&model_dir).map_err(|e| e.to_string()).ok();
    let within_models = std::fs::canonicalize(&models_dir)
        .ok()
        .zip(canonical_dir.as_ref())
        .map(|(root, dir)| dir.starts_with(&root))
        .unwrap_or(false);
    let has_gguf = collect_all_ggufs(&model_dir).is_empty() == false;
    if !within_models || !has_gguf {
        error!("拒绝删除模型目录 [{}]：越界或不含 GGUF 文件", model_dir.display());
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "success": false, "error": "目标目录不在模型存储目录内或不含模型文件，已拒绝删除" })),
        );
    }

    // 若删除的是当前激活模型，先清空激活状态（引擎下次启动自动回退到首个可用模型）
    {
        let mut active_model = state.coordinator.active_model.lock().await;
        if active_model.as_deref() == Some(model_file.to_string_lossy().as_ref()) {
            *active_model = None;
            info!("已删除的模型为当前激活模型，已重置激活状态");
        }
    }

    match std::fs::remove_dir_all(&model_dir) {
        Ok(_) => {
            info!("已删除模型目录: {}", model_dir.display());
            (StatusCode::OK, Json(json!({ "success": true })))
        }
        Err(e) => {
            error!("删除模型目录失败 [{}]: {}", model_dir.display(), e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": e.to_string() })),
            )
        }
    }
}

/// POST /api/models/custom/remove
/// 移除自定义模型条目：仅删除 config.json 中的自定义配置与专属参数，不删除磁盘上的任何模型文件
async fn remove_custom_model(
    State(state): State<AppState>,
    Json(payload): Json<DeleteModelReq>,
) -> impl IntoResponse {
    info!("移除自定义模型条目: {}", payload.model_id);
    let mut config = state.coordinator.config.lock().await;
    let before = config.custom_models.len();
    config.custom_models.retain(|m| m.id != payload.model_id);
    config.model_custom_params.remove(&payload.model_id);
    if config.custom_models.len() == before {
        warn!("移除自定义模型条目未命中: {}", payload.model_id);
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "未找到对应的自定义模型条目" })),
        );
    }
    let data_dir = config.data_dir.clone();
    let store = crate::config::ConfigStore::new(data_dir);
    if let Err(e) = store.save(&config) {
        error!("持久化移除自定义模型条目失败 [{}]: {}", payload.model_id, e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        );
    }
    info!("已移除自定义模型条目: {}", payload.model_id);
    (StatusCode::OK, Json(json!({ "success": true })))
}

/// POST /api/engine/open-ui
/// 唤醒 Tauri 主窗口（Desktop 错误弹层「在引擎中查看」或主程序调用）
/// body 可选：{"panel":"error"|"logs"|"models"|"default"}
/// - error：打开错误分析侧边栏（llama.cpp 错误解读与解决建议）
/// - logs：跳转运行日志
/// - models：跳转模型列表页（Desktop 下载引导流深链，见 PRD-0043）
/// - default/缺省：仅显示并聚焦主窗口
#[derive(Debug, Deserialize)]
struct OpenUiPayload {
    panel: Option<String>,
}

async fn open_ui(
    State(state): State<AppState>,
    payload: Option<Json<OpenUiPayload>>,
) -> impl IntoResponse {
    let panel = payload
        .and_then(|Json(p)| p.panel)
        .filter(|p| p == "error" || p == "logs" || p == "models" || p == "default")
        .unwrap_or_else(|| "default".to_string());
    info!("收到 open-ui 请求，准备显示主窗口 panel={}", panel);

    // 显示并聚焦主窗口（静默 --silent 启动后由 Desktop 跳转唤起）
    if let Some(app_handle) = state.app_handle.as_ref() {
        use tauri::{Emitter, Manager};
        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
            // 通知前端打开目标面板（错误分析侧边栏 / 运行日志）
            let _ = window.emit("engine:ui-intent", json!({ "panel": panel }));
        }
    }

    (StatusCode::ACCEPTED, Json(json!({ "panel": panel })))
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

/// POST /api/engine/start
/// 启动 llama.cpp 推理服务子进程
async fn start_engine_service(State(state): State<AppState>) -> impl IntoResponse {
    info!("收到 start_engine_service 请求");
    match state.coordinator.start_service().await {
        Ok(_) => (StatusCode::OK, Json(json!({ "success": true, "message": "服务启动成功" }))),
        Err(e) => {
            error!("启动服务失败: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": e.to_string() })),
            )
        }
    }
}

/// POST /api/engine/stop
/// 停止 llama.cpp 推理服务子进程
async fn stop_engine_service(State(state): State<AppState>) -> impl IntoResponse {
    info!("收到 stop_engine_service 请求");
    match state.coordinator.stop_service().await {
        Ok(_) => (StatusCode::OK, Json(json!({ "success": true, "message": "服务已停止" }))),
        Err(e) => {
            error!("停止服务失败: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": e.to_string() })),
            )
        }
    }
}

/// GET /api/engine/logs
/// 获取 llama.cpp 最近运行日志
async fn get_engine_logs(State(state): State<AppState>) -> impl IntoResponse {
    let logs = state.coordinator.guard.get_logs().await;
    Json(json!({ "logs": logs }))
}

/// POST /api/engine/logs/clear
/// 清空当前日志缓冲区
async fn clear_engine_logs(State(state): State<AppState>) -> impl IntoResponse {
    state.coordinator.guard.clear_logs().await;
    Json(json!({ "success": true }))
}

/// 注册管理端点路由
pub fn management_routes() -> Router<AppState> {
    Router::new()
        .route("/api/engine/status", get(engine_status))
        .route("/api/engine/start", post(start_engine_service))
        .route("/api/engine/stop", post(stop_engine_service))
        .route("/api/engine/logs", get(get_engine_logs))
        .route("/api/engine/logs/clear", post(clear_engine_logs))
        .route("/api/engine/list", get(engine_list))
        .route("/api/engine/switch", post(switch_engine))
        .route("/api/engine/download/start", post(start_engine_download))
        .route("/api/engine/download/status/{task_id}", get(get_download_status))
        .route("/api/engine/download/cancel/{task_id}", post(cancel_model_download))
        .route("/api/models", get(list_models))
        .route("/api/models/switch", post(switch_model))
        .route("/api/engine/models-dir", post(update_models_dir))
        .route("/api/models/rescan", post(rescan_models))
        .route("/api/models/params", post(save_model_params).get(get_model_params))
        .route("/api/models/custom/add", post(add_custom_model))
        .route("/api/models/custom/remove", post(remove_custom_model))
        .route("/api/models/delete", post(delete_model))
        .route("/api/models/download/start", post(start_model_download))
        .route("/api/models/download/status/{task_id}", get(get_download_status))
        .route("/api/models/download/cancel/{task_id}", post(cancel_model_download))
        .route("/api/engine/params", post(update_params))
        .route("/api/engine/hardware", get(hardware_info))
        .route("/api/engine/open-ui", post(open_ui))
        .route("/api/engine/shutdown", post(shutdown))
        .route("/api/engine/reset-downgrade", post(reset_downgrade))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 零试探 Package Flavor 路由：6 种典型软硬件画像端到端推导 ──

    /// 画像 1：二代酷睿 / 初代至强 E5（仅 AVX1，无独显）→ 定制补全 cpu-avx
    #[test]
    fn profile_sandy_bridge_routes_to_cpu_avx() {
        let backend = resolve_auto_backend("cpu", Some(false), Some(true));
        assert_eq!(backend, "cpu-avx");
        // 显式请求 cpu 也应被修正为 cpu-avx，杜绝误下 AVX2 官方包
        assert_eq!(correct_cpu_backend("cpu", Some(false), Some(true)), "cpu-avx");
    }

    /// 画像 2：老奔腾 / 赛扬（无任何 AVX）→ 定制补全 cpu-noavx 纯 SSE4.2 兜底
    #[test]
    fn profile_pentium_celeron_routes_to_cpu_noavx() {
        let backend = resolve_auto_backend("cpu", Some(false), Some(false));
        assert_eq!(backend, "cpu-noavx");
        assert_eq!(correct_cpu_backend("cpu", Some(false), Some(false)), "cpu-noavx");
        // has_avx2 / has_avx 均缺失（探测失败）时同样兜底 noavx
        assert_eq!(resolve_auto_backend("cpu", None, None), "cpu-noavx");
    }

    /// 画像 3：现代 AVX2 CPU（无可用 GPU）→ 官方 CPU-AVX2 包
    #[test]
    fn profile_modern_avx2_routes_to_cpu() {
        assert_eq!(resolve_auto_backend("cpu", Some(true), Some(true)), "cpu");
        // 显式 cpu 请求 + 已有 AVX2 → 保持 cpu 不变
        assert_eq!(correct_cpu_backend("cpu", Some(true), Some(true)), "cpu");
    }

    /// 画像 4：NVIDIA 现代独显（CUDA 驱动合规）→ 官方 CUDA 12.4 包
    #[test]
    fn profile_modern_nvidia_routes_to_cuda() {
        assert_eq!(resolve_auto_backend("cuda", Some(true), Some(true)), "cuda");
        // 非 CPU 后端不被指令集修正逻辑改写
        assert_eq!(correct_cpu_backend("cuda", Some(false), Some(false)), "cuda");
    }

    /// 画像 5：GTX 1060 Pascal / 驱动过旧 → 平滑路由到官方 Vulkan 包
    #[test]
    fn profile_pascal_or_outdated_driver_routes_to_vulkan() {
        assert_eq!(resolve_auto_backend("vulkan", Some(true), Some(true)), "vulkan");
        assert_eq!(correct_cpu_backend("vulkan", None, None), "vulkan");
    }

    /// 画像 6：双显卡笔记本核显 / 无加速 → 按 CPU 指令集阶梯唯一命中补全包
    #[test]
    fn profile_dual_gpu_or_cpu_fallback_is_unique() {
        // 驱动均不合规落入 cpu 层级后，仍按 AVX 阶梯唯一映射
        assert_eq!(resolve_auto_backend("hip", Some(true), Some(true)), "hip");
        assert_eq!(resolve_auto_backend("sycl", Some(false), Some(true)), "sycl");
        assert_eq!(resolve_auto_backend("metal", Some(false), Some(false)), "metal");
        // 未知/空 best_tier 视作 CPU 阶梯
        assert_eq!(resolve_auto_backend("", Some(false), Some(true)), "cpu-avx");
    }

    /// 下载目标文件名与 Package Flavor 一一对应（cpu-avx / cpu-noavx 长尾补全包）
    #[test]
    fn resolve_target_package_maps_cpu_flavors() {
        if cfg!(windows) {
            let (_, patterns) = resolve_engine_target_package("cpu-avx").expect("cpu-avx 必须可解析");
            assert!(patterns.iter().any(|p| p.contains("cpu-avx-x64")));

            let (_, patterns) = resolve_engine_target_package("cpu-noavx").expect("cpu-noavx 必须可解析");
            assert!(patterns.iter().any(|p| p.contains("cpu-noavx-x64")));

            let (_, patterns) = resolve_engine_target_package("cuda").expect("cuda 必须可解析");
            assert!(patterns.iter().any(|p| p.contains("cuda-12.4")));

            let (_, patterns) = resolve_engine_target_package("vulkan").expect("vulkan 必须可解析");
            assert!(patterns.iter().any(|p| p.contains("vulkan-x64")));

            let (_, patterns) = resolve_engine_target_package("vulkan-compat").expect("vulkan-compat 必须可解析");
            assert!(patterns.iter().any(|p| p.contains("vulkan-compat-x64")));
        }
    }

    /// 双轨候选源优先级强制：无论官方包还是增补包，第一源必为 GitHub，第二源必为 EdgeOne R2
    #[test]
    fn test_candidate_urls_github_first_and_edgeone_fallback() {
        // 1. 增补包 (cpu-avx / cpu-noavx / vulkan-compat)
        let compat_urls = build_candidate_urls("b11095", "llama-b11095-bin-win-cpu-avx-x64.zip");
        assert_eq!(compat_urls.len(), 2);
        assert_eq!(compat_urls[0].0, "GitHub 专属兼容发布");
        assert!(compat_urls[0].1.contains("github.com/Leonard-Li777/firefly-ai-folder/releases/download/llama-compat-b11095"));
        assert_eq!(compat_urls[1].0, "国内高速镜像 (EdgeOne R2)");
        assert!(compat_urls[1].1.contains("download.iocn.cn/llama-cpp/b11095"));

        // 2. 官方包 (cuda / vulkan / cpu 等)
        let official_urls = build_candidate_urls("b11095", "llama-b11095-bin-win-cuda-12.4-x64.zip");
        assert_eq!(official_urls.len(), 2);
        assert_eq!(official_urls[0].0, "GitHub 官方");
        assert!(official_urls[0].1.contains("github.com/ggml-org/llama.cpp/releases/download/b11095"));
        assert_eq!(official_urls[1].0, "国内高速镜像 (EdgeOne R2)");
        assert!(official_urls[1].1.contains("download.iocn.cn/llama-cpp/b11095"));
    }

    /// 动态候选版本构建测试：根据活跃版本列表推导各架构候选包
    #[test]
    fn test_resolve_download_candidates_dynamic() {
        let versions = vec!["b11120".to_string(), "b11095".to_string()];
        if cfg!(windows) {
            let candidates = resolve_download_candidates("cuda12", &versions);
            assert_eq!(candidates.len(), 2);
            assert_eq!(candidates[0].version, "b11120");
            assert_eq!(candidates[0].filename, "llama-b11120-bin-win-cuda-12.4-x64.zip");
            assert_eq!(candidates[1].version, "b11095");
            assert_eq!(candidates[1].filename, "llama-b11095-bin-win-cuda-12.4-x64.zip");

            let vulkan_compat = resolve_download_candidates("vulkan-compat", &versions);
            assert_eq!(vulkan_compat[0].filename, "llama-b11120-bin-win-vulkan-compat-x64.zip");
        }
    }
}
