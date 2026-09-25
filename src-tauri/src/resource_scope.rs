// resource_scope.rs
// 资源查找范围约束：仅「自身安装目录」与「用户数据目录」
// 禁止基于 CWD / exe 祖先向上逐级探测；禁止把宿主工程（如 desktop）的共享资源根当作安装目录。

use std::path::{Path, PathBuf};

/// 引擎用户数据目录名
pub const APP_DATA_DIR_NAME: &str = "com.firefly.ai-engine";

/// 是否为标准 macOS 应用包内的 Resources 目录（Contents/MacOS → Contents/Resources）
fn is_macos_bundle_resources(exe_dir: &Path, candidate: &Path) -> bool {
    if !exe_dir.file_name().map(|n| n == "MacOS").unwrap_or(false) {
        return false;
    }
    if !candidate.file_name().map(|n| n == "Resources").unwrap_or(false) {
        return false;
    }
    match (exe_dir.parent(), candidate.parent()) {
        (Some(e), Some(c)) => e == c && e.file_name().map(|n| n == "Contents").unwrap_or(false),
        _ => false,
    }
}

/// 去掉 Windows `\\?\` 扩展前缀，便于同一目录的两种表示做包含判断
fn strip_extended_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(stripped) => PathBuf::from(stripped),
        None => path.to_path_buf(),
    }
}

/// 判断 resource_dir 是否属于本引擎自身安装树（位于 exe 目录之下）
/// 比较前去掉 `\\?\` 前缀；Windows 下忽略大小写（仅目录归属判定，不做分隔符转换）
fn is_under_exe_dir(resource_dir: &Path, exe_dir: &Path) -> bool {
    let res = strip_extended_prefix(resource_dir);
    let exe = strip_extended_prefix(exe_dir);
    if cfg!(windows) {
        let res_l = PathBuf::from(res.to_string_lossy().to_lowercase());
        let exe_l = PathBuf::from(exe.to_string_lossy().to_lowercase());
        res_l == exe_l || res_l.starts_with(&exe_l)
    } else {
        res == exe || res.starts_with(&exe)
    }
}

/// 计算允许的「自身安装目录」搜索根。
///
/// 规则：
/// 1. 以可执行文件所在目录为锚点，绝不向父级/祖先目录扩散
/// 2. macOS .app 包内标准 Contents/Resources（固定一步包内布局，非任意向上）
/// 3. Tauri resource_dir 仅当位于 exe 目录之下时才采纳；
///    否则（例如宿主 desktop 的共享 extraResources）一律丢弃。
/// 4. debug 构建额外锚定本项目根（编译期 CARGO_MANIFEST_DIR），覆盖 cargo tauri dev 的
///    `build/extraResources` 资源拓扑——这是引擎自身资源，不是宿主 desktop。
pub fn allowed_install_roots(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let exe_dir = exe_dir.to_path_buf();
            push_unique(&mut roots, exe_dir.clone());

            // macOS 应用包标准资源目录（仅 .app/Contents/MacOS → .app/Contents/Resources）
            if let Some(contents) = exe_dir.parent() {
                let resources = contents.join("Resources");
                if is_macos_bundle_resources(&exe_dir, &resources) {
                    push_unique(&mut roots, resources);
                }
            }

            if let Some(res) = resource_dir {
                let accept = is_under_exe_dir(res, &exe_dir) || is_macos_bundle_resources(&exe_dir, res);
                if accept {
                    push_unique(&mut roots, res.to_path_buf());
                }
            }
        }
    }

    // 开发态：编译期锚定本项目根（apps/firefly-ai-engine），非运行时向上探测
    #[cfg(debug_assertions)]
    {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        push_unique(&mut roots, project_root);
        if let Some(res) = resource_dir {
            push_unique(&mut roots, res.to_path_buf());
        }
    }

    roots
}

/// 安装目录下标准 bin 子路径（不向父级扩散）
fn install_bin_subpaths(root: &Path) -> Vec<PathBuf> {
    vec![
        root.join("build").join("extraResources").join("bin"),
        root.join("extraResources").join("bin"),
        root.join("bin"),
        root.join("resources").join("bin"),
    ]
}

/// 允许的安装目录 bin 搜索目录列表
pub fn allowed_install_bin_dirs(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for root in allowed_install_roots(resource_dir) {
        for bin in install_bin_subpaths(&root) {
            push_unique(&mut dirs, bin);
        }
    }
    dirs
}

/// 用户数据目录根（%APPDATA%/com.firefly.ai-engine）
pub fn user_data_root() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(APP_DATA_DIR_NAME))
}

/// 允许的用户数据目录 bin 搜索目录列表
pub fn allowed_user_data_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(root) = user_data_root() {
        push_unique(&mut dirs, root.join("bin"));
        push_unique(&mut dirs, root.join("extraResources").join("bin"));
        push_unique(&mut dirs, root.join("engines"));
    }
    // 既有兼容：桌面产品用户数据下的 bin（fastfetch 等）
    if let Some(data) = dirs::data_dir() {
        push_unique(&mut dirs, data.join("firefly-ai-folder").join("bin"));
    }
    dirs
}

fn push_unique(list: &mut Vec<PathBuf>, path: PathBuf) {
    let key = path_dedup_key(&path);
    if list.iter().any(|p| path_dedup_key(p) == key) {
        return;
    }
    list.push(path);
}

/// 搜索根去重键：Windows 下忽略大小写与 `\\?\` 扩展前缀及末尾斜杠
/// （仅用于候选目录去重，不参与安全比较层的路径等价判定）
fn path_dedup_key(path: &Path) -> String {
    let mut s = path.to_string_lossy().into_owned();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        s = stripped.to_string();
    }
    while s.ends_with('\\') || s.ends_with('/') {
        s.pop();
    }
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_macos_bundle_resources_detection() {
        let exe_dir = Path::new("/Applications/Firefly AI Engine.app/Contents/MacOS");
        let res = Path::new("/Applications/Firefly AI Engine.app/Contents/Resources");
        assert!(is_macos_bundle_resources(exe_dir, res));

        let not_bundle = Path::new("/Applications/Other.app/Contents/Resources");
        assert!(!is_macos_bundle_resources(exe_dir, not_bundle));
    }

    #[test]
    fn test_reject_host_shared_resource_root() {
        // 模拟 sidecar：exe 在 .../extraResources/bin/firefly-ai-engine，
        // resource_dir 解析到宿主 desktop 的共享 .../extraResources
        let exe_dir = Path::new("D:/apps/desktop/build/extraResources/bin/firefly-ai-engine");
        let host_res = Path::new("D:/apps/desktop/build/extraResources");
        assert!(!is_under_exe_dir(host_res, exe_dir));
    }

    #[test]
    fn test_accept_resource_under_exe() {
        let exe_dir = Path::new("C:/Program Files/firefly-ai-engine");
        let res = Path::new("C:/Program Files/firefly-ai-engine/resources");
        assert!(is_under_exe_dir(res, exe_dir));
    }

    #[test]
    fn test_push_unique_dedups_win32_extended_prefix() {
        let mut list = Vec::new();
        push_unique(&mut list, PathBuf::from(r"D:\app\bin"));
        push_unique(&mut list, PathBuf::from(r"\\?\D:\app\bin"));
        push_unique(&mut list, PathBuf::from(r"d:\app\bin\"));
        assert_eq!(list.len(), 1, "应识别为同一搜索根");
    }
}
