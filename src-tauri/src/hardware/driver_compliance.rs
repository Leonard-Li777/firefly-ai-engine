// hardware/driver_compliance.rs
// GPU 驱动合规性检测服务
// 1:1 移植桌面端 GpuDriverComplianceService

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

use super::gpu_info::AccelerationTier;

/// 降级信息（驱动不合规时记录）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DowngradeInfo {
    /// 是否发生了降级
    pub downgraded: bool,
    /// GPU 名称
    pub gpu_name: String,
    /// 最佳层级（如 CUDA）
    pub best_tier: String,
    /// 实际选用层级（如 Vulkan）
    pub current_tier: String,
    /// 降级原因
    pub reason: DowngradeReason,
    /// 用户友好提示
    pub message: String,
}

/// 降级原因
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DowngradeReason {
    /// 驱动版本过低
    GpuDriverOutdated,
    /// 显存不足 OOM
    GpuOom,
    /// 缺少依赖 DLL/SO
    DllMissing,
    /// CPU 指令集不兼容（如缺失 AVX2/AVX 导致 0xC000001D 非法指令）
    CpuInstructionUnsupported,
    /// 其他未知错误
    Unknown,
}

/// 驱动合规性检测结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComplianceResult {
    pub compliant: bool,
    pub gpu_name: Option<String>,
    pub reason: Option<DowngradeReason>,
}

/// 驱动合规性服务（线程安全）
pub struct DriverComplianceService {
    /// 已标记为不合规的二进制路径（key = 规范化路径）
    non_compliant_binaries: Mutex<HashMap<String, ComplianceResult>>,
    /// 当前降级信息
    downgrade_info: Mutex<Option<DowngradeInfo>>,
}

impl DriverComplianceService {
    pub fn new() -> Arc<Self> {
        Arc::new(DriverComplianceService {
            non_compliant_binaries: Mutex::new(HashMap::new()),
            downgrade_info: Mutex::new(None),
        })
    }

    /// 记录降级信息（CUDA → Vulkan 等）
    pub async fn set_downgrade_info(&self, info: DowngradeInfo) {
        info!(
            "记录驱动降级: {} → {}, GPU: {}",
            info.best_tier, info.current_tier, info.gpu_name
        );
        let mut guard = self.downgrade_info.lock().await;
        *guard = Some(info);
    }

    /// 获取当前降级信息
    pub async fn get_downgrade_info(&self) -> Option<DowngradeInfo> {
        let guard = self.downgrade_info.lock().await;
        guard.clone()
    }

    /// 标记二进制路径不合规（运行时捕获到 GPU 致命错误时调用）
    pub async fn mark_non_compliant(
        &self,
        binary_path: &str,
        reason: DowngradeReason,
        gpu_name: Option<String>,
    ) {
        let key = normalize_path(binary_path);
        warn!(
            "标记驱动不合规: {} (原因: {:?})",
            binary_path, reason
        );
        let mut guard = self.non_compliant_binaries.lock().await;
        guard.insert(
            key,
            ComplianceResult {
                compliant: false,
                gpu_name,
                reason: Some(reason),
            },
        );
    }

    /// 检查二进制路径是否不合规
    pub async fn is_non_compliant(&self, binary_path: &str) -> bool {
        let key = normalize_path(binary_path);
        let guard = self.non_compliant_binaries.lock().await;
        guard.get(&key).map(|r| !r.compliant).unwrap_or(false)
    }

    /// 清除合规性缓存
    pub async fn clear_cache(&self) {
        let mut guard = self.non_compliant_binaries.lock().await;
        guard.clear();
        let mut dg = self.downgrade_info.lock().await;
        *dg = None;
        info!("驱动合规性缓存已清除");
    }

