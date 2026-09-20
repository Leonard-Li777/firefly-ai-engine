// engine/scheduler.rs
// 多引擎优先级调度与自动降级熔断
// 1:1 移植桌面端 BinaryManager + GpuDriverComplianceService 降级流

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

use crate::hardware::{
    AccelerationTier, DowngradeInfo, DowngradeReason, DriverComplianceService, get_fallback_tier,
    SystemResources,
};

/// 已安装引擎信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledEngine {
    /// 引擎目录名（如 llama-b4321-bin-win-cuda-12.4-x64）
    pub dir_name: String,
    /// llama-server 可执行文件完整路径
    pub binary_path: PathBuf,
    /// 加速层级
    pub tier: AccelerationTier,
    /// llama-server 版本/构建号（从目录名提取）
    pub build_num: Option<String>,
}

/// 引擎调度器
pub struct EngineScheduler {
    /// 引擎 bin 目录
    bin_dir: PathBuf,
    /// 驱动合规服务
    compliance: Arc<DriverComplianceService>,
    /// 当前正在使用的引擎（用于防止重启死循环）
    #[allow(dead_code)]
    current_engine: Mutex<Option<InstalledEngine>>,
    /// 当前已降级的层级（防止反复降级）
    degraded_tier: Mutex<Option<AccelerationTier>>,
}

impl EngineScheduler {
    pub fn new(bin_dir: PathBuf, compliance: Arc<DriverComplianceService>) -> Self {
        EngineScheduler {
            bin_dir,
            compliance,
            current_engine: Mutex::new(None),
            degraded_tier: Mutex::new(None),
        }
    }

    /// 扫描 bin/ 目录下所有已安装的引擎
    /// 目录命名规范：llama-b{build}-bin-{platform}-{backend}-{arch}/
    pub async fn scan_installed_engines(&self) -> Vec<InstalledEngine> {
        let bin_dir = &self.bin_dir;
        if !bin_dir.exists() {
            warn!("引擎 bin 目录不存在: {:?}", bin_dir);
            return vec![];
        }

        let server_name = if cfg!(windows) {
            "llama-server.exe"
        } else {
            "llama-server"
        };

        let mut engines = vec![];

        let entries = match std::fs::read_dir(bin_dir) {
            Ok(e) => e,
            Err(e) => {
                error!("读取 bin 目录失败: {}", e);
                return vec![];
            }
        };

        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let dir_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            // 只匹配 llama-* 前缀目录
            if !dir_name.to_lowercase().starts_with("llama-") {
                continue;
            }

            let binary_path = path.join(server_name);
            if !binary_path.exists() {
                continue;
            }

            // 从目录名提取加速层级
            let tier = Self::parse_tier_from_dir(&dir_name);

            // 提取构建号（如 llama-b4321-... → "4321"）
            let build_num = dir_name
                .split('-')
                .find(|seg| seg.starts_with('b') && seg.len() > 1 && seg[1..].parse::<u64>().is_ok())
                .map(|s| s[1..].to_string());

            info!("发现已安装引擎: {} (层级: {:?})", dir_name, tier);

            engines.push(InstalledEngine {
                dir_name,
                binary_path,
                tier,
                build_num,
            });
        }

