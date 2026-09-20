// hardware/detector.rs
// fastfetch 硬件精准探测器
// 1:1 移植桌面端 HardwareDetectionService（去除 Electron 依赖，改用原生 Rust）

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::path::{PathBuf};
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use super::gpu_info::{
    AccelerationTier, CpuInfo, GpuInfo, GpuVendor, MemoryInfo, SystemResources,
};

/// 硬件检测结果缓存（TTL = 5 分钟）
struct DetectorCache {
    resources: Option<SystemResources>,
    cached_at: Option<Instant>,
    ttl: Duration,
}

impl DetectorCache {
    fn new() -> Self {
        DetectorCache {
            resources: None,
            cached_at: None,
            ttl: Duration::from_secs(300), // 5 分钟
        }
    }

    fn is_valid(&self) -> bool {
        if let (Some(_), Some(at)) = (&self.resources, &self.cached_at) {
            at.elapsed() < self.ttl
        } else {
            false
        }
    }

    fn get(&self) -> Option<&SystemResources> {
        if self.is_valid() {
            self.resources.as_ref()
        } else {
            None
        }
    }

    fn set(&mut self, resources: SystemResources) {
        self.resources = Some(resources);
        self.cached_at = Some(Instant::now());
    }

    fn clear(&mut self) {
        self.resources = None;
        self.cached_at = None;
    }
}

/// 硬件探测服务
pub struct HardwareDetector {
    cache: Mutex<DetectorCache>,
    /// fastfetch 可执行文件路径（lazy 初始化）
    fastfetch_path: Mutex<Option<PathBuf>>,
    /// 应用根目录（用于查找 bin/fastfetch）
    app_dir: PathBuf,
}

impl HardwareDetector {
    pub fn new(app_dir: PathBuf) -> Self {
        HardwareDetector {
            cache: Mutex::new(DetectorCache::new()),
            fastfetch_path: Mutex::new(None),
            app_dir,
        }
    }

    /// 获取 fastfetch 可执行文件路径
    /// 优先级：1. {app_dir}/bin/fastfetch  2. {app_dir}/../bin/fastfetch  3. PATH
    async fn get_fastfetch_path(&self) -> Result<PathBuf> {
        let mut cached = self.fastfetch_path.lock().await;
        if let Some(ref p) = *cached {
            return Ok(p.clone());
        }

        let executable = if cfg!(windows) { "fastfetch.exe" } else { "fastfetch" };

        // 1. {app_dir}/bin/fastfetch
        let candidates = vec![
            self.app_dir.join("bin").join(executable),
            self.app_dir.join("bin").join(format!("fastfetch-{}", executable)),
            // 向上一级（安装到 extraResources/bin/firefly-ai-engine 时）
            self.app_dir.parent().map(|p| p.join("bin").join(executable)).unwrap_or_default(),
            // 开发环境：项目根 bin 目录
            PathBuf::from("bin").join(executable),
        ];

        for candidate in &candidates {
            if candidate.exists() {
                info!("找到 fastfetch: {:?}", candidate);
                // 非 Windows 确保可执行权限
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let meta = std::fs::metadata(candidate)?;
                    let mut perms = meta.permissions();
                    if perms.mode() & 0o111 == 0 {
                        perms.set_mode(perms.mode() | 0o755);
                        std::fs::set_permissions(candidate, perms)?;
                    }
                }
                let path = candidate.clone();
                *cached = Some(path.clone());
                return Ok(path);
            }
        }

        // 2. PATH 中查找
        if let Ok(output) = std::process::Command::new(if cfg!(windows) { "where" } else { "which" })
            .arg(executable)
            .output()
        {
            if output.status.success() {
                let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let path = PathBuf::from(path_str);
                if path.exists() {
                    *cached = Some(path.clone());
                    return Ok(path);
                }
            }
        }

