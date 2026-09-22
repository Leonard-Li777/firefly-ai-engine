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
    /// 当前加载的模型路径
    pub active_model: Arc<Mutex<Option<String>>>,
    /// 当前加载的模型配置名（用于 --alias 等）
    pub active_model_name: Arc<Mutex<Option<String>>>,
}

impl EngineCoordinator {
    pub fn new(
        hardware: Arc<HardwareDetector>,
        compliance: Arc<DriverComplianceService>,
        bin_dir: PathBuf,
        config: Arc<Mutex<EngineConfig>>,
        proxy_state: ProxyState,
    ) -> Arc<Self> {
        let scheduler = Arc::new(EngineScheduler::new(bin_dir, compliance.clone()));
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
            active_model_name: Arc::new(Mutex::new(None)),
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
        drop(config);

        // 获取硬件信息
        let (hardware, auto_recommended_tier) = match self.hardware.detect(false).await {
            Ok(resources) => {
                let gpu = resources.primary_gpu();
                let best = resources.best_acceleration_tier.as_str().to_string();
                (
                    HardwareSummary {
                        gpu_name: gpu.map(|g| g.name.clone()).unwrap_or_default(),
                        total_vram_gb: gpu.map(|g| g.memory_gb()).unwrap_or(0.0),
                        used_vram_gb: None,
                        best_tier: best.clone(),
                        current_tier: String::new(), // 下方统一填入
                        is_integrated: gpu.map(|g| g.is_integrated).unwrap_or(false),
                        cpu_cores: Some(resources.cpu.cores as usize),
                        cpu_threads: Some(resources.cpu.threads as usize),
                        os_platform: Some(std::env::consts::OS.to_string()),
                        total_ram_gb: Some(resources.memory.total_gb()),
                        used_ram_gb: Some(((resources.memory.total_mb.saturating_sub(resources.memory.available_mb)) as f64) / 1024.0),
                    },
                    best,
                )
            }
            Err(_) => (
                HardwareSummary {
                    gpu_name: String::new(),
                    total_vram_gb: 0.0,
                    used_vram_gb: None,
                    best_tier: "cpu".to_string(),
                    current_tier: "cpu".to_string(),
                    is_integrated: false,
                    cpu_cores: None,
                    cpu_threads: None,
                    os_platform: Some(std::env::consts::OS.to_string()),
                    total_ram_gb: None,
                    used_ram_gb: None,
                },
                "cpu".to_string(),
            ),
        };

        let active_engine = self.active_engine.lock().await.clone();
        let active_backend = active_engine
            .as_ref()
            .map(|e| e.tier.as_str().to_string())
            .or(preferred_backend)
            .unwrap_or(auto_recommended_tier);

        let active_port = self.active_port.lock().await.unwrap_or(38400);
        let active_model = self.active_model.lock().await.clone();

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
            current_model: active_model,
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
    pub async fn start_service(&self) -> anyhow::Result<()> {
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
        let selected_engine = self.scheduler.select_engine(&resources).await?;

        // 2. 确定模型文件
        let config = self.config.lock().await;
        let models_dir = config.models_dir.clone();
        drop(config);

        let active_model_lock = self.active_model.lock().await.clone();
        let all_ggufs = crate::server::api::collect_all_ggufs(&models_dir);

        let model_path = if let Some(m) = active_model_lock {
            let p = std::path::PathBuf::from(&m);
            if p.is_absolute() && p.exists() {
                p
            } else if models_dir.join(&m).exists() {
                models_dir.join(&m)
            } else {
                // 若 active_model 存储的是模型 ID 或相对名，在深度扫描列表中匹配
                let m_lower = m.to_lowercase();
                let m_tail = m_lower.split('/').last().unwrap_or(&m_lower);
                let m_clean = m_tail.split(':').next().unwrap_or(m_tail).replace("-gguf", "");

                all_ggufs.iter().find(|(_, name)| {
                    let name_lower = name.to_lowercase();
                    !name_lower.starts_with("mmproj") && (name_lower.contains(&m_clean) || m_clean.contains(&name_lower.replace(".gguf", "")))
                }).map(|(p, _)| p.clone())
                .or_else(|| {
                    // 降级为已下载的第一个非 mmproj gguf
                    all_ggufs.iter().find(|(_, name)| !name.to_lowercase().starts_with("mmproj")).map(|(p, _)| p.clone())
                })
                .ok_or_else(|| anyhow::anyhow!("未找到模型文件: {}，且当前存储目录中没有可用 GGUF 模型", m))?
            }
        } else {
            // 没有指定激活模型时，从模型目录中挑选第一个已下载就绪的非 mmproj 模型
            all_ggufs.iter().find(|(_, name)| !name.to_lowercase().starts_with("mmproj"))
                .map(|(p, _)| p.clone())
                .ok_or_else(|| anyhow::anyhow!("当前模型存储目录下未检测到任何 GGUF 模型文件，请先在模型管理中下载模型"))?
        };

        if !model_path.exists() {
            return Err(anyhow::anyhow!("模型文件不存在: {}，请在模型管理中重新下载", model_path.display()));
        }

        let model_str = model_path.to_string_lossy().to_string();
        *self.active_model.lock().await = Some(model_str.clone());

        // 自动探测同级或 models_dir 目录下的多模态投影器 mmproj
        let detected_mmproj = {
            let parent_dir = model_path.parent();
            all_ggufs.iter().find(|(p, name)| {
                let n_lower = name.to_lowercase();
                n_lower.starts_with("mmproj") && (p.parent() == parent_dir || p.parent() == Some(&models_dir))
            }).map(|(p, _)| p.to_string_lossy().to_string())
        };

        let model_size_gb = std::fs::metadata(&model_path).map(|m| m.len() as f64 / (1024.0 * 1024.0 * 1024.0)).unwrap_or(1.0);
        let model_lower = model_str.to_lowercase();
        let is_minicpm5 = model_lower.contains("minicpm5");
        let is_nanbeige4 = model_lower.contains("nanbeige4");

        // 提取模型专属参数（若用户在前端配置并保存）
        let active_name_lock = self.active_model_name.lock().await.clone();
        let fallback_stem = model_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("default")
            .to_string();
        let model_alias = active_name_lock.clone().unwrap_or_else(|| fallback_stem.clone());

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
            is_multimodal: detected_mmproj.is_some(),
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
                tracing::info!("引擎服务启动并反代就绪: backend={}, internal_port={}, gateway_port={}", backend_str, llama_internal_port, gateway_port);
                Ok(())
            }
            Err(e) => {
                let err_msg = self.guard.last_error().await.unwrap_or_else(|| e.to_string());
                tracing::error!("引擎就绪探测失败: {}", err_msg);
                // 发生错误停止子进程
                let _ = self.guard.stop().await;
                Err(anyhow::anyhow!("{}", err_msg))
            }
        }
    }

    /// 停止引擎子进程服务
    pub async fn stop_service(&self) -> anyhow::Result<()> {
        self.guard.stop().await?;
        tracing::info!("引擎服务已停止");
        Ok(())
    }
}
