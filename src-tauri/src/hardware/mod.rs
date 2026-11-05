pub mod backend_smoke;
pub mod competitor_detector;
pub mod detector;
pub mod driver_compliance;
pub mod gpu_info;

pub use backend_smoke::{
    build_composite_smoke_cache_key, classify_exit_status, derive_backend_priority_ladder,
    detect_vendor_from_id, execute_probe_subprocess, handle_cli_probe_if_requested,
    should_prune_backend, BackendViability, GpuVendorType, SmokePersistenceManager,
};
pub use competitor_detector::{CompetitorDetector, GpuCompetitorInfo};
pub use detector::HardwareDetector;
pub use driver_compliance::{DowngradeInfo, DowngradeReason, DriverComplianceService, get_fallback_tier};
pub use gpu_info::{
    AccelerationTier, CpuInfo, GpuInfo, GpuVendor, MemoryInfo, SystemResources,
    VramFreeProbe, is_flash_attention_supported, is_pascal_arch_gpu,
};
