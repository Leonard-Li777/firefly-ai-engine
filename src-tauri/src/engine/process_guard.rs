// engine/process_guard.rs
// llama-server 子进程守护器
// 功能：进程生命周期管理 + 实时 stderr/stdout 监控 + 错误结构化分类

use anyhow::{anyhow, Result};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, broadcast};
use tracing::{debug, info, warn};

use crate::hardware::{DowngradeReason, DriverComplianceService};

use super::scheduler::InstalledEngine;

/// 进程状态
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessStatus {
    Starting,
    Running,
    Failed,
    Stopped,
}

/// 结构化进程错误
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProcessError {
    pub kind: DowngradeReason,
    pub message: String,
    pub raw: String,
}

/// 进程输出事件
#[derive(Debug, Clone)]
pub enum ProcessEvent {
    Ready,
    FatalError(ProcessError),
    Log(String),
}

/// 进程守护器（单实例，单进程）
pub struct ProcessGuard {
    compliance: Arc<DriverComplianceService>,
    /// 当前子进程（Mutex 保证安全访问）
    child: Mutex<Option<Child>>,
    /// 进程状态
    status: Mutex<ProcessStatus>,
    /// 是否正在关闭
    shutting_down: Arc<AtomicBool>,
    /// 事件广播（通知调用方进程状态变化）
    event_tx: broadcast::Sender<ProcessEvent>,
    /// 当前引擎（用于错误回调时标记不合规）
    current_engine: Mutex<Option<InstalledEngine>>,
}