    /// 根据 stderr 输出内容判断降级原因
    pub fn classify_error(stderr: &str) -> Option<DowngradeReason> {
        let lower = stderr.to_lowercase();

        // CUDA OOM
        if lower.contains("cuda out of memory")
            || lower.contains("failed to allocate")
            || lower.contains("out of memory")
            || lower.contains("ggml_cuda_init: failed to initialize")
        {
            return Some(DowngradeReason::GpuOom);
        }

        // 驱动版本问题
        if lower.contains("cuda error")
            || lower.contains("driver version insufficient")
            || lower.contains("nvml driver")
            || lower.contains("no kernel image is available")
            || lower.contains("insufficient driver")
        {
            return Some(DowngradeReason::GpuDriverOutdated);
        }

        // DLL / 依赖缺失
        if lower.contains("cannot find")
            || lower.contains("not found")
            || lower.contains("dll")
            || lower.contains("shared library")
            || lower.contains("libcuda")
            || lower.contains("cublas")
        {
            // 只有在包含路径或库名时才视为 DLL 缺失
            if lower.contains(".dll") || lower.contains(".so") || lower.contains("cuda") {
                return Some(DowngradeReason::DllMissing);
            }
        }

        // Vulkan 显存不足
        if lower.contains("vulkan allocation failed") || lower.contains("vk_error_out_of_device_memory") {
            return Some(DowngradeReason::GpuOom);
        }

        // CPU 指令集不兼容（如缺失 AVX2/AVX 导致 0xC000001D 非法指令）
        if lower.contains("illegal instruction")
            || lower.contains("invalid instruction")
            || lower.contains("0xc000001d")
            || lower.contains("sigill")
            || lower.contains("cpu does not support")
            || (lower.contains("avx") && lower.contains("not supported"))
        {
            return Some(DowngradeReason::CpuInstructionUnsupported);
        }

        None
    }

    /// 根据降级原因生成用户友好提示
    pub fn make_downgrade_message(
        reason: &DowngradeReason,
        best_tier: &str,
        current_tier: &str,
    ) -> String {
        match reason {
            DowngradeReason::GpuDriverOutdated => format!(
                "NVIDIA 显卡驱动版本过低，已自动降级至 {} 引擎运行。建议前往官网更新驱动以启用最高性能 {} 加速。",
                current_tier.to_uppercase(),
                best_tier.to_uppercase()
            ),
            DowngradeReason::GpuOom => format!(
                "显存不足（OOM），已自动从 {} 降级至 {} 引擎运行。如需更高性能，请减少其他 GPU 占用进程。",
                best_tier.to_uppercase(),
                current_tier.to_uppercase()
            ),
            DowngradeReason::DllMissing => format!(
                "缺少 {} 必要的运行库（DLL/SO），已自动降级至 {} 引擎。请重新安装对应引擎包。",
                best_tier.to_uppercase(),
                current_tier.to_uppercase()
            ),
            DowngradeReason::CpuInstructionUnsupported => format!(
                "当前 CPU 缺少该引擎所需的高级指令集（如 AVX2），已自动从 {} 降级至兼容性更好的 {} 引擎运行。",
                best_tier.to_uppercase(),
                current_tier.to_uppercase()
            ),
            DowngradeReason::Unknown => format!(
                "引擎启动异常，已自动从 {} 降级至 {} 引擎运行。",
                best_tier.to_uppercase(),
                current_tier.to_uppercase()
            ),
        }
    }
}

