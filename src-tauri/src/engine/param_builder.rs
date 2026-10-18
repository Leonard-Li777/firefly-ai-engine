// engine/param_builder.rs
// Max-Fill 动态引擎启动参数计算器
// 1:1 移植桌面端 LlamacppAdapter::buildCommandContext 核心算法
// 关键安全约束：ubatchSize <= batchSize（防止 llama.cpp 0xC0000005 崩溃）

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::hardware::gpu_info::SystemResources;

/// 引擎启动参数（计算结果）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineParams {
    /// GPU 层数（-1 = 全量卸载，0 = 纯 CPU）
    pub gpu_layers: i32,
    /// 批处理大小
    pub batch_size: u32,
    /// 微批大小（严格 <= batch_size）
    pub ubatch_size: u32,
    /// 上下文大小
    pub ctx_size: u32,
    /// CPU 线程数（保留 2 核给系统）
    pub threads: u32,
    /// 是否启用 Flash Attention
    pub flash_attention: bool,
    /// 是否为 CPU 模式
    pub is_cpu_mode: bool,
    /// 说明（调试用）
    pub description: String,
}

/// 模型信息（用于参数计算）
#[derive(Debug, Clone)]
pub struct ModelInfo {
    /// 模型参数量（B = 十亿）
    pub param_b: f64,
    /// 模型实际文件大小（GB）
    pub size_gb: f64,
    /// 量化精度（如 Q4_K_M、Q8_0、F16）
    pub quantization: String,
    /// 是否多模态（含 mmproj）
    pub is_multimodal: bool,
    /// 是否加载多模态识图模型（双重互锁：物理文件存在 + 开关开启，默认 true）
    pub enable_vision: bool,
    /// 是否加载投机采样加速模型（双重互锁：物理文件存在 + 开关开启，默认 true）
    pub enable_draft: bool,
    /// 投机采样最大预测 token 步数（MTP/常规草稿默认 5；DSpark 草稿强制下限 15，
    /// 因其块扩散架构单次前向固定产出 15 个候选，低于该值会截断同一次计算的产出）
    pub draft_max_tokens: Option<u32>,
    /// 用户指定上下文长度（None = 自动）
    pub context_window: Option<u32>,
    /// 用户强制 GPU 层数（None = 自动）
    pub force_gpu_layers: Option<i32>,
    /// 用户强制批大小（None = 自动）
    pub force_batch_size: Option<u32>,
    /// 用户强制微批大小（None = 自动）
    pub force_ubatch_size: Option<u32>,
    /// 是否强制 CPU 模式
    pub force_cpu: bool,
    /// 是否启用思考模式（默认 false，关闭时注入推理抑制参数）
    pub enable_thinking: bool,
    /// 是否为 MiniCPM5 架构
    pub is_minicpm5: bool,
    /// 是否为 Nanbeige4 架构
    pub is_nanbeige4: bool,
    /// 多模态投影器路径（--mmproj）
    pub mmproj_path: Option<String>,
    /// DSpark 草稿模型路径（--model-draft + --spec-type draft-dspark）
    pub dspark_path: Option<String>,
    /// MTP 或普通草稿模型路径（--model-draft + --spec-type draft-mtp）
    pub draft_path: Option<String>,
    /// KV 缓存 Key 量化类型 ("f16", "q8_0", "q4_0")
    pub cache_type_k: Option<String>,
    /// KV 缓存 Value 量化类型 ("f16", "q8_0", "q4_0")
    pub cache_type_v: Option<String>,
    /// 并发请求槽位 (parallel)
    pub parallel: Option<u32>,
    /// 用户自定义温度 (temp)
    pub temp: Option<f64>,
    /// 用户自定义 Top-P
    pub top_p: Option<f64>,
    /// 用户自定义 Top-K
    pub top_k: Option<u32>,
    /// 用户自定义重复惩罚
    pub repeat_penalty: Option<f64>,
    /// 是否为嵌入模式（--embedding，用于 WeMM-Embedding 等向量模型）
    pub is_embedding: bool,
    /// 是否为生产环境（注入 --verbose）
    pub is_production: bool,
    /// GGUF 二进制解析元数据（优先权威依据）
    pub gguf_meta: Option<crate::engine::gguf_parser::GgufMetadata>,
    /// llama-server 二进制支持特性能力标志
    pub server_flags: Option<crate::engine::flag_detector::ServerFeatureFlags>,
    /// 思考模式宽容 Jinja 模板路径（若需要注入 --chat-template-file）
    pub tolerant_template_path: Option<String>,
}

impl ModelInfo {
    /// 获取模型真实隐藏层数（优先 GGUF 元数据，未获取时回退至估算）
    pub fn effective_layers(&self) -> u32 {
        if let Some(ref meta) = self.gguf_meta {
            if meta.n_layer > 0 {
                return meta.n_layer;
            }
        }
        self.estimated_layers()
    }

    /// 获取模型预训练上下文大小（优先 GGUF 元数据，默认 4096）
    pub fn train_context_size(&self) -> u32 {
        if let Some(ref meta) = self.gguf_meta {
            if meta.train_ctx > 0 {
                return meta.train_ctx;
            }
        }
        4096
    }

    /// 估算模型层数（无元数据时的安全保底）
    pub fn estimated_layers(&self) -> u32 {
        if self.param_b <= 2.0 {
            24
        } else if self.param_b <= 4.0 {
            28
        } else if self.param_b <= 9.0 {
            32
        } else if self.param_b <= 16.0 {
            48
        } else {
            64
        }
    }