        Err(anyhow!("未找到 fastfetch 可执行文件，已搜索路径: {:?}", candidates))
    }

    /// 执行 fastfetch 并解析 JSON
    async fn run_fastfetch(&self) -> Result<Vec<Value>> {
        let fastfetch_path = self.get_fastfetch_path().await?;

        let output = tokio::time::timeout(
            Duration::from_secs(10),
            Command::new(&fastfetch_path)
                .args(&["--format", "json", "--logo", "none", "--pipe", "true"])
                .env("NO_COLOR", "1")
                .env("LANG", "en_US.UTF-8")
                .env("LC_ALL", "en_US.UTF-8")
                .output(),
        )
        .await
        .context("fastfetch 执行超时（10秒）")?
        .context("执行 fastfetch 失败")?;

        let stdout = String::from_utf8_lossy(&output.stdout);

        if stdout.trim().is_empty() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow!("fastfetch 输出为空, stderr: {}", stderr));
        }

        // 鲁棒性：清理 BOM 等不可见字符，定位到第一个 [ 或 {
        let cleaned = stdout
            .replace('\u{200B}', "")
            .replace('\u{200C}', "")
            .replace('\u{200D}', "")
            .replace('\u{FEFF}', "")
            .replace('\u{00A0}', "");
        let cleaned = cleaned.trim().to_string();

        let start = cleaned.find(|c| c == '[' || c == '{').unwrap_or(0);
        let json_str = &cleaned[start..];

        let parsed: Value = serde_json::from_str(json_str)
            .context("解析 fastfetch JSON 失败")?;

        let array = match parsed {
            Value::Array(arr) => arr,
            Value::Object(_) => vec![parsed],
            _ => return Err(anyhow!("fastfetch 输出格式异常")),
        };

        debug!("fastfetch 原始检测结果 {} 个模块", array.len());
        Ok(array)
    }

    /// 探测系统硬件资源
    pub async fn detect(&self, force_refresh: bool) -> Result<SystemResources> {
        // 检查缓存
        if !force_refresh {
            let cache = self.cache.lock().await;
            if let Some(cached) = cache.get() {
                debug!("使用硬件检测缓存");
                return Ok(cached.clone());
            }
        }

        info!("使用 fastfetch 执行实时硬件探测...");

        let fastfetch_data = match self.run_fastfetch().await {
            Ok(data) => data,
            Err(e) => {
                warn!("fastfetch 执行失败，回退到系统 API 兜底: {}", e);
                return self.fallback_detect().await;
            }
        };

        let cpu = self.parse_cpu(&fastfetch_data);
        let memory = self.parse_memory(&fastfetch_data);
        let gpus = self.parse_gpus(&fastfetch_data, &memory);

        // 计算最佳加速层级
        let best_acceleration_tier = self.compute_best_tier(&gpus);

        info!(
            "硬件探测完成 - CPU: {}, 内存: {:.1}GB, GPU 数量: {}, 最佳层级: {:?}",
            cpu.model,
            memory.total_gb(),
            gpus.len(),
            best_acceleration_tier
        );

        let resources = SystemResources {
            cpu,
            memory,
            gpus,
            best_acceleration_tier,
        };

        let mut cache = self.cache.lock().await;
        cache.set(resources.clone());

        Ok(resources)
    }

    /// 系统 API 兜底（fastfetch 不可用时）
    async fn fallback_detect(&self) -> Result<SystemResources> {
        warn!("使用系统原生 API 兜底（无 GPU 信息）");

        // 使用 std 标准库获取 CPU 和内存信息
        let num_cpus = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(4);

        // 内存信息：通过环境变量获取（Windows）
        let total_mem_mb: u64 = Self::get_system_memory_mb().unwrap_or(8192);

        let cpu = CpuInfo {
            model: "Unknown CPU".to_string(),
            cores: num_cpus.max(1),
            threads: num_cpus,
            speed_mhz: 0,
        };

        let memory = MemoryInfo {
            total_mb: total_mem_mb,
            available_mb: total_mem_mb / 2, // 保守估算
        };

        let resources = SystemResources {
            cpu,
            memory,
            gpus: vec![],
            best_acceleration_tier: AccelerationTier::Cpu,
        };

        Ok(resources)
    }

    fn get_system_memory_mb() -> Option<u64> {
        None
    }

    /// 解析 CPU 信息
    fn parse_cpu(&self, data: &[Value]) -> CpuInfo {
        let cpu_module = data.iter().find(|m| m["type"] == "CPU");

        if let Some(cpu) = cpu_module {
            let result = &cpu["result"];
            return CpuInfo {
                model: result["cpu"].as_str().unwrap_or("Unknown CPU").to_string(),
                cores: result["cores"]["physical"].as_u64().unwrap_or(1) as u32,
                threads: result["cores"]["logical"].as_u64().unwrap_or(1) as u32,
                speed_mhz: result["frequency"]["base"].as_u64().unwrap_or(0),
            };
        }

        CpuInfo {
            model: "Unknown CPU".to_string(),
            cores: 1,
            threads: 1,
            speed_mhz: 0,
        }
    }

    /// 解析内存信息
    fn parse_memory(&self, data: &[Value]) -> MemoryInfo {
        let mem_module = data.iter().find(|m| m["type"] == "Memory");

        if let Some(mem) = mem_module {
            let result = &mem["result"];
            let total = result["total"].as_u64().unwrap_or(0);
            let used = result["used"].as_u64().unwrap_or(0);
            let total_mb = total / 1024 / 1024;
            let used_mb = used / 1024 / 1024;

            return MemoryInfo {
                total_mb,
                available_mb: total_mb.saturating_sub(used_mb),
            };
        }

        MemoryInfo {
            total_mb: 8192,
            available_mb: 4096,
        }
    }

    /// 解析 GPU 列表（1:1 移植桌面端 parseGPUs）
    fn parse_gpus(&self, data: &[Value], memory: &MemoryInfo) -> Vec<GpuInfo> {
        let gpu_module = data.iter().find(|m| m["type"] == "GPU");

        let gpu_module = match gpu_module {
            Some(m) => m,
            None => {
                debug!("未在 fastfetch 输出中找到 GPU 信息");
                return vec![];
            }
        };

        let gpu_array = match gpu_module["result"].as_array() {
            Some(arr) => arr,
            None => return vec![],
        };

        // 检测 CPU 型号（用于 Core Ultra iGPU 识别）
        let cpu_module = data.iter().find(|m| m["type"] == "CPU");
        let cpu_name = cpu_module
            .and_then(|c| c["result"]["name"].as_str())
            .unwrap_or("")
            .to_lowercase();
        let is_core_ultra = cpu_name.contains("core ultra");

        let is_win = cfg!(windows);
        let is_darwin = cfg!(target_os = "macos");

        let mut raw_gpus: Vec<GpuInfo> = gpu_array
            .iter()
            .map(|g| {
                let name = g["name"].as_str().unwrap_or("").trim().to_string();
                let vendor_str = g["vendor"].as_str().unwrap_or("");
                let vendor = GpuVendor::detect(&name, vendor_str);
                let lower_name = name.to_lowercase();

                // 解析显存
                let mut vram_mb: u64 = if let Some(dedicated) = g["memory"]["dedicated"]["total"].as_u64() {
                    dedicated / 1024 / 1024
                } else if let Some(total) = g["memory"]["total"].as_u64() {
                    total / 1024 / 1024
                } else {
                    0
                };

                // Apple Silicon 共享内存：显存为 0 时使用系统内存一半
                if vendor == GpuVendor::Apple && vram_mb == 0
                    && (lower_name.contains("m1") || lower_name.contains("m2")
                        || lower_name.contains("m3") || lower_name.contains("m4"))
                {
                    vram_mb = memory.total_mb / 2;
                }

                let type_str = g["type"].as_str().unwrap_or("").to_lowercase();
                let is_integrated = Self::detect_integrated_gpu(&name, &vendor, &type_str);

                // platform_api 字段
                let platform_api = g["platformApi"].as_str().unwrap_or("");

                let supports_vulkan = platform_api.contains("Vulkan")
                    || (vendor != GpuVendor::Apple)
                    || vendor == GpuVendor::Unknown;

                let supports_sycl = is_win
                    && vendor == GpuVendor::Intel
                    && (lower_name.contains("arc")
                        || lower_name.contains("ultra")
                        || is_core_ultra);

                GpuInfo {
                    name: if name.is_empty() {
                        if vendor != GpuVendor::Unknown {
                            format!("{} GPU", vendor.as_str().to_uppercase())
                        } else {
                            "Unknown GPU".to_string()
                        }
                    } else {
                        name
                    },
                    memory_mb: vram_mb,
                    vendor: vendor.clone(),
                    is_integrated,
                    supports_cuda: vendor == GpuVendor::Nvidia,
                    supports_vulkan,
                    supports_hip: vendor == GpuVendor::Amd,
                    supports_metal: vendor == GpuVendor::Apple
                        || (is_darwin && platform_api.contains("Metal")),
                    supports_sycl,
                }
            })
            .collect();

        // 智能去重：同厂商且显存误差 < 10MB 的视为重复
        raw_gpus.sort_by(|a, b| b.name.len().cmp(&a.name.len())); // 名称更长的优先
        let mut final_gpus: Vec<GpuInfo> = vec![];
        for gpu in raw_gpus {
            let is_dup = final_gpus.iter().any(|existing| {
                existing.vendor == gpu.vendor
                    && (existing.memory_mb as i64 - gpu.memory_mb as i64).unsigned_abs() < 10
            });
            if !is_dup {
                final_gpus.push(gpu);
            }
        }

        // 排序：独显优先，显存越大越高
        Self::sort_gpus(&mut final_gpus);
        debug!("GPU 检测完成，共 {} 个", final_gpus.len());
        final_gpus
    }

    /// 判断是否集成显卡（1:1 移植 detectIntegratedGPU）
    fn detect_integrated_gpu(name: &str, vendor: &GpuVendor, type_str: &str) -> bool {
        let lower_name = name.to_lowercase();
        let lower_type = type_str.to_lowercase();

        // fastfetch 明确标记
        if lower_type.contains("integrated") || lower_type.contains("igpu") {
            return true;
        }
        if lower_type.contains("discrete") || lower_type.contains("dgpu") {
            return false;
        }

        // Apple Silicon：UMA 架构视为核显
        if *vendor == GpuVendor::Apple {
            return true;
        }

        // Intel
        if *vendor == GpuVendor::Intel {
            // Arc 独显
            if lower_name.contains("arc(tm) a")
                || lower_name.contains("arc(tm) b")
                || lower_name.contains("arc a")
                || lower_name.contains("arc b")
                || lower_name.contains("arc pro")
            {
                return false;
            }
            // UHD / HD / Iris 核显
            if lower_name.contains("uhd")
                || lower_name.contains("hd graphics")
                || lower_name.contains("iris")
                || lower_name.contains("intel graphics")
            {
                return true;
            }
        }

        // AMD
        if *vendor == GpuVendor::Amd {
            if lower_name.contains("radeon rx")
                || lower_name.contains("radeon pro")
                || lower_name.contains("radeon vii")
                || lower_name.contains("firepro")
                || lower_name.contains("radeon hd")
                || lower_name.contains("radeon r9")
            {
                return false;
            }
            if lower_name.contains("radeon(tm) graphics")
                || lower_name.contains("radeon graphics")
                || lower_name.contains("vega")
                || lower_name.contains("680m")
                || lower_name.contains("780m")
                || lower_name.contains("890m")
            {
                return true;
            }
        }

        // NVIDIA 默认独显
        if *vendor == GpuVendor::Nvidia {
            return false;
        }

        false
    }

    /// GPU 排序（独显优先，NVIDIA > AMD > Intel > Apple > 其他；同类按显存大小）
    fn sort_gpus(gpus: &mut Vec<GpuInfo>) {
        gpus.sort_by(|a, b| {
            let score = |g: &GpuInfo| -> i64 {
                let base_score = if !g.is_integrated {
                    match g.vendor {
                        GpuVendor::Nvidia => 1000,
                        GpuVendor::Amd => 800,
                        GpuVendor::Intel => 600,
                        _ => 400,
                    }
                } else {
                    match g.vendor {
                        GpuVendor::Apple => 700,
                        GpuVendor::Amd => 200,
                        GpuVendor::Intel => 150,
                        _ => 100,
                    }
                };
                // 显存加权（每 1GB 加 10 分，上限 160）
                let vram_bonus = ((g.memory_mb / 1024).min(16) * 10) as i64;
                base_score + vram_bonus
            };
            score(b).cmp(&score(a))
        });
    }

    /// 计算最佳加速层级（1:1 移植 getBestAccelerationTier）
    fn compute_best_tier(&self, gpus: &[GpuInfo]) -> AccelerationTier {
        let is_win = cfg!(windows);
        let is_linux = cfg!(target_os = "linux");

        let has_nvidia = gpus.iter().any(|g| g.supports_cuda);
        let has_metal = gpus.iter().any(|g| g.supports_metal);
        let has_sycl = gpus.iter().any(|g| g.supports_sycl);
        let has_amd = gpus.iter().any(|g| g.supports_hip);
        let has_vulkan = gpus.iter().any(|g| g.supports_vulkan);

        if has_nvidia {
            return AccelerationTier::Cuda;
        }
        if has_sycl {
            return AccelerationTier::Sycl;
        }
        if has_metal {
            return AccelerationTier::Metal;
        }
        if is_win && has_amd {
            return AccelerationTier::Hip;
        }
        if is_linux && has_amd {
            return AccelerationTier::Rocm;
        }
        if has_vulkan {
            return AccelerationTier::Vulkan;
        }

        AccelerationTier::Cpu
    }

    /// 清除缓存（强制重新探测）
    pub async fn clear_cache(&self) {
        let mut cache = self.cache.lock().await;
        cache.clear();
    }
}
