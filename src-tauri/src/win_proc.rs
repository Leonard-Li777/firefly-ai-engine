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
                            "成功将进程 (pid={}) 绑定至 Windows Job Object 守护",
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

/// 默认纳入清理巡检的推理 Worker 进程名清单（支持带/不带 .exe 与大小写不敏感比对）
pub const DEFAULT_WORKER_NAMES: [&str; 10] = [
    "llama-server.exe",
    "llama-server",
    "audio-worker.exe",
    "audio-worker",
    "audiocpp_server.exe",
    "audiocpp_server",
    "diffusion-worker.exe",
    "diffusion-worker",
    "sd-server.exe",
    "sd-server",
];

/// 扫描并强杀系统中残留的 Worker **孤儿**进程
///
/// 「孤儿」判定（缺一不可）：
/// 1. 进程名匹配 `target_names` 中任意一个；
/// 2. 不是调用方自己的子进程（`exclude_pid`）；
/// 3. **父进程已经退出**（父进程仍存活则一律跳过）。
///
/// 第 3 条是硬约束：早期实现会无差别终结所有 `llama-server.exe`，
/// 于是「另一个仍活着的引擎宿主正在服务的推理进程」会被新建实例顺手杀掉——
/// 表现为服务端 stderr 毫无输出、`[guard] llama-server 异常退出: ExitStatus(1)`
/// （`TerminateProcess(h, 1)` 的退出码正是 1），
/// 上层任何一次请求失败触发的重复拉起都能造成这种误杀。
/// 现在只清理真正无人认领的残留，多实例并存也不会互相残杀。
pub fn kill_stale_workers(target_names: &[&str], exclude_pid: Option<u32>) -> usize {
    let mut killed_count = 0;
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE, STILL_ACTIVE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, TerminateProcess, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        };

        /// 父进程是否仍然存活（拿不到句柄视为已退出）
        unsafe fn is_process_alive(pid: u32) -> bool {
            if pid == 0 {
                return false;
            }
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            // STILL_ACTIVE 在 windows-sys 中是 i32(259)，退出码是 u32
            ok != 0 && code == STILL_ACTIVE as u32
        }

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

                        let is_target = target_names.iter().any(|target| {
                            proc_name.eq_ignore_ascii_case(target)
                                || proc_name.eq_ignore_ascii_case(&format!("{}.exe", target))
                        });

                        if is_target {
                            // 父进程仍存活 ⇒ 这个 Worker 有主，属于另一个仍在工作的宿主，绝不可抢杀。
                            if !is_process_alive(entry.th32ParentProcessID) {
                                tracing::warn!(
                                    "发现残留孤儿 Worker 进程: {} (pid={})，正在执行清理与显存释放...",
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
                                        tracing::info!("成功终结残留 Worker 进程: pid={}", pid);
                                        killed_count += 1;
                                    } else {
                                        tracing::warn!("终止残留 Worker 进程 pid={} 失败", pid);
                                    }
                                    CloseHandle(h_proc);
                                }
                            } else {
                                tracing::debug!(
                                    "跳过仍有父进程守护的 Worker {} (pid={}, parent={})",
                                    proc_name,
                                    pid,
                                    entry.th32ParentProcessID
                                );
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
        let _ = (target_names, exclude_pid);
    }

    killed_count
}

/// 扫描并强杀系统中残留的 llama-server **孤儿**进程（向下兼容包装）
pub fn kill_stale_llama_servers(exclude_pid: Option<u32>) -> usize {
    kill_stale_workers(&DEFAULT_WORKER_NAMES, exclude_pid)
}

/// 查询当前 Job Object 中挂载的全部活跃子进程 PID
#[cfg(windows)]
pub fn get_job_process_ids() -> Vec<u32> {
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicProcessIdList, QueryInformationJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    };

    let mut pids = Vec::new();
    if let Some(job) = get_or_create_job_object() {
        unsafe {
            // JOBOBJECT_BASIC_PROCESS_ID_LIST 头包含两个 DWORD/ULONG_PTR 字段，其末尾 ProcessIdList 长度为 1。
            // 变长部分分配容纳最多 512 个 PID 的缓冲区。
            let max_pids: usize = 512;
            let elem_size = std::mem::size_of::<usize>();
            let base_size = std::mem::size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
            let total_size = base_size + elem_size * (max_pids.saturating_sub(1));
            let mut buf = vec![0u8; total_size];
            let mut ret_len = 0u32;

            let ok = QueryInformationJobObject(
                job,
                JobObjectBasicProcessIdList,
                buf.as_mut_ptr() as *mut _,
                total_size as u32,
                &mut ret_len,
            );

            if ok != 0 {
                let list_ptr = buf.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST;
                let count = (*list_ptr).NumberOfProcessIdsInList as usize;
                let process_id_list_ptr = std::ptr::addr_of!((*list_ptr).ProcessIdList) as *const usize;
                for i in 0..count.min(max_pids) {
                    let pid_val = *process_id_list_ptr.add(i);
                    if pid_val > 0 {
                        pids.push(pid_val as u32);
                    }
                }
            } else {
                tracing::debug!("QueryInformationJobObject 返回 0 (可能尚无进程挂载或已终止)");
            }
        }
    }
    pids
}

#[cfg(not(windows))]
pub fn get_job_process_ids() -> Vec<u32> {
    Vec::new()
}

