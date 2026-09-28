// engine/mod.rs
pub mod param_builder;
pub mod process_guard;
pub mod scheduler;

pub use param_builder::{EngineParams, ModelInfo, ParamBuilder};
pub use process_guard::{ProcessError, ProcessEvent, ProcessGuard, ProcessStatus};
pub use scheduler::{EngineScheduler, InstalledEngine};

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::hardware::{DriverComplianceService, HardwareDetector};
use crate::config::{EngineConfig, find_available_port};
use crate::server::proxy::ProxyState;

/// 引擎服务状态（对外暴露）
#[derive(Debug, Clone, serde::Serialize)]
pub struct EngineStatus {
    pub status: String,         // "starting" | "ready" | "error" | "stopped"
    pub active_backend: String, // "cuda" | "vulkan" | "cpu" | ...
    pub current_model: Option<String>,
    pub active_language_model: Option<String>,
    pub active_embedding_model: Option<String>,
    pub models_dir: String,
    pub port: u16,
    pub vram_usage_mb: Option<u64>,
    pub hardware: HardwareSummary,
    pub downgrade_info: Option<crate::hardware::DowngradeInfo>,
    pub runtime_params: Option<serde_json::Value>,
    pub last_error: Option<String>,
}

/// 硬件摘要（status 端点返回）
#[derive(Debug, Clone, serde::Serialize)]
pub struct HardwareSummary {
    pub gpu_name: String,
    pub total_vram_gb: f64,
    pub used_vram_gb: Option<f64>,
    pub best_tier: String,
    pub current_tier: String,
    pub is_integrated: bool,
    pub cpu_cores: Option<usize>,
    pub cpu_threads: Option<usize>,
    pub os_platform: Option<String>,
    pub total_ram_gb: Option<f64>,
    pub used_ram_gb: Option<f64>,
    pub has_avx2: Option<bool>,
    pub has_avx: Option<bool>,
}

impl HardwareSummary {
    /// 将 best_tier 字符串解析为层级枚举（无法识别时按 CPU 处理）
    pub fn best_tier_parsed(&self) -> crate::hardware::gpu_info::AccelerationTier {
        crate::hardware::gpu_info::AccelerationTier::from_str(&self.best_tier)
    }
}

/// 核心引擎协调器（单例）
pub struct EngineCoordinator {
    pub hardware: Arc<HardwareDetector>,
    pub scheduler: Arc<EngineScheduler>,
    pub compliance: Arc<DriverComplianceService>,
    pub guard: Arc<ProcessGuard>,
    pub config: Arc<Mutex<EngineConfig>>,
    /// 当前 Axum 网关正在使用的对外公开端口
    pub active_port: Arc<Mutex<Option<u16>>>,
    /// 反向代理状态管理
    pub proxy_state: ProxyState,
    /// 当前活跃引擎
    pub active_engine: Arc<Mutex<Option<InstalledEngine>>>,
    /// 当前预选或激活的模型路径/ID
    pub active_model: Arc<Mutex<Option<String>>>,
    /// 当前实际在子进程中运行的模型绝对路径
    pub running_model: Arc<Mutex<Option<String>>>,
    /// 当前加载的模型配置名（用于 --alias 等）
    pub active_model_name: Arc<Mutex<Option<String>>>,
    /// 安装目录下的 bin 搜索目录（资源查找白名单）
    pub install_bin_dirs: Vec<PathBuf>,
}

