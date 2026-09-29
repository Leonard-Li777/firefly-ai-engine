// win_proc.rs
// Windows 子进程创建标志：统一抑制控制台窗口闪烁
//
// 背景：llama-server / fastfetch / nvidia-smi / llama-model-download 等均为控制台子系统程序，
// 由 GUI 宿主（firefly-ai-engine）CreateProcess 时不带 CREATE_NO_WINDOW 会瞬间弹出命令行窗口。
// 桌面端静默拉起引擎时用户会看到「多个命令行窗口闪过」，故所有子进程创建统一套用本模块。

/// Windows CreateProcess 标志：不创建控制台窗口
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 为 tokio 子进程附加「不弹控制台」标志（非 Windows 平台为空操作）
#[cfg(windows)]
pub fn apply_no_window(cmd: &mut tokio::process::Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn apply_no_window(_cmd: &mut tokio::process::Command) {}

/// 为 std 子进程附加「不弹控制台」标志（非 Windows 平台为空操作）
#[cfg(windows)]
pub fn apply_no_window_std(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn apply_no_window_std(_cmd: &mut std::process::Command) {}

// ============================================================================
// Windows 作业对象 (Job Object) 守护与残留孤儿进程清理
// ============================================================================

#[cfg(windows)]
struct SafeJobHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for SafeJobHandle {}
#[cfg(windows)]
unsafe impl Sync for SafeJobHandle {}

#[cfg(windows)]
static GLOBAL_JOB: std::sync::OnceLock<Option<SafeJobHandle>> = std::sync::OnceLock::new();

/// 获取或创建全局单例 Job Object，配置 KILL_ON_JOB_CLOSE 属性
#[cfg(windows)]
fn get_or_create_job_object() -> Option<windows_sys::Win32::Foundation::HANDLE> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let opt = GLOBAL_JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() || job == INVALID_HANDLE_VALUE {
            tracing::warn!("创建 Windows Job Object 失败");
            return None;
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let res = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );

        if res == 0 {
            tracing::warn!("配置 Job Object 关联终止失败");
            CloseHandle(job);
            return None;
        }

        tracing::info!("Windows Job Object 创建并配置成功 (KILL_ON_JOB_CLOSE 已激活)");
        Some(SafeJobHandle(job))
    });

    opt.as_ref().map(|s| s.0)
}

/// 将子进程绑定到全局 Job Object 中。
/// 当父进程退出、崩溃或因热更新被强杀时，Windows 内核将强制同时杀灭所有绑定的子进程。
pub fn assign_pid_to_job(pid: u32) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        if let Some(job) = get_or_create_job_object() {
            unsafe {
                let proc_handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if !proc_handle.is_null() && proc_handle != INVALID_HANDLE_VALUE {
                    let res = AssignProcessToJobObject(job, proc_handle);
                    if res == 0 {
                        tracing::warn!("将进程 pid={} 加入 Job Object 失败", pid);
                    } else {
                        tracing::info!(
                            "成功将 llama-server.exe (pid={}) 绑定至 Windows Job Object 守护",
                            pid
                        );
                    }
                    CloseHandle(proc_handle);
                } else {
                    tracing::warn!("打开子进程 pid={} 句柄失败，无法绑定 Job Object", pid);
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
}

/// 扫描并强杀系统中残留的 llama-server 孤儿进程（严格控制单例运行）
///
/// 当因为历史热更新重启、宿主异常退出或模型切换残留时，
/// 本函数会遍历系统进程列表，终结除 `exclude_pid` 之外的所有 `llama-server.exe` 进程，
/// 确保启动新实例时端口与显存被彻底释放。
pub fn kill_stale_llama_servers(exclude_pid: Option<u32>) -> usize {
    let mut killed_count = 0;
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
            PROCESS_TERMINATE,
        };

        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
                tracing::warn!("获取系统进程快照失败，跳过残留进程清理");
                return 0;
            }

            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    let pid = entry.th32ProcessID;
                    let should_skip = exclude_pid.map(|ex| ex == pid).unwrap_or(false);

                    if !should_skip && pid > 4 {
                        // 提取进程名称
                        let name_len = entry
                            .szExeFile
                            .iter()
                            .position(|&c| c == 0)
                            .unwrap_or(entry.szExeFile.len());
                        let proc_name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);

                        if proc_name.eq_ignore_ascii_case("llama-server.exe")
                            || proc_name.eq_ignore_ascii_case("llama-server")
                        {
                            tracing::warn!(
                                "发现残留孤儿进程: {} (pid={})，正在执行清理与显存释放...",
                                proc_name,
                                pid
                            );
                            let h_proc = OpenProcess(
                                PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                                0,
                                pid,
                            );
                            if !h_proc.is_null() && h_proc != INVALID_HANDLE_VALUE {
                                if TerminateProcess(h_proc, 1) != 0 {
                                    // 最多等待 2 秒确保其彻底退出并释放显存
                                    WaitForSingleObject(h_proc, 2000);
                                    tracing::info!("成功终结残留进程: pid={}", pid);
                                    killed_count += 1;
                                } else {
                                    tracing::warn!("终止残留进程 pid={} 失败", pid);
                                }
                                CloseHandle(h_proc);
                            }
                        }
                    }

                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = exclude_pid;
    }

    killed_count
}

