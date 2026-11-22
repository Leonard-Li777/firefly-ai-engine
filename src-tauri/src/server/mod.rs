// server/mod.rs
// Axum HTTP 服务器：管理端点 + 反向代理
// 端口：38400~38419 bind-first 原子滑动

pub mod api;
pub mod custom_model;
pub mod proxy;

use anyhow::Result;
use axum::{
    Router,
    routing::any,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::{debug, info, warn};

use crate::config::bind_first_available_port;
use crate::engine::EngineCoordinator;

use self::api::{management_routes, resolve_model_downloader, AppState};
use self::proxy::{ProxyState, proxy_handler};

/// 默认网关端口滑动范围长度（38400..=38419 共 20 个端口）
pub const ENGINE_PORT_RANGE: u16 = 20;

/// Windows 文件锁重命名退避序列（毫秒）
const RENAME_BACKOFF_MS: [u64; 5] = [20, 40, 80, 160, 320];

/// 实例级服务发现文件契约（`ServiceDiscoveryFileV1`）
/// 落盘路径：`<user_data_dir>/run/engine-config.json`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDiscoveryFileV1 {
    pub schema_version: u32,
    pub service: String,
    pub instance_id: String,
    pub revision: u64,
    pub host: String,
    pub port: u16,
    pub base_url: String,
    pub pid: u32,
    pub started_at: String,
    pub user_data_dir: String,
    pub capabilities: Vec<String>,
}

impl ServiceDiscoveryFileV1 {
    /// 构造标准 `firefly-engine-bridge` 发现文件载荷
    pub fn new_engine(
        port: u16,
        pid: u32,
        instance_id: String,
        revision: u64,
        user_data_dir: String,
    ) -> Self {
        Self {
            schema_version: 1,
            service: "firefly-engine-bridge".to_string(),
            instance_id,
            revision,
            host: "127.0.0.1".to_string(),
            port,
            base_url: format!("http://127.0.0.1:{}", port),
            pid,
            started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            user_data_dir,
            capabilities: Vec::new(),
        }
    }
}

/// 返回发现文件权威路径：`<user_data_dir>/run/engine-config.json`
pub fn discovery_file_path(user_data_dir: &Path) -> PathBuf {
    user_data_dir.join("run").join("engine-config.json")
}

/// 原子写入服务发现文件：
/// 1. `create_dir_all(<user_data_dir>/run)`；
/// 2. 写入同目录临时文件 `engine-config.json.tmp.<pid>`；
/// 3. 带 Windows 锁退避 `[20, 40, 80, 160, 320]ms` 执行 `std::fs::rename` 原子替换；
/// 失败时清理残留临时文件并记录 `tracing::warn!`。
pub fn write_discovery_file_atomic(
    user_data_dir: &Path,
    payload: &ServiceDiscoveryFileV1,
) -> Result<PathBuf> {
    if user_data_dir.as_os_str().is_empty() {
        anyhow::bail!("user_data_dir 为空，跳过写入服务发现文件");
    }

    let target_path = discovery_file_path(user_data_dir);
    let run_dir = target_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("无法解析发现文件父目录: {:?}", target_path))?;

    std::fs::create_dir_all(run_dir)?;

    let tmp_path = run_dir.join(format!("engine-config.json.tmp.{}", payload.pid));
    let json_bytes = serde_json::to_vec_pretty(payload)?;
    std::fs::write(&tmp_path, json_bytes)?;

    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..=RENAME_BACKOFF_MS.len() {
        match std::fs::rename(&tmp_path, &target_path) {
            Ok(()) => {
                debug!("服务发现文件已原子写入: {:?}", target_path);
                return Ok(target_path);
            }
            Err(e) => {
                last_err = Some(e);
                if let Some(&delay_ms) = RENAME_BACKOFF_MS.get(attempt) {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                }
            }
        }
    }

    let _ = std::fs::remove_file(&tmp_path);
    let err_msg = last_err
        .map(|e| e.to_string())
        .unwrap_or_else(|| "unknown rename error".to_string());
    warn!(
        "原子写入服务发现文件失败（已重试 {} 次）: target={:?}, err={}",
        RENAME_BACKOFF_MS.len(),
        target_path,
        err_msg
    );
    Err(anyhow::anyhow!(
        "原子替换服务发现文件失败 {:?}: {}",
        target_path,
        err_msg
    ))
}

