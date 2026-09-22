// engine/param_builder.rs
// Max-Fill 动态引擎启动参数计算器
// 1:1 移植桌面端 LlamacppAdapter::buildCommandContext 核心算法
// 关键安全约束：ubatchSize <= batchSize（防止 llama.cpp 0xC0000005 崩溃）

use serde::{Deserialize, Serialize};
use tracing::info;

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
    /// 是否为生产环境（注入 --verbose）
    pub is_production: bool,
}

impl ModelInfo {
    /// 估算模型层数
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

    /// 【CPU 模式】
    fn cpu_params(resources: &SystemResources, model: &ModelInfo, _backend: &str) -> EngineParams {
        let batch_size = model.force_batch_size.unwrap_or(128).min(128);
        // 严格约束：ubatch <= batch
        let ubatch_size = model.force_ubatch_size.unwrap_or(128).min(batch_size);
        let ctx_size = model.context_window.unwrap_or(4096);
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
        let estimated_layers = model.estimated_layers();

        // 预留 3GB 给系统和前台应用
        let usable_mem = (total_mem_gb - 3.0).max(2.0);

        let gpu_layers = if model_size_gb <= usable_mem {
            -1 // 全量 GPU 加速
        } else {
            let offload_ratio = usable_mem / model_size_gb;
            (estimated_layers as f64 * offload_ratio).floor().max(8.0) as i32
        };

        let final_gpu_layers = model.force_gpu_layers.unwrap_or(gpu_layers);
        let batch_size = model.force_batch_size.unwrap_or(1024);
        let raw_ubatch = model.force_ubatch_size.unwrap_or(512);
        // 核心约束：ubatch <= batch
        let ubatch_size = raw_ubatch.min(batch_size);
        let ctx_size = model.context_window.unwrap_or(4096);
        let threads = Self::compute_threads(&resources.cpu);

        // Apple Silicon Metal 全系支持 Flash Attention
        let flash_attention = true;

        info!(
            "Apple Silicon Metal (UMA: {:.1}GB, 模型: {:.2}GB) → ngl={}, batch={}, ubatch={}, ctx={}, fa={}",
            total_mem_gb, model_size_gb, final_gpu_layers, batch_size, ubatch_size, ctx_size, flash_attention
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
                "Apple Silicon Metal UMA ({:.1}GB 内存, 模型 {:.2}GB)",
                total_mem_gb, model_size_gb
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
        let estimated_layers = model.estimated_layers();

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
            let target = (estimated_layers as f64 * offload_ratio).floor() as i32;
            target.max(8).min(16) // 8~16 层
        };

        let final_gpu_layers = model.force_gpu_layers.unwrap_or(gpu_layers);
        let batch_size = model.force_batch_size.unwrap_or(512);
        let raw_ubatch = model.force_ubatch_size.unwrap_or(256);
        // 核心约束：ubatch <= batch
        let ubatch_size = raw_ubatch.min(batch_size);
        let ctx_size = model.context_window.unwrap_or(4096);
        let threads = Self::compute_threads(&resources.cpu);

        // 核显不支持 Flash Attention（Vulkan 后端不支持）
        let flash_attention = false;

        info!(
            "集成显卡/核显 (VRAM: {:.1}GB, 可用: {:.1}GB, 模型: {:.2}GB, 容纳比: {:.0}%) → ngl={}, batch={}, ubatch={}, ctx={}",
            vram_gb, usable_vram, model_size_gb, offload_ratio * 100.0,
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
                "集成显卡 iGPU (可用 {:.1}GB, 模型 {:.2}GB)",
                usable_vram, model_size_gb
            ),
        }
    }

    /// 【独立显卡 dGPU】
    /// 精准压榨 VRAM，预留 0.8GB 缓冲
    fn dgpu_params(
        resources: &SystemResources,
        model: &ModelInfo,
        vram_mb: u64,
        backend: &str,
    ) -> EngineParams {
        let vram_gb = vram_mb as f64 / 1024.0;
        let model_size_gb = model.effective_size_gb();
        let estimated_layers = model.estimated_layers();

        // 预留 0.8GB (Windows 桌面渲染 400MB + KV Cache 150MB + CUDA Runtime 250MB)
        let usable_vram = (vram_gb - 0.8).max(0.0);
        let offload_ratio = if model_size_gb > 0.0 {
            usable_vram / model_size_gb
        } else {
            1.0
        };

        let gpu_layers = if offload_ratio >= 0.88 {
            -1 // 88% 以上全量卸载
        } else {
            let target = (estimated_layers as f64 * offload_ratio).floor() as i32;
            // < 6 层收益不如传输开销，置 0（纯 CPU）
            if target >= 6 { target } else { 0 }
        };

        // 根据 VRAM 大小确定批大小
        let (batch_size, raw_ubatch, ctx_size) = if vram_gb < 4.0 {
            (512u32, 256u32, model.context_window.unwrap_or(4096))
        } else if vram_gb < 8.0 {
            (1024u32, 512u32, model.context_window.unwrap_or(4096))
        } else {
            (2048u32, 512u32, model.context_window.unwrap_or(8192))
        };

        let final_gpu_layers = model.force_gpu_layers.unwrap_or(gpu_layers);
        let final_batch = model.force_batch_size.unwrap_or(batch_size);
        let final_raw_ubatch = model.force_ubatch_size.unwrap_or(raw_ubatch);
        // 核心安全约束：ubatch_size 严禁 > batch_size（防 0xC0000005 崩溃）
        let final_ubatch = final_raw_ubatch.min(final_batch);

        let threads = Self::compute_threads(&resources.cpu);

        // Flash Attention 判断（使用主 GPU 名称）
        let primary_gpu = resources.primary_gpu();
        let gpu_name = primary_gpu.map(|g| g.name.as_str()).unwrap_or("");
        let flash_attention = crate::hardware::is_flash_attention_supported(backend, gpu_name);

        info!(
            "独立显卡 dGPU (VRAM: {:.1}GB, 可用: {:.1}GB, 模型: {:.2}GB, 容纳比: {:.0}%) → ngl={}, batch={}, ubatch={}, ctx={}, fa={}",
            vram_gb, usable_vram, model_size_gb, offload_ratio * 100.0,
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
                "独立显卡 dGPU ({:.1}GB VRAM, 模型 {:.2}GB, 容纳率 {:.0}%)",
                vram_gb, model_size_gb, offload_ratio * 100.0
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

        // 多模态投影器 --mmproj
        if let Some(info) = model_info {
            if let Some(ref mmproj) = info.mmproj_path {
                args.extend(["--mmproj".to_string(), mmproj.clone()]);
            }

            // DSpark 投机采样
            if let Some(ref dspark) = info.dspark_path {
                args.extend([
                    "--model-draft".to_string(),
                    dspark.clone(),
                    "--spec-type".to_string(),
                    "draft-dspark".to_string(),
                    "--spec-draft-n-max".to_string(),
                    "5".to_string(),
                    "--spec-draft-n-min".to_string(),
                    "0".to_string(),
                ]);
                if !params.is_cpu_mode && params.gpu_layers > 0 {
                    args.extend([
                        "--gpu-layers-draft".to_string(),
                        params.gpu_layers.to_string(),
                    ]);
                }
            } else if let Some(ref draft) = info.draft_path {
                // MTP / 常规 Draft
                args.extend([
                    "--model-draft".to_string(),
                    draft.clone(),
                    "--spec-type".to_string(),
                    "draft-mtp".to_string(),
                    "--spec-draft-n-max".to_string(),
                    "3".to_string(),
                ]);
            }
        }

        args.extend([
            "--ctx-size".to_string(),
            params.ctx_size.to_string(),
            "--alias".to_string(),
            model_alias.to_string(),
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

        // 思考模式与聊天模板
        let enable_thinking = model_info.map(|i| i.enable_thinking).unwrap_or(false);
        let is_minicpm5 = model_info.map(|i| i.is_minicpm5).unwrap_or(false);
        let is_nanbeige4 = model_info.map(|i| i.is_nanbeige4).unwrap_or(false);

        // 采样超参：优先使用用户配置，未配置时依模型架构回退
        let user_temp = model_info.and_then(|i| i.temp);
        let user_top_p = model_info.and_then(|i| i.top_p);
        let user_top_k = model_info.and_then(|i| i.top_k);

        if !enable_thinking {
            args.extend([
                "--reasoning".to_string(),
                "off".to_string(),
                "--reasoning-format".to_string(),
                "none".to_string(),
                "--reasoning-budget".to_string(),
                "0".to_string(),
            ]);

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
            let final_temp = user_temp.unwrap_or(0.9);
            let final_top_p = user_top_p.unwrap_or(0.95);
            args.extend([
                "--reasoning-budget".to_string(),
                "1024".to_string(),
                "--temp".to_string(),
                format!("{:.2}", final_temp),
                "--top-p".to_string(),
                format!("{:.2}", final_top_p),
            ]);

            if let Some(tk) = user_top_k {
                args.extend(["--top-k".to_string(), tk.to_string()]);
            }
        }

        // Flash Attention
        if params.flash_attention {
            args.extend(["-fa".to_string(), "auto".to_string()]);
        } else {
            args.extend(["-fa".to_string(), "off".to_string()]);
        }

        // 生产环境详细日志
        let is_prod = model_info.map(|i| i.is_production).unwrap_or(false);
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

        args
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
            },
            memory: MemoryInfo {
                total_mb: 32768,
                available_mb: 16384,
            },
            gpus: vec![GpuInfo {
                name: "NVIDIA GeForce RTX 3060".to_string(),
                memory_mb: vram_mb,
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
            is_production: false,
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
            },
            memory: MemoryInfo {
                total_mb: 32 * 1024, // 32GB
                available_mb: 20 * 1024,
            },
            gpus: vec![GpuInfo {
                name: "Apple M2 Pro".to_string(),
                memory_mb: 16 * 1024, // UMA
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
            },
            memory: MemoryInfo {
                total_mb: 16384,
                available_mb: 8192,
            },
            gpus: vec![GpuInfo {
                name: "Intel Iris Xe Graphics".to_string(),
                memory_mb: 2048, // 共享 2GB
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
}