    /// 估算模型文件大小（若未提供）
    pub fn effective_size_gb(&self) -> f64 {
        if self.size_gb > 0.0 {
            return self.size_gb;
        }
        // 按量化精度估算 bytes/param
        let quant = self.quantization.to_uppercase();
        let bytes_per_param = if quant.contains("Q8") || quant.contains("FP8") {
            1.05
        } else if quant.contains("Q2") || quant.contains("IQ2") {
            0.38
        } else if quant.contains("Q3") || quant.contains("IQ3") {
            0.48
        } else if quant.contains("Q5") || quant.contains("Q6") {
            0.75
        } else if quant.contains("FP16") || quant.contains("F16") {
            2.0
        } else {
            0.6 // 默认 Q4_K_M
        };
        self.param_b * bytes_per_param
    }
}

/// 参数计算器（无状态，纯函数式）
pub struct ParamBuilder;

impl ParamBuilder {
    /// 主入口：根据硬件和模型信息计算最优引擎启动参数
    /// 移植自 buildCommandContext 核心分支逻辑
    pub fn compute(resources: &SystemResources, model: &ModelInfo, backend: &str) -> EngineParams {
        if model.force_cpu {
            return Self::cpu_params(resources, model, backend);
        }

        let primary_gpu = resources.primary_gpu();

        match primary_gpu {
            None => Self::cpu_params(resources, model, backend),
            Some(gpu) if resources.is_apple_silicon() => {
                Self::apple_silicon_params(resources, model, gpu.memory_mb, backend)
            }
            Some(gpu) if gpu.is_integrated => {
                Self::igpu_params(resources, model, gpu.memory_mb, backend)
            }
            Some(gpu) => {
                Self::dgpu_params(resources, model, gpu.memory_mb, backend)
            }
        }
    }

    /// 计算单 Token KV 缓存所需的 GPU 显存字节数
    pub fn compute_kv_cache_bytes_per_token(
        meta: &crate::engine::gguf_parser::GgufMetadata,
        cache_k: &str,
        cache_v: &str,
        n_gpu_layers: u32,
    ) -> u64 {
        let n_kv_head = if meta.n_kv_head > 0 { meta.n_kv_head } else { 8 };
        let head_dim = if meta.head_dim > 0 { meta.head_dim } else { 128 };
        let total_layers = if meta.n_layer > 0 { meta.n_layer } else { 28 };
        let ngl = n_gpu_layers.min(total_layers);

        let type_bytes = |t: &str| -> f64 {
            match t.to_lowercase().as_str() {
                "q4_0" | "q4_1" => 0.5,
                "q8_0" => 1.0,
                _ => 2.0, // 默认 f16 为 2 字节
            }
        };

        let bytes_k = type_bytes(cache_k);
        let bytes_v = type_bytes(cache_v);

        let bytes_per_layer = (n_kv_head as f64) * (head_dim as f64) * (bytes_k + bytes_v);
        (bytes_per_layer * (ngl as f64)).ceil() as u64
    }

    /// 正则净化 Jinja 模板，剔除导致 400 Alternation 报错的严格交替校验
    pub fn sanitize_tolerant_jinja(raw_template: &str) -> String {
        let re_block = regex::Regex::new(r"\{%[-]?\s*if\s+[^%]*alternate[^%]*%\}[\s\S]*?\{%[-]?\s*endif\s*[-]?%\}").unwrap();
        let cleaned = re_block.replace_all(raw_template, "");
        let re_raise = regex::Regex::new(r"\{\{[^}]*raise_exception\([^}]*alternate[^}]*\)[^}]*\}\}").unwrap();
        re_raise.replace_all(&cleaned, "").to_string()
    }

    /// 【CPU 模式】
    fn cpu_params(resources: &SystemResources, model: &ModelInfo, _backend: &str) -> EngineParams {
        let train_ctx = model.train_context_size().min(131072);
        let batch_size = model.force_batch_size.unwrap_or(128).min(128);
        // 严格约束：ubatch <= batch
        let ubatch_size = model.force_ubatch_size.unwrap_or(128).min(batch_size);
        let ctx_size = model.context_window.unwrap_or(4096).min(train_ctx);
        let threads = Self::compute_threads(&resources.cpu);

        info!(
            "CPU 模式参数: ngl=0, batch={}, ubatch={}, ctx={}, threads={}",
            batch_size, ubatch_size, ctx_size, threads
        );

        EngineParams {
            gpu_layers: 0,
            batch_size,
            ubatch_size,
            ctx_size,
            threads,
            flash_attention: false,
            is_cpu_mode: true,
            description: "CPU 纯软件推理模式".to_string(),
        }
    }

    /// 【Apple Silicon Metal UMA】
    /// 统一内存架构：预留 3GB 给系统，其余最大化 GPU 卸载
    fn apple_silicon_params(
        resources: &SystemResources,
        model: &ModelInfo,
        _vram_mb: u64,
        _backend: &str,
    ) -> EngineParams {
        let total_mem_gb = resources.memory.total_gb();
        let model_size_gb = model.effective_size_gb();
        let total_layers = model.effective_layers();
        let train_ctx = model.train_context_size().min(131072);

        // 预留 3GB 给系统和前台应用
        let usable_mem = (total_mem_gb - 3.0).max(2.0);

        let gpu_layers = if model_size_gb <= usable_mem {
            -1 // 全量 GPU 加速
        } else {
            let offload_ratio = usable_mem / model_size_gb;
            (total_layers as f64 * offload_ratio).floor().max(8.0) as i32
        };

        let final_gpu_layers = model.force_gpu_layers.unwrap_or(gpu_layers);
        let batch_size = model.force_batch_size.unwrap_or(1024);
        let raw_ubatch = model.force_ubatch_size.unwrap_or(512);
        // 核心约束：ubatch <= batch
        let ubatch_size = raw_ubatch.min(batch_size);

        let ctx_size = if let Some(user_ctx) = model.context_window {
            user_ctx.clamp(512, train_ctx)
        } else {
            train_ctx.min(32768).max(4096)
        };

        let threads = Self::compute_threads(&resources.cpu);
        // Apple Silicon Metal 全系支持 Flash Attention
        let flash_attention = true;

        info!(
            "Apple Silicon Metal (UMA: {:.1}GB, 模型: {:.2}GB, 层数: {}) → ngl={}, batch={}, ubatch={}, ctx={}, fa={}",
            total_mem_gb, model_size_gb, total_layers, final_gpu_layers, batch_size, ubatch_size, ctx_size, flash_attention
        );

        EngineParams {
            gpu_layers: final_gpu_layers,
            batch_size,
            ubatch_size,
            ctx_size,
            threads,
            flash_attention,
            is_cpu_mode: false,
            description: format!(
                "Apple Silicon Metal UMA ({:.1}GB 内存, 模型 {:.2}GB, {}层)",
                total_mem_gb, model_size_gb, total_layers
            ),
        }
    }

