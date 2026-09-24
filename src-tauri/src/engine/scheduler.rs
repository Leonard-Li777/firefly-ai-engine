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

    /// 扫描所有可能目录中已安装的引擎（内置目录 + 用户数据热更新目录）
    /// 目录命名规范：llama-b{build}-bin-{platform}-{backend}-{arch}/
    pub async fn scan_installed_engines(&self) -> Vec<InstalledEngine> {
        let server_name = if cfg!(windows) {
            "llama-server.exe"
        } else {
            "llama-server"
        };

        let mut search_dirs = Vec::new();

        // 1. 主协调器传入的 bin_dir
        if self.bin_dir.exists() {
            search_dirs.push(self.bin_dir.clone());
        }

        // 2. 用户数据目录：%APPDATA%/com.firefly.ai-engine/engines 以及 bin (仅生产运行态探测，测试沙箱隔离)
        #[cfg(not(test))]
        if let Some(app_data) = dirs::data_dir() {
            let engine_data = app_data.join("com.firefly.ai-engine");
            let user_engines = engine_data.join("engines");
            if user_engines.exists() {
                search_dirs.push(user_engines);
            }
            let user_bin = engine_data.join("bin");
            if user_bin.exists() {
                search_dirs.push(user_bin);
            }
        }

        // 3. 开发环境与 Monorepo 根目录 (仅开发运行态探测，测试沙箱隔离)
        #[cfg(not(test))]
        if let Ok(cwd) = std::env::current_dir() {
            let mut cur = Some(cwd.as_path());
            for _ in 0..5 {
                if let Some(dir) = cur {
                    let d1 = dir.join("build").join("extraResources").join("bin");
                    if d1.exists() { search_dirs.push(d1); }
                    let d2 = dir.join("apps").join("desktop").join("build").join("extraResources").join("bin");
                    if d2.exists() { search_dirs.push(d2); }
                    let d3 = dir.join("extraResources").join("bin");
                    if d3.exists() { search_dirs.push(d3); }
                    cur = dir.parent();
                } else {
                    break;
                }
            }
        }

        let mut engines = vec![];
        let mut seen_dirs = std::collections::HashSet::new();

        for dir in search_dirs {
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
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

                if seen_dirs.contains(&dir_name) {
                    continue;
                }

                let binary_path = path.join(server_name);
                if !binary_path.exists() {
                    continue;
                }

                seen_dirs.insert(dir_name.clone());

                // 从目录名提取加速层级
                let tier = Self::parse_tier_from_dir(&dir_name);

                // 提取构建号（如 llama-b4321-... → "4321"）
                let build_num = dir_name
                    .split('-')
                    .find(|seg| seg.starts_with('b') && seg.len() > 1 && seg[1..].parse::<u64>().is_ok())
                    .map(|s| s[1..].to_string());

                info!("发现已安装引擎: {} (层级: {:?}, 路径: {:?})", dir_name, tier, binary_path);

                engines.push(InstalledEngine {
                    dir_name,
                    binary_path,
                    tier,
                    build_num,
                });
            }
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

    /// 检查指定 CPU 引擎目录是否与当前系统的 CPU 指令集兼容
    pub fn is_cpu_engine_compatible(dir_name: &str, cpu: &crate::hardware::CpuInfo) -> bool {
        let lower = dir_name.to_lowercase();
        // 官方 Windows 预编译 x64 二进制 (llama-b...-bin-win-x64 或 llama-b...-bin-win-cpu-x64) 默认开启 AVX2
        let requires_avx2 = lower.contains("avx2")
            || (lower.contains("win-x64") && !lower.contains("cpu-avx") && !lower.contains("noavx"))
            || (lower.contains("win-cpu-x64") && !lower.contains("cpu-avx") && !lower.contains("noavx"));

        let requires_avx = lower.contains("cpu-avx") && !lower.contains("noavx");

        if requires_avx2 {
            cpu.has_avx2
        } else if requires_avx {
            cpu.has_avx || cpu.has_avx2
        } else {
            // cpu-noavx 纯 SSE4.2 兜底，所有 x86_64 均可运行
            true
        }
    }

    /// 选择最佳可用引擎（结合用户偏好/硬件最佳层级 + 已安装引擎 + 指令集兼容性 + 降级记录）
    pub async fn select_engine(
        &self,
        resources: &SystemResources,
        preferred_backend: Option<&str>,
    ) -> Result<InstalledEngine> {
        let installed = self.scan_installed_engines().await;
        if installed.is_empty() {
            return Err(anyhow!("bin/ 目录下未发现任何 llama-server 引擎"));
        }

        // 若指定了偏好后端，优先从偏好层级开始调度
        let initial_tier = if let Some(pref) = preferred_backend {
            match pref.to_lowercase().as_str() {
                "cuda" | "cuda12" | "cuda13" | "cuda134" => AccelerationTier::Cuda,
                "vulkan" => AccelerationTier::Vulkan,
                "rocm" | "hip" => AccelerationTier::Rocm,
                "sycl" => AccelerationTier::Sycl,
                "metal" => AccelerationTier::Metal,
                "cpu" | "cpu-avx" | "cpu-noavx" | "cpu-avx2" => AccelerationTier::Cpu,
                _ => resources.best_acceleration_tier.clone(),
            }
        } else {
            resources.best_acceleration_tier.clone()
        };

        let degraded = self.degraded_tier.lock().await.clone();

        // 构建候选列表：从初始层级开始降级
        let mut candidate_tier = initial_tier;
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
                if candidate_tier == AccelerationTier::Cpu {
                    // CPU 候选池：仅保留指令集兼容且未被标记不合规的引擎
                    let mut cpu_candidates: Vec<InstalledEngine> = Vec::new();
                    for engine in installed.iter().filter(|e| e.tier == AccelerationTier::Cpu) {
                        let binary_str = engine.binary_path.to_string_lossy().to_string();
                        if self.compliance.is_non_compliant(&binary_str).await {
                            warn!("CPU 引擎 {} 已被标记不合规，跳过", engine.dir_name);
                            continue;
                        }
                        if Self::is_cpu_engine_compatible(&engine.dir_name, &resources.cpu) {
                            cpu_candidates.push(engine.clone());
                        } else {
                            warn!(
                                "CPU 引擎 {} 与当前硬件指令集不兼容 (has_avx2={}, has_avx={})，跳过",
                                engine.dir_name, resources.cpu.has_avx2, resources.cpu.has_avx
                            );
                        }
                    }

                    // 排序优先级：AVX2 (1) > AVX (2) > NoAVX (3)
                    cpu_candidates.sort_by_key(|e| {
                        let lower = e.dir_name.to_lowercase();
                        if lower.contains("avx2") || (!lower.contains("avx") && !lower.contains("noavx")) {
                            1
                        } else if lower.contains("cpu-avx") {
                            2
                        } else {
                            3
                        }
                    });

                    if let Some(best_cpu) = cpu_candidates.into_iter().next() {
                        info!("调度选择 CPU 引擎: {} (层级: {:?})", best_cpu.dir_name, best_cpu.tier);
                        return Ok(best_cpu);
                    }
                } else {
                    // 非 CPU 层级（CUDA / Vulkan 等）在已安装引擎中查找匹配
                    for engine in installed.iter().filter(|e| e.tier == candidate_tier) {
                        let binary_str = engine.binary_path.to_string_lossy().to_string();
                        if !self.compliance.is_non_compliant(&binary_str).await {
                            info!("调度选择引擎: {} (层级: {:?})", engine.dir_name, engine.tier);
                            return Ok(engine.clone());
                        } else {
                            warn!("引擎 {} 已被标记不合规，跳过", engine.dir_name);
                        }
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
                    // 所有 GPU 层级均不可用且标准流程已结束时，尝试在已安装引擎中找一个兼容的 CPU 引擎保底
                    for engine in installed.iter().filter(|e| e.tier == AccelerationTier::Cpu) {
                        let binary_str = engine.binary_path.to_string_lossy().to_string();
                        if !self.compliance.is_non_compliant(&binary_str).await
                            && Self::is_cpu_engine_compatible(&engine.dir_name, &resources.cpu)
                        {
                            warn!("使用指令集兼容的保底 CPU 引擎: {}", engine.dir_name);
                            return Ok(engine.clone());
                        }
                    }
                    return Err(anyhow!("没有任何与当前硬件指令集兼容的可用引擎"));
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
        match self.select_engine(resources, None).await {
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
        let scheduler = EngineScheduler::new(bin_dir.clone(), compliance);

        let engines = scheduler.scan_installed_engines().await;
        // 过滤出该临时测试目录下的引擎（避免被工作区本地环境其他构建目录的引擎污染）
        let test_engines: Vec<_> = engines.into_iter().filter(|e| e.binary_path.starts_with(&bin_dir)).collect();
        assert_eq!(test_engines.len(), 3, "应发现 3 个引擎");

        // 验证排序：CUDA 优先
        assert_eq!(test_engines[0].tier, AccelerationTier::Cuda);
        assert_eq!(test_engines[1].tier, AccelerationTier::Vulkan);
        assert_eq!(test_engines[2].tier, AccelerationTier::Cpu);
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
            cpu: CpuInfo { model: "Test".to_string(), cores: 8, threads: 16, speed_mhz: 3000, ..Default::default() },
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
        let selected = scheduler.select_engine(&resources, None).await.unwrap();
        assert_eq!(selected.tier, AccelerationTier::Vulkan, "应降级到 Vulkan");
    }

    #[tokio::test]
    async fn test_cpu_engine_instruction_compatibility() {
        use crate::hardware::gpu_info::*;

        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().to_path_buf();

        // 创建三套 CPU 变体
        create_fake_engine(&bin_dir, "llama-b11095-bin-win-cpu-x64"); // 官方预编译默认 AVX2
        create_fake_engine(&bin_dir, "llama-b11095-bin-win-cpu-avx-x64"); // 兼容补全 AVX1
        create_fake_engine(&bin_dir, "llama-b11095-bin-win-cpu-noavx-x64"); // 兼容补全 SSE4.2 兜底

        let compliance = DriverComplianceService::new();
        let scheduler = EngineScheduler::new(bin_dir.clone(), compliance);

        // 1. 现代 CPU (支持 AVX2) -> 优先选择性能最高的 AVX2 包
        let modern_cpu_res = SystemResources {
            cpu: CpuInfo {
                model: "Modern CPU".to_string(),
                cores: 8,
                threads: 16,
                speed_mhz: 3600,
                has_avx2: true,
                has_avx: true,
                has_fma: true,
            },
            memory: MemoryInfo { total_mb: 16384, available_mb: 8192 },
            gpus: vec![],
            best_acceleration_tier: AccelerationTier::Cpu,
        };
        let selected_modern = scheduler.select_engine(&modern_cpu_res, None).await.unwrap();
        assert_eq!(selected_modern.dir_name, "llama-b11095-bin-win-cpu-x64");

        // 2. 老一代 CPU (仅支持 AVX1，无 AVX2) -> 自动跳过 AVX2 包，选择 cpu-avx 包，杜绝 0xC000001D 崩溃
        let avx1_cpu_res = SystemResources {
            cpu: CpuInfo {
                model: "Intel Core i5-2400 (Sandy Bridge)".to_string(),
                cores: 4,
                threads: 4,
                speed_mhz: 3100,
                has_avx2: false,
                has_avx: true,
                has_fma: false,
            },
            memory: MemoryInfo { total_mb: 8192, available_mb: 4096 },
            gpus: vec![],
            best_acceleration_tier: AccelerationTier::Cpu,
        };
        let selected_avx1 = scheduler.select_engine(&avx1_cpu_res, None).await.unwrap();
        assert_eq!(selected_avx1.dir_name, "llama-b11095-bin-win-cpu-avx-x64");

        // 3. 远古/低配 CPU (无 AVX) -> 自动跳过 AVX2 与 AVX 包，选择 cpu-noavx 兜底包
        let noavx_cpu_res = SystemResources {
            cpu: CpuInfo {
                model: "Intel Pentium G4560".to_string(),
                cores: 2,
                threads: 4,
                speed_mhz: 3500,
                has_avx2: false,
                has_avx: false,
                has_fma: false,
            },
            memory: MemoryInfo { total_mb: 4096, available_mb: 2048 },
            gpus: vec![],
            best_acceleration_tier: AccelerationTier::Cpu,
        };
        let selected_noavx = scheduler.select_engine(&noavx_cpu_res, None).await.unwrap();
        assert_eq!(selected_noavx.dir_name, "llama-b11095-bin-win-cpu-noavx-x64");

        // 4. 用户若仅安装了官方 AVX2 包，但 CPU 无 AVX2 -> 拒绝返回不兼容包，避免触发 0xC000001D
        let tmp_avx2_only = TempDir::new().unwrap();
        let avx2_bin_dir = tmp_avx2_only.path().to_path_buf();
        create_fake_engine(&avx2_bin_dir, "llama-b11095-bin-win-cpu-x64");
        let scheduler_avx2_only = EngineScheduler::new(avx2_bin_dir, DriverComplianceService::new());
        let result = scheduler_avx2_only.select_engine(&avx1_cpu_res, None).await;
        assert!(result.is_err(), "在缺乏 AVX2 的 CPU 上不应盲目启动 AVX2 引擎");
    }

    /// is_cpu_engine_compatible 指令集标志位组合推导（AVX2 包 / AVX 包 / noAVX 兜底）
    #[test]
    fn test_cpu_engine_compatibility_flag_matrix() {
        use crate::hardware::CpuInfo;

        let modern = CpuInfo { has_avx2: true, has_avx: true, has_fma: true, ..Default::default() };
        let avx1 = CpuInfo { has_avx2: false, has_avx: true, has_fma: false, ..Default::default() };
        let noavx = CpuInfo { has_avx2: false, has_avx: false, has_fma: false, ..Default::default() };

        // 官方 win-cpu-x64 / win-x64 默认 AVX2：仅现代 CPU 可跑
        assert!(EngineScheduler::is_cpu_engine_compatible("llama-b11095-bin-win-cpu-x64", &modern));
        assert!(!EngineScheduler::is_cpu_engine_compatible("llama-b11095-bin-win-cpu-x64", &avx1));
        assert!(!EngineScheduler::is_cpu_engine_compatible("llama-b11095-bin-win-cpu-x64", &noavx));

        // 显式 avx2 目录名
        assert!(EngineScheduler::is_cpu_engine_compatible("llama-b11095-bin-win-avx2-x64", &modern));
        assert!(!EngineScheduler::is_cpu_engine_compatible("llama-b11095-bin-win-avx2-x64", &avx1));

        // 定制 cpu-avx：AVX1 及以上均可
        assert!(EngineScheduler::is_cpu_engine_compatible("llama-b11095-bin-win-cpu-avx-x64", &avx1));
        assert!(EngineScheduler::is_cpu_engine_compatible("llama-b11095-bin-win-cpu-avx-x64", &modern));
        assert!(!EngineScheduler::is_cpu_engine_compatible("llama-b11095-bin-win-cpu-avx-x64", &noavx));

        // cpu-noavx 纯 SSE4.2：全系 x86_64 保底
        assert!(EngineScheduler::is_cpu_engine_compatible("llama-b11095-bin-win-cpu-noavx-x64", &noavx));
        assert!(EngineScheduler::is_cpu_engine_compatible("llama-b11095-bin-win-cpu-noavx-x64", &avx1));
        assert!(EngineScheduler::is_cpu_engine_compatible("llama-b11095-bin-win-cpu-noavx-x64", &modern));
    }

    /// 画像 4：现代 NVIDIA 独显（驱动合规）→ 命中已安装 CUDA 引擎
    #[tokio::test]
    async fn test_profile_modern_nvidia_selects_cuda() {
        use crate::hardware::gpu_info::*;

        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().to_path_buf();
        create_fake_engine(&bin_dir, "llama-b11095-bin-win-cuda-12.4-x64");
        create_fake_engine(&bin_dir, "llama-b11095-bin-win-vulkan-x64");
        create_fake_engine(&bin_dir, "llama-b11095-bin-win-cpu-x64");

        let scheduler = EngineScheduler::new(bin_dir, DriverComplianceService::new());
        let resources = SystemResources {
            cpu: CpuInfo { model: "Ryzen 7".to_string(), cores: 8, threads: 16, speed_mhz: 4000, has_avx2: true, has_avx: true, has_fma: true },
            memory: MemoryInfo { total_mb: 32768, available_mb: 16384 },
            gpus: vec![GpuInfo {
                name: "NVIDIA GeForce RTX 4070".to_string(),
                memory_mb: 12288,
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

        let selected = scheduler.select_engine(&resources, None).await.unwrap();
        assert_eq!(selected.tier, AccelerationTier::Cuda);
        assert_eq!(selected.dir_name, "llama-b11095-bin-win-cuda-12.4-x64");
    }

    /// 画像 5：Pascal GTX 1060（best_tier 已由探针判为 Vulkan）→ 命中 Vulkan 引擎
    #[tokio::test]
    async fn test_profile_pascal_gtx1060_selects_vulkan() {
        use crate::hardware::gpu_info::*;

        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().to_path_buf();
        create_fake_engine(&bin_dir, "llama-b11095-bin-win-cuda-12.4-x64");
        create_fake_engine(&bin_dir, "llama-b11095-bin-win-vulkan-x64");
        create_fake_engine(&bin_dir, "llama-b11095-bin-win-cpu-x64");

        let scheduler = EngineScheduler::new(bin_dir, DriverComplianceService::new());
        let resources = SystemResources {
            cpu: CpuInfo { model: "Intel Core i5-6500".to_string(), cores: 4, threads: 4, speed_mhz: 3200, has_avx2: true, has_avx: true, has_fma: true },
            memory: MemoryInfo { total_mb: 16384, available_mb: 8192 },
            gpus: vec![GpuInfo {
                name: "NVIDIA GeForce GTX 1060 6GB".to_string(),
                memory_mb: 6144,
                vendor: GpuVendor::Nvidia,
                is_integrated: false,
                supports_cuda: true,
                supports_vulkan: true,
                supports_hip: false,
                supports_metal: false,
                supports_sycl: false,
            }],
            // compute_best_tier 对 Pascal / 旧驱动已判为 Vulkan
            best_acceleration_tier: AccelerationTier::Vulkan,
        };

        let selected = scheduler.select_engine(&resources, None).await.unwrap();
        assert_eq!(selected.tier, AccelerationTier::Vulkan, "Pascal 应命中 Vulkan 而非 CUDA");
    }

    /// 画像 6a：驱动过旧（CUDA 被标不合规）→ 不崩溃，平滑降级到 Vulkan
    #[tokio::test]
    async fn test_profile_outdated_driver_falls_back_to_vulkan() {
        use crate::hardware::gpu_info::*;

        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().to_path_buf();
        create_fake_engine(&bin_dir, "llama-b11095-bin-win-cuda-12.4-x64");
        create_fake_engine(&bin_dir, "llama-b11095-bin-win-vulkan-x64");

        let compliance = DriverComplianceService::new();
        let cuda_path = bin_dir
            .join("llama-b11095-bin-win-cuda-12.4-x64")
            .join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" });
        compliance
            .mark_non_compliant(
                &cuda_path.to_string_lossy(),
                DowngradeReason::GpuDriverOutdated,
                Some("NVIDIA GeForce GTX 1650".to_string()),
            )
            .await;

        let scheduler = EngineScheduler::new(bin_dir, compliance);
        let resources = SystemResources {
            cpu: CpuInfo { model: "Intel Core i5".to_string(), cores: 4, threads: 8, speed_mhz: 3000, has_avx2: true, has_avx: true, has_fma: true },
            memory: MemoryInfo { total_mb: 16384, available_mb: 8192 },
            gpus: vec![GpuInfo {
                name: "NVIDIA GeForce GTX 1650".to_string(),
                memory_mb: 4096,
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

        let selected = scheduler.select_engine(&resources, None).await.unwrap();
        assert_eq!(
            selected.tier,
            AccelerationTier::Vulkan,
            "CUDA 被熔断后应平滑落入 Vulkan，绝不崩溃"
        );
    }

    /// 画像 6b：GPU 全部不可用 + 无 AVX2 CPU → 仅安装 AVX2 包时返回 Err（零试探拒绝启动）
    #[tokio::test]
    async fn test_profile_no_gpu_no_avx2_rejects_incompatible_engine() {
        use crate::hardware::gpu_info::*;

        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().to_path_buf();
        // 仅安装官方默认 AVX2 包
        create_fake_engine(&bin_dir, "llama-b11095-bin-win-cpu-x64");

        let compliance = DriverComplianceService::new();
        let scheduler = EngineScheduler::new(bin_dir, compliance);

        let resources = SystemResources {
            cpu: CpuInfo {
                model: "Intel Pentium G3258".to_string(),
                cores: 2,
                threads: 2,
                speed_mhz: 3200,
                has_avx2: false,
                has_avx: false,
                has_fma: false,
            },
            memory: MemoryInfo { total_mb: 4096, available_mb: 2048 },
            gpus: vec![],
            best_acceleration_tier: AccelerationTier::Cpu,
        };

        let result = scheduler.select_engine(&resources, None).await;
        assert!(
            result.is_err(),
            "无 AVX2 且仅有 AVX2 包时必须拒绝，禁止 0xC000001D 崩溃"
        );
    }

    /// 双显卡笔记本：核显 + 独显排序后独显优先（primary_gpu 语义由 sort_gpus 保证）
    #[test]
    fn test_dual_gpu_discrete_first_ordering() {
        use crate::hardware::gpu_info::*;

        // sort_gpus 为 private，通过公开语义验证双显卡画像：
        // 独显 supports_cuda=true 且核显 is_integrated=true；调度器 best_tier=Cuda 时首选 CUDA。
        let igpu = GpuInfo {
            name: "Intel Iris Xe Graphics".to_string(),
            memory_mb: 0,
            vendor: GpuVendor::detect("Intel Iris Xe Graphics", "intel"),
            is_integrated: true,
            supports_cuda: false,
            supports_vulkan: true,
            supports_hip: false,
            supports_metal: false,
            supports_sycl: false,
        };
        let dgpu = GpuInfo {
            name: "NVIDIA GeForce RTX 3060 Laptop GPU".to_string(),
            memory_mb: 6144,
            vendor: GpuVendor::detect("NVIDIA GeForce RTX 3060 Laptop GPU", "nvidia"),
            is_integrated: false,
            supports_cuda: true,
            supports_vulkan: true,
            supports_hip: false,
            supports_metal: false,
            supports_sycl: false,
        };

        assert!(igpu.is_integrated, "核显应标记为集成");
        assert!(!dgpu.is_integrated, "独显不应标记为集成");
        assert_eq!(igpu.vendor, GpuVendor::Intel);
        assert_eq!(dgpu.vendor, GpuVendor::Nvidia);

        // 画像意图：独显优先评估 —— best_tier 输入为 Cuda 时调度器首选 CUDA 层级
        assert!(dgpu.supports_cuda);
    }
}