impl EngineCoordinator {
    pub fn new(
        hardware: Arc<HardwareDetector>,
        compliance: Arc<DriverComplianceService>,
        bin_dirs: Vec<PathBuf>,
        config: Arc<Mutex<EngineConfig>>,
        proxy_state: ProxyState,
    ) -> Arc<Self> {
        let scheduler = Arc::new(EngineScheduler::new(bin_dirs.clone(), compliance.clone()));
        let guard = ProcessGuard::new(compliance.clone());

        Arc::new(EngineCoordinator {
            hardware,
            scheduler,
            compliance,
            guard,
            config,
            active_port: Arc::new(Mutex::new(None)),
            proxy_state,
            active_engine: Arc::new(Mutex::new(None)),
            active_model: Arc::new(Mutex::new(None)),
            running_model: Arc::new(Mutex::new(None)),
            active_model_name: Arc::new(Mutex::new(None)),
            install_bin_dirs: bin_dirs,
        })
    }

    /// 获取当前引擎状态（用于 /api/engine/status 端点）
    pub async fn get_status(&self) -> EngineStatus {
        let proc_status = self.guard.status().await;
        let status_str = match proc_status {
            ProcessStatus::Starting => "starting",
            ProcessStatus::Running => "ready",
            ProcessStatus::Failed => "error",
            ProcessStatus::Stopped => "stopped",
        };

        let config = self.config.lock().await;
        let models_dir = config.models_dir.to_string_lossy().to_string();
        let preferred_backend = config.preferred_backend.clone();
        let active_language_model = config.active_language_model.clone();
        let active_embedding_model = config.active_embedding_model.clone();
        drop(config);

        // 获取硬件信息（best_tier 仅供前端展示"最佳适配"，不参与当前引擎判定）
        let hardware = match self.hardware.detect(false).await {
            Ok(resources) => {
                let gpu = resources.primary_gpu();
                let best = resources.best_acceleration_tier.as_str().to_string();
                HardwareSummary {
                    gpu_name: gpu.map(|g| g.name.clone()).unwrap_or_default(),
                    total_vram_gb: gpu.map(|g| g.memory_gb()).unwrap_or(0.0),
                    used_vram_gb: None,
                    best_tier: best,
                    current_tier: String::new(), // 下方统一填入
                    is_integrated: gpu.map(|g| g.is_integrated).unwrap_or(false),
                    cpu_cores: Some(resources.cpu.cores as usize),
                    cpu_threads: Some(resources.cpu.threads as usize),
                    os_platform: Some(std::env::consts::OS.to_string()),
                    total_ram_gb: Some(resources.memory.total_gb()),
                    used_ram_gb: Some(((resources.memory.total_mb.saturating_sub(resources.memory.available_mb)) as f64) / 1024.0),
                    has_avx2: Some(resources.cpu.has_avx2),
                    has_avx: Some(resources.cpu.has_avx),
                }
            }
            Err(_) => HardwareSummary {
                gpu_name: String::new(),
                total_vram_gb: 0.0,
                used_vram_gb: None,
                best_tier: "cpu".to_string(),
                current_tier: String::new(),
                is_integrated: false,
                cpu_cores: None,
                cpu_threads: None,
                os_platform: Some(std::env::consts::OS.to_string()),
                total_ram_gb: None,
                used_ram_gb: None,
                has_avx2: None,
                has_avx: None,
            },
        };

        // 当前引擎只反映真实状态：
        // 1. 引擎实际运行中 → 运行引擎的层级；
        // 2. 引擎未运行但用户显式选择过 → 仅当该引擎确实已安装时才上报（否则视为未选定）；
        // 3. 其余情况（如首次使用、无用户偏好）→ 默认选中「已下载引擎中的最佳引擎」：
        //    从硬件最佳层级沿降级链（CUDA→Vulkan→CPU）找到第一个已安装的层级，
        //    与调度器 select_engine 无偏好时的实际选择一致，UI 即可预标记即将生效的引擎。
        // 4. 一个引擎都未下载 → 空串，UI 不得标记任何"当前引擎"。
        let active_engine = self.active_engine.lock().await.clone();
        let active_backend = if proc_status == ProcessStatus::Running || proc_status == ProcessStatus::Starting {
            active_engine
                .as_ref()
                .map(|e| {
                    if e.tier == crate::hardware::gpu_info::AccelerationTier::Cuda {
                        if e.dir_name.contains("cuda-13") {
                            "cuda134".to_string()
                        } else {
                            "cuda".to_string()
                        }
                    } else {
                        e.tier.as_str().to_string()
                    }
                })
                .unwrap_or_default()
        } else {
            let installed = self.scheduler.scan_installed_engines().await;
            let tier_installed = |tier: &crate::hardware::gpu_info::AccelerationTier| -> bool {
                installed.iter().any(|e| e.tier == *tier)
            };

            let preferred_matches = preferred_backend
                .as_deref()
                .map(|pref| {
                    let tier = crate::hardware::gpu_info::AccelerationTier::from_str(pref);
                    // "cpu" 等未知变体一律解析为 Cpu，直接按层级比对已安装引擎
                    tier_installed(&tier)
                })
                .unwrap_or(false);

            if preferred_matches {
                preferred_backend.unwrap_or_default()
            } else {
                // 无有效用户偏好：沿降级链默认选中已下载的最佳引擎
                let mut tier = hardware.best_tier_parsed();
                loop {
                    if tier_installed(&tier) {
                        break tier.as_str().to_string();
                    }
                    match crate::hardware::driver_compliance::get_fallback_tier(&tier) {
                        Some(next) => tier = next,
                        None => break String::new(), // 一个引擎都没下载
                    }
                }
            }
        };

        let active_port = self.active_port.lock().await.unwrap_or(38400);
        let current_model = if proc_status == ProcessStatus::Running {
            let rm = self.running_model.lock().await.clone();
            if rm.is_some() {
                rm
            } else {
                self.active_model.lock().await.clone()
            }
        } else {
            None
        };

        let mut hardware = hardware;
        hardware.current_tier = active_backend.clone();

        let downgrade_info = self.compliance.get_downgrade_info().await;

        let runtime_params = Some(serde_json::json!({
            "n_gpu_layers": 24,
            "threads": 8,
            "ctx_size": 4096,
            "batch_size": 512,
            "ubatch_size": 256
        }));

        let last_error = self.guard.last_error().await;

        EngineStatus {
            status: status_str.to_string(),
            active_backend,
            current_model,
            active_language_model,
            active_embedding_model,
            models_dir,
            port: active_port,
            vram_usage_mb: None,
            hardware,
            downgrade_info,
            runtime_params,
            last_error,
        }
    }

