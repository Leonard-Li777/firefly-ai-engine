// server/proxy.rs
// 透明反向代理：/v1/* → llama-server 实际端口

use axum::{
    body::Body,
    extract::{Request, State},
    http::StatusCode,
    response::Response,
};
use reqwest::Client;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, warn};

use crate::engine::process_guard::ProcessStatus;

/// 代理状态（目标端口可动态变化）
#[derive(Clone)]
pub struct ProxyState {
    pub target_port: Arc<Mutex<Option<u16>>>,
    pub client: Client,
    pub coordinator: Arc<Mutex<Option<Arc<crate::engine::EngineCoordinator>>>>,
}

impl ProxyState {
    pub fn new() -> Self {
        let client = reqwest::ClientBuilder::new()
            .timeout(std::time::Duration::from_secs(300)) // AI 推理可能耗时较长
            .no_proxy()
            .build()
            .unwrap();

        ProxyState {
            target_port: Arc::new(Mutex::new(None)),
            client,
            coordinator: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn set_target_port(&self, port: u16) {
        let mut guard = self.target_port.lock().await;
        *guard = Some(port);
        tracing::info!("反向代理目标端口更新: {}", port);
    }

    pub async fn set_coordinator(&self, coordinator: Arc<crate::engine::EngineCoordinator>) {
        let mut guard = self.coordinator.lock().await;
        *guard = Some(coordinator);
    }
}

/// 流包装器：持有生命周期 Guard 直至流完全消费结束或连接断开析构
struct GuardedStream<S, G> {
    inner: S,
    _guard: Option<G>,
}

impl<S: futures::Stream + Unpin, G: Send + Unpin + 'static> futures::Stream for GuardedStream<S, G> {
    type Item = S::Item;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        let this = self.get_mut();
        std::pin::Pin::new(&mut this.inner).poll_next(cx)
    }
}

/// 判断当前反代请求是否为真正的 AI 模型推理/计算工作请求。
/// 静态网页、样式、脚本、模型列表与探活路由不应触发 active_requests 计数。
fn is_inference_request(path: &str) -> bool {
    let p = path.trim_start_matches('/');
    // 排除已知只读探活与静态资源
    if p.is_empty()
        || p == "index.html"
        || p == "favicon.ico"
        || p == "props"
        || p == "slots"
        || p == "health"
        || p.starts_with("v1/models")
        || p.ends_with(".js")
        || p.ends_with(".css")
        || p.ends_with(".ico")
        || p.ends_with(".png")
        || p.ends_with(".svg")
        || p.ends_with(".wasm")
    {
        return false;
    }

    // 命中 AI 核心推理与计算端点
    p.starts_with("v1/chat/completions")
        || p.starts_with("v1/completions")
        || p.starts_with("v1/embeddings")
        || p.starts_with("v1/rerank")
        || p.starts_with("v1/audio")
        || p.starts_with("v1/images")
        || p.starts_with("v1/x-firefly")
        || p.starts_with("completion")
        || p.starts_with("tokenize")
        || p.starts_with("detokenize")
        || p.starts_with("embedding")
        || p.starts_with("infill")
}