/// 退出自清理：仅当 `<user_data_dir>/run/engine-config.json` 存在且文件内 `pid == expected_pid` 时删除。
/// 防止误删随后新启动实例写出的发现文件。
pub fn remove_discovery_file_if_owned(user_data_dir: &Path, expected_pid: u32) -> bool {
    if user_data_dir.as_os_str().is_empty() {
        return false;
    }

    let target_path = discovery_file_path(user_data_dir);
    let content = match std::fs::read_to_string(&target_path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
        Err(e) => {
            warn!("读取服务发现文件用于退出自清理失败 {:?}: {}", target_path, e);
            return false;
        }
    };

    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            warn!("解析服务发现文件 JSON 失败，跳过自删 {:?}: {}", target_path, e);
            return false;
        }
    };

    let file_pid = parsed.get("pid").and_then(|v| v.as_u64());
    if file_pid != Some(expected_pid as u64) {
        debug!(
            "服务发现文件 pid({:?}) != 当前进程 pid({})，跳过自删: {:?}",
            file_pid, expected_pid, target_path
        );
        return false;
    }

    match std::fs::remove_file(&target_path) {
        Ok(()) => {
            debug!("已自删当前实例服务发现文件: {:?}", target_path);
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => {
            warn!("删除服务发现文件失败 {:?}: {}", target_path, e);
            false
        }
    }
}