/// 检测 Windows/Linux 环境下 NVIDIA 显卡驱动主版本与 CUDA 最大版本号
/// 优先使用内存中快速加载 nvcuda.dll 的 cuDriverGetVersion 探查（<1ms），失败时回退至 nvidia-smi
pub async fn detect_nvidia_driver_info() -> (Option<f64>, Option<f64>) {
    if !cfg!(windows) && !cfg!(target_os = "linux") {
        return (None, None);
    }

    #[cfg(windows)]
    {
        // 1. 尝试直接通过 nvcuda.dll 提取驱动支持的最高 CUDA API 版本
        use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};
        unsafe {
            let dll_name = b"nvcuda.dll\0";
            let h_module = LoadLibraryA(dll_name.as_ptr());
            if !h_module.is_null() {
                let proc_name = b"cuDriverGetVersion\0";
                if let Some(proc) = GetProcAddress(h_module, proc_name.as_ptr()) {
                    type PfnCuDriverGetVersion = unsafe extern "system" fn(*mut i32) -> i32;
                    let get_ver_fn: PfnCuDriverGetVersion = std::mem::transmute(proc);
                    let mut version: i32 = 0;
                    if get_ver_fn(&mut version) == 0 && version > 0 {
                        // version 格式：major * 1000 + minor * 10 (例如 12040 代表 12.4)
                        let major = version / 1000;
                        let minor = (version % 1000) / 10;
                        let cuda_ver = major as f64 + (minor as f64 / 10.0);
                        windows_sys::Win32::Foundation::FreeLibrary(h_module);
                        tracing::debug!("[驱动合规] nvcuda.dll 检测成功: CUDA API 版本: {}", cuda_ver);
                        return (Some(cuda_ver * 40.0), Some(cuda_ver)); // driver_ver 给出估算或通过下文精确探测
                    }
                }
                windows_sys::Win32::Foundation::FreeLibrary(h_module);
            }
        }
    }

    // 2. 回退通过 nvidia-smi 提取
    let output = match tokio::process::Command::new("nvidia-smi").output().await {
        Ok(out) => String::from_utf8_lossy(&out.stdout).to_string(),
        Err(_) => return (None, None),
    };

    // 正则提取 Driver Version: (\d+\.\d+)
    let driver_re = regex::Regex::new(r"Driver Version:\s*(\d+\.?\d*)").ok();
    let cuda_re = regex::Regex::new(r"CUDA Version:\s*(\d+\.?\d*)").ok();

    let driver_ver = driver_re
        .and_then(|re| re.captures(&output))
        .and_then(|cap| cap.get(1))
        .and_then(|m| m.as_str().parse::<f64>().ok());

    let cuda_ver = cuda_re
        .and_then(|re| re.captures(&output))
        .and_then(|cap| cap.get(1))
        .and_then(|m| m.as_str().parse::<f64>().ok());

    (driver_ver, cuda_ver)
}

