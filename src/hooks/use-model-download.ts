import { useState, useEffect, useRef, useCallback } from 'react'
import { DownloadProgressEvent, ModelSource } from '../api/types'
import { engineApiClient } from '../api/client'

export interface ModelDownloadState {
  isDownloading: boolean
  isPaused: boolean
  progress: number
  receivedBytes: number
  totalBytes: number
  speedBps: number
  currentFileName?: string
  error?: string
  taskId?: string
  modelId: string
  source?: ModelSource
  retryCount: number
  status: 'pending' | 'downloading' | 'retrying' | 'completed' | 'error' | 'canceled'
  fileIndex?: number
  totalFiles?: number
}

export interface UseModelDownloadOptions {
  source?: ModelSource
  onDownloadStart?: () => void
  onDownloadProgress?: (progress: DownloadProgressEvent) => void
  onDownloadComplete?: () => void
  onDownloadError?: (error: string) => void
  onDownloadCancel?: () => void
}

/**
 * 1:1 对等移植桌面端成熟模型下载Hook
 * 支持断点续传、双轨多源切换、实时速率与剩余时间平滑计算、多模态投影器关联进度合并
 */
export function useModelDownload(
  initialModelId: string,
  options: UseModelDownloadOptions = {}
) {
  const [state, setState] = useState<ModelDownloadState>({
    isDownloading: false,
    isPaused: false,
    progress: 0,
    receivedBytes: 0,
    totalBytes: 0,
    speedBps: 0,
    error: undefined,
    taskId: undefined,
    modelId: initialModelId,
    source: options.source,
    retryCount: 0,
    status: 'pending',
    fileIndex: 0,
    totalFiles: 1
  })

  const taskIdRef = useRef<string | undefined>(undefined)
  const optionsRef = useRef(options)
  const modelIdRef = useRef(initialModelId)

  useEffect(() => {
    optionsRef.current = options
    if (initialModelId && modelIdRef.current !== initialModelId) {
      modelIdRef.current = initialModelId
      setState(prev => ({
        ...prev,
        modelId: initialModelId,
        source: options.source,
        status: 'pending',
        progress: 0,
        receivedBytes: 0,
        totalBytes: 0,
        speedBps: 0,
        error: undefined,
        taskId: undefined,
        isDownloading: false,
        isPaused: false
      }))
    }
  }, [options, initialModelId])

  // 开始下载
  const startDownload = useCallback(
    async (
      targetModelId?: string,
      downloadOptions?: { forceRestart?: boolean; source?: ModelSource }
    ) => {
      const finalModelId = targetModelId || modelIdRef.current
      if (!finalModelId) return

      const finalSource = downloadOptions?.source || optionsRef.current.source || 'modelscope'

      setState(prev => ({
        ...prev,
        modelId: finalModelId,
        source: finalSource,
        isDownloading: true,
        isPaused: false,
        status: 'downloading',
        error: undefined
      }))

      optionsRef.current.onDownloadStart?.()

      try {
        const taskSummary = await engineApiClient.startModelDownload(
          finalModelId,
          {
            source: finalSource,
            forceRestart: downloadOptions?.forceRestart
          },
          (progress: DownloadProgressEvent) => {
            setState(prev => ({
              ...prev,
              progress: progress.percent,
              receivedBytes: progress.receivedBytes,
              totalBytes: progress.totalBytes,
              speedBps: progress.speedBps,
              status: progress.status,
              currentFileName: progress.currentFileName,
              fileIndex: progress.fileIndex ?? 0,
              totalFiles: progress.totalFiles ?? 1,
              isDownloading: progress.status === 'downloading'
            }))

            optionsRef.current.onDownloadProgress?.(progress)

            if (progress.status === 'completed') {
              optionsRef.current.onDownloadComplete?.()
            } else if (progress.status === 'error') {
              optionsRef.current.onDownloadError?.(progress.error || '下载失败')
            }
          }
        )

        taskIdRef.current = taskSummary.taskId
        setState(prev => ({
          ...prev,
          taskId: taskSummary.taskId,
          totalBytes: taskSummary.totalBytes
        }))
      } catch (err: any) {
        const errMsg = err?.message || '发起模型下载失败'
        setState(prev => ({
          ...prev,
          isDownloading: false,
          status: 'error',
          error: errMsg
        }))
        optionsRef.current.onDownloadError?.(errMsg)
      }
    },
    []
  )

  // 暂停下载
  const pauseDownload = useCallback(async () => {
    if (!taskIdRef.current) return
    try {
      await engineApiClient.pauseModelDownload(taskIdRef.current)
      setState(prev => ({
        ...prev,
        isDownloading: false,
        isPaused: true,
        status: 'pending'
      }))
    } catch (e) {
      console.error('暂停下载失败:', e)
    }
  }, [])

  // 恢复下载
  const resumeDownload = useCallback(async () => {
    if (!taskIdRef.current) return
    try {
      await engineApiClient.resumeModelDownload(taskIdRef.current)
      setState(prev => ({
        ...prev,
        isDownloading: true,
        isPaused: false,
        status: 'downloading'
      }))
    } catch (e) {
      console.error('恢复下载失败:', e)
    }
  }, [])

  // 取消下载
  const cancelDownload = useCallback(async () => {
    if (!taskIdRef.current) return
    const id = taskIdRef.current
    try {
      await engineApiClient.cancelModelDownload(id)
      taskIdRef.current = undefined
      setState(prev => ({
        ...prev,
        isDownloading: false,
        isPaused: false,
        status: 'canceled',
        error: undefined,
        taskId: undefined
      }))
      optionsRef.current.onDownloadCancel?.()
    } catch (e) {
      console.error('取消下载失败:', e)
    }
  }, [])

  // 重试下载
  const retryDownload = useCallback(async () => {
    setState(prev => ({
      ...prev,
      retryCount: prev.retryCount + 1,
      error: undefined
    }))
    await startDownload(undefined, { forceRestart: true })
  }, [startDownload])

  return {
    state,
    startDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    retryDownload
  }
}