/// 获取指定 PID 对应的可执行文件完整路径
#[cfg(windows)]
fn get_process_exe_path(pid: u32) -> Option<std::path::PathBuf> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if ok != 0 && len > 0 {
            let path_str = String::from_utf16_lossy(&buf[..len as usize]);
            Some(std::path::PathBuf::from(path_str))
        } else {
            None
        }
    }
}

/// 判断可执行文件路径是否位于指定目录内（Windows 大小写不敏感且统一正反斜杠）
fn is_path_under_directory(exe_path: &std::path::Path, dir: &std::path::Path) -> bool {
    let exe_str = exe_path.to_string_lossy().replace('/', "\\").to_lowercase();
    let dir_str = dir.to_string_lossy().replace('/', "\\").to_lowercase();
    let dir_trimmed = dir_str.trim_end_matches('\\');
    if exe_str == dir_trimmed {
        return true;
    }
    let with_sep = format!("{}\\", dir_trimmed);
    exe_str.starts_with(&with_sep)
}

/// 终结指定目录下正在运行的属于 Job Object 的活跃子进程，并轮询等待退出
///
/// 注意：严禁对全局 `GLOBAL_JOB` 句柄直接调用 `TerminateJobObject`，
/// 否则将导致全局 Job 彻底失效并误杀所有并发运行的无关 Worker。
/// 本函数通过 PID 遍历定向过滤与强杀，附带超时等待。
pub fn terminate_processes_in_dir(dir: &std::path::Path, timeout_ms: u32) -> usize {
    let mut terminated_count = 0;
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, WaitForSingleObject,
            PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        };

        let pids = get_job_process_ids();
        for pid in pids {
            if let Some(exe_path) = get_process_exe_path(pid) {
                if is_path_under_directory(&exe_path, dir) {
                    tracing::warn!(
                        "发现位于待清理目录 {:?} 下的活跃子进程 (pid={}): {:?}，正在定向强杀...",
                        dir,
                        pid,
                        exe_path
                    );
                    unsafe {
                        let h_proc = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid);
                        if !h_proc.is_null() && h_proc != INVALID_HANDLE_VALUE {
                            if TerminateProcess(h_proc, 1) != 0 {
                                WaitForSingleObject(h_proc, timeout_ms);
                                tracing::info!("成功终结旧目录进程: pid={}", pid);
                                terminated_count += 1;
                            } else {
                                tracing::warn!("终止旧目录进程 pid={} 失败", pid);
                            }
                            CloseHandle(h_proc);
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (dir, timeout_ms);
    }
    terminated_count
}

/// 原子轮转并清理旧版本引擎目录：
/// 1. 快照并精准强杀属于该目录的活跃子进程，等待退出；
/// 2. 将目标目录原子重命名为 `<target>.old.<pid>.<timestamp>`，解除 Windows 句柄锁绑定；
/// 3. 在后台异步线程执行 `remove_dir_all` 物理擦除目录，若因偶发锁死失败则记录日志，由下次启动自愈兜底。
pub async fn atomic_retire_and_remove_dir(dir: &std::path::Path) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    // 1. 定向查杀该目录下的活跃子进程（2 秒硬超时上限）
    let killed = terminate_processes_in_dir(dir, 2000);
    if killed > 0 {
        tracing::info!("[原子清理] 在目录 {:?} 中终止了 {} 个活跃进程", dir, killed);
    }

    // 2. 生成唯一的重命名目标
    let parent = dir.parent().unwrap_or_else(|| std::path::Path::new("."));
    let dir_name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("engine");
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let retired_dir = parent.join(format!("{}.old.{}.{}", dir_name, std::process::id(), timestamp));

    // 3. 尝试原子重命名（尝试 3 次，间隔 100ms）
    let mut rename_succeeded = false;
    for attempt in 1..=3 {
        match std::fs::rename(dir, &retired_dir) {
            Ok(_) => {
                tracing::info!(
                    "[原子清理] 目录已重命名隔离: {:?} -> {:?}",
                    dir,
                    retired_dir
                );
                rename_succeeded = true;
                break;
            }
            Err(e) => {
                tracing::warn!(
                    "[原子清理] 重命名隔离失败 (尝试 {}/3): {:?}, err: {}",
                    attempt,
                    dir,
                    e
                );
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }

    let target_to_delete = if rename_succeeded {
        retired_dir
    } else {
        dir.to_path_buf()
    };

    // 4. 异步物理删除
    tokio::task::spawn_blocking(move || {
        let max_delete_attempts = 3;
        for attempt in 1..=max_delete_attempts {
            match std::fs::remove_dir_all(&target_to_delete) {
                Ok(_) => {
                    tracing::info!("[原子清理] 物理删除完成: {:?}", target_to_delete);
                    return;
                }
                Err(e) => {
                    if attempt < max_delete_attempts {
                        std::thread::sleep(std::time::Duration::from_millis(300));
                    } else {
                        tracing::warn!(
                            "[原子清理] 物理删除未能完全清除 (将在下次启动自愈): {:?}, err: {}",
                            target_to_delete,
                            e
                        );
                    }
                }
            }
        }
    });

    Ok(())
}

/// 原生提取指定进程的真实无符号 32 位退出码（保留 NTSTATUS，如 0xC0000005，防止被截断）
pub fn get_process_raw_exit_code(pid: u32) -> Option<u32> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return None;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            if ok != 0 {
                Some(code)
            } else {
                None
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

