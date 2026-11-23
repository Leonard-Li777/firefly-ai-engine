//! 引擎清单体积解析与 CUDA 13.x 候选链的回归门禁。
//!
//! 背景：镜像清单里 CUDA 13.x 的包键会随官方 Toolkit 小版本变化（cuda134 / cuda135 / cuda13），
//! 旧实现只认写死的 `cuda134` + `cudart-cuda134`，一旦官方升级到 13.5，体积就回落到硬编码常量
//! （150.2 MB），把「清单缺包」的真实故障伪装成一个看似精确的数字，并让 12.4 / 13.x 的体积对比失真。
//! 本测试锁定三条不变量：
//! 1. 清单缺包时必须返回 `None`（前端展示「-」），禁止任何伪造体积；
//! 2. 家族键（cuda13 / cudart-cuda13）与具体小版本键（cuda135 / cudart-cuda135）都必须命中；
//! 3. 下载候选与 cudart 候选必须沿 CUDA 13.x 小版本链（13.5 → 13.4 → 13.3）生成。

use std::collections::HashMap;

use firefly_ai_engine_lib::server::api::{
    extract_win_cuda_version, resolve_cudart_candidates, resolve_download_candidates,
    resolve_package_size_mb, resolve_win_tier_from_filename, ManifestPackageInfo,
    ManifestVersionInfo, RemoteManifest,
};

fn pkg(size: u64) -> ManifestPackageInfo {
    ManifestPackageInfo {
        file: None,
        size: Some(size),
        sha256: None,
    }
}

fn manifest_with(packages: Vec<(&str, u64)>) -> RemoteManifest {
    let map: HashMap<String, ManifestPackageInfo> = packages
        .into_iter()
        .map(|(key, size)| (key.to_string(), pkg(size)))
        .collect();
    RemoteManifest {
        latest_version: Some("b12345".to_string()),
        previous_version: None,
        versions: HashMap::from([("b12345".to_string(), ManifestVersionInfo { packages: map })]),
    }
}

/// 清单缺 CUDA 13 包时，体积必须返回 None，不能再用 150.2 之类常量冒充实测值。
#[test]
fn missing_cuda13_package_returns_none_instead_of_fabricated_constant() {
    let manifest = manifest_with(vec![("cuda124", 319_018_486), ("cudart-cuda124", 391_443_627)]);

    assert_eq!(resolve_package_size_mb(Some(&manifest), "cuda134"), None);
    assert_eq!(resolve_package_size_mb(Some(&manifest), "cuda13"), None);

    // 12.4 有真实包，体积必须是「主包 + cudart」的精确总和（Windows）或主包本身（非 Windows）
    let expected = if cfg!(windows) {
        (319_018_486f64 + 391_443_627f64) / (1024.0 * 1024.0)
    } else {
        319_018_486f64 / (1024.0 * 1024.0)
    };
    let actual = resolve_package_size_mb(Some(&manifest), "cuda").expect("cuda124 包必须命中");
    assert!((actual - expected).abs() < 0.05, "cuda12 体积应为 {expected:.1} MB，实际 {actual:.1} MB");
}

/// 具体小版本键（cuda135 / cudart-cuda135）与家族键（cuda13 / cudart-cuda13）都必须命中。
#[test]
fn versioned_and_family_keys_both_resolve() {
    let versioned = manifest_with(vec![("cuda135", 179_650_000), ("cudart-cuda135", 426_400_000)]);
    let family = manifest_with(vec![("cuda13", 179_650_000), ("cudart-cuda13", 426_400_000)]);

    let expected = if cfg!(windows) {
        (179_650_000f64 + 426_400_000f64) / (1024.0 * 1024.0)
    } else {
        179_650_000f64 / (1024.0 * 1024.0)
    };

    for manifest in [&versioned, &family] {
        let actual = resolve_package_size_mb(Some(manifest), "cuda134").expect("13.x 包必须命中");
        assert!((actual - expected).abs() < 0.05, "13.x 体积应为 {expected:.1} MB，实际 {actual:.1} MB");
    }
}

/// 下载候选必须从最新的 CUDA 13.x 小版本开始，并保留旧小版本作为降级链。
#[test]
fn cuda13_download_candidates_follow_version_chain() {
    let versions = vec!["b12345".to_string()];
    let candidates = resolve_download_candidates("cuda134", &versions);
    let filenames: Vec<&str> = candidates.iter().map(|c| c.filename.as_str()).collect();

    assert_eq!(filenames[0], "llama-b12345-bin-win-cuda-13.5-x64.zip");
    assert!(filenames.contains(&"llama-b12345-bin-win-cuda-13.4-x64.zip"));
    assert!(filenames.contains(&"llama-b12345-bin-win-cuda-13.3-x64.zip"));
    assert!(!filenames.iter().any(|f| f.contains("cuda-12.4")));
}

/// cudart 候选必须以「实际下载到的主包小版本」为准，禁止再按写死的 13.4 / 13.3 分支猜测。
#[test]
fn cudart_candidates_follow_actual_main_package_version() {
    let cuda13 = resolve_cudart_candidates(
        "b12345",
        "llama-b12345-bin-win-cuda-13.5-x64.zip",
    );
    assert_eq!(cuda13[0].filename, "cudart-llama-bin-win-cuda-13.5-x64.zip");
    assert!(cuda13.iter().any(|c| c.filename.contains("cuda-13.4")));
    assert!(!cuda13.iter().any(|c| c.filename.contains("cuda-12.4")));

    let cuda12 = resolve_cudart_candidates(
        "b12345",
        "llama-b12345-bin-win-cuda-12.4-x64.zip",
    );
    assert_eq!(cuda12.len(), 1);
    assert_eq!(cuda12[0].filename, "cudart-llama-bin-win-cuda-12.4-x64.zip");
}

/// 引擎目录 tier 必须由实际包名反解，避免「下载 13.5、目录却叫 13.4」的错位。
#[test]
fn win_tier_is_derived_from_actual_package_name() {
    assert_eq!(
        resolve_win_tier_from_filename("llama-b12345-bin-win-cuda-13.5-x64.zip").as_deref(),
        Some("cuda-13.5")
    );
    assert_eq!(
        resolve_win_tier_from_filename("llama-b12345-bin-win-cuda-12.4-x64.zip").as_deref(),
        Some("cuda-12.4")
    );
    assert_eq!(
        resolve_win_tier_from_filename("llama-b12345-bin-macos-arm64.tar.gz"),
        None
    );
    assert_eq!(
        extract_win_cuda_version("cudart-llama-bin-win-cuda-13.5-x64.zip").as_deref(),
        Some("13.5")
    );
}
