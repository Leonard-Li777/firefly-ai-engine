// tests/dual_worker_concurrency_test.rs
// Issue 04b: 独立常驻 Embedding Worker 调度与语言/向量双进程并发零抖动测试

use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::routing::post;
use axum::Router;
use firefly_ai_engine_lib::engine::process_guard::ProcessStatus;
use firefly_ai_engine_lib::server::api::is_same_model;
use firefly_ai_engine_lib::server::proxy::{
    proxy_handler, Capability, ProxyState, WorkerSlot,
};
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::net::TcpListener;

#[test]
fn test_ac1_is_same_model_semantics() {
    assert!(is_same_model("qwen2.5-7b-instruct", "qwen2.5-7b-instruct"));
    assert!(is_same_model("qwen2.5-7b-instruct.gguf", "qwen2.5-7b-instruct"));
    assert!(is_same_model("models/bge-m3.gguf", "bge-m3"));
    assert!(!is_same_model("qwen2.5-7b-instruct", "bge-m3"));
}

#[tokio::test]
async fn test_ac3_end_to_end_concurrency_zero_thrashing() {
    // 计数器记录各 Worker 收到的请求数
    let lang_req_counter = Arc::new(AtomicUsize::new(0));
    let emb_req_counter = Arc::new(AtomicUsize::new(0));

    // 1. 启动独立的 Mock Language Worker (例如代表端口 38401)
    let lang_counter_clone = lang_req_counter.clone();
    let lang_app = Router::new().route(
        "/v1/chat/completions",
        post(move |body: axum::body::Bytes| {
            let counter = lang_counter_clone.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                let _ = body;
                // 模拟推理耗时 30ms
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                (
                    StatusCode::OK,
                    [("content-type", "application/json")],
                    r#"{"id":"chatcmpl-concurrent","choices":[{"message":{"content":"response from language worker"}}]}"#,
                )
            }
        }),
    );
    let lang_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let lang_port = lang_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(lang_listener, lang_app).await.unwrap();
    });

    // 2. 启动独立的 Mock Embedding Worker (例如代表常驻 CPU 端口 38402)
    let emb_counter_clone = emb_req_counter.clone();
    let emb_app = Router::new().route(
        "/v1/embeddings",
        post(move |body: axum::body::Bytes| {
            let counter = emb_counter_clone.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                let _ = body;
                // 模拟快速特征向量计算 5ms
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                (
                    StatusCode::OK,
                    [("content-type", "application/json")],
                    r#"{"object":"list","data":[{"embedding":[0.1,0.2,0.3],"index":0}],"model":"bge-m3"}"#,
                )
            }
        }),
    );
    let emb_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let emb_port = emb_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(emb_listener, emb_app).await.unwrap();
    });

    // 3. 配置 ProxyState：同时注册两个 Worker，实现零冲突双 Worker 路由
    let proxy_state = ProxyState::new();
    proxy_state.register_worker(Capability::Language, WorkerSlot {
        port: lang_port,
        status: ProcessStatus::Running,
        model_id: "qwen2.5-7b".to_string(),
        last_active_at: std::time::Instant::now(),
    }).await;
    proxy_state.register_worker(Capability::Embedding, WorkerSlot {
        port: emb_port,
        status: ProcessStatus::Running,
        model_id: "bge-m3".to_string(),
        last_active_at: std::time::Instant::now(),
    }).await;

    // 4. 并发压力模拟：
    // 后台持续高频发送 15 次 /v1/embeddings 向量抽取（每次间隔 20ms）
    // 前台并发发送 5 次 /v1/chat/completions 对话
    let mut handles = Vec::new();

    // 启动向量背景任务
    for i in 0..15 {
        let state = proxy_state.clone();
        let h = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(i * 20)).await;
            let req = Request::builder()
                .method("POST")
                .uri("/v1/embeddings")
                .header("content-type", "application/json")
                .body(Body::from(format!(r#"{{"input":"file content chunk {}"}}"#, i)))
                .unwrap();
            let resp = proxy_handler(State(state), req).await;
            assert_eq!(resp.status(), StatusCode::OK);
            let bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
            let json: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(json["model"], "bge-m3");
        });
        handles.push(h);
    }

    // 启动前台对话并发任务
    for j in 0..5 {
        let state = proxy_state.clone();
        let h = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(j * 40)).await;
            let req = Request::builder()
                .method("POST")
                .uri("/v1/chat/completions")
                .header("content-type", "application/json")
                .body(Body::from(format!(r#"{{"messages":[{{"role":"user","content":"turn {}"}}]}}"#, j)))
                .unwrap();
            let resp = proxy_handler(State(state), req).await;
            assert_eq!(resp.status(), StatusCode::OK);
            let bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
            let json: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(json["choices"][0]["message"]["content"], "response from language worker");
        });
        handles.push(h);
    }

    // 等待所有并发任务全部顺利收敛完成
    for h in handles {
        h.await.unwrap();
    }

    // 验证计数器：两个 Worker 各自精确处理全部请求，没有丢包，没有重启！
    assert_eq!(lang_req_counter.load(Ordering::SeqCst), 5);
    assert_eq!(emb_req_counter.load(Ordering::SeqCst), 15);
}
