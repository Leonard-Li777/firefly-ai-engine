// engine/gguf_parser.rs
//
// GGUF v2/v3 极速二进制元数据探测器
// 采用零第三方依赖设计（基于标准库 BufReader + Seek），在毫秒级内提取模型架构、层数、KV头数、训练上下文及 ChatML 模板。
// 针对超大词表数组（tokenizer.ggml.tokens 等），通过定长标量计算直接 Seek 跳过，避免反序列化数万至数十万词元。

use std::fs::File;
use std::io::{BufReader, Error, ErrorKind, Read, Result, Seek, SeekFrom};
use std::path::Path;

/// GGUF 预提取的关键元数据
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct GgufMetadata {
    /// 基础架构代号（如 "qwen2", "llama", "gemma2", "deepseek2"）
    pub arch: String,
    /// 物理 Transformer 隐藏层数（即 --n-gpu-layers 真实上限）
    pub n_layer: u32,
    /// 注意力头总数
    pub n_head: Option<u32>,
    /// KV 注意力头数（GQA 关键参数，若无则回退至 n_head）
    pub n_kv_head: u32,
    /// 单注意力头维度（若无且有 n_embd/n_head 则推导，否则兜底 128）
    pub head_dim: u32,
    /// 隐层嵌入维度
    pub n_embd: Option<u32>,
    /// 模型预训练原生上下文窗口上限（默认兜底 4096）
    pub train_ctx: u32,
    /// GGUF 原生附带的 Jinja 对话模板
    pub chat_template: Option<String>,
    /// 是否包含严格角色交替校验（如 Gemma 的 "roles must alternate"）
    pub has_strict_role_alternation: bool,
    /// 文件物理字节大小
    pub file_size_bytes: u64,
}

impl Default for GgufMetadata {
    fn default() -> Self {
        GgufMetadata {
            arch: "llama".to_string(),
            n_layer: 32,
            n_head: Some(32),
            n_kv_head: 8,
            head_dim: 128,
            n_embd: Some(4096),
            train_ctx: 4096,
            chat_template: None,
            has_strict_role_alternation: false,
            file_size_bytes: 0,
        }
    }
}

impl GgufMetadata {
    /// 从指定物理路径解析 GGUF 文件头部元数据
    pub fn parse_file<P: AsRef<Path>>(path: P) -> Result<Self> {
        let p = path.as_ref();
        let file = File::open(p)?;
        let file_size_bytes = file.metadata()?.len();
        let mut reader = BufReader::with_capacity(64 * 1024, file);
        Self::parse_reader(&mut reader, file_size_bytes)
    }

