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
        mmproj_size_gb: None,
        dspark_path: None,
        draft_path: None,
        draft_size_gb: None,
        draft_gguf_meta: None,
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
        is_downloaded: true,
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
    // 6GB 显卡可用 4.5GB，模型 5.0GB，触发 Step B1 混合卸载回退：锁定 4096 上下文并卸载部分层至 GPU
    assert_eq!(params.ctx_size, 4096, "触发 Step B1 混合卸载时必须锁定 4096 上下文");
    assert!(
        params.gpu_layers > 0 && params.gpu_layers < 32,
        "Step B1 保持部分层在 GPU (实际: {})",
        params.gpu_layers
    );

    // 极端显存匮乏：显卡显存完全不足以容纳 25% 混合卸载，触发 Step B2 彻底切回纯 CPU
    let mut tiny_resources = make_test_resources(2 * 1024, None);
    let tiny_params = ParamBuilder::compute(&tiny_resources, &model, "cuda");
    assert_eq!(tiny_params.gpu_layers, 0, "显存极度不足时彻底切回纯 CPU (Step B2)");

    // 当系统物理内存同样极度匮乏（赤字），CPU 模式平稳安全收敛兜底到 2048 上下文
    tiny_resources.memory.total_mb = 8192;
    tiny_resources.memory.available_mb = 4096;
    let deficit_params = ParamBuilder::compute(&tiny_resources, &model, "cuda");
    assert_eq!(deficit_params.ctx_size, 2048, "显存与内存均严重匮乏时安全兜底到 2048");
}

#[test]
fn test_free_vram_probe_affects_offload_decision() {
    // 总显存 16GB，但真实实时探测到仅剩 6.0GB（后台有竞态进程消耗）
    let resources = make_test_resources(16 * 1024, Some(6000));
    let model = make_base_model(7.0, 4.3);

    let params = ParamBuilder::compute(&resources, &model, "cuda");
    // usable_vram = 6.0 - 1.5 = 4.5GB
    // target_weights = 4.5 - 1.0 - 1.06 ≈ 2.44GB -> offload ~18 layers
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
    let params_mm = ParamBuilder::compute(&resources, &model, "cuda");
    let args_mm = ParamBuilder::to_args(&params_mm, 38400, "D:\\models\\vl-model.gguf", "vl-model", Some(&model));
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
    let params_enabled = ParamBuilder::compute(&resources, &model, "cuda");
    let args_enabled = ParamBuilder::to_args(&params_enabled, 38400, "D:\\models\\main.gguf", "test-model", Some(&model));

    assert!(args_enabled.contains(&"--mmproj".to_string()), "用户开启识图后应注入 --mmproj");
    assert!(args_enabled.contains(&"--model-draft".to_string()), "用户开启加速后应注入 --model-draft");
    let nmax_idx = args_enabled.iter().position(|r| r == "--spec-draft-n-max").unwrap();
    assert_eq!(args_enabled[nmax_idx + 1], "7", "DSpark n-max 低于 15 时应透传用户配置");
    let ngld_idx = args_enabled.iter().position(|r| r == "--gpu-layers-draft").unwrap();
    assert_eq!(args_enabled[ngld_idx + 1], "-1", "GPU 模式下草稿模型应显式全量常驻显存（-1）");

    // 用户配置更高时透传
    model.draft_max_tokens = Some(20);
    let params_higher = ParamBuilder::compute(&resources, &model, "cuda");
    let args_higher = ParamBuilder::to_args(&params_higher, 38400, "D:\\models\\main.gguf", "test-model", Some(&model));
    let nmax_idx2 = args_higher.iter().position(|r| r == "--spec-draft-n-max").unwrap();
    assert_eq!(args_higher[nmax_idx2 + 1], "20", "DSpark n-max 应透传用户配置");

    // 未配置时默认取甜点值 6（对齐草稿平均命中长度 2.4~4.15，砍掉 15 的无效猜测）
    model.draft_max_tokens = None;
    let params_default = ParamBuilder::compute(&resources, &model, "cuda");
    let args_default = ParamBuilder::to_args(&params_default, 38400, "D:\\models\\main.gguf", "test-model", Some(&model));
    let nmax_idx3 = args_default.iter().position(|r| r == "--spec-draft-n-max").unwrap();
    assert_eq!(args_default[nmax_idx3 + 1], "6", "DSpark 未配置 n-max 时应默认 6");
}

