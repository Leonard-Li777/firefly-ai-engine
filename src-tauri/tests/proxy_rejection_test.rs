// tests/proxy_rejection_test.rs
// Issue 01: 500/503 严格映射加固与反向代理拒绝契约测试

use axum::body::to_bytes;
use axum::http::{HeaderMap, StatusCode};
use firefly_ai_engine_lib::engine::process_guard::ProcessStatus;
use firefly_ai_engine_lib::server::proxy::{
    build_rejection_response, create_sse_keepalive_stream, is_sse_request, rejection,
    RejectionReason,
};
use futures::StreamExt;
use serde_json::Value;

#[tokio::test]
async fn test_ac2_failed_status_maps_strictly_to_500() {
    let reason = RejectionReason::Failed {
        message: Some("CUDA kernel execution error".to_string()),
    };
    assert_eq!(reason.status_code(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!reason.is_transient(), "Failed 绝对不能是瞬态错误");

    let response = build_rejection_response(&reason);
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(response.headers().get("retry-after").is_none());

    let body_bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let json: Value = serde_json::from_slice(&body_bytes).unwrap();

    assert_eq!(json["error"]["type"], "engine_failed");
    assert_eq!(json["error"]["code"], "engine_failed");
    assert_eq!(json["error"]["message"], "CUDA kernel execution error");
}

#[tokio::test]
async fn test_ac2_startup_timeout_maps_to_500() {
    let reason = RejectionReason::StartupTimeout;
    assert_eq!(reason.status_code(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!reason.is_transient());

    let response = build_rejection_response(&reason);
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);

    let body_bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let json: Value = serde_json::from_slice(&body_bytes).unwrap();

    assert_eq!(json["error"]["type"], "startup_timeout");
    assert_eq!(json["error"]["code"], "startup_timeout");
}

#[tokio::test]
async fn test_ac2_starting_status_maps_to_503_with_deadline() {
    let reason = RejectionReason::Starting {
        deadline_ms: Some(1730000000000),
    };
    assert_eq!(reason.status_code(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(reason.is_transient(), "Starting 是可重试的瞬态过程");

    let response = build_rejection_response(&reason);
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

    let body_bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let json: Value = serde_json::from_slice(&body_bytes).unwrap();

    assert_eq!(json["error"]["type"], "engine_starting");
    assert_eq!(json["error"]["code"], "engine_starting");
    assert_eq!(json["error"]["deadline_ms"], 1730000000000u64);
}

#[tokio::test]
async fn test_ac2_swapping_status_maps_to_503_with_retry_after_and_eta() {
    let reason = RejectionReason::Swapping {
        retry_after_secs: 3,
        eta_ms: Some(8500),
        queue_position: Some(1),
    };
    assert_eq!(reason.status_code(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(reason.is_transient());
    assert_eq!(reason.retry_after(), Some(3));

    let response = build_rejection_response(&reason);
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers().get("retry-after").unwrap(), "3");

    let body_bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let json: Value = serde_json::from_slice(&body_bytes).unwrap();

    assert_eq!(json["error"]["type"], "engine_swapping");
    assert_eq!(json["error"]["code"], "engine_swapping");
    assert_eq!(json["error"]["eta_ms"], 8500);
    assert_eq!(json["error"]["queue_position"], 1);
}

#[tokio::test]
async fn test_ac2_hardware_exhaustion_maps_to_500() {
    let reason_backend = RejectionReason::NoViableBackend;
    assert_eq!(reason_backend.status_code(), StatusCode::INTERNAL_SERVER_ERROR);
    let resp_backend = build_rejection_response(&reason_backend);
    assert_eq!(resp_backend.status(), StatusCode::INTERNAL_SERVER_ERROR);

    let reason_mem = RejectionReason::InsufficientMemory;
    assert_eq!(reason_mem.status_code(), StatusCode::INTERNAL_SERVER_ERROR);
    let resp_mem = build_rejection_response(&reason_mem);
    assert_eq!(resp_mem.status(), StatusCode::INTERNAL_SERVER_ERROR);

    let body_bytes = to_bytes(resp_mem.into_body(), 1024 * 1024).await.unwrap();
    let json: Value = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(json["error"]["type"], "insufficient_memory");
    assert_eq!(json["error"]["code"], "insufficient_memory");
}

#[tokio::test]
async fn test_ac2_queue_full_maps_to_429_with_retry_after() {
    let reason = RejectionReason::QueueFull { retry_after_secs: 5 };
    assert_eq!(reason.status_code(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(reason.retry_after(), Some(5));

    let response = build_rejection_response(&reason);
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers().get("retry-after").unwrap(), "5");

    let body_bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let json: Value = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(json["error"]["type"], "queue_full");
    assert_eq!(json["error"]["code"], "queue_full");
}

#[test]
fn test_ac2_legacy_rejection_backward_compatibility() {
    let (status, _msg, code) = rejection(Some(&ProcessStatus::Failed));
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(code, "engine_failed");

    let (status, _msg, code) = rejection(Some(&ProcessStatus::Stopped));
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(code, "engine_service_stopped");

    let (status, _, code) = rejection(Some(&ProcessStatus::Starting));
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(code, "engine_starting");
}

#[test]
fn test_ac1_is_sse_request_detection() {
    let mut headers = HeaderMap::new();
    headers.insert("accept", "text/event-stream".parse().unwrap());
    assert!(is_sse_request(&headers, b"{}"));

    let mut headers_json = HeaderMap::new();
    headers_json.insert("accept", "application/json".parse().unwrap());
    assert!(!is_sse_request(&headers_json, b"{\"stream\": false}"));
    assert!(is_sse_request(&headers_json, b"{\"stream\": true}"));
}

#[tokio::test]
async fn test_ac1_create_sse_keepalive_stream_emission() {
    let mut stream = Box::pin(create_sse_keepalive_stream(std::time::Duration::from_millis(10)));
    let first = stream.next().await.unwrap().unwrap();
    assert_eq!(first.as_ref(), b": keep-alive\n\n");
    let second = stream.next().await.unwrap().unwrap();
    assert_eq!(second.as_ref(), b": keep-alive\n\n");
}
