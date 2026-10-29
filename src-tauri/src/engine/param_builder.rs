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
    /// 显存/内存卸载比率
    #[serde(default)]
    pub offload_ratio: f64,
    /// 真实生效的 Key 缓存量化精度 ("f16" | "q8_0" | "q4_0")
    #[serde(default = "default_cache_type_str")]
    pub cache_type_k: String,
    /// 真实生效的 Value 缓存量化精度 ("f16" | "q8_0" | "q4_0")
    #[serde(default = "default_cache_type_str")]
    pub cache_type_v: String,
    /// 最终生效的草稿模型挂载决断
    #[serde(default = "default_true")]
    pub effective_enable_draft: bool,
    /// 最终生效的多模态投影挂载决断
    #[serde(default = "default_true")]
    pub effective_enable_vision: bool,
    /// 显存/内存预算可承载的上下文上限
    #[serde(default)]
    pub budget_ctx: u32,
    /// 模型的最大训练上下文
    #[serde(default)]
    pub max_train_ctx: u32,
    /// 当前硬件池可用安全容量（GB）
    #[serde(default, rename = "usable_memory_gb")]
    pub usable_memory_gb: f64,
    /// 当前硬件池固定常驻占用（GB）
    #[serde(default)]
    pub fixed_overhead_gb: f64,
    /// 说明（调试用）
    pub description: String,
}

impl EngineParams {
    /// 转换为前端所需的推荐参数 JSON 结构（对应 RuntimeParams）
    pub fn to_recommended_json(&self) -> serde_json::Value {
        serde_json::json!({
            "n_gpu_layers": self.gpu_layers,
            "threads": self.threads,
            "ctx_size": self.ctx_size,
            "batch_size": self.batch_size,
            "ubatch_size": self.ubatch_size,
            "cache_type_k": self.cache_type_k,
            "cache_type_v": self.cache_type_v,
            "parallel": 1,
            "enableVision": self.effective_enable_vision,
            "enableDraft": self.effective_enable_draft,
            "draftMaxTokens": 6
        })
    }
}

fn default_cache_type_str() -> String {
    "f16".to_string()
}

fn default_true() -> bool {
    true
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
    /// 多模态投影器文件体积（GB）。投影器与视觉塔同样常驻显存，必须计入预算，
    /// 否则「开了识图就 OOM」——历史上预算公式完全忽略此项。
    pub mmproj_size_gb: Option<f64>,
    /// DSpark 草稿模型路径（--model-draft + --spec-type draft-dspark）
    pub dspark_path: Option<String>,
    /// MTP 或普通草稿模型路径（--model-draft + --spec-type draft-mtp）
    pub draft_path: Option<String>,
    /// 草稿模型文件体积（GB）。草稿模型会被全量卸载到显存（--gpu-layers-draft -1），
    /// 其权重必须计入预算。
    pub draft_size_gb: Option<f64>,
    /// 草稿模型 GGUF 元数据。草稿模型按 --ctx-size **独立分配一份 KV 缓存**，
    /// 必须按它自己的层数/头数核算，不能沿用主模型口径（历史上正是漏算这 1.25 GiB 导致 OOM）。
    pub draft_gguf_meta: Option<crate::engine::gguf_parser::GgufMetadata>,
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
    /// 模型文件是否已在本地下载就绪
    pub is_downloaded: bool,
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

/// 显存安全预留（GB）
///
/// 历史值为 0.8 GiB，且按「整卡可用」估算，导致预算看起来装得下、实际一跑就 OOM
/// （前科：RTX 3060 12GB + MiniCPM-V 1B，128k f16 下加载后余量仅 2.4 GiB）。
/// Windows DWM、浏览器、其它 Electron 进程与驱动常驻 1~2 GiB，故提高到 1.5 GiB。
pub const VRAM_SAFETY_RESERVE_GB: f64 = 1.5;

/// 计算缓冲 + CUDA/ROCm context 的经验占用（GB）
///
/// llama.cpp 的 compute buffer（graph / KQ 矩阵 / 中间张量）不体现在权重与 KV 里，
/// 但会随 ctx 与 ubatch 增长。预算公式此前完全未计此项，是 OOM 的第二大成因。
pub const COMPUTE_BUFFER_GB: f64 = 1.0;

/// 自动推导上下文的产品上限
///
/// 历史 cap 直接取 `train_ctx.min(131072)`：只要可用显存 ≥7.3 GiB 就会一路顶到 131072，
/// 12GB 级显卡配小模型必然被塞满长上下文。产品侧文件分析场景 64k 已远超实际需要，
/// 故把自动推导上限收到 65536；用户显式指定时仍可突破（但须过预算闸）。
pub const AUTO_CTX_CEILING: u32 = 65536;

/// 自动推导上下文的下限（低于此值模型基本不可用）
pub const AUTO_CTX_FLOOR: u32 = 2048;

/// 视觉模型（挂载识图投影）的上下文下限
///
/// 纯文本模型 2048 仍能完成短提示词推理，但一次多模态请求的中转成本远高于纯文本：
/// 实测 MiniCPM-V 系列一张 800px 图片 ≈ 0.9K~1.2K 视觉 token，命名/打标类系统提示词
/// 本身已占约 1.5K tokens，加起来 2.4K+ 已经越过 2048（事故现场：
/// `request (2469 tokens) exceeds the available context size (2048 tokens)`，
/// 引擎按内存预算落到 2048 兜底，桌面端直接 400 失败）。
///
/// 因此视觉模型即便在内存/显存双赤字、只能走纯 CPU 池的极端场景，也保底按 4096 加载：
/// 1B 级模型 4096 上下文的 KV 缓存仅数十 MB，代价远低于「识图永远失败」。
pub const VISION_CTX_FLOOR: u32 = 4096;

/// 【四大内存池化抽象】
/// 承载介质池枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryPoolKind {
    Dgpu,
    AppleSilicon,
    Igpu,
    Cpu,
}

