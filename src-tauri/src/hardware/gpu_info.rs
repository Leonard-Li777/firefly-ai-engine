// hardware/gpu_info.rs
// GPU 信息数据结构，1:1 对应桌面端 IGPUInfo 类型

use serde::{Deserialize, Serialize};

/// GPU 厂商
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Apple,
    Unknown,
}

impl GpuVendor {
    /// 从名称字符串检测厂商
    pub fn detect(name: &str, vendor_str: &str) -> Self {
        let combined = format!("{} {}", name, vendor_str).to_lowercase();

        if combined.contains("nvidia") || combined.contains("geforce") || combined.contains("quadro") {
            return GpuVendor::Nvidia;
        }
        if combined.contains("amd") || combined.contains("radeon") {
            return GpuVendor::Amd;
        }
        if combined.contains("intel") || combined.contains("arc") || combined.contains("iris") {
            return GpuVendor::Intel;
        }
        if combined.contains("apple") || combined.contains("m1") || combined.contains("m2")
            || combined.contains("m3") || combined.contains("m4")
        {
            return GpuVendor::Apple;
        }

        GpuVendor::Unknown
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            GpuVendor::Nvidia => "nvidia",
            GpuVendor::Amd => "amd",
            GpuVendor::Intel => "intel",
            GpuVendor::Apple => "apple",
            GpuVendor::Unknown => "unknown",
        }
    }
}

/// GPU 信息（对应桌面端 IGPUInfo）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuInfo {
    /// 显卡名称
    pub name: String,
    /// 显存大小（MB）
    pub memory_mb: u64,
    /// 厂商
    pub vendor: GpuVendor,
    /// 是否为集成显卡
    pub is_integrated: bool,
    /// 支持 CUDA
    pub supports_cuda: bool,
    /// 支持 Vulkan
    pub supports_vulkan: bool,
    /// 支持 HIP/ROCm
    pub supports_hip: bool,
    /// 支持 Metal
    pub supports_metal: bool,
    /// 支持 SYCL (Intel Arc)
    pub supports_sycl: bool,
}

impl GpuInfo {
    /// 构建空 CPU 保底 GPU
    pub fn cpu_fallback() -> Self {
        GpuInfo {
            name: "CPU".to_string(),
            memory_mb: 0,
            vendor: GpuVendor::Unknown,
            is_integrated: false,
            supports_cuda: false,
            supports_vulkan: false,
            supports_hip: false,
            supports_metal: false,
            supports_sycl: false,
        }
    }

    /// 显存大小（GB，保留一位小数）
    pub fn memory_gb(&self) -> f64 {
        ((self.memory_mb as f64 / 1024.0) * 10.0).round() / 10.0
    }
}

/// 最佳硬件加速层级（按优先级排序：CUDA > ROCm > Metal > Vulkan > CPU）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccelerationTier {
    Cuda,
    Rocm,
    Hip,
    Metal,
    Sycl,
    Vulkan,
    Cpu,
}

impl AccelerationTier {
    pub fn as_str(&self) -> &'static str {
        match self {
            AccelerationTier::Cuda => "cuda",
            AccelerationTier::Rocm => "rocm",
            AccelerationTier::Hip => "hip",
            AccelerationTier::Metal => "metal",
            AccelerationTier::Sycl => "sycl",
            AccelerationTier::Vulkan => "vulkan",
            AccelerationTier::Cpu => "cpu",
        }
    }

    /// 从字符串解析
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "cuda" => AccelerationTier::Cuda,
            "rocm" => AccelerationTier::Rocm,
            "hip" => AccelerationTier::Hip,
            "metal" => AccelerationTier::Metal,
            "sycl" => AccelerationTier::Sycl,
            "vulkan" => AccelerationTier::Vulkan,
            _ => AccelerationTier::Cpu,
        }
    }

    /// 优先级排序（值越小优先级越高）
    pub fn priority(&self) -> u8 {
        match self {
            AccelerationTier::Cuda => 0,
            AccelerationTier::Hip => 1,
            AccelerationTier::Sycl => 2,
            AccelerationTier::Rocm => 3,
            AccelerationTier::Metal => 4,
            AccelerationTier::Vulkan => 5,
            AccelerationTier::Cpu => 6,
        }
    }

    /// 是否高于另一个层级（用于降级判断）
    pub fn is_higher_than(&self, other: &AccelerationTier) -> bool {
        self.priority() < other.priority()
    }
}