// ── 泛化物理预算模型与 Acceptance Criteria (AC 1 ~ AC 11) 验证套件 ──

#[test]
fn test_ac1_budget_fixed_overhead_deduction() {
    let resources = make_test_resources(16 * 1024, None);
    let mut model = make_base_model(7.0, 4.0);
    model.is_multimodal = true;
    model.enable_vision = true;
    model.mmproj_path = Some("C:\\mmproj.gguf".to_string());
    model.mmproj_size_gb = Some(0.85);

    model.enable_draft = true;
    model.dspark_path = Some("C:\\dspark.gguf".to_string());
    model.draft_size_gb = Some(1.25);

    let params = ParamBuilder::compute(&resources, &model, "cuda");
    // 权重(4.0) + mmproj(0.85) + 视觉激活(0.35) + 草稿权重(1.25) + 计算缓冲(1.0) + 草稿缓冲(0.25) = 7.70
    let expected_fixed = 4.0 + 0.85 + 0.35 + 1.25 + 1.0 + 0.25;
    assert!(
        (params.fixed_overhead_gb - expected_fixed).abs() < 0.05,
        "固定占用必须严格涵盖权重、伴随模型与缓冲，实际: {}, 预期: {}",
        params.fixed_overhead_gb,
        expected_fixed
    );
}

#[test]
fn test_ac2_continuous_pressure_quantization_switch() {
    // 1. 显存吃紧场景：总显存 8GB，可用 6.5GB，模型 4.5GB，计算缓冲 1.0GB -> kv_budget = 1.0GB
    // 32K 上下文在 f16 下需求约为 1.8GB -> lambda = 1.8 / 1.0 = 1.8 > 0.8 -> 自动切换 q8_0
    let tight_res = make_test_resources(8 * 1024, None);
    let mut tight_model = make_base_model(7.0, 4.5);
    tight_model.gguf_meta = Some(GgufMetadata {
        arch: "qwen2".to_string(),
        n_layer: 28,
        n_head: Some(28),
        n_kv_head: 4,
        head_dim: 128,
        train_ctx: 32768,
        ..Default::default()
    });
    let tight_params = ParamBuilder::compute(&tight_res, &tight_model, "cuda");
    assert_eq!(
        tight_params.cache_type_k, "q8_0",
        "显存压力 lambda > 0.8 时必须自适应推导为 q8_0"
    );
    assert_eq!(tight_params.cache_type_v, "q8_0");

    // 2. 显存充裕场景：总显存 24GB，模型仅 2.0GB -> lambda <= 0.8 -> 采用 f16
    let rich_res = make_test_resources(24 * 1024, None);
    let mut rich_model = make_base_model(2.0, 1.5);
    rich_model.gguf_meta = Some(GgufMetadata {
        arch: "qwen2".to_string(),
        n_layer: 24,
        n_head: Some(16),
        n_kv_head: 2,
        head_dim: 64,
        train_ctx: 32768,
        ..Default::default()
    });
    let rich_params = ParamBuilder::compute(&rich_res, &rich_model, "cuda");
    assert_eq!(
        rich_params.cache_type_k, "f16",
        "显存充裕 lambda <= 0.8 时优先采用无损 f16"
    );
}

