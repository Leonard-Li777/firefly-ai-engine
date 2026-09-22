// config/store.rs
// 独立配置持久化（严禁使用主程序 AppData 目录）
// 配置路径：%APPDATA%/firefly-ai-engine/config.json

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tracing::{debug, info, warn};

/// 引擎配置（全部字段均有默认值）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineConfig {
    /// 模型存储目录（用户可自定义）
    #[serde(default = "default_models_dir")]
    pub models_dir: PathBuf,

    /// 是否强制 CPU 模式
    #[serde(default)]
    pub force_cpu: bool,

    /// 服务基准端口（38400~38419 滑动探测）
    #[serde(default = "default_port")]
    pub base_port: u16,

    /// 启动时是否静默（不显示主窗口）
    #[serde(default = "default_silent")]
    pub silent: bool,

    /// 是否常驻后台（主程序退出时不退出）
    #[serde(default)]
    pub background_persist: bool,

    /// 用户自定义 GPU 层数（None = 自动计算）
    #[serde(default)]
    pub custom_gpu_layers: Option<i32>,

    /// 用户自定义上下文长度（None = 自动）
    #[serde(default)]
    pub custom_context_window: Option<u32>,

    /// 当前选中的模型文件路径
    #[serde(default)]
    pub selected_model_path: Option<PathBuf>,

    /// 当前使用的加速后端（None = 自动选择）
    #[serde(default)]
    pub preferred_backend: Option<String>,

    /// 模型专属自定义启动参数映射表（key 为模型唯一标识，如 model ID 或模型名）
    #[serde(default)]
    pub model_custom_params: std::collections::HashMap<String, ModelCustomParams>,

    /// 数据目录（由系统设置，不可用户修改）
    #[serde(skip)]
    pub data_dir: PathBuf,
}

/// 每个模型的专属运行时参数（支持保存至 config.json）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelCustomParams {
    /// GPU 卸载层数（-1 为全量，0 为纯 CPU）
    #[serde(default = "default_gpu_layers")]
    pub n_gpu_layers: i32,
    /// CPU 推理物理线程数
    #[serde(default = "default_threads")]
    pub threads: u32,
    /// 上下文长度 (tokens)
    #[serde(default = "default_ctx_size")]
    pub ctx_size: u32,
    /// 批处理 Batch Size
    #[serde(default = "default_batch_size")]
    pub batch_size: u32,
    /// 微批处理 Ubatch Size (严格 <= batch_size)
    #[serde(default = "default_ubatch_size")]
    pub ubatch_size: u32,
    /// KV 缓存 Key 量化类型 ("f16" | "q8_0" | "q4_0")
    #[serde(default = "default_cache_type")]
    pub cache_type_k: String,
    /// KV 缓存 Value 量化类型 ("f16" | "q8_0" | "q4_0")
    #[serde(default = "default_cache_type")]
    pub cache_type_v: String,
    /// 并发槽位数
    #[serde(default = "default_parallel")]
    pub parallel: u32,
    /// 温度超参 (0.0 ~ 2.0)
    #[serde(default = "default_temp")]
    pub temp: f64,
    /// Top-P 采样 (0.0 ~ 1.0)
    #[serde(default = "default_top_p")]
    pub top_p: f64,
    /// Top-K 采样 (1 ~ 100)
    #[serde(default = "default_top_k")]
    pub top_k: u32,
    /// 重复惩罚 (1.0 ~ 2.0)
    #[serde(default = "default_repeat_penalty")]
    pub repeat_penalty: f64,
}

fn default_gpu_layers() -> i32 { 24 }
fn default_threads() -> u32 { 8 }
fn default_ctx_size() -> u32 { 4096 }
fn default_batch_size() -> u32 { 512 }
fn default_ubatch_size() -> u32 { 256 }
fn default_cache_type() -> String { "f16".to_string() }
fn default_parallel() -> u32 { 1 }
fn default_temp() -> f64 { 0.7 }
fn default_top_p() -> f64 { 0.95 }
fn default_top_k() -> u32 { 40 }
fn default_repeat_penalty() -> f64 { 1.1 }

