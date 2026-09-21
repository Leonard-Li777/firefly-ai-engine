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
use crate::config::EngineConfig;

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
    /// 当前正在使用的端口
    pub active_port: Arc<Mutex<Option<u16>>>,
    /// 当前活跃引擎
    pub active_engine: Arc<Mutex<Option<InstalledEngine>>>,
    /// 当前加载的模型路径
    pub active_model: Arc<Mutex<Option<String>>>,
}

impl EngineCoordinator {
    pub fn new(
        hardware: Arc<HardwareDetector>,
        compliance: Arc<DriverComplianceService>,
        bin_dir: PathBuf,
        config: Arc<Mutex<EngineConfig>>,
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
            active_engine: Arc::new(Mutex::new(None)),
            active_model: Arc::new(Mutex::new(None)),
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

        let active_engine = self.active_engine.lock().await.clone();
        let active_backend = active_engine
            .as_ref()
            .map(|e| e.tier.as_str().to_string())
            .unwrap_or_else(|| "cpu".to_string());

        let active_model = self.active_model.lock().await.clone();
        let active_port = self.active_port.lock().await.clone().unwrap_or(38400);

        let config = self.config.lock().await;
        let models_dir = config.models_dir.to_string_lossy().to_string();

        // 获取硬件信息
        let hardware = match self.hardware.detect(false).await {
            Ok(resources) => {
                let gpu = resources.primary_gpu();
                HardwareSummary {
                    gpu_name: gpu.map(|g| g.name.clone()).unwrap_or_default(),
                    total_vram_gb: gpu.map(|g| g.memory_gb()).unwrap_or(0.0),
                    used_vram_gb: None,
                    best_tier: resources.best_acceleration_tier.as_str().to_string(),
                    current_tier: active_backend.clone(),
                    is_integrated: gpu.map(|g| g.is_integrated).unwrap_or(false),
                    cpu_cores: Some(resources.cpu.cores as usize),
                    cpu_threads: Some(resources.cpu.threads as usize),
                    os_platform: Some(std::env::consts::OS.to_string()),
                    total_ram_gb: Some(resources.memory.total_gb()),
                    used_ram_gb: Some(((resources.memory.total_mb.saturating_sub(resources.memory.available_mb)) as f64) / 1024.0),
                }
            }
            Err(_) => HardwareSummary {
                gpu_name: String::new(),
                total_vram_gb: 0.0,
                used_vram_gb: None,
                best_tier: "cpu".to_string(),
                current_tier: active_backend.clone(),
                is_integrated: false,
                cpu_cores: None,
                cpu_threads: None,
                os_platform: Some(std::env::consts::OS.to_string()),
                total_ram_gb: None,
                used_ram_gb: None,
            },
        };

        let downgrade_info = self.compliance.get_downgrade_info().await;

        let runtime_params = Some(serde_json::json!({
            "n_gpu_layers": 24,
            "threads": 8,
            "ctx_size": 4096,
            "batch_size": 512,
            "ubatch_size": 256
        }));

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
        }
    }
}
