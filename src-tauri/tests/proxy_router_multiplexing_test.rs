// tests/proxy_router_multiplexing_test.rs
// Issue 04a: ProxyState 多路复用路由表抽象与能力分发架构测试

use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::{Request, StatusCode};
use firefly_ai_engine_lib::engine::process_guard::ProcessStatus;
use firefly_ai_engine_lib::server::proxy::{
    proxy_handler, Capability, ProxyState, WorkerSlot,
};
use serde_json::Value;

#[test]
fn test_ac1_capability_from_path_routing_rules() {
    // 语言能力
    assert_eq!(Capability::from_path("/v1/chat/completions"), Capability::Language);
    assert_eq!(Capability::from_path("/v1/completions"), Capability::Language);
    assert_eq!(Capability::from_path("/completion"), Capability::Language);
    assert_eq!(Capability::from_path("/tokenize"), Capability::Language);
    assert_eq!(Capability::from_path("/props"), Capability::Language);

    // 向量与重排能力
    assert_eq!(Capability::from_path("/v1/embeddings"), Capability::Embedding);
    assert_eq!(Capability::from_path("/v1/rerank"), Capability::Embedding);
    assert_eq!(Capability::from_path("/embedding"), Capability::Embedding);

    // 音频能力（标准与 x-firefly 扩展）
    assert_eq!(Capability::from_path("/v1/audio/transcriptions"), Capability::Audio);
    assert_eq!(Capability::from_path("/v1/audio/speech"), Capability::Audio);
    assert_eq!(Capability::from_path("/v1/x-firefly/audio/clone"), Capability::Audio);

    // 生图与超分能力（标准与 x-firefly 扩展）
    assert_eq!(Capability::from_path("/v1/images/generations"), Capability::Diffusion);
    assert_eq!(Capability::from_path("/v1/x-firefly/images/upscale"), Capability::Diffusion);
}

#[tokio::test]
async fn test_ac1_proxy_state_worker_registration_and_lookup() {
    let state = ProxyState::new();

    // 注册 Embedding Worker
    let slot = WorkerSlot {
        port: 38402,
        status: ProcessStatus::Running,
        model_id: "bge-m3".to_string(),
        last_active_at: std::time::Instant::now(),
    };
    state.register_worker(Capability::Embedding, slot).await;

    // 查找并断言
    let retrieved = state.get_worker(Capability::Embedding).await.unwrap();
    assert_eq!(retrieved.port, 38402);
    assert_eq!(retrieved.status, ProcessStatus::Running);
    assert_eq!(retrieved.model_id, "bge-m3");

    // 注销并断言
    state.unregister_worker(Capability::Embedding).await;
    assert!(state.get_worker(Capability::Embedding).await.is_none());
}

#[tokio::test]
async fn test_ac1_backward_compatible_set_target_port() {
    let state = ProxyState::new();
    state.set_target_port(38401).await;

    // 既有 target_port 依然能取到
    {
        let guard = state.target_port.lock().await;
        assert_eq!(*guard, Some(38401));
    }

    // 同时自动同步注册了 Language WorkerSlot
    let lang_slot = state.get_worker(Capability::Language).await.unwrap();
    assert_eq!(lang_slot.port, 38401);
    assert_eq!(lang_slot.status, ProcessStatus::Running);
}

#[tokio::test]
async fn test_ac3_v1_models_aggregation_from_multiple_workers() {
    let state = ProxyState::new();

    // 注册 3 个不同能力的活跃 Worker
    state.register_worker(Capability::Language, WorkerSlot {
        port: 38401,
        status: ProcessStatus::Running,
        model_id: "qwen2.5-7b-instruct".to_string(),
        last_active_at: std::time::Instant::now(),
    }).await;

    state.register_worker(Capability::Audio, WorkerSlot {
        port: 38403,
        status: ProcessStatus::Running,
        model_id: "sense-voice-small".to_string(),
        last_active_at: std::time::Instant::now(),
    }).await;

    state.register_worker(Capability::Diffusion, WorkerSlot {
        port: 38404,
        status: ProcessStatus::Stopped, // 未运行状态不应出现在活跃模型列表中
        model_id: "flux-schnell".to_string(),
        last_active_at: std::time::Instant::now(),
    }).await;

    // 构造发向 /v1/models 的 GET 请求
    let req = Request::builder()
        .method("GET")
        .uri("/v1/models")
        .body(Body::empty())
        .unwrap();

    let resp = proxy_handler(State(state), req).await;
    assert_eq!(resp.status(), StatusCode::OK);

    let bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let json: Value = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(json["object"], "list");
    let data = json["data"].as_array().expect("data 字段应为数组");

    // 仅有两个 Running 状态的 Worker 模型
    assert_eq!(data.len(), 2);

    let model_ids: Vec<&str> = data.iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert!(model_ids.contains(&"qwen2.5-7b-instruct"));
    assert!(model_ids.contains(&"sense-voice-small"));
    assert!(!model_ids.contains(&"flux-schnell")); // Stopped 不在列表中
}

