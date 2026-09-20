// server/proxy.rs
// 透明反向代理：/v1/* → llama-server 实际端口

use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderValue, StatusCode, Uri},
    response::Response,
};
use bytes::Bytes;
use hyper::body::Incoming;
use reqwest::Client;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, warn};

/// 代理状态（目标端口可动态变化）
#[derive(Clone)]
pub struct ProxyState {
    pub target_port: Arc<Mutex<Option<u16>>>,
    pub client: Client,
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
        }
    }

    pub async fn set_target_port(&self, port: u16) {
        let mut guard = self.target_port.lock().await;
        *guard = Some(port);
        tracing::info!("反向代理目标端口更新: {}", port);
    }
}

/// 代理 handler：将所有 /v1/* 请求转发到 llama-server
pub async fn proxy_handler(
    State(state): State<ProxyState>,
    req: Request<Body>,
) -> Response<Body> {
    let target_port = {
        let guard = state.target_port.lock().await;
        *guard
    };

    let Some(port) = target_port else {
        warn!("llama-server 尚未就绪，反代请求被拒绝");
        return Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"message":"AI engine is starting, please try again","code":503}}"#,
            ))
            .unwrap();
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
        // 流式透传
        let stream = resp.bytes_stream();
        use futures::StreamExt;
        let body = Body::from_stream(stream.map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))));
        builder.body(body).unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::empty())
                .unwrap()
        })
    } else {
        // 普通响应
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
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(format!(
            r#"{{"error":{{"message":"{}","code":{}}}}}"#,
            msg,
            status.as_u16()
        )))
        .unwrap()
}