/// 代理端点在无法转发时的结构化拒绝原因与上下文
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RejectionReason {
    /// 宿主在线但推理服务未启动（向后兼容存量 stopped 语义）
    #[serde(rename = "engine_service_stopped")]
    ServiceStopped,
    /// 模型加载/服务启动中（正常启动窗口内，带可选截止时间）
    #[serde(rename = "engine_starting")]
    Starting {
        #[serde(skip_serializing_if = "Option::is_none")]
        deadline_ms: Option<u64>,
    },
    /// 服务启动超出硬性时间预算
    #[serde(rename = "startup_timeout")]
    StartupTimeout,
    /// 显存换入中 / 队列排队（附带 Retry-After、预估剩余毫秒数、队列位置）
    #[serde(rename = "engine_swapping")]
    Swapping {
        retry_after_secs: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        eta_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        queue_position: Option<usize>,
    },
    /// 确定性失败（子进程崩溃、驱动 Access Violation 等永久性错误）
    #[serde(rename = "engine_failed")]
    Failed {
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// 可用显存与物理内存均不足以支撑运行
    #[serde(rename = "insufficient_memory")]
    InsufficientMemory,
    /// 全硬件后端冒烟均失败，无可用加速硬件
    #[serde(rename = "no_viable_backend")]
    NoViableBackend,
    /// 排队队列超限
    #[serde(rename = "queue_full")]
    QueueFull {
        retry_after_secs: u32,
    },
}

impl RejectionReason {
    /// 返回对应的 HTTP 状态码
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::ServiceStopped => StatusCode::SERVICE_UNAVAILABLE,
            Self::Starting { .. } => StatusCode::SERVICE_UNAVAILABLE,
            Self::Swapping { .. } => StatusCode::SERVICE_UNAVAILABLE,
            Self::QueueFull { .. } => StatusCode::TOO_MANY_REQUESTS,
            Self::StartupTimeout
            | Self::Failed { .. }
            | Self::InsufficientMemory
            | Self::NoViableBackend => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// 统一错误码与类型标识符（保持 code 与 type 字符串恒等，对齐 OpenAI 规范并兼容旧客户端）
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::ServiceStopped => "engine_service_stopped",
            Self::Starting { .. } => "engine_starting",
            Self::StartupTimeout => "startup_timeout",
            Self::Swapping { .. } => "engine_swapping",
            Self::Failed { .. } => "engine_failed",
            Self::InsufficientMemory => "insufficient_memory",
            Self::NoViableBackend => "no_viable_backend",
            Self::QueueFull { .. } => "queue_full",
        }
    }

    /// 默认人类可读提示文案
    pub fn default_message(&self) -> String {
        match self {
            Self::ServiceStopped => "AI engine service is not started".to_string(),
            Self::Starting { .. } => "AI engine is starting, please try again".to_string(),
            Self::StartupTimeout => "AI engine startup timed out, check engine logs".to_string(),
            Self::Swapping { .. } => "AI engine is swapping models, please retry shortly".to_string(),
            Self::Failed { message } => message
                .clone()
                .unwrap_or_else(|| "AI engine failed to start, check engine logs".to_string()),
            Self::InsufficientMemory => "Insufficient GPU or system memory to run engine".to_string(),
            Self::NoViableBackend => "No viable hardware acceleration backend passed smoke test".to_string(),
            Self::QueueFull { .. } => "Engine request queue is full, please retry shortly".to_string(),
        }
    }

    /// 是否为瞬态错误（客户端可安全自动重试；反之必须上浮中断轮询）
    pub fn is_transient(&self) -> bool {
        matches!(self, Self::Starting { .. } | Self::Swapping { .. } | Self::QueueFull { .. })
    }

    /// 重试建议时间（秒）
    pub fn retry_after(&self) -> Option<u32> {
        match self {
            Self::Swapping { retry_after_secs, .. } => Some(*retry_after_secs),
            Self::QueueFull { retry_after_secs } => Some(*retry_after_secs),
            _ => None,
        }
    }
}

impl From<Option<&ProcessStatus>> for RejectionReason {
    fn from(status: Option<&ProcessStatus>) -> Self {
        match status {
            Some(ProcessStatus::Stopped) => RejectionReason::ServiceStopped,
            Some(ProcessStatus::Failed) => RejectionReason::Failed { message: None },
            Some(ProcessStatus::Starting) | Some(ProcessStatus::Running) | None => {
                RejectionReason::Starting { deadline_ms: None }
            }
        }
    }
}

