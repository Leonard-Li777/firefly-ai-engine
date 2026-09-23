// server/custom_model.rs
// 自由添加任意模型：URL 解析（ModelScope file/view、HuggingFace blob/resolve）
// 与网络嗅探（HEAD 探测主模型大小 + 仓库树 API 查找同目录最小 mmproj 投影文件）
// 嗅探不下载任何文件，仅通过网络检测大小；探测失败的值保持 None（前端不显示）

use serde_json::{json, Value};
use tracing::warn;

use crate::config::CustomModelEntry;

/// URL 解析结果
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedModelUrl {
    /// 下载来源："huggingface" | "modelscope"
    pub source: &'static str,
    /// 仓库标识 org/repo
    pub repo: String,
    /// 修订分支（master/main 等）
    pub rev: String,
    /// 仓库内相对文件路径（可能含子目录）
    pub file_path: String,
    /// 文件名（含扩展名）
    pub file_name: String,
}

/// 解析用户提交的模型下载地址，支持三种形态：
/// - `https://modelscope.cn/models/{org}/{repo}/file/view/{rev}/{path...}`
/// - `https://huggingface.co/{org}/{repo}/blob/{rev}/{path...}`
/// - `https://huggingface.co/{org}/{repo}/resolve/{rev}/{path...}`
/// （同时兼容 modelscope 的 resolve 形态）
pub fn parse_model_url(raw: &str) -> Result<ParsedModelUrl, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("模型下载地址为空".to_string());
    }

    // 去掉查询串与锚点
    let without_tail = trimmed.split(['?', '#']).next().unwrap_or(trimmed);
    // 拆出 host 与 path
    let after_scheme = without_tail
        .strip_prefix("https://")
        .or_else(|| without_tail.strip_prefix("http://"))
        .unwrap_or(without_tail);
    let (host, path) = match after_scheme.split_once('/') {
        Some((h, p)) => (h.to_lowercase(), p),
        None => return Err("URL 缺少路径部分".to_string()),
    };

    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    let (source, repo, rev, file_path) = if host.contains("modelscope.cn") {
        // modelscope: /models/{org}/{repo}/file/view/{rev}/{file} 或 /models/{org}/{repo}/resolve/{rev}/{file}
        parse_modelscope(&segments).ok_or("ModelScope URL 形态不受支持，请使用 /models/组织/仓库/file/view/... 形式")?
    } else if host.contains("huggingface.co") || host.contains("hf-mirror.com") {
        // huggingface: /{org}/{repo}/blob/{rev}/{file} 或 /{org}/{repo}/resolve/{rev}/{file}
        parse_huggingface(&segments).ok_or("HuggingFace URL 形态不受支持，请使用 /组织/仓库/blob/... 或 /resolve/... 形式")?
    } else {
        return Err(format!("不支持的模型托管站点: {}", host));
    };

    let file_name = file_path
        .rsplit('/')
        .next()
        .unwrap_or(&file_path)
        .to_string();
    if file_name.is_empty() {
        return Err("URL 未指向具体模型文件".to_string());
    }

    Ok(ParsedModelUrl {
        source,
        repo,
        rev,
        file_path,
        file_name,
    })
}

/// 解析 ModelScope path 段：models/org/repo/file/view/rev/... 或 models/org/repo/resolve/rev/...
fn parse_modelscope(segments: &[&str]) -> Option<(&'static str, String, String, String)> {
    // 至少需要 models/org/repo/mark/rev/file 六段
    if segments.len() < 6 || segments.first() != Some(&"models") {
        return None;
    }
    let org = segments[1];
    let repo_name = segments[2];
    let marker = segments[3];
    let (rev_idx, file_start) = match marker {
        // file/view/{rev}/{file...}
        "file" if segments.get(4) == Some(&"view") => (5, 6),
        // resolve/{rev}/{file...}
        "resolve" => (4, 5),
        _ => return None,
    };
    if segments.len() <= file_start {
        return None;
    }
    let rev = segments[rev_idx].to_string();
    let file_path = segments[file_start..].join("/");
    Some((
        "modelscope",
        format!("{}/{}", org, repo_name),
        rev,
        file_path,
    ))
}

