// tests/param_builder_test.rs
// 参数自适应调优集成测试：验证 GGUF 元数据感知、Max-Fill 上下文、显存实时探针感知与思考模式隔离

use firefly_ai_engine_lib::engine::flag_detector::ServerFeatureFlags;
use firefly_ai_engine_lib::engine::gguf_parser::GgufMetadata;
use firefly_ai_engine_lib::engine::param_builder::{ModelInfo, ParamBuilder};
use firefly_ai_engine_lib::hardware::gpu_info::{
    AccelerationTier, CpuInfo, GpuInfo, GpuVendor, MemoryInfo, SystemResources,
};

fn make_test_resources(vram_mb: u64, free_vram_mb: Option<u64>) -> SystemResources {
    SystemResources {
        cpu: CpuInfo {
            model: "13th Gen Intel Core i7-13700".to_string(),
            cores: 16,
            threads: 24,
            speed_mhz: 3400,
            ..Default::default()
        },
        memory: MemoryInfo {
            total_mb: 32768,
            available_mb: 24576,
        },
        gpus: vec![GpuInfo {
            name: "NVIDIA GeForce RTX 4070".to_string(),
            memory_mb: vram_mb,
            memory_free_mb: free_vram_mb,
            vendor: GpuVendor::Nvidia,
            is_integrated: false,
            supports_cuda: true,
            supports_vulkan: true,
            supports_hip: false,
            supports_metal: false,
            supports_sycl: false,
        }],
        best_acceleration_tier: AccelerationTier::Cuda,
    }
}

fn make_base_model(param_b: f64, size_gb: f64) -> ModelInfo {
    ModelInfo {
        param_b,
        size_gb,
        quantization: "Q4_K_M".to_string(),
        is_multimodal: false,
        enable_vision: true,
        enable_draft: true,
        draft_max_tokens: None,
        context_window: None,
        force_gpu_layers: None,
        force_batch_size: None,
        force_ubatch_size: None,
        force_cpu: false,
        enable_thinking: false,
        is_minicpm5: false,
        is_nanbeige4: false,
        mmproj_path: None,
        dspark_path: None,
        draft_path: None,
        cache_type_k: None,
        cache_type_v: None,
        parallel: None,
        temp: None,
        top_p: None,
        top_k: None,
        repeat_penalty: None,
        is_embedding: false,
        is_production: false,
        gguf_meta: None,
        server_flags: None,
        tolerant_template_path: None,
    }
}

#[test]
fn test_effective_layers_prefers_gguf_metadata() {
    let mut model = make_base_model(7.0, 4.3);
    // 无元数据时，7B 模型基于参数量盲猜 32 层
    assert_eq!(model.effective_layers(), 32);

    // 注入真实 GGUF 元数据（如 Gemma-2-9B 或 Qwen2-7B 的 28 层或 DeepSeek 36 层）
    model.gguf_meta = Some(GgufMetadata {
        arch: "deepseek2".to_string(),
        n_layer: 36,
        n_head: Some(16),
        n_kv_head: 2,
        head_dim: 128,
        train_ctx: 32768,
        has_strict_role_alternation: false,
        chat_template: None,
        ..Default::default()
    });

    assert_eq!(
        model.effective_layers(),
        36,
        "存在 GGUF 元数据时必须优先使用真实物理层数 36，拒绝盲猜"
    );
    assert_eq!(
        model.train_context_size(),
        32768,
        "训练上下文必须优先读取 GGUF 元数据"
    );
}

#[test]
fn test_max_fill_context_and_alignment() {
    // 16GB 显存，充裕空间容纳 4.3GB 模型后，剩余显存 Max-Fill 动态推算
    let resources = make_test_resources(16 * 1024, None);
    let mut model = make_base_model(7.0, 4.3);
    model.gguf_meta = Some(GgufMetadata {
        arch: "qwen2".to_string(),
        n_layer: 28,
        n_head: Some(28),
        n_kv_head: 4,
        head_dim: 128,
        train_ctx: 32768,
        has_strict_role_alternation: false,
        chat_template: None,
        ..Default::default()
    });

    let params = ParamBuilder::compute(&resources, &model, "cuda");
    // 剩余显存 = 16 - 0.8 - 4.3 = 10.9GB
    // bytes_per_token = 4 (kv_head) * 128 (dim) * (2+2) * 28 (ngl) = 57344 bytes/token ≈ 56KB/token
    // 可用 token 数量非常充裕，应触顶或 clamp 到 train_ctx (32768)
    assert!(params.ctx_size >= 8192, "充裕显存下 ctx_size 应动态拉伸，实际为 {}", params.ctx_size);
    assert_eq!(params.ctx_size % 256, 0, "ctx_size 必须对齐 256 步长");
    assert!(params.ctx_size <= 32768, "ctx_size 不得超过预训练上限");
}

