// hardware/vram_arbiter.rs
// Issue 05: DXGI 动态水位与 VRAM Arbiter 预算租约仲裁器

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};
use tracing::info;

/// 1.5GB 绝对保底安全水位 (字节)
pub const MIN_SAFETY_WATERMARK_BYTES: u64 = (1.5 * 1024.0 * 1024.0 * 1024.0) as u64;
/// 15% 动态预算百分比
pub const SAFETY_WATERMARK_RATIO: f64 = 0.15;
/// 重算力 Worker 默认空闲防抖冷却时间 (30 秒)
pub const DEFAULT_IDLE_COOLDOWN_SECS: u64 = 30;

/// 任务执行优先级
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum TaskPriority {
    /// P0 交互对话（最高优先级，允许打断冷却倒计时）
    P0InteractiveChat = 0,
    /// P1 主动生图 / Diffusion
    P1ActiveImageGen = 1,
    /// P2 后台批处理 / 离线索引
    P2BackgroundBatch = 2,
}

/// 仲裁器迁移状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArbiterPhase {
    Idle,
    Serving,
    Swapping,
    CoolingDown,
}

/// DXGI 显存动态探测数据
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct DxgiVramInfo {
    /// DXGI 可用预算 Budget（字节）
    pub budget_bytes: u64,
    /// 当前整卡显存使用量 CurrentUsage（字节）
    pub current_usage_bytes: u64,
    /// 是否来自真实 DXGI 1.4 原生探针
    pub is_dxgi_native: bool,
}

impl DxgiVramInfo {
    /// 计算动态安全水位 SafetyWatermark = max(1.5GB, Budget * 15%)
    pub fn safety_watermark_bytes(&self) -> u64 {
        let ratio_bytes = (self.budget_bytes as f64 * SAFETY_WATERMARK_RATIO) as u64;
        ratio_bytes.max(MIN_SAFETY_WATERMARK_BYTES)
    }

    /// 多 Worker 共驻准入公式：
    /// NewModelRequired <= Budget - CurrentUsage - SafetyWatermark
    pub fn can_coexist(&self, new_model_required_bytes: u64) -> bool {
        let watermark = self.safety_watermark_bytes();
        let free_budget = self
            .budget_bytes
            .saturating_sub(self.current_usage_bytes)
            .saturating_sub(watermark);
        new_model_required_bytes <= free_budget
    }

    /// 换出换入准入公式（扣除即将释放的目标 Worker 显存）：
    /// NewModelRequired <= Budget - (CurrentUsage - EvictingModelVRAM) - SafetyWatermark
    pub fn can_swap_in(&self, new_model_required_bytes: u64, evicting_vram_bytes: u64) -> bool {
        let watermark = self.safety_watermark_bytes();
        let adjusted_usage = self.current_usage_bytes.saturating_sub(evicting_vram_bytes);
        let free_budget = self
            .budget_bytes
            .saturating_sub(adjusted_usage)
            .saturating_sub(watermark);
        new_model_required_bytes <= free_budget
    }
}