/// 解析 HuggingFace path 段：org/repo/blob/rev/... 或 org/repo/resolve/rev/...
fn parse_huggingface(segments: &[&str]) -> Option<(&'static str, String, String, String)> {
    // 至少需要 org/repo/marker/rev/file 五段
    if segments.len() < 5 {
        return None;
    }
    let org = segments[0];
    let repo_name = segments[1];
    let marker = segments[2];
    if marker != "blob" && marker != "resolve" && marker != "tree" {
        return None;
    }
    let rev = segments[3].to_string();
    let file_path = segments[4..].join("/");
    Some((
        "huggingface",
        format!("{}/{}", org, repo_name),
        rev,
        file_path,
    ))
}

/// 构造直接下载（resolve）URL，用于 HEAD 嗅探与展示
pub fn build_resolve_url(parsed: &ParsedModelUrl) -> String {
    match parsed.source {
        "modelscope" => format!(
            "https://modelscope.cn/models/{}/resolve/{}/{}",
            parsed.repo, parsed.rev, parsed.file_path
        ),
        _ => format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            parsed.repo, parsed.rev, parsed.file_path
        ),
    }
}

/// 从 repo 尾段与文件名推导展示名：优先去掉仓库名尾部的 -GGUF 后缀
pub fn derive_display_name(parsed: &ParsedModelUrl) -> String {
    let repo_tail = parsed.repo.rsplit('/').next().unwrap_or(&parsed.repo);
    let stripped = match repo_tail.rfind("-GGUF") {
        Some(idx) if idx > 0 => {
            // 大小写不敏感地剥离尾部 -GGUF / -gguf
            let candidate = &repo_tail[idx..];
            if candidate.eq_ignore_ascii_case("-gguf") {
                repo_tail[..idx].to_string()
            } else {
                repo_tail.to_string()
            }
        }
        _ => repo_tail.to_string(),
    };
    if !stripped.is_empty() {
        return stripped;
    }
    parsed
        .file_name
        .trim_end_matches(".gguf")
        .trim_end_matches(".GGUF")
        .to_string()
}

/// 由解析结果与嗅探值构造持久化条目。
/// 下载 ID：`repo:QUANT`（量化 tag 可识别时），否则回退为 `repo:文件名.gguf` 精确文件形态。
pub fn build_entry(
    parsed: &ParsedModelUrl,
    resolve_url: String,
    quant: Option<String>,
    main_file_size: Option<u64>,
    mmproj: Option<(String, u64)>,
) -> CustomModelEntry {
    let tag = match &quant {
        Some(q) => q.to_uppercase(),
        None => parsed.file_name.clone(),
    };
    let total_size = match (main_file_size, mmproj.as_ref().map(|(_, s)| *s)) {
        (Some(m), Some(p)) => Some(m + p),
        (Some(m), None) => Some(m),
        (None, Some(p)) => Some(p),
        (None, None) => None,
    };
    CustomModelEntry {
        id: format!("{}:{}", parsed.repo, tag),
        name: derive_display_name(parsed),
        author: parsed.repo.split('/').next().map(|s| s.to_string()),
        source: parsed.source.to_string(),
        quant: quant.map(|q| q.to_uppercase()),
        file_name: parsed.file_name.clone(),
        resolve_url,
        main_file_size,
        mmproj_file_name: mmproj.as_ref().map(|(n, _)| n.clone()),
        mmproj_file_size: mmproj.as_ref().map(|(_, s)| *s),
        total_size,
    }
}

/// 将持久化条目转换为前端 ModelItem 风格 JSON（并标注本地磁盘存在性）。
/// 无法探测到的值不输出对应字段内容（空串/0），由前端负责不显示。
pub fn entry_to_model_json(entry: &CustomModelEntry, is_downloaded: bool, local_path: Option<&str>) -> Value {
    json!({
        "id": entry.id,
        "name": entry.name,
        "author": entry.author,
        "source": entry.source,
        "quant": entry.quant.clone().unwrap_or_default(),
        "fileSize": entry.total_size.unwrap_or(0),
        "params": "",
        "description": "",
        "isMultiModal": entry.mmproj_file_name.is_some(),
        "mmprojFileName": entry.mmproj_file_name,
        "isDownloaded": is_downloaded,
        "localPath": local_path,
        "custom": true,
        "resolveUrl": entry.resolve_url,
    })
}

// ─────────────────────── 网络嗅探 ───────────────────────

/// 从文件绝对路径推导其父目录（仓库内相对路径）；根目录返回 "."
fn parent_dir_of(file_path: &str) -> String {
    match file_path.rfind('/') {
        Some(idx) if idx > 0 => file_path[..idx].to_string(),
        _ => ".".to_string(),
    }
}

