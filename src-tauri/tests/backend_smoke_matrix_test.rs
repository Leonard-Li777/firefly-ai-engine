// tests/backend_smoke_matrix_test.rs
// Issue 03: 独立临时 Worker 1-Token 冒烟测试器与硬件变体矩阵测试

use firefly_ai_engine_lib::hardware::backend_smoke::{
    build_composite_smoke_cache_key, classify_exit_status, derive_backend_priority_ladder,
    detect_vendor_from_id, should_prune_backend, BackendViability, GpuVendorType,
    SmokePersistenceManager,
};

#[test]
fn test_ac1_precise_exit_status_classification() {
    // 1. Success (0) -> Viable
    let res = classify_exit_status(0, false);
    assert_eq!(res, BackendViability::Viable);
    assert!(res.is_viable());
    assert!(!res.should_blacklist());

    // 2. STATUS_ACCESS_VIOLATION (0xC0000005) -> IncompatibleDriverOrCrash (黑名单)
    let res = classify_exit_status(0xC0000005, false);
    assert_eq!(
        res,
        BackendViability::IncompatibleDriverOrCrash {
            status_code: 0xC0000005
        }
    );
    assert!(!res.is_viable());
    assert!(res.should_blacklist());
    assert!(!res.is_transient());

    // 3. STATUS_ILLEGAL_INSTRUCTION (0xC000001D) -> IllegalInstruction (黑名单)
    let res = classify_exit_status(0xC000001D, false);
    assert_eq!(
        res,
        BackendViability::IllegalInstruction {
            status_code: 0xC000001D
        }
    );
    assert!(res.should_blacklist());

    // 4. STATUS_NO_MEMORY (0xC0000017 / 137) -> TransientOom (瞬态繁忙，严禁拉黑)
    let res = classify_exit_status(0xC0000017, false);
    assert_eq!(
        res,
        BackendViability::TransientOom {
            status_code: 0xC0000017
        }
    );
    assert!(res.is_transient());
    assert!(!res.should_blacklist(), "瞬态 OOM 严禁永久拉黑");

    let res_137 = classify_exit_status(137, false);
    assert_eq!(
        res_137,
        BackendViability::TransientOom { status_code: 137 }
    );
    assert!(res_137.is_transient());
    assert!(!res_137.should_blacklist());

    // 5. 20s 硬超时 -> Timeout
    let res_timeout = classify_exit_status(0, true);
    assert_eq!(res_timeout, BackendViability::Timeout);
    assert!(!res_timeout.is_viable());
}

#[test]
fn test_ac2_composite_cache_key_and_vendor_pruning() {
    // 1. 五维复合键格式断言
    let key = build_composite_smoke_cache_key(
        "llama",
        "cuda",
        "10de_2484",
        "551.86",
        "v1.2.0",
    );
    assert_eq!(key, "llama_cuda_10de_2484_551.86_v1.2.0");

    // 2. DXGI 厂商 ID 识别
    assert_eq!(detect_vendor_from_id(0x10DE), GpuVendorType::Nvidia);
    assert_eq!(detect_vendor_from_id(0x1002), GpuVendorType::Amd);
    assert_eq!(detect_vendor_from_id(0x8086), GpuVendorType::Intel);
    assert_eq!(detect_vendor_from_id(0x9999), GpuVendorType::Other);

    // 3. 先行剪枝：AMD / Intel 自动跳过 CUDA
    assert!(should_prune_backend(GpuVendorType::Amd, "cuda"));
    assert!(should_prune_backend(GpuVendorType::Amd, "cuda12"));
    assert!(should_prune_backend(GpuVendorType::Intel, "cuda"));
    assert!(!should_prune_backend(GpuVendorType::Nvidia, "cuda"));
    assert!(!should_prune_backend(GpuVendorType::Amd, "vulkan"));
}

#[tokio::test]
async fn test_ac2_persistence_manager_storage() {
    let temp_dir = tempfile::tempdir().unwrap();
    let manager = SmokePersistenceManager::new(temp_dir.path());

    let key = "llama_cuda_test_gpu_driver1_v1".to_string();
    assert!(manager.get(&key).await.is_none());

    // 写入探测结果
    manager.set(key.clone(), BackendViability::Viable).await;
    assert_eq!(manager.get(&key).await, Some(BackendViability::Viable));

    // 重新实例化读取持久化文件，断言跨进程持久化一致性
    let reloaded = SmokePersistenceManager::new(temp_dir.path());
    assert_eq!(reloaded.get(&key).await, Some(BackendViability::Viable));
}

#[test]
fn test_ac3_backend_priority_ladder_derivation() {
    // 1. NVIDIA GPU profile
    let ladder_nv = derive_backend_priority_ladder(GpuVendorType::Nvidia, true, true);
    assert_eq!(ladder_nv, vec!["cuda", "vulkan", "cpu-avx2", "cpu"]);

    // 2. AMD GPU profile
    let ladder_amd = derive_backend_priority_ladder(GpuVendorType::Amd, true, true);
    assert_eq!(ladder_amd, vec!["vulkan", "sycl", "cpu-avx2", "cpu"]);

    // 3. Intel GPU profile
    let ladder_intel = derive_backend_priority_ladder(GpuVendorType::Intel, true, false);
    assert_eq!(ladder_intel, vec!["vulkan", "sycl", "cpu"]);

    // 4. 纯 CPU profile (有 AVX2)
    let ladder_cpu_avx2 = derive_backend_priority_ladder(GpuVendorType::Other, false, true);
    assert_eq!(ladder_cpu_avx2, vec!["cpu-avx2", "cpu"]);

    // 5. 纯 CPU profile (无 AVX2)
    let ladder_cpu_generic = derive_backend_priority_ladder(GpuVendorType::Other, false, false);
    assert_eq!(ladder_cpu_generic, vec!["cpu"]);
}