/// 原生查询 Windows DXGI 显存信息（支持独显匹配与优雅静态降级）
pub fn query_dxgi_vram() -> DxgiVramInfo {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::FreeLibrary;
        use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};

        unsafe {
            let dxgi_dll = LoadLibraryA(b"dxgi.dll\0".as_ptr());
            if dxgi_dll.is_null() {
                return fallback_static_vram();
            }

            let fn_name = b"CreateDXGIFactory1\0";
            let create_factory_ptr = GetProcAddress(dxgi_dll, fn_name.as_ptr());
            if create_factory_ptr.is_none() {
                FreeLibrary(dxgi_dll);
                return fallback_static_vram();
            }

            type PfnCreateDXGIFactory1 = unsafe extern "system" fn(
                *const windows_sys::core::GUID,
                *mut *mut std::ffi::c_void,
            ) -> i32;
            let create_factory_fn: PfnCreateDXGIFactory1 = std::mem::transmute(create_factory_ptr);

            // IDXGIFactory1 GUID: 770aae78-f26f-4dba-a829-253c83d1b387
            let iid_factory1 = windows_sys::core::GUID {
                data1: 0x770aae78,
                data2: 0xf26f,
                data3: 0x4dba,
                data4: [0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87],
            };

            let mut factory: *mut std::ffi::c_void = std::ptr::null_mut();
            if create_factory_fn(&iid_factory1, &mut factory) != 0 || factory.is_null() {
                FreeLibrary(dxgi_dll);
                return fallback_static_vram();
            }

            // COM VTable helpers
            let vtable = *(factory as *mut *mut usize);
            // QueryInterface(0), AddRef(1), Release(2)
            let release_factory: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32 =
                std::mem::transmute(vtable.add(2).read());
            // EnumAdapters1(12)
            let enum_adapters1: unsafe extern "system" fn(
                *mut std::ffi::c_void,
                u32,
                *mut *mut std::ffi::c_void,
            ) -> i32 = std::mem::transmute(vtable.add(12).read());

            #[repr(C)]
            struct DXGI_ADAPTER_DESC1 {
                description: [u16; 128],
                vendor_id: u32,
                device_id: u32,
                sub_sys_id: u32,
                revision: u32,
                dedicated_video_memory: usize,
                dedicated_system_memory: usize,
                shared_system_memory: usize,
                adapter_luid_low: u32,
                adapter_luid_high: i32,
                flags: u32,
            }

            let mut best_adapter: *mut std::ffi::c_void = std::ptr::null_mut();
            let mut max_dedicated_vram: usize = 0;

            let mut idx = 0;
            loop {
                let mut adapter: *mut std::ffi::c_void = std::ptr::null_mut();
                if enum_adapters1(factory, idx, &mut adapter) != 0 || adapter.is_null() {
                    break;
                }

                let adapter_vtable = *(adapter as *mut *mut usize);
                let release_adapter: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32 =
                    std::mem::transmute(adapter_vtable.add(2).read());
                // GetDesc1(10)
                let get_desc1: unsafe extern "system" fn(
                    *mut std::ffi::c_void,
                    *mut DXGI_ADAPTER_DESC1,
                ) -> i32 = std::mem::transmute(adapter_vtable.add(10).read());

                let mut desc: DXGI_ADAPTER_DESC1 = std::mem::zeroed();
                if get_desc1(adapter, &mut desc) == 0 {
                    // DXGI_ADAPTER_FLAG_SOFTWARE = 2
                    if (desc.flags & 2) == 0 && desc.dedicated_video_memory > max_dedicated_vram {
                        if !best_adapter.is_null() {
                            let rel_best: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32 =
                                std::mem::transmute((*(best_adapter as *mut *mut usize)).add(2).read());
                            rel_best(best_adapter);
                        }
                        max_dedicated_vram = desc.dedicated_video_memory;
                        best_adapter = adapter;
                    } else {
                        release_adapter(adapter);
                    }
                } else {
                    release_adapter(adapter);
                }

                idx += 1;
            }

            release_factory(factory);

            if best_adapter.is_null() {
                FreeLibrary(dxgi_dll);
                return fallback_static_vram();
            }

            // IDXGIAdapter3 GUID: 64596774-9f45-4374-a02f-da1d0addb86b
            let iid_adapter3 = windows_sys::core::GUID {
                data1: 0x64596774,
                data2: 0x9f45,
                data3: 0x4374,
                data4: [0xa0, 0x2f, 0xda, 0x1d, 0x0a, 0xdd, 0xb8, 0x6b],
            };

            let adapter_vtable = *(best_adapter as *mut *mut usize);
            let query_interface: unsafe extern "system" fn(
                *mut std::ffi::c_void,
                *const windows_sys::core::GUID,
                *mut *mut std::ffi::c_void,
            ) -> i32 = std::mem::transmute(adapter_vtable.add(0).read());
            let release_adapter: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32 =
                std::mem::transmute(adapter_vtable.add(2).read());

            let mut adapter3: *mut std::ffi::c_void = std::ptr::null_mut();
            let qi_res = query_interface(best_adapter, &iid_adapter3, &mut adapter3);
            release_adapter(best_adapter);

            if qi_res == 0 && !adapter3.is_null() {
                #[repr(C)]
                struct DXGI_QUERY_VIDEO_MEMORY_INFO {
                    budget: u64,
                    current_usage: u64,
                    available_for_reservation: u64,
                    current_reservation: u64,
                }

                let adapter3_vtable = *(adapter3 as *mut *mut usize);
                let release_adapter3: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32 =
                    std::mem::transmute(adapter3_vtable.add(2).read());
                // QueryVideoMemoryInfo(16)
                let query_video_mem: unsafe extern "system" fn(
                    *mut std::ffi::c_void,
                    u32,
                    u32,
                    *mut DXGI_QUERY_VIDEO_MEMORY_INFO,
                ) -> i32 = std::mem::transmute(adapter3_vtable.add(16).read());

                let mut mem_info: DXGI_QUERY_VIDEO_MEMORY_INFO = std::mem::zeroed();
                // DXGI_MEMORY_SEGMENT_GROUP_LOCAL = 0
                let qres = query_video_mem(adapter3, 0, 0, &mut mem_info);
                release_adapter3(adapter3);
                FreeLibrary(dxgi_dll);

                if qres == 0 && mem_info.budget > 0 {
                    return DxgiVramInfo {
                        budget_bytes: mem_info.budget,
                        current_usage_bytes: mem_info.current_usage,
                        is_dxgi_native: true,
                    };
                }
            } else {
                FreeLibrary(dxgi_dll);
            }

            if max_dedicated_vram > 0 {
                return DxgiVramInfo {
                    budget_bytes: max_dedicated_vram as u64,
                    current_usage_bytes: (max_dedicated_vram as f64 * 0.3) as u64,
                    is_dxgi_native: false,
                };
            }

            fallback_static_vram()
        }
    }
    #[cfg(not(windows))]
    {
        fallback_static_vram()
    }
}

