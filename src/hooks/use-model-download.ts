import { useRef, useCallback, useMemo } from 'react'
import type { ModelSource } from '../api/types'
import { engineApiClient } from '../api/provider'
import {
  useModelDownloadStore,
  ModelDownloadState,
  UseModelDownloadOptions
} from '../stores/model-download-store'

export type { ModelDownloadState, UseModelDownloadOptions }

/**
 * 模型下载 Hook（全局 Store 驱动版）
 * 彻底解决 Tab 切换（ModelScope <-> HuggingFace、顶部各 Tab 之间切换）导致的下载状态丢失与重置问题
 */
export function useModelDownload(
  initialModelId: string,
  options: UseModelDownloadOptions = {}
) {
  const optionsRef = useRef(options)
  optionsRef.current = options

  // 从全局 Store 中直接订阅该模型的实时下载状态（即使组件卸载重挂载，数据完全常驻）
  const storeTask = useModelDownloadStore(state =>
    state.getDownloadState(initialModelId, options.source)
  )

  // 默认兜底状态
  const state: ModelDownloadState = useMemo(() => {
    if (storeTask) {
      return storeTask
    }
    return {
      isDownloading: false,
      isPaused: false,
      progress: options.isDownloaded ? 100 : 0,
      receivedBytes: 0,
      totalBytes: 0,
      speedBps: 0,
      error: undefined,
      taskId: undefined,
      modelId: initialModelId,
      source: options.source,
      retryCount: 0,
      status: options.isDownloaded ? 'completed' : 'pending',
      fileIndex: 0,
      totalFiles: 1
    }
  }, [storeTask, initialModelId, options.source, options.isDownloaded])

  // 开始下载
  const startDownload = useCallback(
    async (
      targetModelId?: string,
      downloadOptions?: { forceRestart?: boolean; source?: ModelSource; quantization?: string }
    ) => {
      const finalModelId = targetModelId || initialModelId
      if (!finalModelId) return

      const finalSource = downloadOptions?.source || optionsRef.current.source || 'modelscope'
      const finalQuant = downloadOptions?.quantization || optionsRef.current.quantization

      await useModelDownloadStore.getState().startDownload(finalModelId, {
        source: finalSource,
        quantization: finalQuant,
        forceRestart: downloadOptions?.forceRestart,
        onDownloadStart: () => optionsRef.current.onDownloadStart?.(),
        onDownloadProgress: (p) => optionsRef.current.onDownloadProgress?.(p),
        onDownloadComplete: () => optionsRef.current.onDownloadComplete?.(),
        onDownloadError: (err) => optionsRef.current.onDownloadError?.(err),
        onDownloadCancel: () => optionsRef.current.onDownloadCancel?.()
      })
    },
    [initialModelId]
  )

  // 暂停下载
  const pauseDownload = useCallback(async () => {
    if (!initialModelId) return
    await useModelDownloadStore.getState().pauseDownload(initialModelId)
  }, [initialModelId])

  // 恢复下载
  const resumeDownload = useCallback(async () => {
    if (!initialModelId) return
    await useModelDownloadStore.getState().resumeDownload(initialModelId)
  }, [initialModelId])

  // 取消下载
  const cancelDownload = useCallback(async () => {
    if (!initialModelId) return
    await useModelDownloadStore.getState().cancelDownload(initialModelId)
  }, [initialModelId])

  // 检查下载状态
  const checkDownloadStatus = useCallback(async () => {
    try {
      const models = await engineApiClient.listModels(optionsRef.current.source)
      const current = models.find(m => m.id === initialModelId)
      return {
        isDownloaded: !!current?.isDownloaded,
        hasPartialFiles: false,
        downloadProgress: current?.isDownloaded ? 100 : 0,
        missingFiles: current?.isDownloaded ? [] : [initialModelId],
        existingFiles:
          current?.isDownloaded && current.localPath
            ? [{ name: current.localPath, size: current.fileSize, expectedSize: current.fileSize }]
            : []
      }
    } catch {
      return {
        isDownloaded: false,
        hasPartialFiles: false,
        downloadProgress: 0,
        missingFiles: [initialModelId],
        existingFiles: []
      }
    }
  }, [initialModelId])

  // 重置下载状态
  const resetDownload = useCallback(() => {
    if (!initialModelId) return
    useModelDownloadStore.getState().resetDownload(initialModelId)
  }, [initialModelId])

  // 重试下载
  const retryDownload = useCallback(async () => {
    if (!initialModelId) return
    await useModelDownloadStore.getState().retryDownload(initialModelId)
  }, [initialModelId])

  return {
    state,
    startDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    checkDownloadStatus,
    retryDownload,
    resetDownload
  }
}