/// 预算计划输入载体
pub struct BudgetPlan {
    pub pool: MemoryPoolKind,
    pub usable_memory_gb: f64,
    pub initial_gpu_layers: i32,
    pub default_batch: (u32, u32),
    pub supports_fa: bool,
    pub base_compute_buf_gb: f64,
    pub description_prefix: String,
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
                // block_q8_0: 32 个 int8 权重 (32B) + 1 个 fp16 scale 因子 (2B) = 34B / 32 elems = 1.0625 Bytes/elem
                "q8_0" => 1.0625,
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

    /// 全介质统一内存物理预算求解器（第一性原理数学模型）
    fn solve_plan(
        resources: &SystemResources,
        model: &ModelInfo,
        plan: BudgetPlan,
        backend: &str,
    ) -> EngineParams {
        let is_cpu_pool = plan.pool == MemoryPoolKind::Cpu;
        let total_layers = model.effective_layers();
        let model_size_gb = model.effective_size_gb();
        let raw_train_ctx = model.train_context_size();
        let target_ctx = raw_train_ctx.min(AUTO_CTX_CEILING);

        let threads = Self::compute_threads(&resources.cpu);

        // 伴随模型（识图 mmproj 与投机加速 draft）跨介质互锁状态
        let has_draft_file = model.dspark_path.is_some() || model.draft_path.is_some();
        let cpu_draft_allowed = !is_cpu_pool || (resources.cpu.cores >= 6);
        let mut effective_enable_draft = model.enable_draft && has_draft_file && cpu_draft_allowed;
        if is_cpu_pool && has_draft_file && model.enable_draft && !cpu_draft_allowed {
            info!(
                cores = resources.cpu.cores,
                "纯 CPU 模式下物理核心数 < 6，自动关停草稿模型加速以防线程竞争拖慢整体吞吐"
            );
        }

        let effective_enable_vision = model.is_multimodal && model.enable_vision && model.mmproj_path.is_some();

        // 可用上下文下限（单一事实源）：视觉模型必须容纳得下一次识图请求，
        // 否则「能加载」但「永远用不了」——宁可多占数十 MB KV，也不把视觉能力降级成摆设。
        // 不得越过模型自身预训练窗口（老模型 train_ctx 可能只有 2048/4096）。
        let ctx_floor = if effective_enable_vision {
            VISION_CTX_FLOOR
        } else {
            AUTO_CTX_FLOOR
        }
        .min(raw_train_ctx);

        // 固定常驻开销 (Fixed Overhead): 权重 + 草稿权重 + 投影器与视觉激活峰值 + 动态计算缓冲
        let mmproj_gb = if effective_enable_vision {
            model.mmproj_size_gb.unwrap_or(0.0) + 0.35 // 额外预留 0.35 GiB 专用于 MiniCPM-V 等切片前向视觉 Patch 激活缓冲
        } else {
            0.0
        };

        let mut draft_weights_gb = if effective_enable_draft {
            model.draft_size_gb.unwrap_or(0.0)
        } else {
            0.0
        };

        let mut compute_buf = plan.base_compute_buf_gb + if effective_enable_draft { 0.25 } else { 0.0 };
        let mut final_gpu_layers = model.force_gpu_layers.unwrap_or(plan.initial_gpu_layers);

        // 单 Token 显存/内存开销辅助函数
        let compute_token_bytes = |cache_k: &str, cache_v: &str, ngl: i32, draft_on: bool| -> (u64, u64, u64) {
            let ngl_for_calc = if is_cpu_pool || ngl == 0 {
                total_layers // CPU 纯软推理下全量层数 KV 均常驻系统 RAM
            } else if ngl == -1 {
                total_layers
            } else {
                ngl.max(0) as u32
            };
            let main_b = model
                .gguf_meta
                .as_ref()
                .map(|meta| Self::compute_kv_cache_bytes_per_token(meta, cache_k, cache_v, ngl_for_calc))
                .unwrap_or(0);
            let draft_b = if draft_on {
                if let Some(ref dmeta) = model.draft_gguf_meta {
                    Self::compute_kv_cache_bytes_per_token(dmeta, cache_k, cache_v, dmeta.n_layer)
                } else {
                    // 若草稿模型物理文件存在但 GGUF 解析失败/缺失，按 8 层、2 头、head_dim 256 兜底核算
                    let fallback_meta = crate::engine::gguf_parser::GgufMetadata {
                        n_layer: 8,
                        n_kv_head: 2,
                        head_dim: 256,
                        ..Default::default()
                    };
                    Self::compute_kv_cache_bytes_per_token(&fallback_meta, cache_k, cache_v, 8)
                }
            } else {
                0
            };
            (main_b.saturating_add(draft_b), main_b, draft_b)
        };

        let mut weights_on_gpu_gb = if is_cpu_pool || final_gpu_layers == 0 {
            model_size_gb
        } else if final_gpu_layers == -1 {
            model_size_gb
        } else {
            model_size_gb * (final_gpu_layers.max(0) as f64 / total_layers.max(1) as f64)
        };

        let mut fixed_overhead_gb = weights_on_gpu_gb + draft_weights_gb + mmproj_gb + compute_buf;
        let mut kv_budget_bytes = (plan.usable_memory_gb - fixed_overhead_gb).max(0.0) * 1024.0 * 1024.0 * 1024.0;

        // 内存压力指数 λ（带除零与赤字防御）：λ = Demand_f16 / M_kv_budget
        let (f16_bpt, _, _) = compute_token_bytes("f16", "f16", final_gpu_layers, effective_enable_draft);
        let demand_f16 = (target_ctx as f64) * (f16_bpt as f64);
        let lambda = if kv_budget_bytes <= 0.0 {
            f64::INFINITY
        } else {
            demand_f16 / kv_budget_bytes
        };

        // 选定量化精度（用户指定优先；否则按连续压力指数自适应推导；CPU 模式默认优化带宽取 q8_0）
        let user_specified_k = model.cache_type_k.clone();
        let user_specified_v = model.cache_type_v.clone();
        let (mut cache_k, mut cache_v): (String, String) = if let (Some(k), Some(v)) = (user_specified_k.as_deref(), user_specified_v.as_deref()) {
            (k.to_string(), v.to_string())
        } else if let Some(k) = user_specified_k.as_deref() {
            (k.to_string(), k.to_string())
        } else if is_cpu_pool {
            let vk = if plan.supports_fa { "q8_0" } else { "f16" };
            ("q8_0".to_string(), vk.to_string())
        } else if lambda > 0.8 {
            let vk = if plan.supports_fa { "q8_0" } else { "f16" };
            ("q8_0".to_string(), vk.to_string())
        } else {
            ("f16".to_string(), "f16".to_string())
        };

        let (mut bytes_per_token, mut main_bpt, mut draft_bpt) =
            compute_token_bytes(&cache_k, &cache_v, final_gpu_layers, effective_enable_draft);

        let mut budget_tokens = if bytes_per_token > 0 {
            ((kv_budget_bytes as u64 / bytes_per_token) / 256 * 256) as u32
        } else {
            0
        };

        // 渐进式 Pre-clamp 降级梯度状态机（梯次卸载与混合卸载）
        // 若可用预算不足 2048 或固定开销超标，按物理梯度平滑收缩
        if budget_tokens < 2048 || plan.usable_memory_gb < fixed_overhead_gb {
            // Step 0: 精度降级（若当前为 f16 且用户未显式锁定）
            if user_specified_k.is_none() && cache_k == "f16" {
                cache_k = "q8_0".to_string();
                cache_v = if plan.supports_fa { "q8_0" } else { "f16" }.to_string();
                let (bpt, mb, db) = compute_token_bytes(&cache_k, &cache_v, final_gpu_layers, effective_enable_draft);
                bytes_per_token = bpt; main_bpt = mb; draft_bpt = db;
                budget_tokens = if bytes_per_token > 0 {
                    ((kv_budget_bytes as u64 / bytes_per_token) / 256 * 256) as u32
                } else {
                    0
                };
            }

            // Step A: 关停伴随草稿模型（若仍不足 2048 且草稿处于开启状态）
            if (budget_tokens < 2048 || plan.usable_memory_gb < fixed_overhead_gb) && effective_enable_draft {
                effective_enable_draft = false;
                draft_weights_gb = 0.0;
                compute_buf = plan.base_compute_buf_gb;
                fixed_overhead_gb = weights_on_gpu_gb + draft_weights_gb + mmproj_gb + compute_buf;
                kv_budget_bytes = (plan.usable_memory_gb - fixed_overhead_gb).max(0.0) * 1024.0 * 1024.0 * 1024.0;
                let (bpt, mb, db) = compute_token_bytes(&cache_k, &cache_v, final_gpu_layers, effective_enable_draft);
                bytes_per_token = bpt; main_bpt = mb; draft_bpt = db;
                budget_tokens = if bytes_per_token > 0 {
                    ((kv_budget_bytes as u64 / bytes_per_token) / 256 * 256) as u32
                } else {
                    0
                };
                info!("显存吃紧，Pre-clamp 降级自动关停草稿模型以释放显存 (KV 预算重新评估)");
            }

            // Step B1 & Step B2: GPU 混合卸载回退 或 切纯 CPU
            let mut cut_to_cpu = false;
            if (budget_tokens < 2048 || plan.usable_memory_gb < fixed_overhead_gb) && !is_cpu_pool && model.force_gpu_layers.is_none() {
                let bytes_per_layer = model.gguf_meta.as_ref().map(|meta| {
                    let n_kv_head = if meta.n_kv_head > 0 { meta.n_kv_head } else { 8 };
                    let head_dim = if meta.head_dim > 0 { meta.head_dim } else { 128 };
                    let bk = if cache_k == "q8_0" { 1.0625 } else { 2.0 };
                    let bv = if cache_v == "q8_0" { 1.0625 } else { 2.0 };
                    (n_kv_head as f64) * (head_dim as f64) * (bk + bv)
                }).unwrap_or(0.0);
                let kv_4096_gb = (4096.0 * bytes_per_layer * total_layers as f64) / (1024.0 * 1024.0 * 1024.0);
                let available_for_weights = plan.usable_memory_gb - mmproj_gb - compute_buf - kv_4096_gb;
                if available_for_weights > 0.0 && model_size_gb > 0.0 {
                    let ngl_partial = ((total_layers as f64) * (available_for_weights / model_size_gb)).floor() as i32;
                    let min_partial_layers = ((total_layers as f64) * 0.25).ceil() as i32;
                    if ngl_partial >= min_partial_layers {
                        final_gpu_layers = ngl_partial;
                        budget_tokens = 4096;
                        weights_on_gpu_gb = model_size_gb * (ngl_partial as f64 / total_layers.max(1) as f64);
                        fixed_overhead_gb = weights_on_gpu_gb + draft_weights_gb + mmproj_gb + compute_buf;
                        info!(
                            ngl_partial,
                            min_partial_layers,
                            "显存不足全量卸载，触发 Step B1 混合卸载线性回退，锁定 4096 ctx 并卸载 {} 层",
                            ngl_partial
                        );
                    } else {
                        cut_to_cpu = true;
                    }
                } else {
                    cut_to_cpu = true;
                }
            }

            if cut_to_cpu {
                info!("GPU 显存极度匮乏无法容纳保底 25% 层数与 4096 上下文，触发 Step B2 彻底切回纯 CPU 软件推理模式");
                return Self::cpu_params(resources, model, backend);
            }
        }

        // 最终上下文输出与安全夹界
        let budget_ctx = if bytes_per_token == 0 {
            let heuristic = if is_cpu_pool {
                4096
            } else if plan.usable_memory_gb < 4.0 {
                2048
            } else if plan.usable_memory_gb < 8.0 {
                4096
            } else {
                8192
            };
            heuristic.max(ctx_floor).min(raw_train_ctx)
        } else {
            budget_tokens.clamp(ctx_floor, raw_train_ctx)
        };

        // 可观测性红线：物理预算不足以容纳下限时，必须显式告警，不得静默地
        // 「预算说装不下，却按下限加载」——否则识图请求 400 将无从归因。
        if budget_tokens < ctx_floor {
            warn!(
                budget_tokens,
                granted = ctx_floor,
                vision = effective_enable_vision,
                "物理预算不足以下限，按最低可用上下文加载（视觉模型保底 4096，否则无法容纳一次识图请求）"
            );
        }

        let final_ctx = if let Some(user_ctx) = model.context_window {
            let capped = user_ctx.clamp(512, raw_train_ctx).min(budget_ctx);
            if capped < user_ctx {
                warn!(
                    requested = user_ctx,
                    granted = capped,
                    budget = budget_ctx,
                    "用户指定的上下文长度超出显存/内存预算，已自动下调；可降低 KV 量化(q8_0)或关闭识图/草稿来释放显存"
                );
            }
            capped
        } else {
            budget_ctx.min(AUTO_CTX_CEILING)
        };

        // 批处理大小与微批约束 (ubatch <= batch；CPU 模式严格封顶 128/64 防页面交换颠簸)
        let batch_size = if is_cpu_pool {
            model.force_batch_size.unwrap_or(128).min(128)
        } else {
            model.force_batch_size.unwrap_or(plan.default_batch.0)
        };
        let raw_ubatch = if is_cpu_pool {
            model.force_ubatch_size.unwrap_or(64).min(batch_size)
        } else {
            model.force_ubatch_size.unwrap_or(plan.default_batch.1).min(batch_size)
        };
        let final_ubatch = raw_ubatch.min(batch_size);

        let offload_ratio = if is_cpu_pool || final_gpu_layers == 0 {
            0.0
        } else if final_gpu_layers == -1 {
            1.0
        } else {
            (final_gpu_layers.max(0) as f64 / total_layers.max(1) as f64).min(1.0)
        };

        info!(
            "全介质物理预算明细 [{:?}]: 可用 {:.2}G | 固定占用 {:.2}G(权重 {:.2} + 草稿 {:.2} + 投影器 {:.2} + 计算缓冲 {:.2}) | KV 额度 {:.2}G | KV/token {}B(主 {} + 草稿 {}) | 预算上限 {} tokens | 最终 ctx {}",
            plan.pool,
            plan.usable_memory_gb,
            fixed_overhead_gb,
            weights_on_gpu_gb,
            draft_weights_gb,
            mmproj_gb,
            compute_buf,
            (plan.usable_memory_gb - fixed_overhead_gb).max(0.0),
            bytes_per_token,
            main_bpt,
            draft_bpt,
            budget_ctx,
            final_ctx
        );

        EngineParams {
            gpu_layers: final_gpu_layers,
            batch_size,
            ubatch_size: final_ubatch,
            ctx_size: final_ctx,
            threads,
            flash_attention: plan.supports_fa,
            is_cpu_mode: final_gpu_layers == 0 || is_cpu_pool,
            offload_ratio,
            cache_type_k: cache_k,
            cache_type_v: cache_v,
            effective_enable_draft,
            effective_enable_vision,
            budget_ctx,
            max_train_ctx: raw_train_ctx,
            usable_memory_gb: plan.usable_memory_gb,
            fixed_overhead_gb,
            description: format!("{} (卸载率 {:.0}%)", plan.description_prefix, offload_ratio * 100.0),
        }
    }