#[test]
fn test_max_fill_fallback_when_vram_constrained() {
    // 显存极度紧张：6GB 显卡，可用 5.2GB，但模型已占 5.0GB
    let resources = make_test_resources(6 * 1024, None);
    let mut model = make_base_model(7.0, 5.0);
    model.gguf_meta = Some(GgufMetadata {
        arch: "llama".to_string(),
        n_layer: 32,
        n_head: Some(32),
        n_kv_head: 8,
        head_dim: 128,
        train_ctx: 16384,
        has_strict_role_alternation: false,
        chat_template: None,
        ..Default::default()
    });

    let params = ParamBuilder::compute(&resources, &model, "cuda");
    // 剩余显存不足 128MB，触发安全兜底回退
    assert_eq!(params.ctx_size, 2048, "显存不足时 Max-Fill 必须安全兜底到 2048");
}

#[test]
fn test_free_vram_probe_affects_offload_decision() {
    // 总显存 16GB，但真实实时探测到仅剩 3.5GB（后台有竞态进程消耗）
    let resources = make_test_resources(16 * 1024, Some(3500));
    let model = make_base_model(7.0, 4.3);

    let params = ParamBuilder::compute(&resources, &model, "cuda");
    // usable_vram = 3.5 - 0.8 = 2.7GB
    // offload_ratio = 2.7 / 4.3 ≈ 62.7% < 88%
    assert_ne!(
        params.gpu_layers, -1,
        "在实时探测到空闲显存不足时，严禁盲目全量卸载 (-ngl -1)"
    );
    assert!(
        params.gpu_layers > 0 && params.gpu_layers < 32,
        "应根据真实可用显存按比例卸载层数，实际计算为: {}",
        params.gpu_layers
    );
}

#[test]
fn test_thinking_mode_isolation_strict() {
    let resources = make_test_resources(16 * 1024, None);
    let mut model = make_base_model(7.0, 4.3);

    // 1. 关闭思考模式：坚决使用 ChatML 组合拳抑制思考外溢
    model.enable_thinking = false;
    model.server_flags = Some(ServerFeatureFlags::full_featured());
    let params = ParamBuilder::compute(&resources, &model, "cuda");
    let args_off = ParamBuilder::to_args(&params, 38400, "C:\\model.gguf", "qwen", Some(&model));

    assert!(args_off.contains(&"--reasoning".to_string()));
    let r_idx = args_off.iter().position(|r| r == "--reasoning").unwrap();
    assert_eq!(args_off[r_idx + 1], "off");

    assert!(args_off.contains(&"--reasoning-format".to_string()));
    let rf_idx = args_off.iter().position(|r| r == "--reasoning-format").unwrap();
    assert_eq!(args_off[rf_idx + 1], "none");

    assert!(args_off.contains(&"--reasoning-budget".to_string()));
    let rb_idx = args_off.iter().position(|r| r == "--reasoning-budget").unwrap();
    assert_eq!(args_off[rb_idx + 1], "0");

    assert!(!args_off.contains(&"--chat-template-file".to_string()), "关闭思考模式严禁注入宽容模板");

    // 2. 开启思考模式：按需注入宽容 Jinja 模板
    model.enable_thinking = true;
    model.tolerant_template_path = Some("C:\\temp\\model.tolerant.jinja".to_string());
    let args_on = ParamBuilder::to_args(&params, 38400, "C:\\model.gguf", "qwen", Some(&model));

    assert!(!args_on.contains(&"--reasoning".to_string()));
    assert!(!args_on.contains(&"--reasoning-format".to_string()));
    assert!(args_on.contains(&"--chat-template-file".to_string()));
    let ctf_idx = args_on.iter().position(|r| r == "--chat-template-file").unwrap();
    assert_eq!(args_on[ctf_idx + 1], "C:\\temp\\model.tolerant.jinja");
}

#[test]
fn test_sanitize_tolerant_jinja() {
    let raw_gemma_template = r#"
{{ bos_token }}
{% if messages[0]['role'] == 'system' %}
    {{ raise_exception('System role not supported') }}
{% endif %}
{% for message in messages %}
    {% if (message['role'] == 'user') != (loop.index0 % 2 == 0) %}
        {{ raise_exception('Conversation roles must alternate user/assistant/user/assistant...') }}
    {% endif %}
    {{ '<start_of_turn>' + message['role'] + '\n' + message['content'] | trim + '<end_of_turn>\n' }}
{% endfor %}
{% if add_generation_prompt %}
    {{ '<start_of_turn>model\n' }}
{% endif %}
"#;

    let sanitized = ParamBuilder::sanitize_tolerant_jinja(raw_gemma_template);
    assert!(
        !sanitized.contains("roles must alternate"),
        "清洗后不得保留严格角色交替报错代码"
    );
    assert!(
        sanitized.contains("<start_of_turn>"),
        "清洗后必须保留原有的 turn 标记结构"
    );
    assert!(
        sanitized.contains("add_generation_prompt"),
        "清洗后必须保留生成提示符"
    );
}