/// 系统 CPU 信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuInfo {
    pub model: String,
    /// 物理核心数
    pub cores: u32,
    /// 逻辑线程数
    pub threads: u32,
    /// 频率 MHz
    pub speed_mhz: u64,
}

/// 系统内存信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryInfo {
    /// 总内存（MB）
    pub total_mb: u64,
    /// 可用内存（MB）
    pub available_mb: u64,
}

impl MemoryInfo {
    pub fn total_gb(&self) -> f64 {
        self.total_mb as f64 / 1024.0
    }
}

/// 系统硬件资源（综合）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemResources {
    pub cpu: CpuInfo,
    pub memory: MemoryInfo,
    pub gpus: Vec<GpuInfo>,
    /// 最佳加速层级
    pub best_acceleration_tier: AccelerationTier,
}

impl SystemResources {
    /// 获取主 GPU（排序后第一个）
    pub fn primary_gpu(&self) -> Option<&GpuInfo> {
        self.gpus.first()
    }

    /// 是否为 Apple Silicon
    pub fn is_apple_silicon(&self) -> bool {
        self.gpus.iter().any(|g| g.vendor == GpuVendor::Apple)
    }
}

/// Pascal 架构 GPU 型号匹配（不支持 Flash Attention）
/// 1:1 移植桌面端 PASCAL_GPU_PATTERNS
static PASCAL_GPU_PATTERNS: &[&str] = &[
    "gtx 1030", "gtx 1050", "gtx 1050 ti", "gtx 1060", "gtx 1070", "gtx 1070 ti",
    "gtx 1080", "gtx 1080 ti",
    "titan xp", "titan x (pascal)",
    "quadro p400", "quadro p600", "quadro p1000", "quadro p2000",
    "quadro p4000", "quadro p5000", "quadro p6000", "quadro gp100",
    "tesla p4", "tesla p40", "tesla p100",
];

/// 判断 GPU 是否为 Pascal 架构（不支持 Flash Attention）
pub fn is_pascal_arch_gpu(gpu_name: &str) -> bool {
    let name_lower = gpu_name.to_lowercase();

    for pattern in PASCAL_GPU_PATTERNS {
        if name_lower.contains(pattern) {
            return true;
        }
    }

    // 正则级模式检测 GTX 10xx 系列
    let gtx10xx = regex::Regex::new(r"gtx\s*10(3|5|6|7|8)0(\s*ti)?").unwrap();
    if gtx10xx.is_match(&name_lower) {
        return true;
    }

    // Titan XP / TITAN X (Pascal)
    if name_lower.contains("titan xp") || name_lower.contains("titan x (pascal)") {
        return true;
    }

    // Quadro Pxxx
    let quadro_p = regex::Regex::new(r"quadro\s*p(400|600|1000|2000|4000|5000|6000)\b").unwrap();
    if quadro_p.is_match(&name_lower) || name_lower.contains("quadro gp100") {
        return true;
    }

    // Tesla P 系列
    let tesla_p = regex::Regex::new(r"tesla\s*p(4|40|100)\b").unwrap();
    if tesla_p.is_match(&name_lower) {
        return true;
    }

    false
}

/// 判断显卡是否支持 Flash Attention
pub fn is_flash_attention_supported(backend: &str, gpu_name: &str) -> bool {
    if backend == "cpu" || backend == "vulkan" {
        return false;
    }

    let upper_gpu = gpu_name.to_uppercase();

    match backend.to_lowercase().as_str() {
        "cuda" => {
            // 排除 GTX / MX Pascal 卡
            if upper_gpu.contains("GTX") || upper_gpu.contains("MX") {
                return false;
            }
            // RTX 系列支持
            if upper_gpu.contains("RTX") {
                return true;
            }
            // 数据中心卡白名单
            let datacenter = ["T4", "A10", "A30", "A40", "A100", "H100", "L4", "L40"];
            datacenter.iter().any(|card| upper_gpu.contains(card))
        }
        "metal" => true, // Apple Silicon 全系支持
        "hip" | "rocm" => {
            // RDNA 3 架构（RX 7000 / 780M / 880M / MI 系列）
            let rdna3 = regex::Regex::new(r"RX\s*7\d{3}|RADEON\s*7\d{3}|RADEON\s*(780|880)M|MI\d{2,3}").unwrap();
            rdna3.is_match(&upper_gpu)
        }
        "sycl" => {
            upper_gpu.contains("ARC") || upper_gpu.contains("CORE ULTRA") || upper_gpu.contains("XE-LPG")
        }
        _ => false,
    }
}
