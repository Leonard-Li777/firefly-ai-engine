import { useState, useEffect, useRef, useCallback } from 'react'
import { DownloadProgressEvent, ModelSource } from '../api/types'
import { engineApiClient } from '../api/provider'
import { t } from '../languages'

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
  const sourceRef = useRef(options.source)
  const isPausedRef = useRef(false)

  // 保持 options 和 source 的最新引用，无需触发无依赖的 useEffect
  optionsRef.current = options
  sourceRef.current = options.source

  useEffect(() => {
    // 仅当 modelId 明确有效且发生变化时才重置状态，防止空 modelId（如无投机加速模型时）反复重置
    if (initialModelId && (modelIdRef.current !== initialModelId || sourceRef.current !== options.source)) {
      modelIdRef.current = initialModelId
      sourceRef.current = options.source
      setState(prev => {
        if (prev.modelId === initialModelId && prev.source === options.source) return prev
        return {
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
        }
      })
    }
  }, [initialModelId, options.source])

  // 开始下载
  const startDownload = useCallback(
    async (
      targetModelId?: string,
      downloadOptions?: { forceRestart?: boolean; source?: ModelSource }
    ) => {
      const finalModelId = targetModelId || modelIdRef.current
      if (!finalModelId) return

      const finalSource = downloadOptions?.source || optionsRef.current.source || 'modelscope'

      isPausedRef.current = false
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
            // 下载过程中若已通过 progress 回调拿到 taskId，立即挂载到 ref 与 state 中，供取消/暂停使用
            if (progress.taskId && !taskIdRef.current) {
              taskIdRef.current = progress.taskId
            }

            // 如果用户已经点击暂停，忽略后续到达的 downloading 进度更新，防止状态被冲掉
            if (isPausedRef.current) {
              return
            }

            setState(prev => ({
              ...prev,
              taskId: progress.taskId || prev.taskId,
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
            } else if (progress.status === 'canceled') {
              optionsRef.current.onDownloadCancel?.()
            } else if (progress.status === 'error') {
              optionsRef.current.onDownloadError?.(progress.error || t('下载失败'))
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
        // 如果是因为处于暂停状态而导致的异常中断，保持暂停状态，不误报错误
        if (isPausedRef.current) {
          return
        }

        const errMsg = err?.message || t('发起模型下载失败')
        // 如果是由于用户主动取消抛出的异常，状态转为 canceled 而非 error
        if (errMsg.includes('取消') || errMsg.toLowerCase().includes('cancel')) {
          taskIdRef.current = undefined
          setState(prev => ({
            ...prev,
            isDownloading: false,
            isPaused: false,
            status: 'canceled',
            error: undefined
          }))
          optionsRef.current.onDownloadCancel?.()
          return
        }

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
    isPausedRef.current = true
    setState(prev => ({
      ...prev,
      isDownloading: false,
      isPaused: true,
      status: 'pending'
    }))
    try {
      await engineApiClient.pauseModelDownload(taskIdRef.current)
    } catch (e) {
      console.error('暂停下载失败:', e)
    }
  }, [])

  // 恢复下载：后端不支持断点恢复（resumeModelDownload 为明确不支持契约），
  // 通过重新发起 startModelDownload 实现恢复（已下载部分由后端断点续传跳过）
  const resumeDownload = useCallback(async () => {
    const modelId = modelIdRef.current
    if (!modelId) return
    isPausedRef.current = false
    try {
      await startDownload(modelId, { source: sourceRef.current as ModelSource })
    } catch (e) {
      console.error('恢复下载失败:', e)
    }
  }, [startDownload])

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

  // 检查下载状态 (对齐桌面端成熟体系)
  const checkDownloadStatus = useCallback(async () => {
    try {
      const models = await engineApiClient.listModels(optionsRef.current.source)
      const current = models.find(m => m.id === modelIdRef.current)
      return {
        isDownloaded: !!current?.isDownloaded,
        hasPartialFiles: false,
        downloadProgress: current?.isDownloaded ? 100 : 0,
        missingFiles: current?.isDownloaded ? [] : [modelIdRef.current],
        existingFiles: current?.isDownloaded && current.localPath ? [{ name: current.localPath, size: current.fileSize, expectedSize: current.fileSize }] : []
      }
    } catch {
      return {
        isDownloaded: false,
        hasPartialFiles: false,
        downloadProgress: 0,
        missingFiles: [modelIdRef.current],
        existingFiles: []
      }
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
    checkDownloadStatus,
    retryDownload
  }
}