impl Default for ModelCustomParams {
    fn default() -> Self {
        Self {
            n_gpu_layers: default_gpu_layers(),
            threads: default_threads(),
            ctx_size: default_ctx_size(),
            batch_size: default_batch_size(),
            ubatch_size: default_ubatch_size(),
            cache_type_k: default_cache_type(),
            cache_type_v: default_cache_type(),
            parallel: default_parallel(),
            temp: default_temp(),
            top_p: default_top_p(),
            top_k: default_top_k(),
            repeat_penalty: default_repeat_penalty(),
        }
    }
}

fn default_models_dir() -> PathBuf {
    PathBuf::from("models")
}

fn default_port() -> u16 {
    38400
}

fn default_silent() -> bool {
    false
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig {
            models_dir: default_models_dir(),
            force_cpu: false,
            base_port: default_port(),
            silent: false,
            background_persist: false,
            custom_gpu_layers: None,
            custom_context_window: None,
            selected_model_path: None,
            preferred_backend: None,
            model_custom_params: std::collections::HashMap::new(),
            data_dir: PathBuf::new(),
        }
    }
}

/// 配置存储（独立 AppData 目录）
pub struct ConfigStore {
    /// 配置文件路径
    config_path: PathBuf,
}

impl ConfigStore {
    /// 初始化配置存储
    /// data_dir：Tauri app_data_dir()（产品名 = "firefly-ai-engine"）
    pub fn new(data_dir: PathBuf) -> Self {
        let config_path = data_dir.join("config.json");
        ConfigStore { config_path }
    }

    /// 加载配置（不存在则返回默认值）
    pub fn load(&self) -> Result<EngineConfig> {
        if !self.config_path.exists() {
            info!("配置文件不存在，使用默认配置: {:?}", self.config_path);
            return Ok(self.default_config());
        }

        let content = std::fs::read_to_string(&self.config_path)
            .context("读取配置文件失败")?;

        let mut config: EngineConfig = serde_json::from_str(&content)
            .unwrap_or_else(|e| {
                warn!("解析配置文件失败，使用默认配置: {}", e);
                self.default_config()
            });

        // 确保 models_dir 是绝对路径
        let data_dir = self.config_path.parent().unwrap().to_path_buf();
        config.data_dir = data_dir.clone();
        if config.models_dir.is_relative() {
            config.models_dir = data_dir.join(&config.models_dir);
        }

        debug!("加载配置成功: models_dir={:?}", config.models_dir);
        Ok(config)
    }

    /// 保存配置
    pub fn save(&self, config: &EngineConfig) -> Result<()> {
        // 确保目录存在
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent).context("创建配置目录失败")?;
        }

        let content = serde_json::to_string_pretty(config)
            .context("序列化配置失败")?;

        std::fs::write(&self.config_path, content)
            .context("写入配置文件失败")?;

        debug!("配置已保存: {:?}", self.config_path);
        Ok(())
    }

    /// 默认配置（数据目录下）
    fn default_config(&self) -> EngineConfig {
        let data_dir = self.config_path.parent().unwrap().to_path_buf();
        EngineConfig {
            models_dir: data_dir.join("models"),
            data_dir: data_dir.clone(),
            ..EngineConfig::default()
        }
    }
}

/// 查找 38400~38419 范围内第一个可用端口
pub async fn find_available_port(base: u16) -> u16 {
    for port in base..=(base + 19) {
        if is_port_available(port).await {
            info!("找到可用端口: {}", port);
            return port;
        }
        warn!("端口 {} 已占用，尝试下一个", port);
    }
    warn!("38400~38419 均已占用，使用基准端口 {}", base);
    base
}

/// 检测端口是否可用
async fn is_port_available(port: u16) -> bool {
    tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port))
        .await
        .is_ok()
}