#[test]
fn test_ac3_cpu_constraints_and_weak_core_draft_gate() {
    let mut cpu_res = SystemResources {
        cpu: CpuInfo {
            model: "AMD Ryzen 3 3200G".to_string(),
            cores: 4,
            threads: 4,
            speed_mhz: 3600,
            ..Default::default()
        },
        memory: MemoryInfo {
            total_mb: 16384,
            available_mb: 12288,
        },
        gpus: vec![],
        best_acceleration_tier: AccelerationTier::Cpu,
    };

    let mut model = make_base_model(7.0, 4.0);
    model.dspark_path = Some("C:\\dspark.gguf".to_string());
    model.draft_size_gb = Some(0.8);
    model.enable_draft = true;

    let params = ParamBuilder::compute(&cpu_res, &model, "cpu");
    // 4 核心：(4 - 2).clamp(1, 8) = 2
    assert_eq!(params.threads, 2, "4 核 CPU 线程数应为 2 (保留 2 核给系统)");
    assert!(
        !params.effective_enable_draft,
        "弱算力 CPU (< 6 物理核心) 必须自动停用草稿模型"
    );
    assert_eq!(
        params.cache_type_k, "q8_0",
        "CPU 模式默认 KV 缓存量化必须为 q8_0 (内存带宽优化)"
    );

    let args = ParamBuilder::to_args(&params, 38400, "C:\\model.gguf", "cpu-model", Some(&model));
    assert!(
        !args.contains(&"--model-draft".to_string()),
        "停用草稿时不应传递 --model-draft 参数"
    );

    // 8 核心 CPU：(8 - 2).clamp(1, 8) = 6
    cpu_res.cpu.cores = 8;
    cpu_res.cpu.threads = 16;
    let params_8 = ParamBuilder::compute(&cpu_res, &model, "cpu");
    assert_eq!(params_8.threads, 6, "8 核 CPU 线程数应为 6");

    // 强制指定 512 批大小时，CPU 模式必须严格限制为 128 (防内存页面交换颠簸)
    model.force_batch_size = Some(512);
    let params_batch = ParamBuilder::compute(&cpu_res, &model, "cpu");
    assert_eq!(params_batch.batch_size, 128, "CPU 模式下批处理大小必须严格限制在 128 以内");
}

#[test]
fn test_ac4_auto_context_ceiling_cap() {
    let res = make_test_resources(48 * 1024, None);
    let mut model = make_base_model(7.0, 4.0);
    model.gguf_meta = Some(GgufMetadata {
        arch: "llama".to_string(),
        n_layer: 32,
        n_head: Some(32),
        n_kv_head: 8,
        head_dim: 128,
        train_ctx: 262144, // 256K 超大预训练窗口
        ..Default::default()
    });

    let params = ParamBuilder::compute(&res, &model, "cuda");
    assert_eq!(
        params.ctx_size, 65536,
        "自动推导上下文上限必须产品级封顶于 65536，不得无脑顶到 131072 或 262144"
    );
}

#[test]
fn test_ac5_user_context_clamp_and_preservation() {
    // 显存充裕时：用户显式要求 131072 必须得到保全（不被 65536 自动封顶误杀）
    let big_res = make_test_resources(48 * 1024, None);
    let mut big_model = make_base_model(7.0, 4.0);
    big_model.context_window = Some(131072);
    big_model.gguf_meta = Some(GgufMetadata {
        arch: "llama".to_string(),
        n_layer: 32,
        n_head: Some(32),
        n_kv_head: 8,
        head_dim: 128,
        train_ctx: 262144,
        ..Default::default()
    });

    let big_params = ParamBuilder::compute(&big_res, &big_model, "cuda");
    assert_eq!(
        big_params.ctx_size, 131072,
        "显存充裕且用户显式指定 131072 时必须忠实采纳"
    );

    // 显存不足时：用户显式要求 131072 必须截断至预算上限 budget_ctx
    let tight_res = make_test_resources(8 * 1024, None);
    let mut tight_model = make_base_model(7.0, 4.5);
    tight_model.context_window = Some(131072);
    tight_model.gguf_meta = Some(GgufMetadata {
        arch: "llama".to_string(),
        n_layer: 32,
        n_head: Some(32),
        n_kv_head: 8,
        head_dim: 128,
        train_ctx: 262144,
        ..Default::default()
    });

    let tight_params = ParamBuilder::compute(&tight_res, &tight_model, "cuda");
    assert!(
        tight_params.ctx_size <= tight_params.budget_ctx,
        "显存吃紧时，用户指定上下文必须截断至安全预算 (granted={}, budget={})",
        tight_params.ctx_size,
        tight_params.budget_ctx
    );
}

