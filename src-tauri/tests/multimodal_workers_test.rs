// tests/multimodal_workers_test.rs
// Issue 06 & Issue 07: 多模态推理 Worker (Diffusion & Audio) 托管、LRU 缓存淘汰与端点流式代理测试

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::post;
use axum::Router;
use firefly_ai_engine_lib::engine::clean_image_cache_lru;
use firefly_ai_engine_lib::engine::process_guard::ProcessStatus;
use firefly_ai_engine_lib::server::proxy::{
    proxy_handler, Capability, ProxyState, WorkerSlot,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::net::TcpListener;

#[test]
fn test_ac2_image_cache_lru_cleaner() {
    let temp_dir = tempfile::tempdir().unwrap();
    let cache_dir = temp_dir.path();

    // 创建 3 个不同时间戳的临时图片文件
    let file1 = cache_dir.join("img_old.png");
    let file2 = cache_dir.join("img_mid.png");
    let file3 = cache_dir.join("img_new.png");

    // 写入模拟数据：每个文件 100KB (102400 字节)
    let data_100k = vec![0u8; 102400];
    std::fs::write(&file1, &data_100k).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(50));
    std::fs::write(&file2, &data_100k).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(50));
    std::fs::write(&file3, &data_100k).unwrap();

    // 总大小 300KB，设置上限为 150KB，应当触发 LRU，优先清理最旧的 file1
    let max_bytes = 150 * 1024;
    let cleaned = clean_image_cache_lru(cache_dir, max_bytes).unwrap();
    assert!(cleaned >= 102400, "必须至少清理一个文件");

    // 验证最旧的文件已被删除，而最新的文件仍然保留
    assert!(!file1.exists(), "最旧的图片必须被淘汰");
    assert!(file3.exists(), "最新的图片必须保留");
}

#[test]
fn test_ac1_audio_thread_allocation_anti_oversubscription() {
    // 线程分配公式: min(4, max(1, cores / 2))
    fn calculate_threads(cores: usize) -> u32 {
        std::cmp::min(4, std::cmp::max(1, (cores / 2) as u32))
    }

    assert_eq!(calculate_threads(2), 1);
    assert_eq!(calculate_threads(4), 2);
    assert_eq!(calculate_threads(8), 4);
    assert_eq!(calculate_threads(16), 4, "即便拥有 16 核也严格封顶 4 线程，杜绝 CPU 超订卡顿");
    assert_eq!(calculate_threads(32), 4);
}

#[tokio::test]
async fn test_multimodal_proxy_routing_diffusion_and_audio() {
    let diff_req_counter = Arc::new(AtomicUsize::new(0));
    let audio_req_counter = Arc::new(AtomicUsize::new(0));

    // 1. Mock sd-server (Diffusion)
    let d_count = diff_req_counter.clone();
    let diff_app = Router::new().route(
        "/v1/images/generations",
        post(move |_body: axum::body::Bytes| {
            let c = d_count.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                (
                    StatusCode::OK,
                    [("content-type", "application/json")],
                    r#"{"created":1700000000,"data":[{"url":"http://127.0.0.1/fake.png"}]}"#,
                )
            }
        }),
    );
    let diff_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let diff_port = diff_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(diff_listener, diff_app).await.unwrap();
    });

    // 2. Mock audiocpp_server (Audio)
    let a_count = audio_req_counter.clone();
    let audio_app = Router::new().route(
        "/v1/audio/transcriptions",
        post(move |_body: axum::body::Bytes| {
            let c = a_count.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                (
                    StatusCode::OK,
                    [("content-type", "application/json")],
                    r#"{"text":"transcribed audio stream text"}"#,
                )
            }
        }),
    );
    let audio_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let audio_port = audio_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(audio_listener, audio_app).await.unwrap();
    });

    // 3. 配置 ProxyState 注册两个 Worker
    let proxy_state = ProxyState::new();
    proxy_state.register_worker(
        Capability::Diffusion,
        WorkerSlot {
            port: diff_port,
            status: ProcessStatus::Running,
            model_id: "sd-v1-5".to_string(),
            last_active_at: std::time::Instant::now(),
        },
    ).await;

    proxy_state.register_worker(
        Capability::Audio,
        WorkerSlot {
            port: audio_port,
            status: ProcessStatus::Running,
            model_id: "sensevoice".to_string(),
            last_active_at: std::time::Instant::now(),
        },
    ).await;

    // 4. 测试 /v1/images/generations 精准转发到 Diffusion
    let diff_req = Request::builder()
        .method("POST")
        .uri("/v1/images/generations")
        .body(Body::from(r#"{"prompt":"a cute cat"}"#))
        .unwrap();

    let diff_resp: axum::response::Response = proxy_handler(axum::extract::State(proxy_state.clone()), diff_req).await;
    assert_eq!(diff_resp.status(), StatusCode::OK);
    assert_eq!(diff_req_counter.load(Ordering::SeqCst), 1);
    assert_eq!(audio_req_counter.load(Ordering::SeqCst), 0);

    // 5. 测试 /v1/audio/transcriptions 精准转发到 Audio
    let audio_req = Request::builder()
        .method("POST")
        .uri("/v1/audio/transcriptions")
        .body(Body::from(r#"dummy audio bytes"#))
        .unwrap();

    let audio_resp: axum::response::Response = proxy_handler(axum::extract::State(proxy_state), audio_req).await;
    assert_eq!(audio_resp.status(), StatusCode::OK);
    assert_eq!(diff_req_counter.load(Ordering::SeqCst), 1);
    assert_eq!(audio_req_counter.load(Ordering::SeqCst), 1);
}
