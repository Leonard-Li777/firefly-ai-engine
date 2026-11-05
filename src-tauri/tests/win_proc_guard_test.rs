// tests/win_proc_guard_test.rs
// Issue 02: Windows Job Object 进程树看门狗与退出快照清理守护测试

use firefly_ai_engine_lib::win_proc::{
    assign_pid_to_job, atomic_retire_and_remove_dir, get_job_process_ids,
    kill_stale_llama_servers, kill_stale_workers, terminate_processes_in_dir,
    DEFAULT_WORKER_NAMES,
};
use std::fs::File;
use std::io::Write;

#[test]
fn test_ac1_kill_stale_workers_idempotent() {
    let current_pid = std::process::id();
    // 自身进程作为排除项，不应发生自残误杀
    let killed = kill_stale_workers(&DEFAULT_WORKER_NAMES, Some(current_pid));
    println!("Idempotent clean killed count: {}", killed);

    // 向下兼容别名验证
    let killed_llama = kill_stale_llama_servers(Some(current_pid));
    println!("Idempotent clean llama-server killed count: {}", killed_llama);
}

#[tokio::test]
async fn test_ac1_assign_pid_to_job_and_query_snapshot() {
    // 启动一个休眠 3 秒的临时子进程
    #[cfg(windows)]
    let mut child = std::process::Command::new("cmd")
        .args(["/c", "ping -n 4 127.0.0.1 >nul"])
        .spawn()
        .expect("启动临时子进程失败");

    #[cfg(not(windows))]
    let mut child = std::process::Command::new("sleep")
        .arg("3")
        .spawn()
        .expect("启动临时子进程失败");

    let pid = child.id();
    assign_pid_to_job(pid);

    #[cfg(windows)]
    {
        // 查询 Job Object 快照
        let pids = get_job_process_ids();
        assert!(
            pids.contains(&pid),
            "Job Object 活跃 PID 列表应包含刚挂载的子进程 pid={}, 当前列表: {:?}",
            pid,
            pids
        );
    }

    // 强杀子进程以便资源释放
    let _ = child.kill();
    let _ = child.wait();
}

#[tokio::test]
async fn test_ac2_terminate_processes_in_dir_empty() {
    let temp_dir = tempfile::tempdir().unwrap();
    let killed = terminate_processes_in_dir(temp_dir.path(), 500);
    assert_eq!(killed, 0, "空目录不应有挂载进程被杀");
}

#[tokio::test]
async fn test_ac2_atomic_retire_and_remove_dir_lifecycle() {
    let temp_dir = tempfile::tempdir().unwrap();
    let sub_dir = temp_dir.path().join("fake_engine_v1");
    std::fs::create_dir_all(&sub_dir).unwrap();

    let dummy_file = sub_dir.join("engine.bin");
    {
        let mut f = File::create(&dummy_file).unwrap();
        f.write_all(b"dummy engine content").unwrap();
    }
    assert!(sub_dir.exists());

    // 执行原子轮转与物理清理
    let res = atomic_retire_and_remove_dir(&sub_dir).await;
    assert!(res.is_ok(), "atomic_retire_and_remove_dir 执行失败: {:?}", res);

    // 原路径应瞬间消失（已重命名移走，解除锁）
    assert!(
        !sub_dir.exists(),
        "原目录应在原子轮转后立即从原路径被移除，以允许新版本引擎写入"
    );

    // 等待后台异步删除线程完成清理
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
}

#[tokio::test]
async fn test_ac2_atomic_retire_non_existent_dir_is_ok() {
    let temp_dir = tempfile::tempdir().unwrap();
    let non_existent = temp_dir.path().join("does_not_exist");
    let res = atomic_retire_and_remove_dir(&non_existent).await;
    assert!(res.is_ok(), "不存在的目录清理应幂等返回 Ok");
}
