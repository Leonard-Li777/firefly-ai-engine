// hardware/competitor_detector.rs
//
// GPU 显存竞态进程扫描器
// 在启动模型前非阻塞探测系统内是否存在其他进程大量占用显存（如 ollama, vllm, lmstudio 或游戏等）。
// 发现高显存竞争进程时，记录结构化诊断并广播警告事件，辅助前端与运维排查 OOM 风险。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuCompetitorInfo {
    pub pid: u32,
    pub process_name: String,
    pub used_memory_mb: u64,
}

pub struct CompetitorDetector;

impl CompetitorDetector {
    /// 扫描当前占用显存超过 threshold_mb 的竞争进程（排除指定自身 PID）
    /// 设有 1500ms 超时防挂起保护，并在 Windows 上配置 CREATE_NO_WINDOW
    pub async fn scan_competitors(threshold_mb: u64, exclude_pid: Option<u32>) -> Vec<GpuCompetitorInfo> {
        let mut cmd = tokio::process::Command::new("nvidia-smi");
        cmd.args(&[
            "--query-compute-apps=pid,process_name,used_memory",
            "--format=csv,noheader,nounits",
        ]);

        #[cfg(windows)]
        {
            cmd.creation_flags(crate::win_proc::CREATE_NO_WINDOW);
        }

        let child = cmd.output();
        let output = match tokio::time::timeout(std::time::Duration::from_millis(1500), child).await {
            Ok(Ok(out)) => out,
            Ok(Err(_)) => return vec![],
            Err(_) => {
                tracing::warn!("nvidia-smi 竞态扫描超时（1.5s），跳过");
                return vec![];
            }
        };

        if !output.status.success() {
            return vec![];
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut map: std::collections::HashMap<u32, GpuCompetitorInfo> = std::collections::HashMap::new();

        for line in stdout.lines() {
            let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
            if parts.len() >= 3 {
                if let (Ok(pid), Ok(used_mb)) = (parts[0].parse::<u32>(), parts[2].parse::<u64>()) {
                    if exclude_pid.map(|ex| ex == pid).unwrap_or(false) {
                        continue;
                    }
                    map.entry(pid)
                        .and_modify(|info| info.used_memory_mb += used_mb)
                        .or_insert_with(|| GpuCompetitorInfo {
                            pid,
                            process_name: parts[1].to_string(),
                            used_memory_mb: used_mb,
                        });
                }
            }
        }

        map.into_values()
            .filter(|info| info.used_memory_mb >= threshold_mb)
            .collect()
    }
}