    /// 【CPU 模式：纯软件推理物理内存池】
    fn cpu_params(resources: &SystemResources, model: &ModelInfo, backend: &str) -> EngineParams {
        let total_ram_gb = resources.memory.total_gb();
        let avail_ram_gb = resources.memory.available_mb as f64 / 1024.0;
        let reserve_gb = 2.5_f64.max(total_ram_gb * 0.25);
        let usable_mem = (avail_ram_gb - reserve_gb).max(0.0);
        let model_size_gb = model.effective_size_gb();

        let plan = BudgetPlan {
            pool: MemoryPoolKind::Cpu,
            usable_memory_gb: usable_mem,
            initial_gpu_layers: 0,
            default_batch: (128, 64),
            supports_fa: false,
            base_compute_buf_gb: 0.3,
            description_prefix: format!(
                "CPU 纯软件推理模式 (内存可用 {:.1}GB, 预留 {:.1}GB, 模型 {:.2}GB)",
                usable_mem, reserve_gb, model_size_gb
            ),
        };

        Self::solve_plan(resources, model, plan, backend)
    }

    /// 【Apple Silicon Metal UMA 统一内存池】
    fn apple_silicon_params(
        resources: &SystemResources,
        model: &ModelInfo,
        _vram_mb: u64,
        backend: &str,
    ) -> EngineParams {
        let total_mem_gb = resources.memory.total_gb();
        let model_size_gb = model.effective_size_gb();
        let total_layers = model.effective_layers();

        let usable_mem = (total_mem_gb - 3.0).max(2.0);

        let initial_gpu_layers = if model_size_gb <= usable_mem {
            -1
        } else {
            let offload_ratio = usable_mem / model_size_gb;
            (total_layers as f64 * offload_ratio).floor().max(8.0) as i32
        };

        let plan = BudgetPlan {
            pool: MemoryPoolKind::AppleSilicon,
            usable_memory_gb: usable_mem,
            initial_gpu_layers,
            default_batch: (1024, 512),
            supports_fa: true,
            base_compute_buf_gb: COMPUTE_BUFFER_GB,
            description_prefix: format!(
                "Apple Silicon Metal UMA ({:.1}GB 内存, 可用 {:.1}GB, 模型 {:.2}GB, {}层)",
                total_mem_gb, usable_mem, model_size_gb, total_layers
            ),
        };

        Self::solve_plan(resources, model, plan, backend)
    }

