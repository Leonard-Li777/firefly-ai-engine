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