/// HEAD 探测文件大小：优先 content-length，回退 Range 请求解析 content-range 总长。
/// 任何网络失败返回 None（不阻断添加流程）。
pub async fn probe_file_size(client: &reqwest::Client, url: &str) -> Option<u64> {
    if let Ok(resp) = client.head(url).send().await {
        if let Some(len) = resp.content_length() {
            if len > 0 {
                return Some(len);
            }
        }
        // HEAD 不给长度时尝试状态码有效性判断后再走 Range
    }
    let range_result = client
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await
        .ok()?;
    if let Some(cr) = range_result.headers().get(reqwest::header::CONTENT_RANGE) {
        let text = cr.to_str().ok()?;
        // 形如 "bytes 0-0/123456789"
        if let Some(total) = text.rsplit('/') .next() {
            if let Ok(v) = total.trim().parse::<u64>() {
                if v > 0 {
                    return Some(v);
                }
            }
        }
    }
    if let Some(len) = range_result.content_length() {
        if len > 1 {
            return Some(len);
        }
    }
    None
}

/// 解析 HuggingFace tree API 响应（JSON 数组），找出 dir 目录下最小的 mmproj .gguf 文件
/// 响应条目形如 {"type":"file","path":"dir/name.gguf","size":123} 或 lfs: {"size":...}
pub fn parse_hf_tree_for_mmproj(body: &Value, dir: &str) -> Option<(String, u64)> {
    let items = body.as_array()?;
    let prefix = if dir == "." { String::new() } else { format!("{}/", dir) };
    let mut best: Option<(String, u64)> = None;
    for item in items {
        if item.get("type").and_then(|v| v.as_str()) != Some("file") {
            continue;
        }
        let Some(path) = item.get("path").and_then(|v| v.as_str()) else {
            continue;
        };
        if !path.ends_with(".gguf") {
            continue;
        }
        // 严格同目录：去掉前缀后不得再含 '/'
        let name = match path.strip_prefix(prefix.as_str()) {
            Some(rest) if !rest.contains('/') => rest.to_string(),
            _ => continue,
        };
        if !name.to_lowercase().contains("mmproj") {
            continue;
        }
        let size = item
            .get("size")
            .and_then(|v| v.as_u64())
            .or_else(|| item.get("lfs").and_then(|l| l.get("size")).and_then(|v| v.as_u64()))
            .unwrap_or(0);
        if size == 0 {
            continue;
        }
        if best.as_ref().map(|(_, b)| size < *b).unwrap_or(true) {
            best = Some((name, size));
        }
    }
    best
}

/// 解析 ModelScope repo/tree API 响应，找出 dir 目录下指定主模型文件的大小
/// 响应形如 {"Data":{"Files":[{"Name":"x.gguf","Size":123,"Type":"blob"}]}}
pub fn parse_modelscope_tree_for_main_file(body: &Value, dir: &str, file_name: &str) -> Option<u64> {
    let files = body.get("Data")?.get("Files")?.as_array()?;
    let name_lower = file_name.to_lowercase();
    for item in files {
        let name = item.get("Name").and_then(|v| v.as_str()).unwrap_or("");
        if !name.eq_ignore_ascii_case(file_name) && name.to_lowercase() != name_lower {
            continue;
        }
        // 目录条目 Type 为 "tree"，文件为 "blob"
        if let Some(t) = item.get("Type").and_then(|v| v.as_str()) {
            if !t.eq_ignore_ascii_case("blob") {
                continue;
            }
        }
        let size = item.get("Size").and_then(|v| v.as_u64()).unwrap_or(0);
        if size > 0 {
            let _ = dir; // dir 仅用于日志语义，主文件按 Name 精确匹配即可
            return Some(size);
        }
    }
    None
}