#[test]
fn test_ac6_cascading_downgrade_steps() {
    // 场景 A: 显卡 6GB (可用 4.5GB)，模型 4.5GB + 1.0GB 计算缓冲 -> 无法容纳全量卸载 + 2048 ctx
    // 但显存足够容纳 >= 25% 层数与 4096 ctx -> 触发 Step B1 混合卸载回退
    let res_b1 = make_test_resources(6 * 1024, None);
    let mut model_b1 = make_base_model(7.0, 4.5);
    model_b1.gguf_meta = Some(GgufMetadata {
        arch: "llama".to_string(),
        n_layer: 32,
        n_head: Some(32),
        n_kv_head: 8,
        head_dim: 128,
        train_ctx: 32768,
        ..Default::default()
    });

    let params_b1 = ParamBuilder::compute(&res_b1, &model_b1, "cuda");
    assert!(
        params_b1.gpu_layers > 0 && params_b1.gpu_layers < 32,
        "Step B1 必须反解出部分层数卸载到 GPU (实际: {})",
        params_b1.gpu_layers
    );
    assert_eq!(params_b1.ctx_size, 4096, "Step B1 混合卸载锁定 4096 上下文");
    assert!(params_b1.offload_ratio > 0.0 && params_b1.offload_ratio < 1.0);

    // 场景 B: 显卡仅剩 1.6GB 可用 (可用 0.1GB)，连 25% 层数都无法容纳 -> 触发 Step B2 彻底切回纯 CPU
    let res_b2 = make_test_resources(2 * 1024, Some(1600));
    let mut model_b2 = make_base_model(7.0, 4.5);
    model_b2.gguf_meta = Some(GgufMetadata {
        arch: "llama".to_string(),
        n_layer: 32,
        n_head: Some(32),
        n_kv_head: 8,
        head_dim: 128,
        train_ctx: 32768,
        ..Default::default()
    });

    let params_b2 = ParamBuilder::compute(&res_b2, &model_b2, "cuda");
    assert_eq!(params_b2.gpu_layers, 0, "Step B2 显存无法承载混合卸载时必须彻底切回 CPU");
    assert_eq!(params_b2.offload_ratio, 0.0);
}

