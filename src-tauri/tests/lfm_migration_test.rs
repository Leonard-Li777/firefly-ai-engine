// tests/lfm_migration_test.rs
// Issue 08: 废弃 LFM2.5 清除与存量配置平滑迁移测试

use firefly_ai_engine_lib::config::{migrate_deprecated_models, ConfigStore, EngineConfig};
use firefly_ai_engine_lib::config::store::ModelCustomParams;
use std::collections::HashMap;
use std::path::PathBuf;

#[test]
fn test_ac2_lfm_deprecated_config_smooth_migration() {
    let mut config = EngineConfig::default();
    config.active_language_model = Some("LiquidAI/LFM2.5-1.2B-Instruct-DSpark-Q4_K_M".to_string());
    config.selected_model_path = Some(PathBuf::from("models/LFM2.5-1.2B-Instruct-GGUF--Q4_K_M.gguf"));

    let mut custom_params = HashMap::new();
    let lfm_params = ModelCustomParams {
        n_gpu_layers: 32,
        threads: 4,
        ctx_size: 2048,
        ..Default::default()
    };
    custom_params.insert("LFM2.5-1.2B-Instruct".to_string(), lfm_params.clone());
    config.model_custom_params = custom_params;

    // 1. 执行自动迁移
    let modified = migrate_deprecated_models(&mut config);
    assert!(modified, "检测到 LFM2.5 配置，必须执行迁移重定向");

    // 2. 验证主语言模型重定向至 Qwen 2.5
    let expected_target = "Qwen/Qwen2.5-1.5B-Instruct-GGUF:Q4_K_M";
    assert_eq!(
        config.active_language_model.as_deref(),
        Some(expected_target)
    );
    assert_eq!(config.selected_model_path, None);

    // 3. 验证专属参数键名平滑迁移且参数值无损保留
    assert!(!config.model_custom_params.contains_key("LFM2.5-1.2B-Instruct"));
    let migrated_params = config.model_custom_params.get(expected_target).expect("迁移后的参数必须存在");
    assert_eq!(migrated_params.n_gpu_layers, 32);
    assert_eq!(migrated_params.threads, 4);
    assert_eq!(migrated_params.ctx_size, 2048);

    // 4. 幂等性测试：再次执行不再重复修改
    let second_run = migrate_deprecated_models(&mut config);
    assert!(!second_run, "已迁移配置不可重复修改");
}

#[test]
fn test_ac3_store_load_persists_migration_without_500() {
    let temp_dir = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(temp_dir.path().to_path_buf());

    // 模拟存量老用户的 config.json 文件
    let legacy_json = serde_json::json!({
        "models_dir": "models",
        "active_language_model": "LFM2.5-1.2B-Instruct-GGUF",
        "selected_model_path": "models/LFM2.5.gguf",
        "model_custom_params": {
            "LFM2.5-1.2B-Instruct-GGUF": {
                "n_gpu_layers": 28,
                "threads": 6
            }
        }
    });

    let config_file = temp_dir.path().join("config.json");
    std::fs::write(&config_file, legacy_json.to_string()).unwrap();

    // 首次 load：自动触发 migrate 并写回磁盘
    let loaded = store.load().expect("加载老配置不得报错 500");
    assert_eq!(
        loaded.active_language_model.as_deref(),
        Some("Qwen/Qwen2.5-1.5B-Instruct-GGUF:Q4_K_M")
    );

    // 重新从磁盘读取，验证已完成写盘持久化
    let persisted_content = std::fs::read_to_string(&config_file).unwrap();
    assert!(!persisted_content.contains("LFM2.5"));
    assert!(persisted_content.contains("Qwen2.5-1.5B-Instruct"));
}