/// 解析 ModelScope repo/tree API 响应，找出 dir 目录下最小的 mmproj .gguf 文件
/// 响应形如 {"Data":{"Files":[{"Name":"x.gguf","Path":"...","Size":123,"Type":"blob"}]}}
pub fn parse_modelscope_tree_for_mmproj(body: &Value, dir: &str) -> Option<(String, u64)> {
    let files = body.get("Data")?.get("Files")?.as_array()?;
    let mut best: Option<(String, u64)> = None;
    for item in files {
        // ModelScope 树中目录条目 Type 为 "tree"，文件为 "blob"
        let type_ok = match item.get("Type").and_then(|v| v.as_str()) {
            Some(t) => t.eq_ignore_ascii_case("blob"),
            None => true,
        };
        if !type_ok {
            continue;
        }
        let name = item.get("Name").and_then(|v| v.as_str()).unwrap_or("");
        if !name.to_lowercase().contains("mmproj") || !name.to_lowercase().ends_with(".gguf") {
            continue;
        }
        // Path 校验同目录（部分版本 Path 含仓库前缀，宽松匹配：尾段等于 Name 即可）
        if let Some(path) = item.get("Path").and_then(|v| v.as_str()) {
            let tail = path.rsplit('/').next().unwrap_or(path);
            if tail != name {
                continue;
            }
            // 若 Path 去掉尾部文件名后的父段与目标目录不一致（且双方都不是空/根），跳过
            let parent = &path[..path.len() - name.len()].trim_end_matches('/');
            if !parent.is_empty() && *parent != dir && !parent.ends_with(dir) {
                warn!("[custom-model] ModelScope 树路径目录不一致: {} vs {}", parent, dir);
            }
        }
        let size = item.get("Size").and_then(|v| v.as_u64()).unwrap_or(0);
        if size == 0 {
            continue;
        }
        if best.as_ref().map(|(_, b)| size < *b).unwrap_or(true) {
            best = Some((name.to_string(), size));
        }
    }
    best
}

/// 网络嗅探主模型大小与同目录最小投影（mmproj）文件大小，不下载任何内容。
/// 返回 (主模型大小, 投影 (文件名, 大小))，探测失败项为 None。
pub async fn sniff_model(
    client: &reqwest::Client,
    parsed: &ParsedModelUrl,
    resolve_url: &str,
) -> (Option<u64>, Option<(String, u64)>) {
    // 1. 主模型大小（HEAD resolve URL）；ModelScope 的 HEAD 探测常被 CDN 拦截（无 content-length），
    //    失败时回退到仓库树 API 按 Name 精确匹配读取 Size 字段
    let mut main_size = probe_file_size(client, resolve_url).await;
    if main_size.is_none() && parsed.source == "modelscope" {
        let dir = parent_dir_of(&parsed.file_path);
        let url = format!(
            "https://modelscope.cn/api/v1/models/{}/repo/tree?Revision={}&Path={}",
            parsed.repo,
            parsed.rev,
            urlencoding(&dir)
        );
        if let Ok(resp) = client.get(&url).send().await {
            if let Ok(body) = resp.json::<Value>().await {
                main_size = parse_modelscope_tree_for_main_file(&body, &dir, &parsed.file_name);
            }
        }
    }
    if main_size.is_none() {
        warn!("[custom-model] 主模型大小嗅探失败: {}", parsed.file_name);
    }

    // 2. 同目录最小 mmproj（仓库树 API）
    let dir = parent_dir_of(&parsed.file_path);
    let mmproj = match parsed.source {
        "modelscope" => {
            let url = format!(
                "https://modelscope.cn/api/v1/models/{}/repo/tree?Revision={}&Path={}",
                parsed.repo,
                parsed.rev,
                urlencoding(&dir)
            );
            match client.get(&url).send().await {
                Ok(resp) => match resp.json::<Value>().await {
                    Ok(body) => parse_modelscope_tree_for_mmproj(&body, &dir),
                    Err(e) => {
                        warn!("[custom-model] ModelScope 树响应解析失败: {}", e);
                        None
                    }
                },
                Err(e) => {
                    warn!("[custom-model] ModelScope 树请求失败: {}", e);
                    None
                }
            }
        }
        _ => {
            let url = format!(
                "https://huggingface.co/api/models/{}/tree/{}?recursive=true",
                parsed.repo, parsed.rev
            );
            match client.get(&url).send().await {
                Ok(resp) => match resp.json::<Value>().await {
                    Ok(body) => parse_hf_tree_for_mmproj(&body, &dir),
                    Err(e) => {
                        warn!("[custom-model] HuggingFace 树响应解析失败: {}", e);
                        None
                    }
                },
                Err(e) => {
                    warn!("[custom-model] HuggingFace 树请求失败: {}", e);
                    None
                }
            }
        }
    };

    (main_size, mmproj)
}

