// hardware/mod.rs
pub mod detector;
pub mod driver_compliance;
pub mod gpu_info;

pub use detector::HardwareDetector;
pub use driver_compliance::{DowngradeInfo, DowngradeReason, DriverComplianceService, get_fallback_tier};
pub use gpu_info::{
    AccelerationTier, CpuInfo, GpuInfo, GpuVendor, MemoryInfo, SystemResources,
    is_flash_attention_supported, is_pascal_arch_gpu,
};