#[test]
fn test_flag_detector_legacy_server_graceful_downgrade() {
    let resources = make_test_resources(16 * 1024, None);
    let mut model = make_base_model(7.0, 4.3);
    model.enable_thinking = false;

    // 模拟旧版 llama.cpp：不支持 --reasoning*、不支持 --alias、不支持 --chat-template-file
    model.server_flags = Some(ServerFeatureFlags {
        supports_alias: false,
        supports_chat_template_file: false,
        supports_cache_reuse: false,
        supports_flash_attn: true,
        supports_reasoning: false,
        supports_reasoning_format: false,
        supports_reasoning_budget: false,
    });

    let params = ParamBuilder::compute(&resources, &model, "cuda");
    let args = ParamBuilder::to_args(&params, 38400, "C:\\model.gguf", "qwen", Some(&model));

    assert!(!args.contains(&"--alias".to_string()), "旧版服务必须省略 --alias");
    assert!(!args.contains(&"--reasoning".to_string()), "旧版服务必须省略 --reasoning");
    assert!(!args.contains(&"--reasoning-format".to_string()), "旧版服务必须省略 --reasoning-format");
    assert!(!args.contains(&"--reasoning-budget".to_string()), "旧版服务必须省略 --reasoning-budget");
}

#[test]
fn test_to_args_non_multimodal_ignores_mmproj() {
    let resources = make_test_resources(16 * 1024, None);
    let mut model = make_base_model(7.0, 4.3);
    model.is_multimodal = false;
    model.mmproj_path = Some("D:\\models\\mmproj.gguf".to_string());

    let params = ParamBuilder::compute(&resources, &model, "cuda");
    let args = ParamBuilder::to_args(&params, 38400, "D:\\models\\text-only.gguf", "test-model", Some(&model));

    assert!(!args.contains(&"--mmproj".to_string()), "非多模态模型即使有投影文件也不应注入 --mmproj");

    model.is_multimodal = true;
    let args_mm = ParamBuilder::to_args(&params, 38400, "D:\\models\\vl-model.gguf", "vl-model", Some(&model));
    assert!(args_mm.contains(&"--mmproj".to_string()), "多模态模型且存在投影文件时应注入 --mmproj");
}

#[test]
fn test_to_args_respects_enable_vision_and_draft_interlocks() {
    let resources = make_test_resources(16 * 1024, None);
    let mut model = make_base_model(7.0, 4.3);
    model.is_multimodal = true;
    model.mmproj_path = Some("D:\\models\\mmproj.gguf".to_string());
    model.dspark_path = Some("D:\\models\\dspark.gguf".to_string());
    model.enable_vision = false;
    model.enable_draft = false;

    let params = ParamBuilder::compute(&resources, &model, "cuda");
    let args_disabled = ParamBuilder::to_args(&params, 38400, "D:\\models\\main.gguf", "test-model", Some(&model));

    assert!(!args_disabled.contains(&"--mmproj".to_string()), "用户关闭识图后即使有投影文件也不应注入 --mmproj");
    assert!(!args_disabled.contains(&"--model-draft".to_string()), "用户关闭加速后即使有草稿文件也不应注入 --model-draft");

    // 重新开启并自定义步数（2026-10-20 起 DSpark 取消 15 下限：用户值透传）
    model.enable_vision = true;
    model.enable_draft = true;
    model.draft_max_tokens = Some(7);
    let args_enabled = ParamBuilder::to_args(&params, 38400, "D:\\models\\main.gguf", "test-model", Some(&model));

    assert!(args_enabled.contains(&"--mmproj".to_string()), "用户开启识图后应注入 --mmproj");
    assert!(args_enabled.contains(&"--model-draft".to_string()), "用户开启加速后应注入 --model-draft");
    let nmax_idx = args_enabled.iter().position(|r| r == "--spec-draft-n-max").unwrap();
    assert_eq!(args_enabled[nmax_idx + 1], "7", "DSpark n-max 低于 15 时应透传用户配置");
    let ngld_idx = args_enabled.iter().position(|r| r == "--gpu-layers-draft").unwrap();
    assert_eq!(args_enabled[ngld_idx + 1], "-1", "GPU 模式下草稿模型应显式全量常驻显存（-1）");

    // 用户配置更高时透传
    model.draft_max_tokens = Some(20);
    let args_higher = ParamBuilder::to_args(&params, 38400, "D:\\models\\main.gguf", "test-model", Some(&model));
    let nmax_idx2 = args_higher.iter().position(|r| r == "--spec-draft-n-max").unwrap();
    assert_eq!(args_higher[nmax_idx2 + 1], "20", "DSpark n-max 应透传用户配置");

    // 未配置时默认取甜点值 6（对齐草稿平均命中长度 2.4~4.15，砍掉 15 的无效猜测）
    model.draft_max_tokens = None;
    let args_default = ParamBuilder::to_args(&params, 38400, "D:\\models\\main.gguf", "test-model", Some(&model));
    let nmax_idx3 = args_default.iter().position(|r| r == "--spec-draft-n-max").unwrap();
    assert_eq!(args_default[nmax_idx3 + 1], "6", "DSpark 未配置 n-max 时应默认 6");
}