    /// 从任意实现了 Read + Seek 的流中解析元数据
    pub fn parse_reader<R: Read + Seek>(reader: &mut R, file_size_bytes: u64) -> Result<Self> {
        // 1. 校验 Magic
        let mut magic = [0u8; 4];
        reader.read_exact(&mut magic)?;
        if &magic != b"GGUF" {
            return Err(Error::new(
                ErrorKind::InvalidData,
                format!("非法 GGUF 头部魔数: {:?}", magic),
            ));
        }

        // 2. 读取版本 (v2 或 v3)
        let version = read_u32_le(reader)?;
        if version != 2 && version != 3 {
            return Err(Error::new(
                ErrorKind::InvalidData,
                format!("不支持的 GGUF 版本: {}", version),
            ));
        }

        // 3. 读取 tensor 数量与 kv 对数量
        let _tensor_count = read_u64_le(reader)?;
        let kv_count = read_u64_le(reader)?;

        let mut raw_arch: Option<String> = None;
        let mut raw_block_count: Option<u32> = None;
        let mut raw_head_count: Option<u32> = None;
        let mut raw_head_count_kv: Option<u32> = None;
        let mut raw_key_length: Option<u32> = None;
        let mut raw_embedding_length: Option<u32> = None;
        let mut raw_context_length: Option<u32> = None;
        let mut raw_chat_template: Option<String> = None;

        // 4. 循环扫描 KV 元数据
        for _ in 0..kv_count {
            // 短路提前退出条件：核心关键字段已全部就绪
            if raw_arch.is_some()
                && raw_block_count.is_some()
                && raw_head_count.is_some()
                && raw_context_length.is_some()
                && raw_chat_template.is_some()
            {
                break;
            }

            let key = read_string_limited(reader, 256)?;

            let val_type = read_u32_le(reader)?;

            // 针对大数组（如 tokenizer.ggml.tokens, scores 等）直接跳过
            if val_type == 9 {
                skip_array_value(reader)?;
                continue;
            }

            // 针对感兴趣的键进行提取
            if key == "general.architecture" {
                if let Ok(s) = read_value_string(reader, val_type) {
                    raw_arch = Some(s);
                }
            } else if key.ends_with(".block_count") {
                if let Ok(val) = read_value_u32(reader, val_type) {
                    raw_block_count = Some(val);
                }
            } else if key.ends_with(".attention.head_count") {
                if let Ok(val) = read_value_u32(reader, val_type) {
                    raw_head_count = Some(val);
                }
            } else if key.ends_with(".attention.head_count_kv") {
                if let Ok(val) = read_value_u32(reader, val_type) {
                    raw_head_count_kv = Some(val);
                }
            } else if key.ends_with(".attention.key_length") {
                if let Ok(val) = read_value_u32(reader, val_type) {
                    raw_key_length = Some(val);
                }
            } else if key.ends_with(".embedding_length") {
                if let Ok(val) = read_value_u32(reader, val_type) {
                    raw_embedding_length = Some(val);
                }
            } else if key.ends_with(".context_length") {
                if let Ok(val) = read_value_u32(reader, val_type) {
                    raw_context_length = Some(val);
                }
            } else if key == "tokenizer.chat_template" {
                if let Ok(s) = read_value_string(reader, val_type) {
                    raw_chat_template = Some(s);
                }
            } else {
                // 跳过不关心的标量或字符串
                skip_scalar_or_string(reader, val_type)?;
            }
        }

        let arch = raw_arch.unwrap_or_else(|| "unknown".to_string());
        let n_layer = raw_block_count.unwrap_or(0);
        let n_kv_head = raw_head_count_kv.or(raw_head_count).unwrap_or(0);
        let head_dim = raw_key_length.unwrap_or_else(|| {
            if let (Some(embd), Some(heads)) = (raw_embedding_length, raw_head_count) {
                if heads > 0 {
                    embd / heads
                } else {
                    128
                }
            } else {
                128
            }
        });
        let train_ctx = raw_context_length.unwrap_or(4096);
        let has_strict_role_alternation = raw_chat_template
            .as_deref()
            .map(|tmpl| tmpl.contains("roles must alternate") || tmpl.contains("Conversation roles must alternate"))
            .unwrap_or(false);

        Ok(GgufMetadata {
            arch,
            n_layer,
            n_head: raw_head_count,
            n_kv_head,
            head_dim,
            n_embd: raw_embedding_length,
            train_ctx,
            chat_template: raw_chat_template,
            has_strict_role_alternation,
            file_size_bytes,
        })
    }
}

// ---------------------------------------------------------
// 二进制反序列化底层辅助函数
// ---------------------------------------------------------

#[inline]
fn read_u32_le<R: Read>(reader: &mut R) -> Result<u32> {
    let mut buf = [0u8; 4];
    reader.read_exact(&mut buf)?;
    Ok(u32::from_le_bytes(buf))
}

#[inline]
fn read_u64_le<R: Read>(reader: &mut R) -> Result<u64> {
    let mut buf = [0u8; 8];
    reader.read_exact(&mut buf)?;
    Ok(u64::from_le_bytes(buf))
}

fn read_string_limited<R: Read>(reader: &mut R, max_bytes: usize) -> Result<String> {
    let len = read_u64_le(reader)? as usize;
    if len > max_bytes {
        return Err(Error::new(
            ErrorKind::InvalidData,
            format!("字符串超长 ({} > {})", len, max_bytes),
        ));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf)?;
    String::from_utf8(buf).map_err(|e| Error::new(ErrorKind::InvalidData, e))
}

fn read_value_string<R: Read>(reader: &mut R, val_type: u32) -> Result<String> {
    if val_type != 8 {
        return Err(Error::new(ErrorKind::InvalidData, "期望字符串类型(8)"));
    }
    // 模板等文本限制 16MB
    read_string_limited(reader, 16 * 1024 * 1024)
}