/// 构建符合 OpenAI 规范与向下兼容双字段（code + type 保持一致）的标准拒绝响应
pub fn build_rejection_response(reason: &RejectionReason) -> Response<Body> {
    let status = reason.status_code();
    let code = reason.error_code();
    let message = reason.default_message();

    let mut error_obj = serde_json::json!({
        "message": message,
        "type": code,
        "code": code,
    });

    if let serde_json::Value::Object(ref mut map) = error_obj {
        match reason {
            RejectionReason::Starting { deadline_ms: Some(dl) } => {
                map.insert("deadline_ms".to_string(), serde_json::json!(dl));
            }
            RejectionReason::Swapping { eta_ms, queue_position, .. } => {
                if let Some(eta) = eta_ms {
                    map.insert("eta_ms".to_string(), serde_json::json!(eta));
                }
                if let Some(pos) = queue_position {
                    map.insert("queue_position".to_string(), serde_json::json!(pos));
                }
            }
            _ => {}
        }
    }

    let body_json = serde_json::json!({ "error": error_obj }).to_string();

    let mut builder = Response::builder()
        .status(status)
        .header("content-type", "application/json");

    if let Some(retry_after) = reason.retry_after() {
        builder = builder.header("retry-after", retry_after.to_string());
    }

    builder.body(Body::from(body_json)).unwrap()
}

/// 向后兼容的快速三元组推断（保留给既有调用方或测试）
pub fn rejection(status: Option<&ProcessStatus>) -> (StatusCode, &'static str, &'static str) {
    match status {
        Some(ProcessStatus::Stopped) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "AI engine service is not started",
            "engine_service_stopped",
        ),
        Some(ProcessStatus::Failed) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "AI engine failed to start, check engine logs",
            "engine_failed",
        ),
        Some(ProcessStatus::Starting) | Some(ProcessStatus::Running) | None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "AI engine is starting, please try again",
            "engine_starting",
        ),
    }
}

/// 判断当前请求是否声明接收或产生 Server-Sent Events (SSE) 流式响应
pub fn is_sse_request(headers: &axum::http::HeaderMap, body: &[u8]) -> bool {
    if let Some(accept) = headers.get("accept").and_then(|v| v.to_str().ok()) {
        if accept.contains("text/event-stream") {
            return true;
        }
    }

    if let Ok(json_val) = serde_json::from_slice::<serde_json::Value>(body) {
        if json_val.get("stream").and_then(|v| v.as_bool()) == Some(true) {
            return true;
        }
    }

    false
}

/// 构造一个周期性发送 `: keep-alive\n\n` SSE 注释帧的流，用于流式请求等待排队换入时防止连接断开
pub fn create_sse_keepalive_stream(
    interval: std::time::Duration,
) -> impl futures::Stream<Item = Result<axum::body::Bytes, std::convert::Infallible>> {
    futures::stream::unfold((), move |_| async move {
        tokio::time::sleep(interval).await;
        Some((Ok(axum::body::Bytes::from_static(b": keep-alive\n\n")), ()))
    })
}

