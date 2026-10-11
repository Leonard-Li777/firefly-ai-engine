use firefly_ai_engine_lib::engine::gguf_parser::GgufMetadata;
use std::io::Cursor;

fn write_str(buf: &mut Vec<u8>, s: &str) {
    let len = s.len() as u64;
    buf.extend_from_slice(&len.to_le_bytes());
    buf.extend_from_slice(s.as_bytes());
}

fn write_kv_u32(buf: &mut Vec<u8>, key: &str, val: u32) {
    write_str(buf, key);
    buf.extend_from_slice(&4u32.to_le_bytes()); // Type 4: UINT32
    buf.extend_from_slice(&val.to_le_bytes());
}

fn write_kv_str(buf: &mut Vec<u8>, key: &str, val: &str) {
    write_str(buf, key);
    buf.extend_from_slice(&8u32.to_le_bytes()); // Type 8: STRING
    write_str(buf, val);
}

#[test]
fn test_parse_gguf_metadata_synthetic() {
    let mut data = Vec::new();
    data.extend_from_slice(b"GGUF");
    data.extend_from_slice(&3u32.to_le_bytes());
    data.extend_from_slice(&100u64.to_le_bytes());
    data.extend_from_slice(&7u64.to_le_bytes());

    write_kv_str(&mut data, "general.architecture", "qwen2");
    write_kv_u32(&mut data, "qwen2.block_count", 28);
    write_kv_u32(&mut data, "qwen2.attention.head_count", 16);
    write_kv_u32(&mut data, "qwen2.attention.head_count_kv", 2);
    write_kv_u32(&mut data, "qwen2.attention.key_length", 128);
    write_kv_u32(&mut data, "qwen2.context_length", 32768);
    write_kv_str(
        &mut data,
        "tokenizer.chat_template",
        "{% for message in messages %}{{ message.content }}{% endfor %}",
    );

    let mut cursor = Cursor::new(data);
    let meta = GgufMetadata::parse_reader(&mut cursor, 1024 * 1024).expect("解析必须成功");

    assert_eq!(meta.arch, "qwen2");
    assert_eq!(meta.n_layer, 28);
    assert_eq!(meta.n_head, Some(16));
    assert_eq!(meta.n_kv_head, 2);
    assert_eq!(meta.head_dim, 128);
    assert_eq!(meta.train_ctx, 32768);
    assert!(!meta.has_strict_role_alternation);
}

#[test]
fn test_parse_gguf_strict_role_alternation() {
    let mut data = Vec::new();
    data.extend_from_slice(b"GGUF");
    data.extend_from_slice(&3u32.to_le_bytes());
    data.extend_from_slice(&1u64.to_le_bytes());
    data.extend_from_slice(&2u64.to_le_bytes());

    write_kv_str(&mut data, "general.architecture", "gemma2");
    write_kv_str(
        &mut data,
        "tokenizer.chat_template",
        "{{ raise_exception('Conversation roles must alternate user/assistant') }}",
    );

    let mut cursor = Cursor::new(data);
    let meta = GgufMetadata::parse_reader(&mut cursor, 2048).expect("解析必须成功");

    assert_eq!(meta.arch, "gemma2");
    assert!(meta.has_strict_role_alternation);
}

#[test]
fn test_parse_gguf_mha_fallback_head_count() {
    let mut data = Vec::new();
    data.extend_from_slice(b"GGUF");
    data.extend_from_slice(&2u32.to_le_bytes()); // v2
    data.extend_from_slice(&0u64.to_le_bytes());
    data.extend_from_slice(&3u64.to_le_bytes());

    write_kv_str(&mut data, "general.architecture", "llama");
    write_kv_u32(&mut data, "llama.block_count", 32);
    write_kv_u32(&mut data, "llama.attention.head_count", 32);

    let mut cursor = Cursor::new(data);
    let meta = GgufMetadata::parse_reader(&mut cursor, 4096).expect("解析必须成功");

    assert_eq!(meta.arch, "llama");
    assert_eq!(meta.n_layer, 32);
    assert_eq!(meta.n_kv_head, 32);
    assert_eq!(meta.head_dim, 128);
}

#[test]
fn test_parse_gguf_corrupted_or_truncated_file() {
    // 1. 非法 Magic
    let mut bad_magic = Cursor::new(b"BADM\x03\0\0\0");
    assert!(GgufMetadata::parse_reader(&mut bad_magic, 8).is_err(), "非法魔数必须报错");

    // 2. 截断文件：声明有 5 个 KV，但字节流提前结束
    let mut truncated = Vec::new();
    truncated.extend_from_slice(b"GGUF");
    truncated.extend_from_slice(&3u32.to_le_bytes()); // v3
    truncated.extend_from_slice(&10u64.to_le_bytes()); // 10 tensors
    truncated.extend_from_slice(&5u64.to_le_bytes());  // 5 kv pairs
    truncated.extend_from_slice(&100u64.to_le_bytes()); // 键长度声明 100 字节，但后文空空如也

    let mut cursor = Cursor::new(truncated);
    assert!(GgufMetadata::parse_reader(&mut cursor, 32).is_err(), "数据流截断必须报错 Err");
}