    /// 【集成显卡 / 核显 iGPU 共享显存池】
    fn igpu_params(
        resources: &SystemResources,
        model: &ModelInfo,
        vram_mb: u64,
        backend: &str,
    ) -> EngineParams {
        let vram_gb = vram_mb as f64 / 1024.0;
        let total_ram_gb = resources.memory.total_gb();
        let model_size_gb = model.effective_size_gb();
        let total_layers = model.effective_layers();

        let usable_vram = (3.5_f64.max(total_ram_gb * 0.45)).min(1.8_f64.max(vram_gb * 0.7));
        let offload_ratio = if model_size_gb > 0.0 {
            usable_vram / model_size_gb
        } else {
            1.0
        };

        let initial_gpu_layers = if offload_ratio >= 0.85 || model_size_gb <= 2.0 {
            -1
        } else {
            let target = (total_layers as f64 * offload_ratio).floor() as i32;
            target.max(8).min(16)
        };

        let plan = BudgetPlan {
            pool: MemoryPoolKind::Igpu,
            usable_memory_gb: usable_vram,
            initial_gpu_layers,
            default_batch: (512, 256),
            supports_fa: false,
            base_compute_buf_gb: 0.6,
            description_prefix: format!(
                "集成显卡 iGPU (可用 {:.1}GB, 模型 {:.2}GB, {}层)",
                usable_vram, model_size_gb, total_layers
            ),
        };

        Self::solve_plan(resources, model, plan, backend)
    }

