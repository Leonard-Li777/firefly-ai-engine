// stdin_guard.rs
// 宿主生命周期守护：stdin EOF 看门狗
//
// 背景：桌面端（Electron 主进程）以子进程方式静默拉起 firefly-ai-engine。
// Windows 没有「父进程退出即带走子进程」的内核语义，Electron 主进程侧也没有
// Job Object 调用能力（仓库无原生插件）；一旦用户用任务管理器 / `taskkill /F`
// 强杀 Electron 主进程，`will-quit` / `before-quit` 钩子不会执行，
// 引擎与其拉起的 llama-server 就成为孤儿进程，长期占用端口（38400）、
// 模型文件句柄与显存。
//
// 本模块复用 firefly-omni 已确立的约定（`OMNI_WATCH_STDIN=1`）：宿主以管道方式
// 创建本进程 stdin，宿主无论以何种方式消失（正常退出 / 崩溃 / 强杀），
// 管道写端都由内核关闭，本进程随即读到 EOF 并优雅退出；退出时自身持有的
// Job Object 句柄关闭，`KILL_ON_JOB_CLOSE` 生效，llama-server 等孙进程
// 由内核一并清理（见 `win_proc.rs` 的 `assign_pid_to_job`）。

use tauri::AppHandle;

/// 宿主（桌面端）通过该环境变量显式开启 stdin 看门狗。
///
/// 缺省不开启：独立运行、终端调试或以 `cmd /c start` 启动时 stdin 可能立即 EOF，
/// 无条件监听会导致进程刚起来就自我退出。
pub const WATCH_STDIN_ENV: &str = "ENGINE_WATCH_STDIN";

/// 若宿主已声明 `ENGINE_WATCH_STDIN=1`，则启动后台线程监听 stdin EOF，读到即优雅退出。
///
/// 该函数不阻塞调用方：Tauri setup 阶段调用后立即返回，看门狗在独立线程中等待。
pub fn spawn_if_requested(app_handle: AppHandle) {
    let enabled = std::env::var(WATCH_STDIN_ENV)
        .map(|v| v == "1")
        .unwrap_or(false);
    if !enabled {
        tracing::debug!("未设置 {}，跳过宿主 stdin 看门狗", WATCH_STDIN_ENV);
        return;
    }

    let spawned = std::thread::Builder::new()
        .name("host-stdin-guard".to_string())
        .spawn(move || {
            use std::io::Read;

            let mut stdin = std::io::stdin();
            let mut buf = [0u8; 1];
            loop {
                match stdin.read(&mut buf) {
                    // 真正读到 EOF：宿主进程已销毁，管道写端被内核关闭
                    Ok(0) => break,
                    // 宿主写入了心跳或数据，继续等待
                    Ok(_) => continue,
                    // 管道断开等错误，与 EOF 等价处理
                    Err(e) => {
                        tracing::warn!("读取宿主 stdin 失败，按宿主已退出处理: {}", e);
                        break;
                    }
                }
            }

            tracing::warn!("宿主 stdin 已关闭（桌面端进程已退出），引擎主动退出以避免孤儿残留");
            app_handle.exit(0);

            // 兜底：托盘常驻 / 隐藏窗口可能让事件循环未及时响应退出请求，
            // 超时后强制结束进程，确保 Job Object 句柄关闭、llama-server 被内核回收。
            std::thread::sleep(std::time::Duration::from_secs(3));
            tracing::error!("优雅退出未在 3s 内完成，强制终止进程");
            std::process::exit(0);
        });

    if let Err(e) = spawned {
        tracing::warn!("启动宿主 stdin 看门狗线程失败: {}", e);
    }
}
