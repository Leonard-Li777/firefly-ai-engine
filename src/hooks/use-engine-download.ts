import { useState, useCallback } from 'react'
import { engineApiClient } from '../api/client'
import { useEngineStore } from '../stores/engine-store'
import { DownloadProgressEvent } from '../api/types'
import { t } from '../lib/i18n'

export interface EngineDownloadState {
  isDownloading: boolean
  progress: number
  speedBps: number
  receivedBytes: number
  totalBytes: number
  status: 'idle' | 'downloading' | 'extracting' | 'completed' | 'error'
  error?: string
  currentBackend?: string
}

export function useEngineDownload() {
  const [state, setState] = useState<EngineDownloadState>({
    isDownloading: false,
    progress: 0,
    speedBps: 0,
    receivedBytes: 0,
    totalBytes: 0,
    status: 'idle'
  })

  const { fetchEngineList } = useEngineStore()

  const startDownload = useCallback(async (backend: string) => {
    setState({
      isDownloading: true,
      progress: 0,
      speedBps: 0,
      receivedBytes: 0,
      totalBytes: 0,
      status: 'downloading',
      currentBackend: backend,
      error: undefined
    })

    try {
      const res = await engineApiClient.downloadEngine(
        backend,
        (progress: DownloadProgressEvent) => {
          setState(prev => ({
            ...prev,
            progress: progress.percent,
            receivedBytes: progress.receivedBytes,
            totalBytes: progress.totalBytes,
            speedBps: progress.speedBps,
            status: progress.percent >= 100 ? 'extracting' : 'downloading'
          }))
        }
      )

      if (res.success) {
        setState(prev => ({
          ...prev,
          isDownloading: false,
          progress: 100,
          status: 'completed'
        }))
        // 刷新引擎列表，使未安装状态变为已安装就绪
        await fetchEngineList()
      } else {
        throw new Error(t('下载未正常完成'))
      }
    } catch (err: any) {
      setState(prev => ({
        ...prev,
        isDownloading: false,
        status: 'error',
        error: err.message || t('引擎下载失败')
      }))
    }
  }, [fetchEngineList])

  return {
    state,
    startDownload
  }
}