impl ProcessGuard {
    pub fn new(compliance: Arc<DriverComplianceService>) -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(64);
        Arc::new(ProcessGuard {
            compliance,
            child: Mutex::new(None),
            status: Mutex::new(ProcessStatus::Stopped),
            shutting_down: Arc::new(AtomicBool::new(false)),
            event_tx,
            current_engine: Mutex::new(None),
        })
    }

    /// 订阅进程事件
    pub fn subscribe(&self) -> broadcast::Receiver<ProcessEvent> {
        self.event_tx.subscribe()
    }

    /// 启动 llama-server 子进程
    pub async fn start(
        self: &Arc<Self>,
        engine: &InstalledEngine,
        args: &[String],
        env_extras: &[(&str, &str)],
    ) -> Result<()> {
        // 更新状态
        {
            let mut status = self.status.lock().await;
            *status = ProcessStatus::Starting;
        }
        {
            let mut cur = self.current_engine.lock().await;
            *cur = Some(engine.clone());
        }
        self.shutting_down.store(false, Ordering::SeqCst);

        info!(
            "启动 llama-server: {:?} {}",
            engine.binary_path,
            args.join(" ")
        );

        // 构建环境变量（注入 bin 目录到 PATH 以加载 DLL）
        let engine_dir = engine.binary_path.parent().unwrap_or(&engine.binary_path);
        let engine_dir_str = engine_dir.to_string_lossy().to_string();

        let mut cmd = Command::new(&engine.binary_path);
        cmd.args(args);

        // 注入 PATH（Windows DLL 加载关键）
        let path_key = if cfg!(windows) { "Path" } else { "PATH" };
        let sep = if cfg!(windows) { ";" } else { ":" };
        let original_path = std::env::var(path_key).unwrap_or_default();
        cmd.env(path_key, format!("{}{}{}", engine_dir_str, sep, original_path));

        // Linux：注入 LD_LIBRARY_PATH
        #[cfg(target_os = "linux")]
        {
            let orig_ld = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
            cmd.env("LD_LIBRARY_PATH", format!("{}:{}", engine_dir_str, orig_ld));
        }

        // 额外环境变量
        for (k, v) in env_extras {
            cmd.env(k, v);
        }

        // 标准环境
        cmd.env("WER_DONT_SHOW_UI", "1")
            .env("LANG", "en_US.UTF-8")
            .env("LC_ALL", "en_US.UTF-8");

        // 捕获 stdout / stderr
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| anyhow!("启动 llama-server 失败: {}", e))?;

        // 异步监控 stdout
        if let Some(stdout) = child.stdout.take() {
            let tx = self.event_tx.clone();
            tokio::spawn(async move {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    debug!("[llama-stdout] {}", line);

                    // 检测 server ready 信号
                    if line.contains("server listening") || line.contains("llama server listening") {
                        info!("llama-server 已就绪");
                        let _ = tx.send(ProcessEvent::Ready);
                    }

                    let _ = tx.send(ProcessEvent::Log(format!("[stdout] {}", line)));
                }
            });
        }

        // 异步监控 stderr
        if let Some(stderr) = child.stderr.take() {
            let tx = self.event_tx.clone();
            let compliance = self.compliance.clone();
            let engine_clone = engine.clone();
            let shutting_down = self.shutting_down.clone();

            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                let mut error_buffer = String::new();

                while let Ok(Some(line)) = lines.next_line().await {
                    debug!("[llama-stderr] {}", line);
                    let _ = tx.send(ProcessEvent::Log(format!("[stderr] {}", line)));

                    error_buffer.push_str(&line);
                    error_buffer.push('\n');

                    // 分类检测致命错误
                    if let Some(reason) = DriverComplianceService::classify_error(&line) {
                        if !shutting_down.load(Ordering::SeqCst) {
                            warn!("检测到致命错误 ({:?}): {}", reason, line);
                            let binary_str = engine_clone.binary_path.to_string_lossy().to_string();
                            compliance
                                .mark_non_compliant(&binary_str, reason.clone(), None)
                                .await;

                            let proc_err = ProcessError {
                                kind: reason,
                                message: Self::friendly_error_message(&line),
                                raw: line.clone(),
                            };
                            let _ = tx.send(ProcessEvent::FatalError(proc_err));
                        }
                    }
                }
            });
        }

        let mut guard = self.child.lock().await;
        *guard = Some(child);

        {
            let mut status = self.status.lock().await;
            *status = ProcessStatus::Running;
        }

        info!("llama-server 子进程已启动");
        Ok(())
    }

    /// 生成用户友好的错误提示
    fn friendly_error_message(raw: &str) -> String {
        let lower = raw.to_lowercase();
        if lower.contains("cuda out of memory") || lower.contains("failed to allocate") {
            "显存不足（OOM），已自动降级到低算力引擎".to_string()
        } else if lower.contains("cuda error") || lower.contains("driver version insufficient") {
            "NVIDIA 驱动版本过低，建议更新驱动以启用 CUDA 加速".to_string()
        } else if lower.contains(".dll") || lower.contains("cannot find") {
            "缺少必要的运行库文件（DLL），引擎无法启动".to_string()
        } else if lower.contains("vulkan allocation failed") {
            "Vulkan 显存分配失败，已自动降级".to_string()
        } else {
            format!("引擎启动异常: {}", &raw[..raw.len().min(120)])
        }
    }

    /// 等待 llama-server 就绪（健康检测端口可达）
    pub async fn wait_ready(&self, port: u16, timeout_secs: u64) -> Result<()> {
        let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);

        loop {
            if std::time::Instant::now() > deadline {
                return Err(anyhow!(
                    "llama-server 启动超时（{}秒），端口 {} 不可达",
                    timeout_secs, port
                ));
            }

            // 轻量 TCP 探测
            match tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port)).await {
                Ok(_) => {
                    info!("llama-server 端口 {} 已可达", port);
                    return Ok(());
                }
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
    }

    /// 获取当前状态
    pub async fn status(&self) -> ProcessStatus {
        self.status.lock().await.clone()
    }

    /// 停止子进程（强制终止，确保完全释放 GPU 显存）
    pub async fn stop(&self) -> Result<()> {
        self.shutting_down.store(true, Ordering::SeqCst);

        let mut guard = self.child.lock().await;
        if let Some(mut child) = guard.take() {
            info!("正在终止 llama-server 子进程...");

            // 先尝试优雅终止
            #[cfg(windows)]
            {
                // Windows：直接 kill（无 SIGTERM）
                let _ = child.kill().await;
            }
            #[cfg(not(windows))]
            {
                use tokio::signal::unix::{SignalKind, signal};
                let pid = child.id().unwrap_or(0);
                if pid > 0 {
                    unsafe {
                        libc::kill(pid as i32, libc::SIGTERM);
                    }
                    // 等待 3 秒优雅退出
                    tokio::select! {
                        _ = child.wait() => {},
                        _ = tokio::time::sleep(Duration::from_secs(3)) => {
                            warn!("优雅终止超时，强制 kill");
                            let _ = child.kill().await;
                        }
                    }
                } else {
                    let _ = child.kill().await;
                }
            }

            // 等待进程退出
            let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;

            info!("llama-server 子进程已终止，GPU 显存已释放");
        }

        {
            let mut status = self.status.lock().await;
            *status = ProcessStatus::Stopped;
        }

        Ok(())
    }

    /// 检查进程是否仍在运行
    pub async fn is_running(&self) -> bool {
        let mut guard = self.child.lock().await;
        if let Some(ref mut child) = *guard {
            match child.try_wait() {
                Ok(None) => true,  // 还在运行
                Ok(Some(_)) | Err(_) => false,
            }
        } else {
            false
        }
    }
}

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        // 确保进程不会成为僵尸进程
        // 通过 tokio::spawn 在单独任务中终止
        if let Ok(mut child_guard) = self.child.try_lock() {
            if let Some(mut child) = child_guard.take() {
                std::thread::spawn(move || {
                    let _ = child.start_kill();
                });
            }
        }
    }
}
