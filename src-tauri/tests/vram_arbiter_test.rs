// tests/vram_arbiter_test.rs
// Issue 05: DXGI 动态水位与 VRAM Arbiter 预算租约仲裁器全契约测试

use firefly_ai_engine_lib::hardware::vram_arbiter::{
    query_dxgi_vram, ArbiterPhase, DxgiVramInfo, TaskPriority, VramArbiter,
    MIN_SAFETY_WATERMARK_BYTES,
};
use std::time::Duration;

#[test]
fn test_ac1_dxgi_vram_formulas_and_admission() {
    // 1. 安全水位计算：max(1.5GB, Budget * 15%)
    // 假设显存 Budget 为 8GB (8 * 1024^3 字节)
    let budget_8gb: u64 = 8 * 1024 * 1024 * 1024;
    // 8GB * 15% = 1.2GB，小于 1.5GB 保底水位，所以应取 1.5GB
    let vram_8gb = DxgiVramInfo {
        budget_bytes: budget_8gb,
        current_usage_bytes: 2 * 1024 * 1024 * 1024, // 已用 2GB
        is_dxgi_native: true,
    };
    assert_eq!(vram_8gb.safety_watermark_bytes(), MIN_SAFETY_WATERMARK_BYTES);

    // 假设显存 Budget 为 16GB (16 * 1024^3 字节)
    // 16GB * 15% = 2.4GB，大于 1.5GB，取 2.4GB
    let budget_16gb: u64 = 16 * 1024 * 1024 * 1024;
    let vram_16gb = DxgiVramInfo {
        budget_bytes: budget_16gb,
        current_usage_bytes: 4 * 1024 * 1024 * 1024,
        is_dxgi_native: true,
    };
    let expected_watermark_16gb = (budget_16gb as f64 * 0.15) as u64;
    assert_eq!(vram_16gb.safety_watermark_bytes(), expected_watermark_16gb);

    // 2. 多 Worker 共驻准入式：
    // NewModelRequired <= Budget - CurrentUsage - SafetyWatermark
    // 8GB 显卡，已用 2GB，安全水位 1.5GB，剩余可共驻空间 = 8 - 2 - 1.5 = 4.5GB
    let req_3gb = 3 * 1024 * 1024 * 1024;
    let req_5gb = 5 * 1024 * 1024 * 1024;
    assert!(vram_8gb.can_coexist(req_3gb), "3GB 模型应准许共驻 (4.5GB 空间)");
    assert!(!vram_8gb.can_coexist(req_5gb), "5GB 模型不准许共驻 (超出了 4.5GB 空间)");

    // 3. 换出换入准入式：
    // NewModelRequired <= Budget - (CurrentUsage - EvictingModelVRAM) - SafetyWatermark
    // 假设当前正在运行的旧 Worker 占用了 1.8GB，换出后可用空间 = 8 - (2 - 1.8) - 1.5 = 6.3GB
    let evicting_1_8gb = (1.8 * 1024.0 * 1024.0 * 1024.0) as u64;
    let req_6gb = 6 * 1024 * 1024 * 1024;
    assert!(vram_8gb.can_swap_in(req_6gb, evicting_1_8gb), "6GB 模型换入应准入 (换出后有 6.3GB 空间)");
    let req_7gb = 7 * 1024 * 1024 * 1024;
    assert!(!vram_8gb.can_swap_in(req_7gb, evicting_1_8gb), "7GB 模型换入应拒绝 (超出 6.3GB 空间)");

    // 4. 原生 DXGI 探针调用不 panic（无论平台环境与显卡驱动如何，均优雅返回）
    let live_probe = query_dxgi_vram();
    assert!(live_probe.budget_bytes > 0);
}

#[tokio::test]
async fn test_ac2_arbiter_atomic_swapping_and_lease_guard() {
    let arbiter = VramArbiter::new();
    assert_eq!(arbiter.phase().await, ArbiterPhase::Idle);
    assert!(!arbiter.has_active_leases());

    // 1. 申请常规业务租约 (P0)
    {
        let lease = arbiter.acquire_lease(TaskPriority::P0InteractiveChat).await;
        assert!(lease.is_ok());
        assert_eq!(arbiter.phase().await, ArbiterPhase::Serving);
        assert!(arbiter.has_active_leases());

        // 当有 in-flight 租约时，严禁强杀与原子切换，begin_atomic_swap 必须拒绝
        let swap_res = arbiter.begin_atomic_swap(5000).await;
        assert!(swap_res.is_err(), "有活跃租约时不准许执行原子换出");
    }

    // lease 已经 drop，活跃租约计数自动归零
    assert!(!arbiter.has_active_leases());

    // 2. 进入不可中断的原子状态迁移段 (Atomic Swapping Phase)
    let swap_ok = arbiter.begin_atomic_swap(8500).await;
    assert!(swap_ok.is_ok());
    assert_eq!(arbiter.phase().await, ArbiterPhase::Swapping);

    // 在 Swapping 期间，任何新租约请求一律拒绝并返回 ETA（用于 503 engine_swapping）
    let lease_err = arbiter.acquire_lease(TaskPriority::P0InteractiveChat).await;
    assert!(lease_err.is_err());
    assert_eq!(lease_err.unwrap_err(), 8500);

    // 在 Swapping 期间，重叠的原子迁移也必须拒绝
    let overlap_swap = arbiter.begin_atomic_swap(3000).await;
    assert!(overlap_swap.is_err());

    // 完成原子迁移
    arbiter.finish_atomic_swap("diffusion-worker".to_string()).await;
    assert_eq!(arbiter.phase().await, ArbiterPhase::Serving);

    // 3. 空闲冷却防抖倒计时 (30s)
    arbiter.start_idle_cooldown(Duration::from_secs(30)).await;
    assert_eq!(arbiter.phase().await, ArbiterPhase::CoolingDown);

    // 4. P0 交互对话请求到达，允许立即提前中断冷却倒计时
    let p0_lease = arbiter.acquire_lease(TaskPriority::P0InteractiveChat).await;
    assert!(p0_lease.is_ok());
    assert_eq!(arbiter.phase().await, ArbiterPhase::Serving);
}

#[tokio::test]
async fn test_ac4_status_snapshot_and_metrics() {
    let arbiter = VramArbiter::new();
    let snapshot = arbiter.get_status_snapshot().await;
    assert_eq!(snapshot.phase, ArbiterPhase::Idle);
    assert_eq!(snapshot.eta_ms, 0);
    assert!(snapshot.vram_budget_mb > 0);

    // 进入 swapping 阶段时，快照如实体现
    let _ = arbiter.begin_atomic_swap(6000).await;
    let swapping_snapshot = arbiter.get_status_snapshot().await;
    assert_eq!(swapping_snapshot.phase, ArbiterPhase::Swapping);
    assert_eq!(swapping_snapshot.eta_ms, 6000);
}
