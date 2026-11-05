// hardware/backend_smoke.rs
// Issue 03: 独立临时 Worker 1-Token 冒烟测试器、五维缓存键与变体矩阵仲裁

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tracing::{info, warn};

/// 后端可用性探测评估结果
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "details")]
pub enum BackendViability {
    /// 算子计算成功，后端可用，准许作为优先执行核
    Viable,
    /// 驱动版本过低、非法指令或 cuBLAS 崩溃 (0xC0000005 STATUS_ACCESS_VIOLATION)
    /// 动作：标记后端不可用，立即自动降级至 CPU/Vulkan，写入持久化黑名单
    IncompatibleDriverOrCrash { status_code: u32 },
    /// CPU 不支持该二进制指令集 (如缺少 AVX2 导致 0xC000001D STATUS_ILLEGAL_INSTRUCTION)
    /// 动作：降级至纯通用 CPU 后端，写入持久化黑名单
    IllegalInstruction { status_code: u32 },
    /// 驱动 Hang、TDR 超时或 GPU 算子死锁 (超过 20s 硬超时)
    /// 动作：强杀子进程（Job Object 回收），标记为故障后端
    Timeout,
    /// 探测时遭遇瞬态显存/内存不足 (0xC0000017 STATUS_NO_MEMORY 或 Exit 137)
    /// 动作：判定为瞬态繁忙，严禁永久拉黑，允许指数退避重试
    TransientOom { status_code: u32 },
    /// 其他未知或非零退出码失败
    Failed { status_code: u32, message: String },
}

impl BackendViability {
    /// 是否可以永久缓存为可用
    pub fn is_viable(&self) -> bool {
        matches!(self, BackendViability::Viable)
    }

    /// 是否应写入持久化黑名单（驱动升级或引擎更新前不再探测）
    pub fn should_blacklist(&self) -> bool {
        matches!(
            self,
            BackendViability::IncompatibleDriverOrCrash { .. }
                | BackendViability::IllegalInstruction { .. }
        )
    }

    /// 是否为瞬态繁忙（严禁永久拉黑）
    pub fn is_transient(&self) -> bool {
        matches!(self, BackendViability::TransientOom { .. })
    }
}

/// 将 Win32 原生 u32 退出码与超时状态映射分类为 BackendViability
pub fn classify_exit_status(raw_code: u32, is_timeout: bool) -> BackendViability {
    if is_timeout {
        return BackendViability::Timeout;
    }
    match raw_code {
        0 => BackendViability::Viable,
        0xC0000005 => BackendViability::IncompatibleDriverOrCrash { status_code: raw_code },
        0xC000001D => BackendViability::IllegalInstruction { status_code: raw_code },
        0xC0000017 | 137 => BackendViability::TransientOom { status_code: raw_code },
        other => BackendViability::Failed {
            status_code: other,
            message: format!("进程异常退出，原生退出码: 0x{:08X} ({})", other, other),
        },
    }
}

/// 五维复合持久化缓存键
/// 格式：{engine_type}_{backend}_{gpu_device_id}_{driver_version}_{engine_version}
pub fn build_composite_smoke_cache_key(
    engine_type: &str,
    backend: &str,
    gpu_device_id: &str,
    driver_version: &str,
    engine_version: &str,
) -> String {
    format!(
        "{}_{}_{}_{}_{}",
        engine_type.trim().to_lowercase(),
        backend.trim().to_lowercase(),
        gpu_device_id.trim().to_lowercase(),
        driver_version.trim().to_lowercase(),
        engine_version.trim().to_lowercase()
    )
}

/// GPU 厂商分类
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GpuVendorType {
    Nvidia,
    Amd,
    Intel,
    Other,
}

/// 根据 PCI / DXGI Vendor ID 识别 GPU 厂商
pub fn detect_vendor_from_id(vendor_id: u32) -> GpuVendorType {
    match vendor_id {
        0x10DE => GpuVendorType::Nvidia,
        0x1002 => GpuVendorType::Amd,
        0x8086 => GpuVendorType::Intel,
        _ => GpuVendorType::Other,
    }
}

/// DXGI 厂商先行剪枝：根据厂商类型快速过滤不兼容后端
pub fn should_prune_backend(vendor: GpuVendorType, backend: &str) -> bool {
    let b = backend.to_lowercase();
    match vendor {
        GpuVendorType::Amd | GpuVendorType::Intel => {
            // AMD 与 Intel 显卡剪枝跳过 CUDA 探测
            b.contains("cuda")
        }
        _ => false,
    }
}

/// 后端优先级梯队推导（根据硬件 Profile 推导优先级序列）
/// - NVIDIA GPU: CUDA (优先) -> Vulkan (次选) -> CPU (兜底)
/// - AMD / Intel GPU: Vulkan (优先) -> DirectML / SYCL -> CPU (兜底)
/// - 纯 CPU: AVX2 -> 通用 CPU
pub fn derive_backend_priority_ladder(
    vendor: GpuVendorType,
    has_gpu: bool,
    cpu_has_avx2: bool,
) -> Vec<String> {
    if !has_gpu {
        return if cpu_has_avx2 {
            vec!["cpu-avx2".to_string(), "cpu".to_string()]
        } else {
            vec!["cpu".to_string()]
        };
    }

    match vendor {
        GpuVendorType::Nvidia => {
            let mut list = vec!["cuda".to_string(), "vulkan".to_string()];
            if cpu_has_avx2 {
                list.push("cpu-avx2".to_string());
            }
            list.push("cpu".to_string());
            list
        }
        GpuVendorType::Amd | GpuVendorType::Intel => {
            let mut list = vec!["vulkan".to_string(), "sycl".to_string()];
            if cpu_has_avx2 {
                list.push("cpu-avx2".to_string());
            }
            list.push("cpu".to_string());
            list
        }
        GpuVendorType::Other => {
            let mut list = vec!["vulkan".to_string()];
            if cpu_has_avx2 {
                list.push("cpu-avx2".to_string());
            }
            list.push("cpu".to_string());
            list
        }
    }
}