    /// 【集成显卡 / 核显 iGPU】
    /// 核显受带宽约束，安全可用显存折算
    fn igpu_params(
        resources: &SystemResources,
        model: &ModelInfo,
        vram_mb: u64,
        _backend: &str,
    ) -> EngineParams {
        let vram_gb = vram_mb as f64 / 1024.0;
        let model_size_gb = model.effective_size_gb();
        let total_layers = model.effective_layers();
        let train_ctx = model.train_context_size().min(131072);

        // 核显安全可用显存：min(3.5, max(1.8, vram * 0.7))
        let usable_vram = vram_gb.mul_add(0.7, 0.0).max(1.8).min(3.5);
        let offload_ratio = if model_size_gb > 0.0 {
            usable_vram / model_size_gb
        } else {
            1.0
        };

        let gpu_layers = if offload_ratio >= 0.85 || model_size_gb <= 2.0 {
            -1 // 轻量模型全量 GPU
        } else {
            let target = (total_layers as f64 * offload_ratio).floor() as i32;
            target.max(8).min(16) // 8~16 层
        };

        let final_gpu_layers = model.force_gpu_layers.unwrap_or(gpu_layers);
        let batch_size = model.force_batch_size.unwrap_or(512);
        let raw_ubatch = model.force_ubatch_size.unwrap_or(256);
        // 核心约束：ubatch <= batch
        let ubatch_size = raw_ubatch.min(batch_size);
        let ctx_size = model.context_window.unwrap_or(4096).min(train_ctx);
        let threads = Self::compute_threads(&resources.cpu);

        // 核显不支持 Flash Attention（Vulkan 后端不支持）
        let flash_attention = false;

        info!(
            "集成显卡/核显 (VRAM: {:.1}GB, 可用: {:.1}GB, 模型: {:.2}GB, 层数: {}, 容纳比: {:.0}%) → ngl={}, batch={}, ubatch={}, ctx={}",
            vram_gb, usable_vram, model_size_gb, total_layers, offload_ratio * 100.0,
            final_gpu_layers, batch_size, ubatch_size, ctx_size
        );

        EngineParams {
            gpu_layers: final_gpu_layers,
            batch_size,
            ubatch_size,
            ctx_size,
            threads,
            flash_attention,
            is_cpu_mode: false,
            description: format!(
                "集成显卡 iGPU (可用 {:.1}GB, 模型 {:.2}GB, {}层)",
                usable_vram, model_size_gb, total_layers
            ),
        }
    }

    /// 【独立显卡 dGPU】
    /// 精准压榨 VRAM，预留 0.8GB 缓冲，结合 GGUF 与实时显存推导 Max-Fill
    fn dgpu_params(
        resources: &SystemResources,
        model: &ModelInfo,
        vram_mb: u64,
        backend: &str,
    ) -> EngineParams {
        let vram_gb = vram_mb as f64 / 1024.0;
        let model_size_gb = model.effective_size_gb();
        let total_layers = model.effective_layers();
        let train_ctx = model.train_context_size().min(131072);

        // 可用显存：若实时探测到了 memory_free_mb，优先使用真实剩余空闲（更准确）；否则回退至总显存
        let primary_gpu = resources.primary_gpu();
        let free_vram_gb = primary_gpu.and_then(|g| g.memory_free_gb());
        let usable_vram = if let Some(free_gb) = free_vram_gb {
            (free_gb - 0.8).max(0.0)
        } else {
            (vram_gb - 0.8).max(0.0)
        };

        let offload_ratio = if model_size_gb > 0.0 {
            usable_vram / model_size_gb
        } else {
            1.0
        };

        let gpu_layers = if offload_ratio >= 0.88 {
            -1 // 88% 以上全量卸载
        } else {
            let target = (total_layers as f64 * offload_ratio).floor() as i32;
            if target >= 6 { target } else { 0 }
        };

        let final_gpu_layers = model.force_gpu_layers.unwrap_or(gpu_layers);

        // 计算上下文窗口 Max-Fill
        let ctx_size = if let Some(user_ctx) = model.context_window {
            user_ctx.clamp(512, train_ctx)
        } else if let Some(ref meta) = model.gguf_meta {
            let cache_k = model.cache_type_k.as_deref().unwrap_or("f16");
            let cache_v = model.cache_type_v.as_deref().unwrap_or("f16");
            let ngl_for_calc = if final_gpu_layers == -1 {
                total_layers
            } else {
                final_gpu_layers.max(0) as u32
            };

            if ngl_for_calc == 0 {
                4096.min(train_ctx)
            } else {
                let bytes_per_token = Self::compute_kv_cache_bytes_per_token(meta, cache_k, cache_v, ngl_for_calc);
                let weights_on_gpu_gb = if final_gpu_layers == -1 {
                    model_size_gb
                } else {
                    model_size_gb * (ngl_for_calc as f64 / total_layers.max(1) as f64)
                };

                let remaining_vram_bytes = ((usable_vram - weights_on_gpu_gb).max(0.0) * 1024.0 * 1024.0 * 1024.0) as u64;

                if bytes_per_token > 0 && remaining_vram_bytes > (128 * 1024 * 1024) {
                    let max_tokens = (remaining_vram_bytes / bytes_per_token) as u32;
                    let aligned_tokens = (max_tokens / 256) * 256;
                    aligned_tokens.clamp(2048, train_ctx)
                } else {
                    2048.min(train_ctx)
                }
            }
        } else {
            if vram_gb < 4.0 {
                2048
            } else if vram_gb < 8.0 {
                4096
            } else {
                8192
            }
        };

        // 根据 VRAM 大小确定批大小
        let (batch_size, raw_ubatch) = if vram_gb < 4.0 {
            (512u32, 256u32)
        } else if vram_gb < 8.0 {
            (1024u32, 512u32)
        } else {
            (2048u32, 512u32)
        };

        let final_batch = model.force_batch_size.unwrap_or(batch_size);
        let final_raw_ubatch = model.force_ubatch_size.unwrap_or(raw_ubatch);
        // 核心安全约束：ubatch_size 严禁 > batch_size（防 0xC0000005 崩溃）
        let final_ubatch = final_raw_ubatch.min(final_batch);

        let threads = Self::compute_threads(&resources.cpu);

        // Flash Attention 判断（使用主 GPU 名称）
        let gpu_name = primary_gpu.map(|g| g.name.as_str()).unwrap_or("");
        let flash_attention = crate::hardware::is_flash_attention_supported(backend, gpu_name);

        info!(
            "独立显卡 dGPU (VRAM: {:.1}GB, 可用: {:.1}GB, 模型: {:.2}GB, 层数: {}, 容纳比: {:.0}%) → ngl={}, batch={}, ubatch={}, ctx={}, fa={}",
            vram_gb, usable_vram, model_size_gb, total_layers, offload_ratio * 100.0,
            final_gpu_layers, final_batch, final_ubatch, ctx_size, flash_attention
        );

        EngineParams {
            gpu_layers: final_gpu_layers,
            batch_size: final_batch,
            ubatch_size: final_ubatch,
            ctx_size,
            threads,
            flash_attention,
            is_cpu_mode: final_gpu_layers == 0,
            description: format!(
                "独立显卡 dGPU ({:.1}GB VRAM, 模型 {:.2}GB, {}层, 容纳率 {:.0}%)",
                vram_gb, model_size_gb, total_layers, offload_ratio * 100.0
            ),
        }
    }