/// 极简 URL 编码（仅处理树 API 的 Path 查询参数中的特殊字符）
fn urlencoding(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b'_' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modelscope_file_view_url() {
        let p = parse_model_url(
            "https://modelscope.cn/models/Abiray/Qwen-Image-2.1-GGUF/file/view/master/qwen_image_2.1_Q4_K_S.gguf",
        )
        .unwrap();
        assert_eq!(p.source, "modelscope");
        assert_eq!(p.repo, "Abiray/Qwen-Image-2.1-GGUF");
        assert_eq!(p.rev, "master");
        assert_eq!(p.file_name, "qwen_image_2.1_Q4_K_S.gguf");
        assert_eq!(build_resolve_url(&p), "https://modelscope.cn/models/Abiray/Qwen-Image-2.1-GGUF/resolve/master/qwen_image_2.1_Q4_K_S.gguf");
    }

    #[test]
    fn parses_huggingface_blob_url() {
        let p = parse_model_url(
            "https://huggingface.co/HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF/blob/main/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf",
        )
        .unwrap();
        assert_eq!(p.source, "huggingface");
        assert_eq!(p.rev, "main");
        assert_eq!(p.file_name, "Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf");
    }

    #[test]
    fn parses_huggingface_resolve_url() {
        let p = parse_model_url(
            "https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/resolve/main/MiniCPM5-2B-Q4_K_M.gguf",
        )
        .unwrap();
        assert_eq!(p.repo, "openbmb/MiniCPM5-2B-GGUF");
        assert_eq!(p.file_path, "MiniCPM5-2B-Q4_K_M.gguf");
        assert_eq!(build_resolve_url(&p), "https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/resolve/main/MiniCPM5-2B-Q4_K_M.gguf");
    }

    #[test]
    fn rejects_unknown_host_and_short_paths() {
        assert!(parse_model_url("https://evil.example.com/a/b/c/d/e.gguf").is_err());
        assert!(parse_model_url("https://huggingface.co/org/repo").is_err());
        assert!(parse_model_url("").is_err());
    }

    #[test]
    fn build_entry_prefers_quant_tag_then_filename() {
        let p = parse_model_url(
            "https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/blob/main/MiniCPM5-2B-Q4_K_M.gguf",
        )
        .unwrap();
        let entry = build_entry(&p, build_resolve_url(&p), Some("q4_k_m".into()), Some(100), Some(("mmproj-x.gguf".into(), 50)));
        assert_eq!(entry.id, "openbmb/MiniCPM5-2B-GGUF:Q4_K_M");
        assert_eq!(entry.total_size, Some(150));
        assert_eq!(entry.name, "MiniCPM5-2B");

        // 非标准量化（Q4_K_P）识别失败时回退完整文件名作为下载 tag
        let p2 = parse_model_url(
            "https://huggingface.co/HauhauCS/Repo-GGUF/blob/main/Model-Q4_K_P.gguf",
        )
        .unwrap();
        let e2 = build_entry(&p2, build_resolve_url(&p2), None, Some(7), None);
        assert_eq!(e2.id, "HauhauCS/Repo-GGUF:Model-Q4_K_P.gguf");
        assert_eq!(e2.total_size, Some(7));
        assert_eq!(e2.quant, None);
    }

    #[test]
    fn hf_tree_finds_smallest_mmproj_in_same_dir() {
        let body: Value = json!([
            {"type":"file","path":"MiniCPM5-2B-Q4_K_M.gguf","size":1000},
            {"type":"file","path":"mmproj-BF16.gguf","lfs":{"size":900000}},
            {"type":"file","path":"mmproj-F16.gguf","lfs":{"size":1800000}},
            {"type":"file","path":"sub/mmproj-tiny.gguf","size":10},
        ]);
        let found = parse_hf_tree_for_mmproj(&body, ".").unwrap();
        assert_eq!(found.0, "mmproj-BF16.gguf");
        assert_eq!(found.1, 900000);
    }

    #[test]
    fn modelscope_tree_finds_smallest_mmproj() {
        let body: Value = json!({
            "Data": {
                "Files": [
                    {"Name":"main.gguf","Path":"main.gguf","Size":5000,"Type":"blob"},
                    {"Name":"mmproj-f16.gguf","Path":"mmproj-f16.gguf","Size":800000,"Type":"blob"},
                    {"Name":"mmproj-q8.gguf","Path":"mmproj-q8.gguf","Size":400000,"Type":"blob"},
                    {"Name":"docs","Path":"docs","Type":"tree"}
                ]
            }
        });
        let found = parse_modelscope_tree_for_mmproj(&body, ".").unwrap();
        assert_eq!(found.0, "mmproj-q8.gguf");
        assert_eq!(found.1, 400000);
    }

    #[test]
    fn parent_dir_helper() {
        assert_eq!(parent_dir_of("b.gguf"), ".");
        assert_eq!(parent_dir_of("a/b.gguf"), "a");
        assert_eq!(parent_dir_of("quant/b.gguf"), "quant");
    }
}
