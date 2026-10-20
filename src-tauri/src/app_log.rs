// app_log.rs
//! 应用级日志落盘：tracing 输出 + panic 现场
//!
//! 与 `engine::log_store` 的区别：
//! - `log_store::runtime.log`：llama-server 子进程的 stdout/stderr（UI「运行日志」面板）
//! - 本模块 `app.log`：引擎宿主进程自身的 tracing 日志与 panic 现场
//!
//! 两者都是 append-only，崩溃 / 重启都不会清空，用于事后排查「上次为什么挂」。
//!
//! 说明：`panic = "abort"` 的 release 构建里 panic hook 仍会先执行，因此 panic 现场
//! 能被写入文件；但进程被强杀（taskkill / OOM killer）时不会有 panic，只能靠
//! tracing 日志最后几行判断。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 单文件上限（8MB），超过滚动为 `app.log.1`
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static LOG_FILE: Mutex<Option<File>> = Mutex::new(None);

/// 初始化：创建目录、记录启动分隔行。可重复调用（只有首次生效）。
pub fn init(dir: &Path) {
    if LOG_PATH.get().is_some() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("[app-log] 创建日志目录失败 {:?}: {}", dir, e);
        return;
    }
    let path = dir.join("app.log");
    let _ = LOG_PATH.set(path);
    append_line(&format!(
        "===== {} 引擎进程启动 =====",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    ));
}

/// 日志文件路径（未初始化时为 None）
pub fn log_path() -> Option<&'static PathBuf> {
    LOG_PATH.get()
}

/// 追加一行（自动补换行与时间戳前缀）
pub fn append_line(line: &str) {
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    write_bytes(format!("{} {}\n", ts, line).as_bytes());
}

fn write_bytes(buf: &[u8]) {
    let Ok(mut guard) = LOG_FILE.lock() else {
        return;
    };
    if guard.is_none() {
        let Some(path) = LOG_PATH.get() else {
            return;
        };
        rotate_if_needed(path);
        *guard = OpenOptions::new().create(true).append(true).open(path).ok();
    }
    let Some(file) = guard.as_mut() else {
        return;
    };
    if file.write_all(buf).is_err() || file.flush().is_err() {
        *guard = None;
    }
}

fn rotate_if_needed(path: &Path) {
    let too_big = std::fs::metadata(path)
        .map(|m| m.len() >= MAX_FILE_BYTES)
        .unwrap_or(false);
    if !too_big {
        return;
    }
    let rotated = PathBuf::from(format!("{}.1", path.display()));
    let _ = std::fs::remove_file(&rotated);
    let _ = std::fs::rename(path, &rotated);
}

/// 安装 panic hook：把 panic 消息与位置写入 app.log，再交给默认 hook（stderr 行为不变）
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "非字符串 panic payload".to_string()
        };
        append_line(&format!("[panic] {} @ {}", payload, location));
        default_hook(info);
    }));
}

/// tracing 的 `MakeWriter`：把格式化后的日志行写进 app.log
#[derive(Clone, Copy)]
pub struct FileAppender;

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for FileAppender {
    type Writer = AppLogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        AppLogWriter
    }
}

pub struct AppLogWriter;

impl Write for AppLogWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        write_bytes(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if let Ok(mut guard) = LOG_FILE.lock() {
            if let Some(file) = guard.as_mut() {
                let _ = file.flush();
            }
        }
        Ok(())
    }
}