/// 代理 handler：将所有 /v1/* 与 WebUI 请求转发到 llama-server
pub async fn proxy_handler(
    State(state): State<ProxyState>,
    req: Request<Body>,
) -> Response<Body> {
    let req_path = req.uri().path().to_string();
    let _request_guard = if is_inference_request(&req_path) {
        let coordinator = {
            let guard = state.coordinator.lock().await;
            guard.clone()
        };
        coordinator.as_ref().map(|c| c.begin_request())
    } else {
        None
    };

    let target_port = {
        let guard = state.target_port.lock().await;
        *guard
    };

    let Some(port) = target_port else {
        // 宿主进程可能活着但推理服务从未启动：按真实状态分流，禁止一律谎报 "starting"
        let coordinator = {
            let guard = state.coordinator.lock().await;
            guard.clone()
        };
        let proc_status = match coordinator {
            Some(c) => Some(c.guard.status().await),
            None => None,
        };
        let reason = RejectionReason::from(proc_status.as_ref());
        warn!(
            "推理服务尚未就绪，反代请求被拒绝: proc_status={:?}, reason={:?}",
            proc_status, reason
        );
        return build_rejection_response(&reason);
    };

    // 构建目标 URL
    let uri = req.uri();
    let path_and_query = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
    let target_url = format!("http://127.0.0.1:{}{}", port, path_and_query);

    debug!("代理请求: {} {}", req.method(), target_url);

    // 构建代理请求
    let method = req.method().clone();
    let headers = req.headers().clone();

    // 读取请求体
    let body_bytes = match axum::body::to_bytes(req.into_body(), 1024 * 1024 * 100).await {
        Ok(b) => b,
        Err(e) => {
            warn!("读取请求体失败: {}", e);
            return error_response(StatusCode::BAD_REQUEST, "Failed to read request body");
        }
    };

    // 转发请求
    let mut proxy_req = state
        .client
        .request(reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap(), &target_url);

    // 透传请求头（排除 hop-by-hop 头）
    for (key, value) in &headers {
        let key_str = key.as_str().to_lowercase();
        if !matches!(
            key_str.as_str(),
            "host" | "connection" | "transfer-encoding" | "upgrade"
        ) {
            if let Ok(v) = value.to_str() {
                proxy_req = proxy_req.header(key.as_str(), v);
            }
        }
    }

    proxy_req = proxy_req.body(body_bytes);

    // 发送并获取响应
    let resp = match proxy_req.send().await {
        Ok(r) => r,
        Err(e) => {
            warn!("代理请求失败: {}", e);
            return error_response(
                StatusCode::BAD_GATEWAY,
                &format!("AI engine request failed: {}", e),
            );
        }
    };

    // 构建响应
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::OK);
    let mut builder = Response::builder().status(status);

    // 透传响应头
    for (key, value) in resp.headers() {
        let key_str = key.as_str().to_lowercase();
        if !matches!(key_str.as_str(), "connection" | "transfer-encoding") {
            builder = builder.header(key.as_str(), value.as_bytes());
        }
    }

    // 检查是否为流式响应（SSE / streaming）
    let is_stream = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.contains("text/event-stream") || ct.contains("application/x-ndjson"))
        .unwrap_or(false);

    if is_stream {
        // 流式透传：使用 GuardedStream 持有 _request_guard 直至整个数据流传输结束
        let stream = resp.bytes_stream();
        use futures::StreamExt;
        let mapped = stream.map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
        let guarded = GuardedStream {
            inner: Box::pin(mapped),
            _guard: _request_guard,
        };
        let body = Body::from_stream(guarded);
        builder.body(body).unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::empty())
                .unwrap()
        })
    } else {
        // 普通响应：body_bytes 读取完成并写入 Response，_request_guard 随函数正常返回而自动 drop
        let body_bytes = resp.bytes().await.unwrap_or_default();
        builder
            .body(Body::from(body_bytes))
            .unwrap_or_else(|_| {
                Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .body(Body::empty())
                    .unwrap()
            })
    }
}

fn error_response(status: StatusCode, msg: &str) -> Response<Body> {
    let code_str = match status {
        StatusCode::BAD_REQUEST => "bad_request",
        StatusCode::BAD_GATEWAY => "bad_gateway",
        StatusCode::SERVICE_UNAVAILABLE => "service_unavailable",
        _ => "internal_error",
    };
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({
                "error": {
                    "message": msg,
                    "type": code_str,
                    "code": code_str,
                }
            })
            .to_string(),
        ))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 四态映射必须精确：`Stopped` 不得谎报 starting，`Failed` 必须 500（否则被客户端判瞬态）
    #[test]
    fn rejection_maps_each_process_status() {
        let (status, message, code) = rejection(Some(&ProcessStatus::Stopped));
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(code, "engine_service_stopped");
        assert!(
            !message.contains("starting"),
            "「推理服务从未启动」不得谎报为「正在启动」，否则排查方向被引向 llama-server"
        );

        let (status, _, code) = rejection(Some(&ProcessStatus::Failed));
        assert_eq!(
            status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed 必须是 500：客户端按 status===503 无条件判瞬态，503 会让文件无限 pending 重试"
        );
        assert_eq!(code, "engine_failed");

        let (status, _, code) = rejection(Some(&ProcessStatus::Starting));
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(code, "engine_starting");

        let (status, _, code) = rejection(Some(&ProcessStatus::Running));
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(code, "engine_starting");

        // 协调器未注入（仅测试路径）：回退 starting，保持兼容
        let (status, _, code) = rejection(None);
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(code, "engine_starting");
    }
}
