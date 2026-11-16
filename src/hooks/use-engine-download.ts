import { useEngineStore } from '../stores/engine-store'
import type { EngineDownloadState } from '../stores/engine-store'

export type { EngineDownloadState }

/**
 * 引擎下载 Hook：
 * 统一订阅全局 useEngineStore 中的 engineDownloadState 与 startEngineDownload，
 * 解决多组件（ModelListPanel 与 EngineTable）状态孤岛、切页卸载导致轮询中断的问题。
 */
export function useEngineDownload() {
  const state = useEngineStore(s => s.engineDownloadState)
  const startDownload = useEngineStore(s => s.startEngineDownload)

  return {
    state,
    startDownload
  }
}