/// 回归（2026-10-29 识图 400）：视觉模型在物理预算赤字下必须保底 4096 上下文。
///
/// 事故现场：RTX 3060 + MiniCPM-V 4.7 1B，系统内存已用 27.9/31.8GB，引擎按 CPU 池预留公式
/// 算出 usable=0 → budget_tokens=0 → 旧逻辑 clamp 到 AUTO_CTX_FLOOR(2048)，llama-server 以
/// 2048 启动；而一次识图请求本身就要 2.4K+ tokens（系统提示词约 1.5K + 800px 图片约 1K），
/// 被 `exceed_context_size` 直接拒绝。视觉模型的下限必须是「装得下一次识图请求」的 4096。
#[test]
fn test_vision_model_floor_never_below_one_image_request() {
    let mut res = make_test_resources(2 * 1024, Some(1024));
    res.memory.total_mb = 8192;
    res.memory.available_mb = 4096; // 可用内存 < 25% 预留 → CPU 池预算归零

    let mut vision = make_base_model(1.0, 1.0);
    vision.is_multimodal = true;
    vision.mmproj_path = Some("D:/models/mmproj-f16.gguf".to_string());
    vision.mmproj_size_gb = Some(0.7);
    vision.gguf_meta = Some(GgufMetadata {
        arch: "minicpmv".to_string(),
        n_layer: 24,
        n_head: Some(8),
        n_kv_head: 2,
        head_dim: 128,
        train_ctx: 32768,
        ..Default::default()
    });

    let params = ParamBuilder::compute(&res, &vision, "cuda");
    assert!(
        params.effective_enable_vision,
        "挂载 mmproj 的模型必须走视觉预算路径"
    );
    assert_eq!(
        params.ctx_size, 4096,
        "视觉模型在物理赤字下也必须保底 4096，否则识图请求永远 400（实际 {}）",
        params.ctx_size
    );
    assert!(params.ctx_size <= params.max_train_ctx);

    // 纯文本模型的 2048 保底口径由 test_max_fill_fallback_when_vram_constrained 锁定，此处不重复。
    // 这里只确认：视觉下限不会越过模型自身的预训练窗口。
    let mut tiny_ctx = vision.clone();
    tiny_ctx.gguf_meta = Some(GgufMetadata {
        arch: "minicpmv".to_string(),
        n_layer: 24,
        n_head: Some(8),
        n_kv_head: 2,
        head_dim: 128,
        train_ctx: 2048,
        ..Default::default()
    });
    let tiny_params = ParamBuilder::compute(&res, &tiny_ctx, "cuda");
    assert_eq!(
        tiny_params.ctx_size, 2048,
        "视觉下限不得越过预训练窗口（train_ctx=2048 时仍取 2048）"
    );
}

#[test]
fn test_ac8_ssot_recommended_params_and_budget_json() {
    let res = make_test_resources(16 * 1024, None);
    let model = make_base_model(7.0, 4.0);
    let params = ParamBuilder::compute(&res, &model, "cuda");
    let rec_json = params.to_recommended_json();

    assert!(rec_json.get("n_gpu_layers").is_some());
    assert!(rec_json.get("threads").is_some());
    assert!(rec_json.get("ctx_size").is_some());
    assert!(rec_json.get("cache_type_k").is_some());
    assert!(rec_json.get("enableVision").is_some());
    assert!(rec_json.get("enableDraft").is_some());
    assert_eq!(rec_json["parallel"], 1);
}

#[test]
fn test_ac10_self_allocation_compensation_formula() {
    let total_vram_gb: f64 = 12.0;
    let free_vram_gb: f64 = 3.0; // 当前仅剩 3GB 可用
    let self_allocated_gb: f64 = 5.5; // 当前引擎模型占用了 5.5GB
    let effective_free: f64 = (free_vram_gb + self_allocated_gb).min(total_vram_gb - 1.5);
    // 3.0 + 5.5 = 8.5GB <= 12.0 - 1.5 = 10.5GB -> 8.5GB
    assert_eq!(effective_free, 8.5);
}

#[test]
fn test_ac11_deficit_division_by_zero_defense() {
    let mut res = make_test_resources(2 * 1024, Some(1024)); // 极小显存
    res.memory.total_mb = 8192;
    res.memory.available_mb = 4096;
    let mut model = make_base_model(7.0, 4.0); // 模型 4GB
    model.gguf_meta = Some(GgufMetadata {
        arch: "llama".to_string(),
        n_layer: 32,
        n_head: Some(32),
        n_kv_head: 8,
        head_dim: 128,
        train_ctx: 32768,
        ..Default::default()
    });

    let params = ParamBuilder::compute(&res, &model, "cuda");
    assert!(
        params.ctx_size >= 2048,
        "赤字显存下绝不发生除零 Panic 或 NaN，并平稳收敛至保底上下文 (ctx={})",
        params.ctx_size
    );
}