fn read_value_u32<R: Read>(reader: &mut R, val_type: u32) -> Result<u32> {
    match val_type {
        0 => { // UINT8
            let mut buf = [0u8; 1];
            reader.read_exact(&mut buf)?;
            Ok(buf[0] as u32)
        }
        2 => { // UINT16
            let mut buf = [0u8; 2];
            reader.read_exact(&mut buf)?;
            Ok(u16::from_le_bytes(buf) as u32)
        }
        4 => { // UINT32
            read_u32_le(reader)
        }
        5 => { // INT32
            let mut buf = [0u8; 4];
            reader.read_exact(&mut buf)?;
            Ok(i32::from_le_bytes(buf) as u32)
        }
        10 => { // UINT64
            let v = read_u64_le(reader)?;
            Ok(v as u32)
        }
        11 => { // INT64
            let mut buf = [0u8; 8];
            reader.read_exact(&mut buf)?;
            Ok(i64::from_le_bytes(buf) as u32)
        }
        _ => Err(Error::new(ErrorKind::InvalidData, format!("非整数类型: {}", val_type))),
    }
}

fn skip_scalar_or_string<R: Read + Seek>(reader: &mut R, val_type: u32) -> Result<()> {
    match val_type {
        0 | 1 | 7 => { // UINT8, INT8, BOOL
            reader.seek(SeekFrom::Current(1))?;
        }
        2 | 3 => { // UINT16, INT16
            reader.seek(SeekFrom::Current(2))?;
        }
        4 | 5 | 6 => { // UINT32, INT32, FLOAT32
            reader.seek(SeekFrom::Current(4))?;
        }
        10 | 11 | 12 => { // UINT64, INT64, FLOAT64
            reader.seek(SeekFrom::Current(8))?;
        }
        8 => { // STRING
            let len = read_u64_le(reader)?;
            reader.seek(SeekFrom::Current(len as i64))?;
        }
        9 => { // ARRAY
            skip_array_value(reader)?;
        }
        _ => {
            return Err(Error::new(
                ErrorKind::InvalidData,
                format!("未知 GGUF 值类型: {}", val_type),
            ));
        }
    }
    Ok(())
}

fn skip_array_value<R: Read + Seek>(reader: &mut R, ) -> Result<()> {
    let elem_type = read_u32_le(reader)?;
    let elem_count = read_u64_le(reader)?;

    match elem_type {
        0 | 1 | 7 => {
            let bytes = elem_count as i64;
            reader.seek(SeekFrom::Current(bytes))?;
        }
        2 | 3 => {
            let bytes = (elem_count * 2) as i64;
            reader.seek(SeekFrom::Current(bytes))?;
        }
        4 | 5 | 6 => {
            let bytes = (elem_count * 4) as i64;
            reader.seek(SeekFrom::Current(bytes))?;
        }
        10 | 11 | 12 => {
            let bytes = (elem_count * 8) as i64;
            reader.seek(SeekFrom::Current(bytes))?;
        }
        8 => {
            // String array (如 tokens 列表)
            for _ in 0..elem_count {
                let s_len = read_u64_le(reader)?;
                reader.seek(SeekFrom::Current(s_len as i64))?;
            }
        }
        _ => {
            return Err(Error::new(
                ErrorKind::InvalidData,
                format!("不支持跳过的数组元素类型: {}", elem_type),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
        // Magic
        data.extend_from_slice(b"GGUF");
        // Version 3
        data.extend_from_slice(&3u32.to_le_bytes());
        // tensor_count = 100
        data.extend_from_slice(&100u64.to_le_bytes());
        // kv_count = 7
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
        // 缺少 head_count_kv，应回退至 head_count (32)

        let mut cursor = Cursor::new(data);
        let meta = GgufMetadata::parse_reader(&mut cursor, 4096).expect("解析必须成功");

        assert_eq!(meta.arch, "llama");
        assert_eq!(meta.n_layer, 32);
        assert_eq!(meta.n_kv_head, 32);
        assert_eq!(meta.head_dim, 128); // 默认 128
    }

    #[test]
    fn test_parse_gguf_invalid_magic() {
        let data = b"BADF\x03\x00\x00\x00".to_vec();
        let mut cursor = Cursor::new(data);
        let res = GgufMetadata::parse_reader(&mut cursor, 8);
        assert!(res.is_err());
    }
}