/// 默认保底静态显存（8GB 显卡，已占用 2GB）
fn fallback_static_vram() -> DxgiVramInfo {
    DxgiVramInfo {
        budget_bytes: 8 * 1024 * 1024 * 1024,
        current_usage_bytes: 2 * 1024 * 1024 * 1024,
        is_dxgi_native: false,
    }
}

/// 仲裁器状态快照对外输出
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArbiterStatusSnapshot {
    pub phase: ArbiterPhase,
    pub eta_ms: u64,
    pub queue_position: usize,
    pub vram_budget_mb: u64,
    pub vram_used_mb: u64,
}

/// 显存租约门禁（生命周期保护，RAII 退出释放租约）
pub struct VramArbiter {
    current_phase: RwLock<ArbiterPhase>,
    active_leases: AtomicUsize,
    active_worker_id: RwLock<Option<String>>,
    cooldown_until: Mutex<Option<Instant>>,
    swapping_eta_ms: Mutex<u64>,
}

impl VramArbiter {
    pub fn new() -> Arc<Self> {
        Arc::new(VramArbiter {
            current_phase: RwLock::new(ArbiterPhase::Idle),
            active_leases: AtomicUsize::new(0),
            active_worker_id: RwLock::new(None),
            cooldown_until: Mutex::new(None),
            swapping_eta_ms: Mutex::new(0),
        })
    }

    /// 获取当前阶段
    pub async fn phase(&self) -> ArbiterPhase {
        *self.current_phase.read().await
    }

    /// 当前是否有活跃的任务租约正在执行 (in-flight)
    pub fn has_active_leases(&self) -> bool {
        self.active_leases.load(Ordering::SeqCst) > 0
    }