/// 获取显卡驱动官方下载页面 URL（支持 CN / 国际区分）
pub fn get_vendor_driver_update_url(vendor: &str, is_cn: bool) -> &'static str {
    match vendor.to_lowercase().as_str() {
        "nvidia" => {
            if is_cn {
                "https://www.nvidia.cn/Download/index.aspx"
            } else {
                "https://www.nvidia.com/Download/index.aspx"
            }
        }
        "amd" => {
            if is_cn {
                "https://www.amd.com/zh-cn/support"
            } else {
                "https://www.amd.com/en/support"
            }
        }
        "intel" => {
            if is_cn {
                "https://www.intel.cn/content/www/cn/zh/download-center/home.html"
            } else {
                "https://www.intel.com/content/www/us/en/download-center/home.html"
            }
        }
        _ => {
            if is_cn {
                "https://www.nvidia.cn/Download/index.aspx"
            } else {
                "https://www.nvidia.com/Download/index.aspx"
            }
        }
    }
}
/// 规范化路径作为缓存键
fn normalize_path(path: &str) -> String {
    path.to_lowercase()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

/// 判断 tier 序列中的降级顺序
/// CUDA -> Vulkan -> CPU
pub fn get_fallback_tier(current: &AccelerationTier) -> Option<AccelerationTier> {
    match current {
        AccelerationTier::Cuda => Some(AccelerationTier::Vulkan),
        AccelerationTier::Hip => Some(AccelerationTier::Vulkan),
        AccelerationTier::Sycl => Some(AccelerationTier::Vulkan),
        AccelerationTier::Rocm => Some(AccelerationTier::Vulkan),
        AccelerationTier::Metal => Some(AccelerationTier::Cpu), // macOS Metal -> CPU
        AccelerationTier::Vulkan => Some(AccelerationTier::Cpu),
        AccelerationTier::Cpu => None, // 已到底，无法再降级
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 驱动过旧 / CUDA API 版本不足 → GpuDriverOutdated（避免拉起高版本 CUDA 引擎闪退）
    #[test]
    fn classify_driver_outdated_branches() {
        assert_eq!(
            DriverComplianceService::classify_error("CUDA error: driver version is insufficient for CUDA driver version"),
            Some(DowngradeReason::GpuDriverOutdated)
        );
        assert_eq!(
            DriverComplianceService::classify_error("insufficient driver"),
            Some(DowngradeReason::GpuDriverOutdated)
        );
        assert_eq!(
            DriverComplianceService::classify_error("NVML driver/library version mismatch"),
            Some(DowngradeReason::GpuDriverOutdated)
        );
    }

    /// CPU 指令集缺失（0xC000001D 非法指令）→ CpuInstructionUnsupported
    #[test]
    fn classify_cpu_instruction_unsupported_branches() {
        assert_eq!(
            DriverComplianceService::classify_error("Exception 0xC000001D in thread illegal instruction"),
            Some(DowngradeReason::CpuInstructionUnsupported)
        );
        assert_eq!(
            DriverComplianceService::classify_error("this CPU does not support AVX2"),
            Some(DowngradeReason::CpuInstructionUnsupported)
        );
        assert_eq!(
            DriverComplianceService::classify_error("SIGILL: illegal instruction"),
            Some(DowngradeReason::CpuInstructionUnsupported)
        );
    }

    /// 显存瞬时耗尽 / Vulkan 分配失败 → GpuOom（触发熔断降级）
    #[test]
    fn classify_oom_branches() {
        assert_eq!(
            DriverComplianceService::classify_error("CUDA out of memory: tried to allocate 512 MiB"),
            Some(DowngradeReason::GpuOom)
        );
        assert_eq!(
            DriverComplianceService::classify_error("vk_error_out_of_device_memory"),
            Some(DowngradeReason::GpuOom)
        );
    }

    /// 缺失运行库 DLL / SO → DllMissing
    #[test]
    fn classify_dll_missing_branches() {
        assert_eq!(
            DriverComplianceService::classify_error("The specified module could not be found. nvcuda.dll"),
            Some(DowngradeReason::DllMissing)
        );
            assert_eq!(
            DriverComplianceService::classify_error("cannot find shared library libcublas.so.12"),
            Some(DowngradeReason::DllMissing)
        );
    }

    /// 无法分类的未知错误返回 None，交由 Unknown 降级消息兜底
    #[test]
    fn classify_unknown_returns_none() {
        assert_eq!(DriverComplianceService::classify_error("some random stderr"), None);
    }

    /// mark_non_compliant / is_non_compliant 状态转移（路径规范化后命中同一缓存键）
    #[tokio::test]
    async fn mark_and_query_non_compliant_state() {
        let svc = DriverComplianceService::new();
        assert!(!svc.is_non_compliant("C:\\engines\\cuda\\llama-server.exe").await);

        svc.mark_non_compliant(
            "C:\\engines\\cuda\\llama-server.exe",
            DowngradeReason::GpuDriverOutdated,
            Some("NVIDIA GeForce GTX 1060".to_string()),
        )
        .await;
        // 正反斜杠与大小写归一后仍应命中
        assert!(svc.is_non_compliant("c:/engines/CUDA/llama-server.exe").await);

        svc.clear_cache().await;
        assert!(!svc.is_non_compliant("C:\\engines\\cuda\\llama-server.exe").await);
    }

    /// 降级阶梯：CUDA/HIP/SYCL/ROCm → Vulkan → CPU，CPU 为终点
    #[test]
    fn fallback_tier_ladder_is_complete() {
        assert_eq!(get_fallback_tier(&AccelerationTier::Cuda), Some(AccelerationTier::Vulkan));
        assert_eq!(get_fallback_tier(&AccelerationTier::Vulkan), Some(AccelerationTier::Cpu));
        assert_eq!(get_fallback_tier(&AccelerationTier::Cpu), None);
    }

    /// 驱动过旧降级消息包含用户可读指引（更新驱动以解锁 GPU 加速）
    #[test]
    fn downgrade_message_mentions_driver_update() {
        let msg = DriverComplianceService::make_downgrade_message(
            &DowngradeReason::GpuDriverOutdated,
            "CUDA",
            "VULKAN",
        );
        assert!(msg.contains("驱动"), "消息应提示更新驱动: {}", msg);
        assert!(msg.contains("VULKAN"));
    }
}