/// 启动 Axum HTTP 服务
/// 返回实际绑定的端口
/// app_handle：用于 open-ui 显示主窗口并向前端 emit 导航意图
pub async fn start_server(
    base_port: u16,
    coordinator: Arc<EngineCoordinator>,
    proxy_state: ProxyState,
    app_handle: Option<tauri::AppHandle>,
) -> Result<u16> {
    // 1. bind-first 原子滑动绑定（38400..=38419），彻底消除探测-绑定 TOCTOU
    let (listener, port) = bind_first_available_port(base_port, ENGINE_PORT_RANGE).await?;
    let addr = listener.local_addr()?;

    // 立即记录实际绑定的端口，确保 IPC 与首帧状态在 serve 阻塞前就能返回该端口
    *coordinator.active_port.lock().await = Some(port);
    *coordinator.app_handle.lock().await = app_handle.clone();
    proxy_state.set_coordinator(coordinator.clone()).await;

    // 初始化下载任务管理器与活跃进程 PID 表
    let download_tasks = Arc::new(Mutex::new(HashMap::new()));
    let active_child_pids = Arc::new(Mutex::new(HashMap::new()));

    // 查找 llama-model-download 可执行文件路径（仅在安装目录与用户数据目录内查找）
    let model_downloader_path = Arc::new(resolve_model_downloader(&coordinator.install_bin_dirs));
    debug!("llama-model-download 路径: {:?}", model_downloader_path);

    // 模型元数据目录（generate:dims 权威落点：build/extraResources/model）
    let model_meta_dirs = Arc::new(crate::resource_scope::allowed_install_model_meta_dirs(None));
    debug!("模型元数据目录: {:?}", model_meta_dirs);

    let app_state = AppState {
        coordinator: coordinator.clone(),
        download_tasks,
        active_child_pids,
        model_downloader_path,
        model_meta_dirs,
        app_handle,
        // 待消费的 UI 导航意图：open-ui 写入、前端挂载后补偿消费
        ui_intent: Arc::new(Mutex::new(None)),
    };

    // CORS 配置（允许主程序前端跨域调用）
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // 合并路由：管理端点 + 反代
    let app = Router::new()
        // 管理端点
        .merge(management_routes().with_state(app_state))
        // 透明反代 /v1/*
        .route("/v1/{*path}", any(proxy_handler).with_state(proxy_state.clone()))
        // 注意：严禁在此硬编码静态 /health 返回 "ok"，
        // 必须让 /health 走 fallback 转发给底层 llama-server 探活，
        // 当模型仍在加载时（target_port 为 None 或 llama-server 报告 503）真实反映未就绪状态
        // 兜底：其余所有路径（/、/health、/index.html 等 llama-server WebUI 资源）
        // 全部转发给内部 llama-server，使网关端口即可直接访问聊天 WebUI 与真实探活端点
        .fallback(any(proxy_handler).with_state(proxy_state.clone()))
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    // 2. 双通道发布通道 1：第一时间向 stdout 输出 FIREFLY_READY 快路径并 flush
    let pid = std::process::id();
    println!(
        "FIREFLY_READY:{{\"port\":{},\"pid\":{},\"instanceId\":\"{}\"}}",
        port, pid, coordinator.instance_id
    );
    let _ = std::io::stdout().flush();

    // 3. 双通道发布通道 2：原子写入 <user_data_dir>/run/engine-config.json
    if !coordinator.user_data_dir.is_empty() {
        let payload = ServiceDiscoveryFileV1::new_engine(
            port,
            pid,
            coordinator.instance_id.clone(),
            coordinator.current_revision(),
            coordinator.user_data_dir.clone(),
        );
        if let Err(e) = write_discovery_file_atomic(Path::new(&coordinator.user_data_dir), &payload) {
            warn!("服务发现文件写入失败（不影响 HTTP 服务运行）: {}", e);
        }
    }

    info!("Firefly AI Engine HTTP 服务已启动: http://{}", addr);

    // 4. 优雅停机：监听 coordinator.shutdown_tx，停机时 SSE 流主动断流使 serve <500ms 退出
    let mut shutdown_rx = coordinator.subscribe_shutdown();
    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            if *shutdown_rx.borrow() {
                return;
            }
            while shutdown_rx.changed().await.is_ok() {
                if *shutdown_rx.borrow() {
                    break;
                }
            }
        })
        .await;

    // 5. serve 退出后按 pid 校验自删发现文件
    if !coordinator.user_data_dir.is_empty() {
        remove_discovery_file_if_owned(Path::new(&coordinator.user_data_dir), pid);
    }

    serve_result?;
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{bind_first_available_port, EngineConfig};
    use crate::engine::{resolve_user_data_dir_with, EngineCoordinator, HardwareSummary};
    use crate::hardware::{DriverComplianceService, HardwareDetector};
    use futures::StreamExt;
    use std::time::Instant;

    /// 构造带缓存硬件摘要的测试用 `EngineCoordinator`（避免单测拉起外部 fastfetch 进程）
    async fn make_test_coordinator(user_data_dir: &Path) -> Arc<EngineCoordinator> {
        let mut cfg = EngineConfig::default();
        cfg.data_dir = user_data_dir.to_path_buf();
        cfg.models_dir = user_data_dir.join("models");

        let hardware = Arc::new(HardwareDetector::new(Vec::new()));
        let compliance = DriverComplianceService::new();
        let proxy_state = ProxyState::new();
        let coordinator = EngineCoordinator::new_with_log_dir(
            hardware,
            compliance,
            Vec::new(),
            Arc::new(Mutex::new(cfg)),
            proxy_state,
            None,
        );

        // 预热硬件缓存，确保 get_status() 在毫秒级纯内存返回
        *coordinator.hardware_cache.lock().await = Some((
            Instant::now(),
            HardwareSummary {
                gpu_name: "Test GPU".to_string(),
                total_vram_gb: 8.0,
                used_vram_gb: None,
                best_tier: "cpu".to_string(),
                current_tier: "cpu".to_string(),
                is_integrated: false,
                cpu_cores: Some(4),
                cpu_threads: Some(8),
                os_platform: Some("windows".to_string()),
                total_ram_gb: Some(16.0),
                used_ram_gb: Some(4.0),
                has_avx2: Some(true),
                has_avx: Some(true),
            },
        ));
        coordinator
    }

    #[tokio::test]
    async fn test_bind_first_available_port_concurrent_contention() {
        // 先找一段起始空闲端口（使用高位临时段避免与本机服务冲突）
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_port = probe.local_addr().unwrap().port();
        // 保持 probe 占用 base_port，验证 bind_first_available_port 自动顺延
        let (l1, p1) = bind_first_available_port(base_port, 10)
            .await
            .expect("应自动顺延至后续空闲端口");
        assert!(p1 > base_port, "首端口被占时应顺延到更大端口");

        // 并发竞争：两个任务同时向同一范围发起 bind-first，应拿到互不冲突的端口
        let fut_a = bind_first_available_port(base_port, 10);
        let fut_b = bind_first_available_port(base_port, 10);
        let (res_a, res_b) = tokio::join!(fut_a, fut_b);
        let (_la, pa) = res_a.expect("并发任务 A 绑定应成功");
        let (_lb, pb) = res_b.expect("并发任务 B 绑定应成功");
        assert_ne!(pa, pb, "并发 bind-first 绝不能返回相同端口");
        assert_ne!(pa, p1);
        assert_ne!(pb, p1);

        // 单端口已被占且 range=1 时应返回 Err
        let exhausted = bind_first_available_port(base_port, 1).await;
        assert!(exhausted.is_err(), "范围占满时必须返回错误");

        drop(l1);
        drop(probe);
    }

    #[test]
    fn test_discovery_file_atomic_write_and_pid_gated_remove() {
        let tmp = tempfile::tempdir().expect("创建临时目录失败");
        let user_data_dir = tmp.path();
        let my_pid = std::process::id();

        let payload = ServiceDiscoveryFileV1::new_engine(
            38405,
            my_pid,
            "11111111-2222-4333-8444-555555555555".to_string(),
            7,
            user_data_dir.to_string_lossy().to_string(),
        );

        let written_path = write_discovery_file_atomic(user_data_dir, &payload)
            .expect("原子写入发现文件应成功");
        assert_eq!(written_path, discovery_file_path(user_data_dir));
        assert!(written_path.exists());

        // 确认无残留 .tmp 文件
        let tmp_file = user_data_dir
            .join("run")
            .join(format!("engine-config.json.tmp.{}", my_pid));
        assert!(!tmp_file.exists(), "rename 成功后不应残留 .tmp.<pid> 文件");

        // 反序列化校验字段完整性与 camelCase 规范
        let raw = std::fs::read_to_string(&written_path).unwrap();
        let val: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(val["schemaVersion"], 1);
        assert_eq!(val["service"], "firefly-engine-bridge");
        assert_eq!(val["instanceId"], "11111111-2222-4333-8444-555555555555");
        assert_eq!(val["revision"], 7);
        assert_eq!(val["host"], "127.0.0.1");
        assert_eq!(val["port"], 38405);
        assert_eq!(val["baseUrl"], "http://127.0.0.1:38405");
        assert_eq!(val["pid"], my_pid);
        assert_eq!(val["userDataDir"], user_data_dir.to_string_lossy().as_ref());

        // 非己方 pid 严禁误删
        let other_pid = my_pid.wrapping_add(1).max(1);
        assert!(
            !remove_discovery_file_if_owned(user_data_dir, other_pid),
            "pid 不匹配时不得删除发现文件"
        );
        assert!(written_path.exists());

        // 己方 pid 校验通过后执行自删
        assert!(
            remove_discovery_file_if_owned(user_data_dir, my_pid),
            "pid 匹配时应成功自删发现文件"
        );
        assert!(!written_path.exists());
    }

    #[test]
    fn test_resolve_user_data_dir_precedence() {
        let fallback = Path::new("C:\\fallback\\engine");
        let args = vec![
            "firefly-ai-engine".to_string(),
            "--discovery-dir".to_string(),
            "C:\\cli\\dir".to_string(),
        ];

        // 1. 环境变量最高优先
        assert_eq!(
            resolve_user_data_dir_with(Some("C:\\env\\dir".to_string()), &args, fallback),
            "C:\\env\\dir"
        );
        // 2. 环境变量缺失或空白时回落 --discovery-dir
        assert_eq!(
            resolve_user_data_dir_with(Some("   ".to_string()), &args, fallback),
            "C:\\cli\\dir"
        );
        // 支持 --discovery-dir=<path> 形式
        let args_eq = vec!["--discovery-dir=C:\\cli\\eq".to_string()];
        assert_eq!(
            resolve_user_data_dir_with(None, &args_eq, fallback),
            "C:\\cli\\eq"
        );
        // 3. 均缺失时回落引擎自身 data_dir
        assert_eq!(
            resolve_user_data_dir_with(None, &[], fallback),
            "C:\\fallback\\engine"
        );
    }

    #[tokio::test]
    async fn test_sse_stream_lagged_recovery_and_shutdown_termination() {
        let tmp = tempfile::tempdir().expect("创建临时目录失败");
        let coordinator = make_test_coordinator(tmp.path()).await;
        *coordinator.active_port.lock().await = Some(38409);

        let stream = api::build_engine_status_json_stream(coordinator.clone()).await;
        futures::pin_mut!(stream);

        // 1. 首帧必须包含身份与初始 revision
        let first_raw = stream.next().await.expect("首帧不应为空");
        let first: serde_json::Value = serde_json::from_str(&first_raw).unwrap();
        assert_eq!(first["pid"], std::process::id());
        assert_eq!(first["instance_id"], coordinator.instance_id);
        assert_eq!(first["revision"], 1);
        assert_eq!(first["port"], 38409);

        // 2. 连续灌入 40 条广播（超过 channel 容量 32），强制触发 RecvError::Lagged
        for _ in 0..40 {
            coordinator.notify_status_changed().await;
        }
        let expected_latest_rev = coordinator.current_revision();
        assert!(expected_latest_rev >= 41);

        // 下一次拉取应因 Lagged 自动重新抓取最新权威快照并补发
        let recovered_raw = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
            .await
            .expect("Lagged 补发不应超时")
            .expect("Lagged 后必须补发最新权威快照");
        let recovered: serde_json::Value = serde_json::from_str(&recovered_raw).unwrap();
        assert_eq!(
            recovered["revision"], expected_latest_rev,
            "Lagged 后应补发最新权威 revision 快照"
        );

        // 3. 触发优雅停机信号：必须在 <500ms 内下发 status="stopping" 终帧并立即闭合流返回 None
        let t0 = Instant::now();
        coordinator.trigger_shutdown();

        let stopping_raw = tokio::time::timeout(std::time::Duration::from_millis(500), stream.next())
            .await
            .expect("停机终帧必须在 500ms 内送达")
            .expect("停机前必须下发 stopping 终帧");
        let stopping: serde_json::Value = serde_json::from_str(&stopping_raw).unwrap();
        assert_eq!(stopping["status"], "stopping");

        let end = tokio::time::timeout(std::time::Duration::from_millis(500), stream.next())
            .await
            .expect("停机终帧后流必须在 500ms 内闭合");
        assert!(end.is_none(), "下发 stopping 终帧后必须立即返回 None 结束流");
        assert!(
            t0.elapsed() < std::time::Duration::from_millis(500),
            "SSE 停机断流总耗时必须 <500ms，实际 {:?}",
            t0.elapsed()
        );
    }

    #[tokio::test]
    async fn test_start_server_graceful_shutdown_under_500ms_and_cleans_discovery_file() {
        let tmp = tempfile::tempdir().expect("创建临时目录失败");
        let coordinator = make_test_coordinator(tmp.path()).await;
        let proxy_state = coordinator.proxy_state.clone();

        // 选一个空闲临时端口作为 base_port
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let free_port = probe.local_addr().unwrap().port();
        drop(probe);

        let coord_for_server = coordinator.clone();
        let server_task = tokio::spawn(async move {
            start_server(free_port, coord_for_server, proxy_state, None).await
        });

        // 等待发现文件落地（证明 bind-first + 发现文件写入已完成）
        let disc_path = discovery_file_path(Path::new(&coordinator.user_data_dir));
        let wait_deadline = Instant::now() + std::time::Duration::from_secs(3);
        while !disc_path.exists() {
            assert!(Instant::now() < wait_deadline, "等待发现文件写入超时");
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(disc_path.exists());

        // 建立一条真实 SSE HTTP 连接模拟 Desktop 长期挂载
        let bound_port = coordinator.active_port.lock().await.expect("active_port 应已赋值");
        let client = reqwest::Client::new();
        let sse_resp = client
            .get(format!("http://127.0.0.1:{}/api/engine/events", bound_port))
            .send()
            .await
            .expect("连接真实 SSE 端点应成功");
        assert_eq!(sse_resp.status(), reqwest::StatusCode::OK);

        // 触发停机，断言即便有活跃 SSE 连接，axum::serve 也能在 <500ms 内优雅退出并自删发现文件
        let t0 = Instant::now();
        coordinator.trigger_shutdown();

        let serve_res = tokio::time::timeout(std::time::Duration::from_millis(500), server_task)
            .await
            .expect("触发 shutdown 后 axum::serve 必须在 500ms 内退出")
            .expect("server task 不应 panic")
            .expect("start_server 应正常返回 Ok");

        assert_eq!(serve_res, bound_port);
        assert!(
            t0.elapsed() < std::time::Duration::from_millis(500),
            "优雅停机耗时应 <500ms，实际 {:?}",
            t0.elapsed()
        );
        assert!(!disc_path.exists(), "优雅停机后应按 pid 自动删除发现文件");

        // 消费完 SSE 响应体，确认包含 stopping 终帧
        let body = sse_resp.text().await.unwrap_or_default();
        assert!(
            body.contains("\"stopping\""),
            "SSE 流应包含 stopping 终帧，实际响应: {}",
            body
        );
    }
}