        // 按优先级排序（CUDA > Vulkan > CPU）
        engines.sort_by_key(|e| e.tier.priority());
        engines
    }

    /// 从目录名解析加速层级
    fn parse_tier_from_dir(dir_name: &str) -> AccelerationTier {
        let lower = dir_name.to_lowercase();
        if lower.contains("cuda") {
            AccelerationTier::Cuda
        } else if lower.contains("rocm") || lower.contains("hip") {
            AccelerationTier::Rocm
        } else if lower.contains("metal") || lower.contains("macos") {
            AccelerationTier::Metal
        } else if lower.contains("vulkan") {
            AccelerationTier::Vulkan
        } else if lower.contains("sycl") {
            AccelerationTier::Sycl
        } else {
            // cpu / avx / x64 保底
            AccelerationTier::Cpu
        }
    }

    /// 选择最佳可用引擎（结合硬件最佳层级 + 已安装引擎 + 降级记录）
    pub async fn select_engine(
        &self,
        resources: &SystemResources,
    ) -> Result<InstalledEngine> {
        let installed = self.scan_installed_engines().await;
        if installed.is_empty() {
            return Err(anyhow!("bin/ 目录下未发现任何 llama-server 引擎"));
        }

        let best_tier = &resources.best_acceleration_tier;
        let degraded = self.degraded_tier.lock().await.clone();

        // 构建候选列表：从最佳层级开始降级
        let mut candidate_tier = best_tier.clone();
        loop {
            // 检查是否已标记为不可用
            let should_skip = if let Some(ref deg) = degraded {
                candidate_tier.priority() <= deg.priority() && &candidate_tier != deg
                    || &candidate_tier == deg
            } else {
                false
            };

            // 跳过已降级的层级
            if !should_skip {
                // 在已安装引擎中查找匹配层级
                if let Some(engine) = installed.iter().find(|e| e.tier == candidate_tier) {
                    // 检查该引擎是否已被标记不合规
                    let binary_str = engine.binary_path.to_string_lossy().to_string();
                    if !self.compliance.is_non_compliant(&binary_str).await {
                        info!("调度选择引擎: {} (层级: {:?})", engine.dir_name, engine.tier);
                        return Ok(engine.clone());
                    } else {
                        warn!("引擎 {} 已被标记不合规，跳过", engine.dir_name);
                    }
                }
            }

            // 尝试降级
            match get_fallback_tier(&candidate_tier) {
                Some(fallback) => {
                    warn!("层级 {:?} 不可用，降级到 {:?}", candidate_tier, fallback);
                    candidate_tier = fallback;
                }
                None => {
                    // 所有层级均不可用时，返回第一个可用引擎（保底 CPU）
                    if let Some(engine) = installed.last() {
                        warn!("所有层级不可用，使用保底 CPU 引擎: {}", engine.dir_name);
                        return Ok(engine.clone());
                    }
                    return Err(anyhow!("没有任何可用的引擎"));
                }
            }
        }
    }

    /// 记录引擎降级（运行时捕获到致命错误时调用）
    pub async fn handle_engine_failure(
        &self,
        failed_engine: &InstalledEngine,
        reason: DowngradeReason,
        resources: &SystemResources,
    ) -> Option<InstalledEngine> {
        let binary_str = failed_engine.binary_path.to_string_lossy().to_string();

        // 标记失败引擎不合规
        self.compliance
            .mark_non_compliant(
                &binary_str,
                reason.clone(),
                resources.primary_gpu().map(|g| g.name.clone()),
            )
            .await;

        // 记录降级信息（防止 UI 反复闪烁）
        let gpu_name = resources
            .primary_gpu()
            .map(|g| g.name.clone())
            .unwrap_or_else(|| "未知 GPU".to_string());

        let fallback_tier = get_fallback_tier(&failed_engine.tier);
        if let Some(ref next_tier) = fallback_tier {
            let message = DriverComplianceService::make_downgrade_message(
                &reason,
                failed_engine.tier.as_str(),
                next_tier.as_str(),
            );
            self.compliance
                .set_downgrade_info(DowngradeInfo {
                    downgraded: true,
                    gpu_name: gpu_name.clone(),
                    best_tier: failed_engine.tier.as_str().to_string(),
                    current_tier: next_tier.as_str().to_string(),
                    reason,
                    message,
                })
                .await;

            // 更新已降级层级记录（防止死循环重启）
            {
                let mut guard = self.degraded_tier.lock().await;
                *guard = Some(failed_engine.tier.clone());
            }
        }

        // 尝试降级选择
        match self.select_engine(resources).await {
            Ok(engine) => {
                info!("降级成功，切换到: {}", engine.dir_name);
                Some(engine)
            }
            Err(e) => {
                error!("降级失败，无可用引擎: {}", e);
                None
            }
        }
    }

    /// 重置降级状态
    pub async fn reset_degradation(&self) {
        let mut guard = self.degraded_tier.lock().await;
        *guard = None;
        self.compliance.clear_cache().await;
        info!("引擎降级状态已重置");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::TempDir;

    fn create_fake_engine(dir: &Path, name: &str) {
        let engine_dir = dir.join(name);
        std::fs::create_dir_all(&engine_dir).unwrap();
        // 创建假的 llama-server 可执行文件
        let bin_name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
        std::fs::write(engine_dir.join(bin_name), b"fake").unwrap();
    }

    #[tokio::test]
    async fn test_scan_finds_engines() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().to_path_buf();

        create_fake_engine(&bin_dir, "llama-b4321-bin-win-cuda-12.4-x64");
        create_fake_engine(&bin_dir, "llama-b4321-bin-win-vulkan-x64");
        create_fake_engine(&bin_dir, "llama-b4321-bin-win-cpu-x64");

        let compliance = DriverComplianceService::new();
        let scheduler = EngineScheduler::new(bin_dir, compliance);

        let engines = scheduler.scan_installed_engines().await;
        assert_eq!(engines.len(), 3, "应发现 3 个引擎");

        // 验证排序：CUDA 优先
        assert_eq!(engines[0].tier, AccelerationTier::Cuda);
        assert_eq!(engines[1].tier, AccelerationTier::Vulkan);
        assert_eq!(engines[2].tier, AccelerationTier::Cpu);
    }

    #[test]
    fn test_parse_tier_from_dir() {
        assert_eq!(
            EngineScheduler::parse_tier_from_dir("llama-b4321-bin-win-cuda-12.4-x64"),
            AccelerationTier::Cuda
        );
        assert_eq!(
            EngineScheduler::parse_tier_from_dir("llama-b4321-bin-win-vulkan-x64"),
            AccelerationTier::Vulkan
        );
        assert_eq!(
            EngineScheduler::parse_tier_from_dir("llama-b4321-bin-win-cpu-x64"),
            AccelerationTier::Cpu
        );
        assert_eq!(
            EngineScheduler::parse_tier_from_dir("llama-b4321-bin-macos-arm64"),
            AccelerationTier::Metal
        );
    }

    #[tokio::test]
    async fn test_non_compliant_engine_skipped() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().to_path_buf();

        create_fake_engine(&bin_dir, "llama-b4321-bin-win-cuda-12.4-x64");
        create_fake_engine(&bin_dir, "llama-b4321-bin-win-vulkan-x64");

        let compliance = DriverComplianceService::new();

        // 标记 CUDA 引擎不合规
        let cuda_path = bin_dir
            .join("llama-b4321-bin-win-cuda-12.4-x64")
            .join("llama-server.exe");
        compliance
            .mark_non_compliant(
                &cuda_path.to_string_lossy(),
                DowngradeReason::GpuDriverOutdated,
                Some("NVIDIA GeForce RTX 3060".to_string()),
            )
            .await;

        let scheduler = EngineScheduler::new(bin_dir, compliance);

        // 创建带 NVIDIA GPU 的 SystemResources
        use crate::hardware::gpu_info::*;
        let resources = SystemResources {
            cpu: CpuInfo { model: "Test".to_string(), cores: 8, threads: 16, speed_mhz: 3000 },
            memory: MemoryInfo { total_mb: 16384, available_mb: 8192 },
            gpus: vec![GpuInfo {
                name: "NVIDIA GeForce RTX 3060".to_string(),
                memory_mb: 12 * 1024,
                vendor: GpuVendor::Nvidia,
                is_integrated: false,
                supports_cuda: true,
                supports_vulkan: true,
                supports_hip: false,
                supports_metal: false,
                supports_sycl: false,
            }],
            best_acceleration_tier: AccelerationTier::Cuda,
        };

        // 应自动降级到 Vulkan
        let selected = scheduler.select_engine(&resources).await.unwrap();
        assert_eq!(selected.tier, AccelerationTier::Vulkan, "应降级到 Vulkan");
    }
}
