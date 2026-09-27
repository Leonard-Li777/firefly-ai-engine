import { useState, useCallback, useRef, useEffect } from 'react'
import { engineApiClient } from '../api/provider'
import { useEngineStore } from '../stores/engine-store'
import { DownloadProgressEvent } from '../api/types'
import { t } from '../languages'
import { toast } from '../components/common/Toast'

export interface EngineDownloadState {
  isDownloading: boolean
  progress: number
  speedBps: number
  receivedBytes: number
  totalBytes: number
  status: 'idle' | 'downloading' | 'extracting' | 'completed' | 'error'
  error?: string
  currentBackend?: string
  sourceName?: string
}

export function useEngineDownload() {
  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const [state, setState] = useState<EngineDownloadState>({
    isDownloading: false,
    progress: 0,
    speedBps: 0,
    receivedBytes: 0,
    totalBytes: 0,
    status: 'idle'
  })

  const { fetchEngineList, fetchEngineStatus } = useEngineStore()

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
          if (!isMountedRef.current) return
          setState(prev => ({
            ...prev,
            progress: progress.percent,
            receivedBytes: progress.receivedBytes,
            totalBytes: progress.totalBytes,
            speedBps: progress.speedBps,
            sourceName: progress.sourceName || prev.sourceName,
            status: progress.percent >= 100 ? 'extracting' : 'downloading'
          }))
        }
      )

      if (res.success) {
        if (!isMountedRef.current) return
        setState(prev => ({
          ...prev,
          isDownloading: false,
          progress: 100,
          status: 'completed'
        }))
        // 刷新引擎列表与状态，使未安装状态变为已安装就绪并同步热切换可能发生的运行状态
        await fetchEngineList()
        await fetchEngineStatus(true)
        toast.success(t('引擎更新并部署成功'))
      } else {
        throw new Error(t('下载未正常完成'))
      }
    } catch (err: any) {
      if (!isMountedRef.current) return
      const errMsg = err.message || t('引擎下载失败')
      setState(prev => ({
        ...prev,
        isDownloading: false,
        status: 'error',
        error: errMsg
      }))
      toast.error(errMsg)
    }
  }, [fetchEngineList, fetchEngineStatus])

  return {
    state,
    startDownload
  }
}