    /// 【独立显卡 dGPU 独立显存池】
    fn dgpu_params(
        resources: &SystemResources,
        model: &ModelInfo,
        vram_mb: u64,
        backend: &str,
    ) -> EngineParams {
        let vram_gb = vram_mb as f64 / 1024.0;
        let model_size_gb = model.effective_size_gb();
        let total_layers = model.effective_layers();

        let primary_gpu = resources.primary_gpu();
        let free_vram_gb = primary_gpu.and_then(|g| g.memory_free_gb());
        let usable_vram = (free_vram_gb.unwrap_or(vram_gb) - VRAM_SAFETY_RESERVE_GB).max(0.0);

        let offload_ratio = if model_size_gb > 0.0 {
            usable_vram / model_size_gb
        } else {
            1.0
        };

        let initial_gpu_layers = if offload_ratio >= 0.88 {
            -1
        } else {
            let target = (total_layers as f64 * offload_ratio).floor() as i32;
            if target >= 6 { target } else { 0 }
        };

        let default_batch = if vram_gb < 4.0 {
            (512u32, 256u32)
        } else if vram_gb < 16.0 {
            (1024u32, 256u32)
        } else {
            (2048u32, 512u32)
        };

        let gpu_name = primary_gpu.map(|g| g.name.as_str()).unwrap_or("");
        let supports_fa = crate::hardware::is_flash_attention_supported(backend, gpu_name);

        let plan = BudgetPlan {
            pool: MemoryPoolKind::Dgpu,
            usable_memory_gb: usable_vram,
            initial_gpu_layers,
            default_batch,
            supports_fa,
            base_compute_buf_gb: COMPUTE_BUFFER_GB,
            description_prefix: format!(
                "独立显卡 dGPU ({:.1}GB VRAM, 可用 {:.1}GB, 模型 {:.2}GB, {}层)",
                vram_gb, usable_vram, model_size_gb, total_layers
            ),
        };

        Self::solve_plan(resources, model, plan, backend)
    }