    /// 计算安全的 CPU 线程数
    /// 规则：保留 2 个核心给系统，线程数控制在 2~8 之间
    fn compute_threads(cpu: &crate::hardware::gpu_info::CpuInfo) -> u32 {
        let physical_cores = cpu.cores.max(1);
        physical_cores.saturating_sub(2).max(2).min(8)
    }

    /// 将参数转换为 llama-server 命令行参数列表（1:1 对等桌面端完整参数生成）
    pub fn to_args(
        params: &EngineParams,
        port: u16,
        model_path: &str,
        model_alias: &str,
        model_info: Option<&ModelInfo>,
    ) -> Vec<String> {
        let mut args = vec![
            "--host".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            port.to_string(),
            "--model".to_string(),
            model_path.to_string(),
        ];

        // 多模态投影器 --mmproj（双重互锁：模型明确为多模态 + 文件存在 + 用户未关闭识图）
        if let Some(info) = model_info {
            if info.is_multimodal && info.enable_vision {
                if let Some(ref mmproj) = info.mmproj_path {
                    args.extend(["--mmproj".to_string(), mmproj.clone()]);
                }
            }
        }

        let is_prod = model_info.map(|i| i.is_production).unwrap_or(false);
        let flags = model_info.and_then(|i| i.server_flags.as_ref());
        let supports_alias = flags.map(|f| f.supports_alias).unwrap_or(true);

        // ── 嵌入向量服务模式（WeMM-Embedding 等高维修正专用）──
        if model_info.map(|i| i.is_embedding).unwrap_or(false) {
            args.push("--embedding".to_string());
            args.extend([
                "--ctx-size".to_string(),
                params.ctx_size.to_string(),
            ]);
            if supports_alias {
                args.extend(["--alias".to_string(), model_alias.to_string()]);
            }
            Self::push_compute_args(&mut args, params, is_prod);
            return args;
        }

        // ── 语言模型（生成）模式 ──
        if let Some(info) = model_info {
            if info.enable_draft {
                // MTP / 常规草稿模型默认步数
                let draft_max = info.draft_max_tokens.unwrap_or(5);
                // DSpark 投机采样
                if let Some(ref dspark) = info.dspark_path {
                    // DSpark 草稿模型（openbmb/MiniCPM-V-4.7-1B-DSpark-gguf）采用块扩散 +
                    // 马尔可夫头架构，单次前向传播固定产出 15 个草稿 token；llama.cpp 的
                    // DSpark 实现一次前向即输出整块候选，n-max < 15 会人为截断同一次计算
                    // 的剩余候选。故下限强制对齐官方推荐值 15，用户配置更高（>15）时透传。
                    let dspark_max = info.draft_max_tokens.map_or(15, |v| v.max(15));
                    args.extend([
                        "--model-draft".to_string(),
                        dspark.clone(),
                        "--spec-type".to_string(),
                        "draft-dspark".to_string(),
                        "--spec-draft-n-max".to_string(),
                        dspark_max.to_string(),
                        "--spec-draft-n-min".to_string(),
                        "0".to_string(),
                    ]);
                    // 草稿模型 GPU 层数显式化：DSpark 草稿模型仅约 438MB / 5 层，若依赖
                    // llama.cpp 的 auto 估算，长上下文显存吃紧时可能保守回退 CPU 导致推理
                    // 变慢。只要主模型存在任何 GPU 卸载（-1 全量或部分层数），草稿模型即
                    // 全量常驻显存（--gpu-layers-draft -1，别名 -ngld -1）；仅 CPU 模式跳过。
                    if !params.is_cpu_mode && params.gpu_layers != 0 {
                        args.extend(["--gpu-layers-draft".to_string(), "-1".to_string()]);
                    }
                    // 显存提示：开启投机采样后主模型与 DSpark 草稿模型会按 --ctx-size 各自
                    // 分配 KV 缓存（f16 精度下开销近似翻倍）。日常无需满载长上下文时，建议
                    // 下调 ctx-size（参照官方示例 8192 / 32768）以降低占用并加速批处理验证。
                    if params.ctx_size >= 65536 {
                        warn!(
                            ctx_size = params.ctx_size,
                            "DSpark 投机采样下主模型与草稿模型各按 --ctx-size 分配 KV 缓存（f16 精度近似双倍开销），显存吃紧时建议下调至 8192/32768"
                        );
                    }
                } else if let Some(ref draft) = info.draft_path {
                    // MTP / 常规 Draft
                    args.extend([
                        "--model-draft".to_string(),
                        draft.clone(),
                        "--spec-type".to_string(),
                        "draft-mtp".to_string(),
                        "--spec-draft-n-max".to_string(),
                        draft_max.to_string(),
                    ]);
                }
            }
        }

        args.extend([
            "--ctx-size".to_string(),
            params.ctx_size.to_string(),
        ]);
        if supports_alias {
            args.extend(["--alias".to_string(), model_alias.to_string()]);
        }
        args.extend([
            "--jinja".to_string(),
            "--no-context-shift".to_string(),
            "--load-mode".to_string(),
            "auto".to_string(),
        ]);

        // KV 缓存量化 (--cache-type-k, --cache-type-v)
        let cache_k = model_info.and_then(|i| i.cache_type_k.clone()).unwrap_or_else(|| "f16".to_string());
        let cache_v = model_info.and_then(|i| i.cache_type_v.clone()).unwrap_or_else(|| "f16".to_string());
        args.extend([
            "--cache-type-k".to_string(),
            cache_k,
            "--cache-type-v".to_string(),
            cache_v,
        ]);

        // 并发槽位 (--parallel)
        let parallel_slots = model_info.and_then(|i| i.parallel).unwrap_or(1);
        args.extend([
            "--parallel".to_string(),
            parallel_slots.to_string(),
        ]);

        // 重复惩罚 (--repeat-penalty)
        let rep_penalty = model_info.and_then(|i| i.repeat_penalty).unwrap_or(1.1);
        args.extend([
            "--repeat-penalty".to_string(),
            format!("{:.2}", rep_penalty),
        ]);

        // 思考模式与聊天模板状态机
        let enable_thinking = model_info.map(|i| i.enable_thinking).unwrap_or(false);
        let is_minicpm5 = model_info.map(|i| i.is_minicpm5).unwrap_or(false);
        let is_nanbeige4 = model_info.map(|i| i.is_nanbeige4).unwrap_or(false);

        // 采样超参：优先使用用户配置，未配置时依模型架构回退
        let user_temp = model_info.and_then(|i| i.temp);
        let user_top_p = model_info.and_then(|i| i.top_p);
        let user_top_k = model_info.and_then(|i| i.top_k);

        if !enable_thinking {
            // 【非思考模式】坚决使用 ChatML 组合拳抑制思考外溢
            let supports_reasoning = flags.map(|f| f.supports_reasoning).unwrap_or(true);
            let supports_format = flags.map(|f| f.supports_reasoning_format).unwrap_or(true);
            let supports_budget = flags.map(|f| f.supports_reasoning_budget).unwrap_or(true);

            if supports_reasoning {
                args.extend(["--reasoning".to_string(), "off".to_string()]);
            }
            if supports_format {
                args.extend(["--reasoning-format".to_string(), "none".to_string()]);
            }
            if supports_budget {
                args.extend(["--reasoning-budget".to_string(), "0".to_string()]);
            }

            let final_temp = user_temp.unwrap_or(0.7);
            let final_top_p = user_top_p.unwrap_or(0.95);
            args.extend([
                "--temp".to_string(),
                format!("{:.2}", final_temp),
                "--top-p".to_string(),
                format!("{:.2}", final_top_p),
            ]);

            if let Some(tk) = user_top_k {
                args.extend(["--top-k".to_string(), tk.to_string()]);
            }

            if is_minicpm5 {
                args.extend([
                    "--chat-template".to_string(),
                    "chatml".to_string(),
                ]);
            } else if is_nanbeige4 {
                args.extend([
                    "--chat-template".to_string(),
                    "{% for message in messages %}{{'<|im_start|>' + message['role'] + '\\n' + message['content'] + '<|im_end|>\\n'}}{% endfor %}".to_string(),
                ]);
            } else {
                args.extend([
                    "--chat-template".to_string(),
                    "{% for message in messages %}{{'<|im_start|>' + message['role'] + '\\n' + message['content'] + '<|im_end|>\\n'}}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant\\n' }}{% endif %}".to_string(),
                ]);
            }
        } else {
            // 【思考模式】按需注入宽容 Jinja 模板与思考预算
            let supports_budget = flags.map(|f| f.supports_reasoning_budget).unwrap_or(true);
            let supports_template_file = flags.map(|f| f.supports_chat_template_file).unwrap_or(true);

            if supports_budget {
                args.extend([
                    "--reasoning-budget".to_string(),
                    "1024".to_string(),
                ]);
            }

            let final_temp = user_temp.unwrap_or(0.9);
            let final_top_p = user_top_p.unwrap_or(0.95);
            args.extend([
                "--temp".to_string(),
                format!("{:.2}", final_temp),
                "--top-p".to_string(),
                format!("{:.2}", final_top_p),
            ]);

            if let Some(tk) = user_top_k {
                args.extend(["--top-k".to_string(), tk.to_string()]);
            }

            // 若存在宽容模板且 flags 支持，注入 --chat-template-file
            if let Some(ref tolerant_path) = model_info.and_then(|i| i.tolerant_template_path.as_ref()) {
                if supports_template_file {
                    args.extend([
                        "--chat-template-file".to_string(),
                        tolerant_path.to_string(),
                    ]);
                }
            }
        }

        Self::push_compute_args(&mut args, params, is_prod);

        args
    }