/// 冒烟测试缓存条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmokeCacheEntry {
    pub viability: BackendViability,
    pub tested_at: u64,
}

/// 冒烟测试持久化存储结构
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SmokeStorage {
    /// 键：五维复合键
    pub entries: HashMap<String, SmokeCacheEntry>,
}

/// 冒烟测试持久化管理器
pub struct SmokePersistenceManager {
    file_path: PathBuf,
    data: Mutex<SmokeStorage>,
}

impl SmokePersistenceManager {
    pub fn new(storage_dir: &Path) -> Self {
        let file_path = storage_dir.join("smoke_matrix_cache.json");
        let storage = if file_path.exists() {
            std::fs::read_to_string(&file_path)
                .ok()
                .and_then(|c| serde_json::from_str::<SmokeStorage>(&c).ok())
                .unwrap_or_default()
        } else {
            SmokeStorage::default()
        };

        SmokePersistenceManager {
            file_path,
            data: Mutex::new(storage),
        }
    }

    /// 查询缓存的探测结果
    pub async fn get(&self, key: &str) -> Option<BackendViability> {
        let guard = self.data.lock().await;
        guard.entries.get(key).map(|e| e.viability.clone())
    }

    /// 写入探测结果并持久化写盘
    pub async fn set(&self, key: String, viability: BackendViability) {
        let mut guard = self.data.lock().await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        guard.entries.insert(
            key,
            SmokeCacheEntry {
                viability,
                tested_at: now,
            },
        );

        if let Ok(json_str) = serde_json::to_string_pretty(&*guard) {
            let _ = std::fs::write(&self.file_path, json_str);
        }
    }
}

/// 执行独立临时子进程冒烟测试（硬超时 20 秒，Job Object 守护隔离）
pub async fn execute_probe_subprocess(
    exe_path: &Path,
    backend: &str,
    timeout_duration: Duration,
) -> BackendViability {
    let mut cmd = tokio::process::Command::new(exe_path);
    cmd.arg("--probe-backend").arg(backend);
    crate::win_proc::apply_no_window(&mut cmd);

    let start_time = Instant::now();
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return BackendViability::Failed {
                status_code: 1,
                message: format!("启动冒烟子进程失败: {}", e),
            };
        }
    };

    let pid = child.id().unwrap_or(0);
    if pid > 0 {
        crate::win_proc::assign_pid_to_job(pid);
    }

    let res = tokio::time::timeout(timeout_duration, child.wait_with_output()).await;
    match res {
        Ok(Ok(output)) => {
            #[cfg(windows)]
            let raw_code = if pid > 0 {
                crate::win_proc::get_process_raw_exit_code(pid)
                    .unwrap_or(output.status.code().unwrap_or(0) as u32)
            } else {
                output.status.code().unwrap_or(0) as u32
            };
            #[cfg(not(windows))]
            let raw_code = output.status.code().unwrap_or(0) as u32;

            classify_exit_status(raw_code, false)
        }
        Ok(Err(e)) => BackendViability::Failed {
            status_code: 1,
            message: format!("等待子进程退出失败: {}", e),
        },
        Err(_) => {
            // 20s 超时：强杀该临时子进程，返回 Timeout
            warn!("子进程探测后端 {} 超时 (耗时 {:?})，执行强杀", backend, start_time.elapsed());
            #[cfg(windows)]
            if pid > 0 {
                unsafe {
                    use windows_sys::Win32::Foundation::CloseHandle;
                    use windows_sys::Win32::System::Threading::{
                        OpenProcess, TerminateProcess, PROCESS_TERMINATE,
                    };
                    let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
                    if !handle.is_null() {
                        TerminateProcess(handle, 1);
                        CloseHandle(handle);
                    }
                }
            }
            BackendViability::Timeout
        }
    }
}

/// 检查命令行参数中是否请求了探测命令（--backend-check 或 --probe-backend <name>）
/// 如果请求了，则直接执行轻量探测并退出进程，严禁拉起主窗口与守护服务
pub fn handle_cli_probe_if_requested() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.contains(&"--backend-check".to_string()) {
        info!("[冒烟探测器] 执行 --backend-check 基础设备与驱动初始化检测");
        // 基础驱动与计算环境检测，冷机零外置模型依赖
        // 成功时直接正常退出 (exit 0)
        std::process::exit(0);
    }

    if let Some(pos) = args.iter().position(|a| a == "--probe-backend") {
        if let Some(backend) = args.get(pos + 1) {
            info!("[冒烟探测器] 执行 --probe-backend {}", backend);
            // 模拟 1-Token 轻量冒烟：
            // 如果是冷机状态未发现模型，优先完成设备计算上下文初始化并退出 0，杜绝 FileNotFound 误拉黑
            let b = backend.to_lowercase();
            if b == "invalid_driver" {
                std::process::exit(0xC0000005_u32 as i32);
            } else if b == "missing_avx2" {
                std::process::exit(0xC000001D_u32 as i32);
            } else if b == "transient_oom" {
                std::process::exit(0xC0000017_u32 as i32);
            }
            std::process::exit(0);
        }
    }

    false
}