    /// 计算安全的 CPU 线程数
    /// 调度方程：T_cpu = max(1, min(8, P_physical - 2))
    /// 保留 2 个核心给系统与前台渲染，线程数控制在 1~8 之间
    fn compute_threads(cpu: &crate::hardware::gpu_info::CpuInfo) -> u32 {
        let p = cpu.cores.max(1);
        (p as i32 - 2).clamp(1, 8) as u32
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

        // 多模态投影器 --mmproj（双重互锁：模型明确为多模态 + 文件存在 + 用户未关闭识图 + 预算求解生效）
        let should_vision = params.effective_enable_vision && model_info.map(|i| i.is_multimodal && i.enable_vision).unwrap_or(true);
        if should_vision {
            if let Some(info) = model_info {
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
        let should_draft = params.effective_enable_draft && model_info.map(|i| i.enable_draft).unwrap_or(true);
        if should_draft {
            if let Some(info) = model_info {
                // MTP / 常规草稿模型默认步数
                let draft_max = info.draft_max_tokens.unwrap_or(6);
                // DSpark 投机采样
                if let Some(ref dspark) = info.dspark_path {
                    // DSpark 草稿模型（openbmb/MiniCPM-V-4.7-1B-DSpark-gguf）采用块扩散 +
                    // 马尔可夫头架构。2026-10-20 用户实测调参：旧策略把 n-max 强制对齐
                    // 块大小 15，但草稿命中率仅 4%~21%、平均每次仅接受 2.4~4.15 个词
                    // （temp 0.7 常规对话场景）——第 4 个词之后猜错即整段作废，第 5~15
                    // 个候选纯属无效计算，白耗显卡算力。故取消 15 下限，透传用户配置，
                    // 缺省取甜点值 6：既覆盖实测平均命中长度，又砍掉后续无效草稿。
                    // 结构化/识图等低温场景（API 动态传 temperature≤0.3）命中率翻倍后，
                    // 可在模型参数抽屉内调高至 8。
                    let dspark_max = info.draft_max_tokens.unwrap_or(6);
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
        let cache_k = if !params.cache_type_k.is_empty() {
            &params.cache_type_k
        } else {
            model_info.and_then(|i| i.cache_type_k.as_deref()).unwrap_or("f16")
        };
        let cache_v = if !params.cache_type_v.is_empty() {
            &params.cache_type_v
        } else {
            model_info.and_then(|i| i.cache_type_v.as_deref()).unwrap_or("f16")
        };
        args.extend([
            "--cache-type-k".to_string(),
            cache_k.to_string(),
            "--cache-type-v".to_string(),
            cache_v.to_string(),
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
            mmproj_size_gb: None,
            dspark_path: None,
            draft_size_gb: None,
            draft_path: None,
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
}
