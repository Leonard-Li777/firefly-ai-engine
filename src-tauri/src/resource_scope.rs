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
///
/// 历史说明：曾额外锚定编译期 `CARGO_MANIFEST_DIR/..`（引擎工程根）以覆盖开发态资源拓扑。
/// 该锚点已移除——引擎统一由 desktop 部署到集成目录
/// `apps/desktop/build/extraResources/bin/firefly-ai-engine/` 并以最终发布形态运行，
/// 开发态资源由 `_up_/build/extraResources`（`cargo tauri dev`）或集成目录内的 1:1 镜像提供，
/// 二者物理上都在 exe 目录之内。
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

    roots
}

/// 安装目录下标准 bin 子路径（不向父级扩散）
///
/// - `build/extraResources/bin`：desktop 集成目录 1:1 镜像（ADR-0033）与引擎自身
///   `pnpm setup-resources` 产物落点
/// - `_up_/build/extraResources/bin`：Tauri 对 `../build/extraResources/**/*` 资源模式的
///   归一化落点（见 tauri-utils `ResourcePaths`：`..` 段被改写为 `_up_`），
///   覆盖 `cargo tauri dev` 与引擎独立打包形态。该目录**物理上位于 exe 目录之内**，
///   与「向父级探测」有本质区别。
fn install_bin_subpaths(root: &Path) -> Vec<PathBuf> {
    vec![
        root.join("build").join("extraResources").join("bin"),
        root.join("_up_").join("build").join("extraResources").join("bin"),
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
///
/// 仅限引擎自身命名空间 `com.firefly.ai-engine`。
/// 不再包含宿主 desktop 的 `%APPDATA%/firefly-ai-folder/bin`：
/// 该目录属宿主应用的用户数据，不属于「引擎自身安装目录 / 自身用户数据目录」两类白名单。
pub fn allowed_user_data_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(root) = user_data_root() {
        push_unique(&mut dirs, root.join("bin"));
        push_unique(&mut dirs, root.join("extraResources").join("bin"));
        push_unique(&mut dirs, root.join("engines"));
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

    #[test]
    fn test_install_roots_never_escape_exe_dir() {
        // 回归：不得再出现 CARGO_MANIFEST_DIR 之类的工程根锚点，
        // 所有安装根都必须落在 exe 目录之内。
        let exe_dir = std::env::current_exe()
            .expect("测试进程应有可执行路径")
            .parent()
            .expect("可执行文件应有父目录")
            .to_path_buf();

        let roots = allowed_install_roots(None);
        assert!(!roots.is_empty(), "至少应包含 exe 所在目录");
        for root in &roots {
            assert!(
                is_under_exe_dir(root, &exe_dir),
                "安装根越出 exe 目录: {root:?}（exe_dir={exe_dir:?}）"
            );
        }
    }

    #[test]
    fn test_host_shared_root_rejected_even_with_debug_build() {
        // 宿主 desktop 的共享 extraResources 一律不得成为安装根（debug 构建同样如此）
        let host_root = PathBuf::from("/repo/apps/desktop/build/extraResources");
        let roots = allowed_install_roots(Some(host_root.as_path()));
        assert!(
            !roots.contains(&host_root),
            "宿主共享资源根不得进入安装根: {roots:?}"
        );
    }

    #[test]
    fn test_integration_layout_maps_to_own_extra_resources() {
        // desktop 集成目录布局：exe 位于 .../extraResources/bin/firefly-ai-engine/
        // 引擎自身资源应解析到同级的 build/extraResources/bin，而不是宿主共享的 bin
        let exe_dir = Path::new("/repo/apps/desktop/build/extraResources/bin/firefly-ai-engine");
        let subpaths = install_bin_subpaths(exe_dir);

        assert!(
            subpaths.contains(&exe_dir.join("build").join("extraResources").join("bin")),
            "应包含集成目录内的 1:1 镜像资源路径"
        );
        assert!(
            !subpaths.contains(&PathBuf::from("/repo/apps/desktop/build/extraResources/bin")),
            "不得包含宿主共享 bin 目录"
        );
    }

    #[test]
    fn test_up_prefix_subpath_covers_tauri_dev_layout() {
        // cargo tauri dev / 引擎独立打包：Tauri 把 ../build/extraResources 归一化为 _up_/
        let exe_dir = Path::new("/repo/apps/firefly-ai-engine/src-tauri/target/debug");
        let subpaths = install_bin_subpaths(exe_dir);
        assert!(
            subpaths.contains(&exe_dir.join("_up_").join("build").join("extraResources").join("bin")),
            "应包含 Tauri `_up_` 归一化资源路径"
        );
    }

    #[test]
    fn test_user_data_dirs_only_engine_namespace() {
        // 用户数据白名单只应落在引擎自身命名空间下，不得指向宿主 desktop 的 firefly-ai-folder
        for dir in allowed_user_data_bin_dirs() {
            let s = dir.to_string_lossy().to_lowercase();
            assert!(
                !s.contains("firefly-ai-folder"),
                "用户数据白名单不得包含宿主 desktop 目录: {dir:?}"
            );
        }
    }
}