    /// 启动引擎子进程服务
    ///
    /// 失败时把原因写入 `guard.last_error`，使 `/api/engine/status` 能把它带给引擎前端
    /// （Footer 错误行 / 错误分析侧边栏）。**校验类失败**（未检测到 GGUF 模型、
    /// 引擎二进制缺失、模型文件不存在等）在拉起子进程之前就已返回，不会进入
    /// 子进程监控循环，若不显式落库，前端将完全看不到失败原因。
    pub async fn start_service(&self) -> anyhow::Result<()> {
        match self.start_service_inner().await {
            Ok(()) => Ok(()),
            Err(e) => {
                let message = e.to_string();
                tracing::error!("引擎服务启动失败: {}", message);
                self.guard.set_last_error(message).await;
                Err(e)
            }
        }
    }

    /// `start_service` 的实际实现；错误由调用方统一落库
    async fn start_service_inner(&self) -> anyhow::Result<()> {
        let current_status = self.guard.status().await;
        if current_status == ProcessStatus::Running || current_status == ProcessStatus::Starting {
            tracing::info!("引擎服务已经在运行或启动中，无需重复启动");
            return Ok(());
        }

        // 清除上一次的失败错误记录
        self.guard.clear_last_error().await;

        // 1. 扫描与探测引擎
        let resources = self.hardware.detect(false).await
            .map_err(|e| anyhow::anyhow!("硬件探测失败: {}", e))?;

        let (models_dir, preferred_backend, active_lang_pref, custom_models) = {
            let config = self.config.lock().await;
            (
                config.models_dir.clone(),
                config.preferred_backend.clone(),
                config.active_language_model.clone(),
                config.custom_models.clone(),
            )
        };

        let selected_engine = self.scheduler.select_engine(&resources, preferred_backend.as_deref()).await?;

        // 2. 确定模型文件（优先使用当前运行指定或持久化的主语言模型）
        let active_model_lock = self.active_model.lock().await.clone()
            .or(active_lang_pref);
        let all_ggufs = crate::server::api::collect_all_ggufs(&models_dir);

        let model_path = if let Some(ref m) = active_model_lock {
            let p = std::path::PathBuf::from(&m);
            let p_name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
            if p.is_absolute() && p.exists() && !p_name.contains("mmproj") {
                p
            } else if models_dir.join(&m).exists() && !m.to_lowercase().contains("mmproj") {
                models_dir.join(&m)
            } else {
                // 若 active_model 存储的是模型 ID 或相对名，在深度扫描列表中匹配
                let m_lower = m.to_lowercase();
                let m_clean_source = m_lower.split('@').next().unwrap_or(&m_lower);

                // 优先检查是否有冒号指定确切的 .gguf 文件名
                let exact_match = if let Some(exact_file) = m_clean_source.split(':').nth(1) {
                    if exact_file.ends_with(".gguf") {
                        all_ggufs.iter().find(|(_, name)| {
                            let nl = name.to_lowercase();
                            !nl.contains("mmproj") && nl == exact_file
                        }).map(|(p, _)| p.clone())
                    } else {
                        None
                    }
                } else {
                    None
                };

                if let Some(matched_p) = exact_match {
                    matched_p
                } else {
                    let m_tail = m_clean_source.split('/').last().unwrap_or(m_clean_source);
                    let m_clean = m_tail.split(':').next().unwrap_or(m_tail).replace("-gguf", "");

                    all_ggufs.iter().find(|(_, name)| {
                        let name_lower = name.to_lowercase();
                        !name_lower.contains("mmproj") && (name_lower.contains(&m_clean) || m_clean.contains(&name_lower.replace(".gguf", "")))
                    }).map(|(p, _)| p.clone())
                    .or_else(|| {
                        // 降级为已下载的第一个非 mmproj、非 wemm 的主语言模型
                        all_ggufs.iter().find(|(_, name)| {
                            let nl = name.to_lowercase();
                            !nl.contains("mmproj") && !nl.contains("wemm")
                        }).map(|(p, _)| p.clone())
                    })
                    .ok_or_else(|| anyhow::anyhow!("未找到模型文件: {}，且当前存储目录中没有可用 GGUF 模型", m))?
                }
            }
        } else {
            // 没有指定激活模型时，从模型目录中挑选第一个已下载就绪的非 mmproj、非 wemm 的主语言模型
            all_ggufs.iter().find(|(_, name)| {
                let nl = name.to_lowercase();
                !nl.contains("mmproj") && !nl.contains("wemm")
            })
            .or_else(|| all_ggufs.iter().find(|(_, name)| !name.to_lowercase().contains("mmproj")))
            .map(|(p, _)| p.clone())
            .ok_or_else(|| anyhow::anyhow!("当前模型存储目录下未检测到任何 GGUF 模型文件，请先在模型管理中下载模型"))?
        };

        if !model_path.exists() {
            return Err(anyhow::anyhow!("模型文件不存在: {}，请在模型管理中重新下载", model_path.display()));
        }

        let model_str = model_path.to_string_lossy().to_string();
        *self.active_model.lock().await = Some(model_str.clone());

        // 提取模型专属参数（若用户在前端配置并保存）
        let active_name_lock = self.active_model_name.lock().await.clone();
        let fallback_stem = model_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("default")
            .to_string();
        let model_alias = active_name_lock.clone().unwrap_or_else(|| fallback_stem.clone());

        // 判定当前模型是否为多模态模型：
        // 权威检查模型元数据/自定义模型配置，若 isMultiModal: false 则绝不挂载投影模型！
        let model_meta_dirs = crate::resource_scope::allowed_install_model_meta_dirs(None);
        let is_multimodal = detect_model_is_multimodal(
            &model_path,
            active_model_lock.as_deref(),
            active_name_lock.as_deref(),
            &custom_models,
            &model_meta_dirs,
        );

        // 仅当模型为多模态模型时，才自动探测同级或 models_dir 目录下的多模态投影器 mmproj；
        // 若当前模型 isMultiModal: false，即使同目录或存储目录存在投影模型，启动时也绝不加载
        let detected_mmproj = if is_multimodal {
            let parent_dir = model_path.parent();
            all_ggufs.iter().find(|(p, name)| {
                let n_lower = name.to_lowercase();
                n_lower.contains("mmproj") && (p.parent() == parent_dir || p.parent() == Some(&models_dir))
            }).map(|(p, _)| p.to_string_lossy().to_string())
        } else {
            None
        };

        let model_size_gb = std::fs::metadata(&model_path).map(|m| m.len() as f64 / (1024.0 * 1024.0 * 1024.0)).unwrap_or(1.0);
        let model_lower = model_str.to_lowercase();
        let is_minicpm5 = model_lower.contains("minicpm5");
        let is_nanbeige4 = model_lower.contains("nanbeige4");

        let (user_model_params, custom_layers, custom_ctx) = {
            let config = self.config.lock().await;
            // 尝试通过活跃模型名、别名、文件名 stem 或原始 key 查找配置
            let found = config.model_custom_params.get(&model_str)
                .or_else(|| active_name_lock.as_ref().and_then(|n| config.model_custom_params.get(n)))
                .or_else(|| config.model_custom_params.get(&fallback_stem))
                .cloned();
            (found, config.custom_gpu_layers, config.custom_context_window)
        };

        let force_gpu_layers = user_model_params.as_ref().map(|p| p.n_gpu_layers).or(custom_layers);
        let context_window = user_model_params.as_ref().map(|p| p.ctx_size).or(custom_ctx);
        let force_batch_size = user_model_params.as_ref().map(|p| p.batch_size);
        let force_ubatch_size = user_model_params.as_ref().map(|p| p.ubatch_size);

        let model_info = ModelInfo {
            param_b: if model_size_gb < 1.0 { 0.8 } else if model_size_gb < 2.0 { 1.5 } else { 2.5 },
            size_gb: model_size_gb,
            quantization: "Q4_K_M".to_string(),
            is_multimodal: is_multimodal && detected_mmproj.is_some(),
            context_window,
            force_gpu_layers,
            force_batch_size,
            force_ubatch_size,
            force_cpu: selected_engine.tier == crate::hardware::gpu_info::AccelerationTier::Cpu,
            enable_thinking: false,
            is_minicpm5,
            is_nanbeige4,
            mmproj_path: detected_mmproj,
            dspark_path: None,
            draft_path: None,
            cache_type_k: user_model_params.as_ref().map(|p| p.cache_type_k.clone()),
            cache_type_v: user_model_params.as_ref().map(|p| p.cache_type_v.clone()),
            parallel: user_model_params.as_ref().map(|p| p.parallel),
            temp: user_model_params.as_ref().map(|p| p.temp),
            top_p: user_model_params.as_ref().map(|p| p.top_p),
            top_k: user_model_params.as_ref().map(|p| p.top_k),
            repeat_penalty: user_model_params.as_ref().map(|p| p.repeat_penalty),
            is_embedding: model_str.to_lowercase().contains("wemm") || model_str.to_lowercase().contains("embedding"),
            is_production: !cfg!(debug_assertions),
        };

        let backend_str = selected_engine.tier.as_str();
        let mut params = ParamBuilder::compute(&resources, &model_info, backend_str);

        // 如果用户配置了线程数，覆盖 ParamBuilder 计算的 threads
        if let Some(ref ump) = user_model_params {
            if ump.threads > 0 {
                params.threads = ump.threads;
            }
        }

        // 端口隔离：llama-server 使用独立内部端口，避免与 Axum HTTP 网关冲突
        let gateway_port = self.active_port.lock().await.unwrap_or(38400);
        let llama_internal_port = find_available_port(gateway_port + 1).await;

        let args = ParamBuilder::to_args(&params, llama_internal_port, &model_str, &model_alias, Some(&model_info));

        // 记录活跃引擎
        *self.active_engine.lock().await = Some(selected_engine.clone());

        // 启动子进程
        if let Err(e) = self.guard.start(&selected_engine, &args, &[]).await {
            tracing::error!("启动子进程失败: {}", e);
            return Err(e);
        }

        // 等待服务内部端口可达（超时 15 秒）
        match self.guard.wait_ready(llama_internal_port, 15).await {
            Ok(_) => {
                // 成功就绪：向反向代理注册内部目标端口，并标记进程状态为 Running
                self.proxy_state.set_target_port(llama_internal_port).await;
                self.guard.mark_running().await;
                *self.running_model.lock().await = Some(model_str.clone());
                tracing::info!("引擎服务启动并反代就绪: backend={}, internal_port={}, gateway_port={}", backend_str, llama_internal_port, gateway_port);
                Ok(())
            }
            Err(e) => {
                let err_msg = self.guard.last_error().await.unwrap_or_else(|| e.to_string());
                tracing::error!("引擎就绪探测失败: {}", err_msg);
                // 发生错误停止子进程
                let _ = self.guard.stop().await;
                *self.running_model.lock().await = None;
                Err(anyhow::anyhow!("{}", err_msg))
            }
        }
    }