    /// 追加「算力卸载 / 批处理」通用参数（语言模型与嵌入模型共用）
    fn push_compute_args(args: &mut Vec<String>, params: &EngineParams, is_prod: bool) {
        // Flash Attention
        if params.flash_attention {
            args.extend(["-fa".to_string(), "auto".to_string()]);
        } else {
            args.extend(["-fa".to_string(), "off".to_string()]);
        }

        // 生产环境详细日志
        if is_prod {
            args.extend(["--verbose".to_string()]);
        }

        // GPU 层数
        if params.is_cpu_mode || params.gpu_layers == 0 {
            args.extend(["--device".to_string(), "none".to_string()]);
            args.extend(["--n-gpu-layers".to_string(), "0".to_string()]);
        } else {
            args.extend([
                "--n-gpu-layers".to_string(),
                params.gpu_layers.to_string(),
            ]);
        }

        // 批大小
        args.extend([
            "--batch-size".to_string(),
            params.batch_size.to_string(),
            "--ubatch-size".to_string(),
            params.ubatch_size.to_string(),
        ]);

        // CPU 线程数
        args.extend(["-t".to_string(), params.threads.to_string()]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hardware::gpu_info::*;

    fn make_resources_with_dgpu(vram_mb: u64) -> SystemResources {
        SystemResources {
            cpu: CpuInfo {
                model: "Test CPU".to_string(),
                cores: 8,
                threads: 16,
                speed_mhz: 3500,
                ..Default::default()
            },
            memory: MemoryInfo {
                total_mb: 32768,
                available_mb: 16384,
            },
            gpus: vec![GpuInfo {
                name: "NVIDIA GeForce RTX 3060".to_string(),
                memory_mb: vram_mb,
                memory_free_mb: None,
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

    fn make_model(param_b: f64, size_gb: f64) -> ModelInfo {
        ModelInfo {
            param_b,
            size_gb,
            quantization: "Q4_K_M".to_string(),
            is_multimodal: false,
            enable_vision: true,
            enable_draft: true,
            draft_max_tokens: Some(5),
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
    fn test_ubatch_never_exceeds_batch() {
        // 核心约束测试：ubatch 在任何情况下不得超过 batch
        let resources = make_resources_with_dgpu(12 * 1024); // 12GB VRAM
        let model = ModelInfo {
            force_ubatch_size: Some(9999), // 故意设置超大值
            ..make_model(7.0, 4.3)
        };
        let params = ParamBuilder::compute(&resources, &model, "cuda");
        assert!(
            params.ubatch_size <= params.batch_size,
            "ubatch_size ({}) 不得超过 batch_size ({})",
            params.ubatch_size,
            params.batch_size
        );
    }

    #[test]
    fn test_dgpu_88pct_threshold_full_offload() {
        // 独显：可用显存 >= 88% 模型体积时应全量卸载 (-ngl -1)
        let resources = make_resources_with_dgpu(12 * 1024); // 12GB
        let model = make_model(7.0, 4.3); // 4.3GB Q4_K_M 7B
        // usable = 12 - 0.8 = 11.2GB; offload = 11.2/4.3 ≈ 260% >> 88%
        let params = ParamBuilder::compute(&resources, &model, "cuda");
        assert_eq!(params.gpu_layers, -1, "大显存应全量卸载");
    }

    #[test]
    fn test_dgpu_small_vram_proportional_offload() {
        // 独显：4GB 显卡装 4.3GB 模型，应按比例卸载而非全量
        let resources = make_resources_with_dgpu(4 * 1024);
        let model = make_model(7.0, 4.3); // 4.3GB 模型
        // usable = 4.0 - 0.8 = 3.2GB; ratio = 3.2/4.3 ≈ 74% < 88%
        let params = ParamBuilder::compute(&resources, &model, "cuda");
        assert!(
            params.gpu_layers > 0 && params.gpu_layers < 32,
            "应按比例卸载 ({}层)",
            params.gpu_layers
        );
        assert!(!params.is_cpu_mode);
    }

    #[test]
    fn test_cpu_mode_batch_capped_at_128() {
        let resources = SystemResources {
            cpu: CpuInfo {
                model: "CPU".to_string(),
                cores: 4,
                threads: 8,
                speed_mhz: 2000,
                ..Default::default()
            },
            memory: MemoryInfo {
                total_mb: 8192,
                available_mb: 4096,
            },
            gpus: vec![],
            best_acceleration_tier: AccelerationTier::Cpu,
        };
        let model = ModelInfo {
            force_cpu: true,
            force_batch_size: Some(512), // 超过限制
            ..make_model(1.5, 1.0)
        };
        let params = ParamBuilder::compute(&resources, &model, "cpu");
        assert!(params.batch_size <= 128, "CPU 模式 batch 不得超过 128");
        assert!(params.ubatch_size <= params.batch_size, "ubatch <= batch");
    }

    #[test]
    fn test_apple_silicon_full_offload() {
        let resources = SystemResources {
            cpu: CpuInfo {
                model: "Apple M2 Pro".to_string(),
                cores: 12,
                threads: 12,
                speed_mhz: 3500,
                ..Default::default()
            },
            memory: MemoryInfo {
                total_mb: 32 * 1024, // 32GB
                available_mb: 20 * 1024,
            },
            gpus: vec![GpuInfo {
                name: "Apple M2 Pro".to_string(),
                memory_mb: 16 * 1024, // UMA
                memory_free_mb: None,
                vendor: GpuVendor::Apple,
                is_integrated: true,
                supports_cuda: false,
                supports_vulkan: false,
                supports_hip: false,
                supports_metal: true,
                supports_sycl: false,
            }],
            best_acceleration_tier: AccelerationTier::Metal,
        };
        let model = make_model(7.0, 4.3);
        // usable = 32 - 3 = 29GB >> 4.3GB 模型 → 全量 GPU
        let params = ParamBuilder::compute(&resources, &model, "metal");
        assert_eq!(params.gpu_layers, -1, "Apple Silicon 应全量 GPU 卸载");
        assert!(params.flash_attention, "Apple Silicon 支持 Flash Attention");
    }

    #[test]
    fn test_igpu_capped_layers() {
        let resources = SystemResources {
            cpu: CpuInfo {
                model: "Intel Core i5-1235U".to_string(),
                cores: 10,
                threads: 12,
                speed_mhz: 3300,
                ..Default::default()
            },
            memory: MemoryInfo {
                total_mb: 16384,
                available_mb: 8192,
            },
            gpus: vec![GpuInfo {
                name: "Intel Iris Xe Graphics".to_string(),
                memory_mb: 2048, // 共享 2GB
                memory_free_mb: None,
                vendor: GpuVendor::Intel,
                is_integrated: true,
                supports_cuda: false,
                supports_vulkan: true,
                supports_hip: false,
                supports_metal: false,
                supports_sycl: false,
            }],
            best_acceleration_tier: AccelerationTier::Vulkan,
        };
        let model = make_model(7.0, 4.3);
        let params = ParamBuilder::compute(&resources, &model, "vulkan");
        // usable = min(3.5, max(1.8, 2.0 * 0.7)) = min(3.5, max(1.8, 1.4)) = min(3.5, 1.8) = 1.8GB
        // offload = 1.8 / 4.3 ≈ 41.8% < 85% → 动态卸载
        assert!(params.gpu_layers >= 8 && params.gpu_layers <= 16, "核显层数应在 8~16 层");
        assert!(!params.flash_attention, "Vulkan 不支持 Flash Attention");
    }

    #[test]
    fn test_to_args_with_thinking_suppression_and_dspark() {
        let resources = make_resources_with_dgpu(12 * 1024);
        let mut model = make_model(7.0, 4.3);
        model.enable_thinking = false;
        model.dspark_path = Some("D:\\models\\dspark.gguf".to_string());
        model.is_production = true;

        let params = ParamBuilder::compute(&resources, &model, "cuda");
        let args = ParamBuilder::to_args(&params, 38400, "D:\\models\\main.gguf", "test-model", Some(&model));

        // 验证推理抑制
        assert!(args.contains(&"--reasoning".to_string()));
        let r_idx = args.iter().position(|r| r == "--reasoning").unwrap();
        assert_eq!(args[r_idx + 1], "off");

        assert!(args.contains(&"--reasoning-format".to_string()));
        let rf_idx = args.iter().position(|r| r == "--reasoning-format").unwrap();
        assert_eq!(args[rf_idx + 1], "none");

        assert!(args.contains(&"--reasoning-budget".to_string()));
        let rb_idx = args.iter().position(|r| r == "--reasoning-budget").unwrap();
        assert_eq!(args[rb_idx + 1], "0");

        // 验证 DSpark
        assert!(args.contains(&"--spec-type".to_string()));
        let st_idx = args.iter().position(|r| r == "--spec-type").unwrap();
        assert_eq!(args[st_idx + 1], "draft-dspark");

        assert!(args.contains(&"--model-draft".to_string()));
        let md_idx = args.iter().position(|r| r == "--model-draft").unwrap();
        assert_eq!(args[md_idx + 1], "D:\\models\\dspark.gguf");

        assert!(args.contains(&"--verbose".to_string()));
    }

    #[test]
    fn test_to_args_with_thinking_enabled() {
        let resources = make_resources_with_dgpu(12 * 1024);
        let mut model = make_model(7.0, 4.3);
        model.enable_thinking = true;

        let params = ParamBuilder::compute(&resources, &model, "cuda");
        let args = ParamBuilder::to_args(&params, 38400, "D:\\models\\main.gguf", "test-model", Some(&model));

        // 思考模式开启：不得注入推理抑制参数
        assert!(!args.contains(&"--reasoning".to_string()), "思考模式开启时不应注入 --reasoning off");
        assert!(!args.contains(&"--reasoning-format".to_string()), "思考模式开启时不应注入 --reasoning-format none");

        // 应注入思考预算（开启分支专属）
        assert!(args.contains(&"--reasoning-budget".to_string()));
        let rb_idx = args.iter().position(|r| r == "--reasoning-budget").unwrap();
        assert_eq!(args[rb_idx + 1], "1024");
    }

    #[test]
    fn test_to_args_with_embedding() {
        let resources = make_resources_with_dgpu(12 * 1024);
        let mut model = make_model(2.0, 1.8);
        model.is_embedding = true;
        // 即便配置了语言模型专属项，嵌入模式也必须全部剔除
        model.enable_thinking = false;
        model.temp = Some(0.7);
        model.top_p = Some(0.95);
        model.top_k = Some(40);
        model.repeat_penalty = Some(1.1);
        model.parallel = Some(1);
        model.cache_type_k = Some("f16".to_string());
        model.cache_type_v = Some("f16".to_string());
        model.dspark_path = Some("D:\\models\\dspark.gguf".to_string());

        let params = ParamBuilder::compute(&resources, &model, "cuda");
        let args = ParamBuilder::to_args(&params, 38400, "D:\\models\\wemm.gguf", "wemm-2b", Some(&model));

        // 必需：嵌入模式开关
        assert!(args.contains(&"--embedding".to_string()), "应该注入 --embedding 参数");

        // 必需：服务寻址 / 上下文 / 算力卸载 / 批处理
        for flag in [
            "--host", "--port", "--model", "--ctx-size", "--alias", "-fa",
            "--n-gpu-layers", "--batch-size", "--ubatch-size", "-t",
        ] {
            assert!(args.contains(&flag.to_string()), "嵌入模式应保留必要参数 {}", flag);
        }

        // 严禁：语言模型（生成）专属参数
        for forbidden in [
            "--jinja",
            "--chat-template",
            "--no-context-shift",
            "--load-mode",
            "--cache-type-k",
            "--cache-type-v",
            "--parallel",
            "--repeat-penalty",
            "--reasoning",
            "--reasoning-format",
            "--reasoning-budget",
            "--temp",
            "--top-p",
            "--top-k",
            "--model-draft",
            "--spec-type",
        ] {
            assert!(
                !args.contains(&forbidden.to_string()),
                "嵌入模式不得注入语言模型专属参数 {}",
                forbidden
            );
        }
    }

    #[test]
    fn test_to_args_language_mode_keeps_generation_params() {
        // 反向守卫：语言模型模式必须仍然保留对话/采样/推理抑制参数
        let resources = make_resources_with_dgpu(12 * 1024);
        let model = make_model(7.0, 4.3);

        let params = ParamBuilder::compute(&resources, &model, "cuda");
        let args = ParamBuilder::to_args(&params, 38400, "D:\\models\\main.gguf", "test-model", Some(&model));

        assert!(!args.contains(&"--embedding".to_string()), "语言模型不得注入 --embedding");
        for flag in ["--jinja", "--chat-template", "--reasoning", "--temp", "--top-p"] {
            assert!(args.contains(&flag.to_string()), "语言模型模式应保留 {}", flag);
        }
    }

    #[test]
    fn test_to_args_non_multimodal_ignores_mmproj() {
        let resources = make_resources_with_dgpu(12 * 1024);
        let mut model = make_model(7.0, 4.3);
        // 关键条件：模型不是多模态，但设置了投影模型路径（例如磁盘上下载了投影模型）
        model.is_multimodal = false;
        model.mmproj_path = Some("D:\\models\\mmproj.gguf".to_string());

        let params = ParamBuilder::compute(&resources, &model, "cuda");
        let args = ParamBuilder::to_args(&params, 38400, "D:\\models\\text-only.gguf", "test-model", Some(&model));

        // 验证绝对不能注入 --mmproj 参数
        assert!(!args.contains(&"--mmproj".to_string()), "非多模态模型即使有投影文件也不应注入 --mmproj");

        // 当多模态模型且有投影路径时，才应该注入
        model.is_multimodal = true;
        let args_mm = ParamBuilder::to_args(&params, 38400, "D:\\models\\vl-model.gguf", "vl-model", Some(&model));
        assert!(args_mm.contains(&"--mmproj".to_string()), "多模态模型且存在投影文件时应注入 --mmproj");
    }

    #[test]
    fn test_to_args_respects_enable_vision_and_draft_interlocks() {
        let resources = make_resources_with_dgpu(12 * 1024);
        let mut model = make_model(7.0, 4.3);
        model.is_multimodal = true;
        model.mmproj_path = Some("D:\\models\\mmproj.gguf".to_string());
        model.dspark_path = Some("D:\\models\\dspark.gguf".to_string());
        model.enable_vision = false; // 用户在高级选项中关闭识图以节约显存
        model.enable_draft = false;  // 用户关闭加速

        let params = ParamBuilder::compute(&resources, &model, "cuda");
        let args_disabled = ParamBuilder::to_args(&params, 38400, "D:\\models\\main.gguf", "test-model", Some(&model));

        assert!(!args_disabled.contains(&"--mmproj".to_string()), "用户关闭识图后即使有投影文件也不应注入 --mmproj");
        assert!(!args_disabled.contains(&"--model-draft".to_string()), "用户关闭加速后即使有草稿文件也不应注入 --model-draft");

        // 重新开启并自定义步数（DSpark 草稿存在下限 15：低于 15 自动对齐官方块大小）
        model.enable_vision = true;
        model.enable_draft = true;
        model.draft_max_tokens = Some(7);
        let args_enabled = ParamBuilder::to_args(&params, 38400, "D:\\models\\main.gguf", "test-model", Some(&model));

        assert!(args_enabled.contains(&"--mmproj".to_string()), "用户开启识图后应注入 --mmproj");
        assert!(args_enabled.contains(&"--model-draft".to_string()), "用户开启加速后应注入 --model-draft");
        let nmax_idx = args_enabled.iter().position(|r| r == "--spec-draft-n-max").unwrap();
        assert_eq!(args_enabled[nmax_idx + 1], "15", "DSpark n-max 低于 15 应对齐官方块大小 15");
        let ngld_idx = args_enabled.iter().position(|r| r == "--gpu-layers-draft").unwrap();
        assert_eq!(args_enabled[ngld_idx + 1], "-1", "GPU 模式下草稿模型应显式全量常驻显存（-1）");

        // 用户配置高于 15 时透传
        model.draft_max_tokens = Some(20);
        let args_higher = ParamBuilder::to_args(&params, 38400, "D:\\models\\main.gguf", "test-model", Some(&model));
        let nmax_idx2 = args_higher.iter().position(|r| r == "--spec-draft-n-max").unwrap();
        assert_eq!(args_higher[nmax_idx2 + 1], "20", "DSpark n-max 高于 15 应透传用户配置");

        // 未配置时默认对齐官方推荐值 15
        model.draft_max_tokens = None;
        let args_default = ParamBuilder::to_args(&params, 38400, "D:\\models\\main.gguf", "test-model", Some(&model));
        let nmax_idx3 = args_default.iter().position(|r| r == "--spec-draft-n-max").unwrap();
        assert_eq!(args_default[nmax_idx3 + 1], "15", "DSpark 未配置 n-max 时应默认 15");
    }
}
