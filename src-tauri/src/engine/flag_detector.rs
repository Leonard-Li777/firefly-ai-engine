// engine/flag_detector.rs
//
// llama-server 启动参数标志（Flags）能力探测器
// 探活目标 llama-server 可执行文件的 --help 输出，确认当前二进制是否支持特定命令行开关。
// 探测结果由内存 RwLock/HashMap 缓存，避免重复执行子进程。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// llama-server 命令行特性开关探测结果
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ServerFeatureFlags {
    pub supports_alias: bool,
    pub supports_chat_template_file: bool,
    pub supports_cache_reuse: bool,
    pub supports_flash_attn: bool,
    pub supports_reasoning: bool,
    pub supports_reasoning_format: bool,
    pub supports_reasoning_budget: bool,
}

impl ServerFeatureFlags {
    /// 全特性支持的现代 llama-server（如最新 b4000+ 版本）
    pub fn full_featured() -> Self {
        ServerFeatureFlags {
            supports_alias: true,
            supports_chat_template_file: true,
            supports_cache_reuse: true,
            supports_flash_attn: true,
            supports_reasoning: true,
            supports_reasoning_format: true,
            supports_reasoning_budget: true,
        }
    }
}

impl Default for ServerFeatureFlags {
    fn default() -> Self {
        ServerFeatureFlags {
            supports_alias: true,
            supports_chat_template_file: true,
            supports_cache_reuse: true,
            supports_flash_attn: true,
            supports_reasoning: false,
            supports_reasoning_format: false,
            supports_reasoning_budget: false,
        }
    }
}

static FLAGS_CACHE: std::sync::OnceLock<RwLock<HashMap<PathBuf, ServerFeatureFlags>>> =
    std::sync::OnceLock::new();

pub struct FlagDetector;

impl FlagDetector {
    /// 探活指定 llama-server 二进制的 flags 支持情况（带内存缓存）
    pub async fn detect<P: AsRef<Path>>(binary_path: P) -> ServerFeatureFlags {
        let p = binary_path.as_ref().to_path_buf();
        let cache_lock = FLAGS_CACHE.get_or_init(|| RwLock::new(HashMap::new()));

        {
            let r = cache_lock.read().unwrap();
            if let Some(cached) = r.get(&p) {
                return cached.clone();
            }
        }

        let flags = Self::probe_binary_help(&p).await;

        {
            let mut w = cache_lock.write().unwrap();
            w.insert(p, flags.clone());
        }

        flags
    }

    async fn probe_binary_help(binary_path: &Path) -> ServerFeatureFlags {
        let mut cmd = tokio::process::Command::new(binary_path);
        cmd.arg("--help");

        #[cfg(windows)]
        {
            cmd.creation_flags(crate::win_proc::CREATE_NO_WINDOW);
        }

        let child = cmd.output();
        let output = match tokio::time::timeout(std::time::Duration::from_millis(2000), child).await {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => {
                tracing::warn!("调用 llama-server --help 失败: {}, 使用安全默认标志", e);
                return ServerFeatureFlags::default();
            }
            Err(_) => {
                tracing::warn!("调用 llama-server --help 超时（2s），使用安全默认标志");
                return ServerFeatureFlags::default();
            }
        };

        // llama-server --help 可能输出在 stdout 或 stderr
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let help_text = format!("{}\n{}", stdout, stderr);

        ServerFeatureFlags {
            supports_alias: help_text.contains("--alias"),
            supports_chat_template_file: help_text.contains("--chat-template-file"),
            supports_cache_reuse: help_text.contains("--cache-reuse"),
            supports_flash_attn: help_text.contains("--flash-attn") || help_text.contains("-fa"),
            supports_reasoning: help_text.contains("--reasoning"),
            supports_reasoning_format: help_text.contains("--reasoning-format"),
            supports_reasoning_budget: help_text.contains("--reasoning-budget"),
        }
    }
}