    /// 尝试进入原子状态迁移段 (Atomic Swapping Phase)
    /// 返回 Ok(()) 表示获准独占切换；如果当前正在 Swapping，返回 Err(eta_ms)
    pub async fn begin_atomic_swap(&self, eta_ms: u64) -> Result<(), u64> {
        let mut phase_guard = self.current_phase.write().await;
        if *phase_guard == ArbiterPhase::Swapping {
            let eta = *self.swapping_eta_ms.lock().await;
            return Err(eta);
        }

        // 永不强杀 in-flight
        if self.has_active_leases() {
            let eta = *self.swapping_eta_ms.lock().await;
            return Err(eta.max(3000));
        }

        *phase_guard = ArbiterPhase::Swapping;
        *self.swapping_eta_ms.lock().await = eta_ms;
        *self.cooldown_until.lock().await = None;
        info!("[VRAM Arbiter] 进入不可中断原子迁移段，预估 ETA: {}ms", eta_ms);
        Ok(())
    }

    /// 完成原子状态迁移
    pub async fn finish_atomic_swap(&self, new_worker_id: String) {
        let mut phase_guard = self.current_phase.write().await;
        *self.active_worker_id.write().await = Some(new_worker_id);
        *phase_guard = ArbiterPhase::Serving;
        *self.swapping_eta_ms.lock().await = 0;
        info!("[VRAM Arbiter] 原子迁移完成，进入 Serving 状态");
    }

    /// 启动重算力空闲防抖冷却 (默认 30s)
    pub async fn start_idle_cooldown(&self, cooldown_duration: Duration) {
        let mut phase_guard = self.current_phase.write().await;
        if *phase_guard == ArbiterPhase::Serving && !self.has_active_leases() {
            *phase_guard = ArbiterPhase::CoolingDown;
            *self.cooldown_until.lock().await = Some(Instant::now() + cooldown_duration);
            info!("[VRAM Arbiter] 开启空闲冷却防抖倒计时: {:?}", cooldown_duration);
        }
    }

    /// 当有 P0 请求到达时，检查并允许提前中断空闲倒计时
    pub async fn check_and_interrupt_cooldown_for_p0(&self) -> bool {
        let mut phase_guard = self.current_phase.write().await;
        if *phase_guard == ArbiterPhase::CoolingDown && !self.has_active_leases() {
            *phase_guard = ArbiterPhase::Idle;
            *self.cooldown_until.lock().await = None;
            info!("[VRAM Arbiter] P0 交互请求抢占，成功中断冷却倒计时");
            return true;
        }
        false
    }

    /// 申请租约：若是 P0 允许中断冷却；如果正在 swapping 则返回失败
    pub async fn acquire_lease(&self, priority: TaskPriority) -> Result<VramLeaseToken<'_>, u64> {
        if priority == TaskPriority::P0InteractiveChat {
            self.check_and_interrupt_cooldown_for_p0().await;
        }

        let phase = *self.current_phase.read().await;
        if phase == ArbiterPhase::Swapping {
            let eta = *self.swapping_eta_ms.lock().await;
            return Err(eta.max(1000));
        }

        self.active_leases.fetch_add(1, Ordering::SeqCst);
        let mut phase_guard = self.current_phase.write().await;
        if *phase_guard != ArbiterPhase::Serving {
            *phase_guard = ArbiterPhase::Serving;
        }

        Ok(VramLeaseToken {
            leases_ref: &self.active_leases,
        })
    }

    /// 获取对外暴露的状态快照
    pub async fn get_status_snapshot(&self) -> ArbiterStatusSnapshot {
        let phase = *self.current_phase.read().await;
        let eta_ms = if phase == ArbiterPhase::Swapping {
            *self.swapping_eta_ms.lock().await
        } else {
            0
        };

        let vram = query_dxgi_vram();

        ArbiterStatusSnapshot {
            phase,
            eta_ms,
            queue_position: 0,
            vram_budget_mb: vram.budget_bytes / (1024 * 1024),
            vram_used_mb: vram.current_usage_bytes / (1024 * 1024),
        }
    }
}

/// 租约句柄（RAII 释放）
#[derive(Debug)]
pub struct VramLeaseToken<'a> {
    leases_ref: &'a AtomicUsize,
}

impl<'a> Drop for VramLeaseToken<'a> {
    fn drop(&mut self) {
        self.leases_ref.fetch_sub(1, Ordering::SeqCst);
    }
}