    /// 停止引擎子进程服务
    pub async fn stop_service(&self) -> anyhow::Result<()> {
        self.guard.stop().await?;
        *self.running_model.lock().await = None;
        tracing::info!("引擎服务已停止");
        Ok(())
    }
}

/// 判断当前启动模型是否为多模态模型
/// 1. 优先比对用户自定义模型列表（通过 ID 或文件名命中，以其 mmproj_file_name 判定）
/// 2. 匹配预设模型元数据文件（model_{lang}.json），若命中则以预设的 isMultiModal 为权威依据
/// 3. 若均未命中（未知本地模型），检查文件名是否具备明确多模态特征（如含 vl、vision）
pub fn detect_model_is_multimodal(
    model_path: &std::path::Path,
    active_id: Option<&str>,
    active_name: Option<&str>,
    custom_models: &[crate::config::CustomModelEntry],
    meta_dirs: &[std::path::PathBuf],
) -> bool {
    let file_name = model_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let name_lower = file_name.to_lowercase();

    // 1. 检查自定义模型
    for custom in custom_models {
        if custom.file_name.eq_ignore_ascii_case(&file_name)
            || active_id.map(|id| id.eq_ignore_ascii_case(&custom.id)).unwrap_or(false)
        {
            return custom.mmproj_file_name.is_some();
        }
    }

    // 2. 检查预设模型元数据
    let file_quant = crate::server::api::extract_quant_tag_from_name(&name_lower);
    for dir in meta_dirs {
        for entry in ["model_zh-CN.json", "model_zh.json", "model_en-US.json", "model_en.json"] {
            let meta_file = dir.join(entry);
            if let Ok(content) = std::fs::read_to_string(&meta_file) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(models) = val.get("models").and_then(|m| m.as_array()) {
                        for m in models {
                            let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            let id_lower = id.to_lowercase();
                            let expected_quant = m.get("quantization").and_then(|v| v.as_str());
                            let tag_clean = expected_quant
                                .map(|q| q.trim_start_matches("UD-").to_lowercase());

                            let tag_ok = match (&tag_clean, &file_quant) {
                                (Some(expected), Some(actual)) => expected == actual,
                                (Some(expected), None) => name_lower.contains(expected.as_str()),
                                (None, _) => true,
                            };

                            let id_tail = id_lower.split('/').last().unwrap_or(&id_lower);
                            let id_matched = active_id
                                .map(|aid| {
                                    let aid_lower = aid.to_lowercase();
                                    aid_lower == id_lower
                                        || aid_lower.starts_with(&id_lower)
                                        || id_lower.starts_with(&aid_lower)
                                        || aid_lower.contains(id_tail)
                                })
                                .unwrap_or(false);

                            let name_matched = active_name
                                .and_then(|an| m.get("name").and_then(|v| v.as_str()).map(|mn| an.eq_ignore_ascii_case(mn)))
                                .unwrap_or(false);

                            if id_matched
                                || name_matched
                                || (tag_ok
                                    && (name_lower.contains(id_tail)
                                        || name_lower.replace(".gguf", "").contains(&id_tail.replace("-gguf", ""))))
                            {
                                return m.get("isMultiModal").and_then(|v| v.as_bool()).unwrap_or(false);
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. 兜底：未匹配到任何预设或自定义模型，检查名称是否含明确多模态特征
    name_lower.contains("-vl") || name_lower.contains("_vl") || name_lower.contains("vision")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_detect_model_is_multimodal_preset_text_only() {
        // 测试预设文本模型（如 Qwen3.5-0.8B）：必须判定为 false
        let model_path = PathBuf::from("D:\\models\\hub\\models\\unsloth\\Qwen3.5-0.8B-GGUF\\qwen3.5-0.8b-instruct-ud-q4_k_xl.gguf");
        let active_id = "unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL";
        let meta_dirs = crate::resource_scope::allowed_install_model_meta_dirs(None);

        let is_mm = detect_model_is_multimodal(&model_path, Some(active_id), None, &[], &meta_dirs);
        assert!(!is_mm, "预设纯文本模型即使同目录有投影文件，也绝不能被判定为多模态");
    }

    #[test]
    fn test_detect_model_is_multimodal_custom_text_only() {
        let model_path = PathBuf::from("D:\\models\\my-text-model.gguf");
        let custom = crate::config::CustomModelEntry {
            id: "custom/my-text-model".to_string(),
            name: "My Text Model".to_string(),
            author: None,
            source: "modelscope".to_string(),
            quant: Some("Q4_K_M".to_string()),
            file_name: "my-text-model.gguf".to_string(),
            resolve_url: "https://example.com".to_string(),
            main_file_size: Some(100),
            mmproj_file_name: None, // 无投影
            mmproj_file_size: None,
            total_size: Some(100),
        };

        let is_mm = detect_model_is_multimodal(&model_path, Some("custom/my-text-model"), None, &[custom], &[]);
        assert!(!is_mm, "自定义无投影模型必须判定为 false");
    }

    #[test]
    fn test_detect_model_is_multimodal_custom_with_mmproj() {
        let model_path = PathBuf::from("D:\\models\\my-vl-model.gguf");
        let custom = crate::config::CustomModelEntry {
            id: "custom/my-vl-model".to_string(),
            name: "My VL Model".to_string(),
            author: None,
            source: "modelscope".to_string(),
            quant: Some("Q4_K_M".to_string()),
            file_name: "my-vl-model.gguf".to_string(),
            resolve_url: "https://example.com".to_string(),
            main_file_size: Some(100),
            mmproj_file_name: Some("mmproj.gguf".to_string()), // 有投影
            mmproj_file_size: Some(50),
            total_size: Some(150),
        };

        let is_mm = detect_model_is_multimodal(&model_path, Some("custom/my-vl-model"), None, &[custom], &[]);
        assert!(is_mm, "自定义多模态模型必须判定为 true");
    }
}