#[tokio::test]
async fn test_ac2_unregistered_worker_request_returns_structured_rejection() {
    let state = ProxyState::new();

    // 没有注册 Audio Worker，向 /v1/audio/speech 发请求
    let req = Request::builder()
        .method("POST")
        .uri("/v1/audio/speech")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"input": "hello"}"#))
        .unwrap();

    let resp = proxy_handler(State(state), req).await;
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

    let bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let json: Value = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(json["error"]["type"], "engine_service_stopped");
    assert_eq!(json["error"]["code"], "engine_service_stopped");
}

#[tokio::test]
async fn test_ac2_streaming_multiplexing_to_mock_workers() {
    use axum::routing::post;
    use axum::Router;
    use tokio::net::TcpListener;

    // 1. 启动 Mock Language Worker
    let lang_app = Router::new().route(
        "/v1/chat/completions",
        post(|body: axum::body::Bytes| async move {
            assert!(!body.is_empty());
            (
                StatusCode::OK,
                [("content-type", "application/json")],
                r#"{"id":"chatcmpl-123","choices":[{"message":{"content":"hello from language"}}]}"#,
            )
        }),
    );
    let lang_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let lang_port = lang_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(lang_listener, lang_app).await.unwrap();
    });

    // 2. 启动 Mock Audio Worker
    let audio_app = Router::new().route(
        "/v1/audio/transcriptions",
        post(|body: axum::body::Bytes| async move {
            assert_eq!(body.len(), 64 * 1024); // 验证流式发送的数据大小无损
            (
                StatusCode::OK,
                [("content-type", "application/json")],
                r#"{"text":"transcribed audio content"}"#,
            )
        }),
    );
    let audio_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let audio_port = audio_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(audio_listener, audio_app).await.unwrap();
    });

    // 3. 配置 ProxyState 注册两个 Worker
    let state = ProxyState::new();
    state.register_worker(Capability::Language, WorkerSlot {
        port: lang_port,
        status: ProcessStatus::Running,
        model_id: "mock-llm".to_string(),
        last_active_at: std::time::Instant::now(),
    }).await;
    state.register_worker(Capability::Audio, WorkerSlot {
        port: audio_port,
        status: ProcessStatus::Running,
        model_id: "mock-audio".to_string(),
        last_active_at: std::time::Instant::now(),
    }).await;

    // 4. 发送 Language 请求
    let lang_req = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"messages":[{"role":"user","content":"hi"}]}"#))
        .unwrap();
    let lang_resp = proxy_handler(State(state.clone()), lang_req).await;
    assert_eq!(lang_resp.status(), StatusCode::OK);
    let lang_bytes = to_bytes(lang_resp.into_body(), 1024 * 1024).await.unwrap();
    let lang_json: Value = serde_json::from_slice(&lang_bytes).unwrap();
    assert_eq!(lang_json["choices"][0]["message"]["content"], "hello from language");

    // 5. 发送 Audio 请求（流式传输 64KB 音频二进制数据）
    let dummy_audio_bytes = vec![0xABu8; 64 * 1024];
    let audio_req = Request::builder()
        .method("POST")
        .uri("/v1/audio/transcriptions")
        .header("content-type", "application/octet-stream")
        .body(Body::from(dummy_audio_bytes))
        .unwrap();
    let audio_resp = proxy_handler(State(state), audio_req).await;
    assert_eq!(audio_resp.status(), StatusCode::OK);
    let audio_bytes = to_bytes(audio_resp.into_body(), 1024 * 1024).await.unwrap();
    let audio_json: Value = serde_json::from_slice(&audio_bytes).unwrap();
    assert_eq!(audio_json["text"], "transcribed audio content");
}
