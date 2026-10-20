// engine/log_store.rs
//! 运行时日志落盘（llama-server stdout/stderr + 守护器生命周期事件）
//!
//! 设计目标：**崩溃可追溯**。
//!
//! 原实现只把子进程输出放进内存环形缓冲（2000 行），宿主进程一旦崩溃 / 被重启，
//! 日志整段消失，事后完全无从排查「上次为什么挂」。这里额外维护一份 append-only
//! 文件副本：
//!
//! - 只追加，绝不截断（唯一例外：用户主动点「清空日志」）
//! - 单文件超过 [`MAX_FILE_BYTES`] 滚动为 `runtime.log.1`（覆盖更早的一代）
//! - 启动时回读尾部若干行灌回内存缓冲，界面能直接看到崩溃前最后一段
//!
//! 降级策略：任何 IO 错误都只让落盘能力失效（静默），绝不影响引擎启停。

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Local;

/// 单文件上限（8MB）。llama-server 冷载日志通常只有数十 KB，8MB 足以容纳数十次启动。
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// 当前文件名（滚动备份为 `<FILE_NAME>.1`）
const FILE_NAME: &str = "runtime.log";

/// 运行时日志文件存储（线程安全，进程内单实例）
pub struct RuntimeLogStore {
    path: PathBuf,
    /// 追加写句柄。写失败时置空，下次 append 自动重开。
    file: Mutex<Option<File>>,
}

impl RuntimeLogStore {
    /// 在 `dir` 下打开（必要时创建目录与文件）。
    ///
    /// 目录 / 文件不可写时返回 `None`，调用方应把落盘视为可选增强能力。
    pub fn open(dir: &Path) -> Option<Self> {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("[log-store] 创建日志目录失败 {:?}: {}", dir, e);
            return None;
        }
        let path = dir.join(FILE_NAME);
        let file = Self::open_append(&path)?;
        Some(Self {
            path,
            file: Mutex::new(Some(file)),
        })
    }

    fn open_append(path: &Path) -> Option<File> {
        match OpenOptions::new().create(true).append(true).open(path) {
            Ok(f) => Some(f),
            Err(e) => {
                eprintln!("[log-store] 打开日志文件失败 {:?}: {}", path, e);
                None
            }
        }
    }

    /// 日志文件绝对路径（供 UI / 排查提示使用）
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 追加一行（自动补换行），超过上限先滚动
    pub fn append(&self, line: &str) {
        let Ok(mut guard) = self.file.lock() else {
            return;
        };
        self.rotate_if_needed(&mut guard);
        let Some(f) = guard.as_mut() else {
            return;
        };
        // 写入失败（磁盘满 / 句柄失效）时丢弃句柄，下次 append 会重开
        if f.write_all(line.as_bytes()).is_err()
            || f.write_all(b"\n").is_err()
            || f.flush().is_err()
        {
            *guard = None;
        }
    }

    /// 写入会话分隔标记（带本地时间），让重启后的日志能分辨「上一轮 / 本轮」。
    ///
    /// 返回实际写入的行，便于调用方同步到内存缓冲。
    pub fn append_marker(&self, text: &str) -> String {
        let ts = Local::now().format("%Y-%m-%d %H:%M:%S");
        let line = format!("===== {} {} =====", ts, text);
        self.append(&line);
        line
    }

    /// 回读尾部最多 `max_lines` 行（先读滚动出的上一代，再读当前文件，保证时序）
    pub fn read_tail(&self, max_lines: usize) -> Vec<String> {
        if max_lines == 0 {
            return Vec::new();
        }
        let mut out: VecDeque<String> = VecDeque::with_capacity(max_lines);
        for path in [self.rotated_path(), self.path.clone()] {
            let Ok(file) = File::open(&path) else {
                continue;
            };
            for line in BufReader::new(file).lines() {
                let Ok(line) = line else { break };
                if out.len() == max_lines {
                    out.pop_front();
                }
                out.push_back(line);
            }
        }
        out.into_iter().collect()
    }

    /// 用户主动清空：截断当前文件并删除滚动备份。
    ///
    /// **仅此一处允许破坏历史**——崩溃 / 重启路径一律走 append。
    pub fn clear(&self) {
        let Ok(mut guard) = self.file.lock() else {
            return;
        };
        *guard = None;
        let _ = File::create(&self.path); // truncate
        let _ = std::fs::remove_file(self.rotated_path());
        *guard = Self::open_append(&self.path);
    }

    fn rotated_path(&self) -> PathBuf {
        PathBuf::from(format!("{}.1", self.path.display()))
    }

    /// 超过上限时滚动：当前文件 → `<name>.1`（旧 .1 覆盖），然后重开新文件
    fn rotate_if_needed(&self, guard: &mut Option<File>) {
        if guard.is_none() {
            *guard = Self::open_append(&self.path);
            if guard.is_none() {
                return;
            }
        }
        let too_big = guard
            .as_ref()
            .and_then(|f| f.metadata().ok())
            .map(|m| m.len() >= MAX_FILE_BYTES)
            .unwrap_or(false);
        if !too_big {
            return;
        }

        *guard = None; // 关闭句柄后再改名（Windows 不允许改被占用的文件）
        let rotated = self.rotated_path();
        let _ = std::fs::remove_file(&rotated);
        let _ = std::fs::rename(&self.path, &rotated);
        *guard = Self::open_append(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (tempfile::TempDir, RuntimeLogStore) {
        let dir = tempfile::tempdir().expect("创建临时目录");
        let store = RuntimeLogStore::open(dir.path()).expect("打开日志存储");
        (dir, store)
    }

    /// 追加的内容必须能被回读，且跨实例（模拟进程重启）不丢失。
    #[tokio::test]
    async fn append_survives_reopen() {
        let (dir, store) = temp_store();
        store.append("[stdout] hello");
        store.append("[stderr] boom");
        drop(store);

        let reopened = RuntimeLogStore::open(dir.path()).expect("重新打开");
        assert_eq!(
            reopened.read_tail(10),
            vec!["[stdout] hello".to_string(), "[stderr] boom".to_string()]
        );
    }

    /// read_tail 只保留尾部 max_lines 行，且保持时序。
    #[tokio::test]
    async fn read_tail_keeps_last_lines() {
        let (_dir, store) = temp_store();
        for i in 0..10 {
            store.append(&format!("line-{}", i));
        }
        assert_eq!(
            store.read_tail(3),
            vec!["line-7".to_string(), "line-8".to_string(), "line-9".to_string()]
        );
    }

    /// 只有显式 clear 才允许清空文件。
    #[tokio::test]
    async fn clear_truncates_file() {
        let (_dir, store) = temp_store();
        store.append("before-clear");
        store.clear();
        assert!(store.read_tail(10).is_empty());
        store.append("after-clear");
        assert_eq!(store.read_tail(10), vec!["after-clear".to_string()]);
    }
}
