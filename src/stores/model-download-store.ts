import { create } from 'zustand'
import { DownloadProgressEvent, ModelSource } from '../api/types'
import { engineApiClient } from '../api/provider'
import { useEngineStore } from './engine-store'
import { captureEvent } from '../lib/posthog'
import { t } from '../languages'
import { toast } from '../components/common/Toast'

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
  quantization?: string
  isDownloaded?: boolean
  onDownloadStart?: () => void
  onDownloadProgress?: (progress: DownloadProgressEvent) => void
  onDownloadComplete?: () => void
  onDownloadError?: (error: string) => void
  onDownloadCancel?: () => void
}

interface ModelDownloadStoreState {
  tasks: Record<string, ModelDownloadState>
  activeDownloadsCount: number
  startDownload: (
    modelId: string,
    options?: {
      source?: ModelSource
      quantization?: string
      forceRestart?: boolean
      onDownloadStart?: () => void
      onDownloadProgress?: (progress: DownloadProgressEvent) => void
      onDownloadComplete?: () => void
      onDownloadError?: (error: string) => void
      onDownloadCancel?: () => void
    }
  ) => Promise<void>
  pauseDownload: (modelId: string) => Promise<void>
  resumeDownload: (modelId: string) => Promise<void>
  cancelDownload: (modelId: string) => Promise<void>
  retryDownload: (modelId: string) => Promise<void>
  resetDownload: (modelId: string) => void
  getDownloadState: (modelId: string, source?: ModelSource) => ModelDownloadState | undefined
  syncActiveTasks: () => Promise<void>
}

// 活跃轮询器注册表（单例）
const activePollingTasks = new Set<string>()

/** 标准化任务键 */
function getTaskKey(modelId: string, source?: string): string {
  if (!modelId) return ''
  return source ? `${modelId}@${source}` : modelId
}

/** 提取模型的核心指纹（例如从仓库名与量化提取），便于跨源匹配同一模型 */
function extractModelFingerprint(modelId: string): string {
  if (!modelId) return ''
  const lower = modelId.toLowerCase().replace(/\\/g, '/')
  const lastSegment = lower.split('/').pop() || lower
  // 去除通用后缀
  return lastSegment.replace(/-uncensored|-heretic|-instruct/g, '')
}

export const useModelDownloadStore = create<ModelDownloadStoreState>((set, get) => ({
  tasks: {},
  activeDownloadsCount: 0,

  getDownloadState: (modelId: string, source?: ModelSource) => {
    if (!modelId) return undefined
    const { tasks } = get()
    // 1. 精确匹配 modelId
    if (tasks[modelId]) {
      return tasks[modelId]
    }
    // 2. 匹配 modelId@source
    if (source) {
      const key = getTaskKey(modelId, source)
      if (tasks[key]) return tasks[key]
    }
    // 3. 遍历匹配：若同一个任务在进行中，检查 ID 包含性或跨源指纹匹配
    const fp = extractModelFingerprint(modelId)
    if (fp) {
      for (const t of Object.values(tasks)) {
        if (t.isDownloading || t.status === 'downloading' || t.status === 'pending') {
          const taskFp = extractModelFingerprint(t.modelId)
          if (taskFp && (taskFp === fp || taskFp.includes(fp) || fp.includes(taskFp))) {
            return t
          }
        }
      }
    }
    return undefined
  },

  startDownload: async (modelId, options = {}) => {
    if (!modelId) return
    const source = options.source || 'modelscope'
    const quantization = options.quantization
    const current = get().tasks[modelId]

    // 避免重复启动同一模型的下载任务
    if (current?.isDownloading && current.status === 'downloading') {
      return
    }

    const initialTaskState: ModelDownloadState = {
      modelId,
      source,
      isDownloading: true,
      isPaused: false,
      status: 'downloading',
      progress: 0,
      receivedBytes: 0,
      totalBytes: 0,
      speedBps: 0,
      retryCount: current?.retryCount || 0,
      fileIndex: 0,
      totalFiles: 1,
      error: undefined,
      taskId: current?.taskId
    }

    set(state => {
      const nextTasks = {
        ...state.tasks,
        [modelId]: initialTaskState,
        [getTaskKey(modelId, source)]: initialTaskState
      }
      const activeCount = Object.values(nextTasks).filter(t => t.isDownloading).length
      return { tasks: nextTasks, activeDownloadsCount: activeCount }
    })

    options.onDownloadStart?.()
    captureEvent('开始下载模型', { modelId, source })

    try {
      const taskSummary = await engineApiClient.startModelDownload(
        modelId,
        {
          source,
          forceRestart: options.forceRestart,
          quantization
        },
        (progress: DownloadProgressEvent) => {
          set(state => {
            const prev = state.tasks[modelId] || initialTaskState
            const isCompleted = progress.status === 'completed'
            const isStillDownloading = progress.status === 'downloading' || progress.status === 'pending'

            const updated: ModelDownloadState = {
              ...prev,
              taskId: progress.taskId || prev.taskId,
              progress: isCompleted ? 100 : progress.percent,
              receivedBytes: progress.receivedBytes,
              totalBytes: progress.totalBytes,
              speedBps: progress.speedBps,
              status: progress.status,
              currentFileName: progress.currentFileName,
              fileIndex: progress.fileIndex ?? prev.fileIndex,
              totalFiles: progress.totalFiles ?? prev.totalFiles,
              isDownloading: isStillDownloading,
              isPaused: false,
              error: progress.error
            }

            const nextTasks = {
              ...state.tasks,
              [modelId]: updated,
              [getTaskKey(modelId, source)]: updated
            }
            const activeCount = Object.values(nextTasks).filter(t => t.isDownloading).length
            return { tasks: nextTasks, activeDownloadsCount: activeCount }
          })

          options.onDownloadProgress?.(progress)

          if (progress.status === 'completed') {
            captureEvent('模型下载完成', { modelId, source })
            options.onDownloadComplete?.()
            // 自动刷新全局已扫描模型列表
            useEngineStore.getState().fetchModels()
            toast.success(t('模型下载并校验完成！已就绪使用。'))
          } else if (progress.status === 'canceled') {
            options.onDownloadCancel?.()
          } else if (progress.status === 'error') {
            captureEvent('模型下载失败', { modelId, source })
            const errMsg = progress.error || t('下载失败')
            options.onDownloadError?.(errMsg)
            toast.error(errMsg)
          }
        }
      )

      // 更新获取到的实际 taskId
      if (taskSummary.taskId) {
        set(state => {
          const prev = state.tasks[modelId]
          if (!prev) return state
          const updated = {
            ...prev,
            taskId: taskSummary.taskId,
            totalBytes: taskSummary.totalBytes || prev.totalBytes
          }
          return {
            tasks: {
              ...state.tasks,
              [modelId]: updated,
              [getTaskKey(modelId, source)]: updated
            }
          }
        })
      }
    } catch (err: any) {
      const errMsg = err?.message || t('发起模型下载失败')
      const isCanceled = errMsg.includes('取消') || errMsg.toLowerCase().includes('cancel')

      set(state => {
        const prev = state.tasks[modelId] || initialTaskState
        const updated: ModelDownloadState = {
          ...prev,
          isDownloading: false,
          isPaused: false,
          status: isCanceled ? 'canceled' : 'error',
          error: isCanceled ? undefined : errMsg
        }
        const nextTasks = {
          ...state.tasks,
          [modelId]: updated,
          [getTaskKey(modelId, source)]: updated
        }
        const activeCount = Object.values(nextTasks).filter(t => t.isDownloading).length
        return { tasks: nextTasks, activeDownloadsCount: activeCount }
      })

      if (isCanceled) {
        options.onDownloadCancel?.()
      } else {
        options.onDownloadError?.(errMsg)
        toast.error(errMsg)
      }
    }
  },

  pauseDownload: async (modelId: string) => {
    const task = get().tasks[modelId]
    if (!task?.taskId) return

    set(state => {
      const prev = state.tasks[modelId]
      if (!prev) return state
      const updated: ModelDownloadState = {
        ...prev,
        isDownloading: false,
        isPaused: true,
        status: 'pending'
      }
      return {
        tasks: {
          ...state.tasks,
          [modelId]: updated,
          [getTaskKey(modelId, prev.source)]: updated
        },
        activeDownloadsCount: Math.max(0, state.activeDownloadsCount - 1)
      }
    })

    try {
      await engineApiClient.pauseModelDownload(task.taskId)
    } catch (e) {
      console.error('暂停模型下载失败:', e)
    }
  },

  resumeDownload: async (modelId: string) => {
    const task = get().tasks[modelId]
    if (!task) return
    await get().startDownload(modelId, { source: task.source })
  },

  cancelDownload: async (modelId: string) => {
    const task = get().tasks[modelId]
    const taskId = task?.taskId

    set(state => {
      const prev = state.tasks[modelId]
      if (!prev) return state
      const updated: ModelDownloadState = {
        ...prev,
        isDownloading: false,
        isPaused: false,
        status: 'canceled',
        taskId: undefined,
        error: undefined
      }
      const nextTasks = {
        ...state.tasks,
        [modelId]: updated,
        [getTaskKey(modelId, prev.source)]: updated
      }
      const activeCount = Object.values(nextTasks).filter(t => t.isDownloading).length
      return { tasks: nextTasks, activeDownloadsCount: activeCount }
    })

    if (taskId) {
      try {
        await engineApiClient.cancelModelDownload(taskId)
      } catch (e) {
        console.error('取消模型下载失败:', e)
      }
    }
  },

  retryDownload: async (modelId: string) => {
    const task = get().tasks[modelId]
    set(state => {
      const prev = state.tasks[modelId]
      if (!prev) return state
      const updated: ModelDownloadState = {
        ...prev,
        retryCount: prev.retryCount + 1,
        error: undefined
      }
      return {
        tasks: {
          ...state.tasks,
          [modelId]: updated,
          [getTaskKey(modelId, prev.source)]: updated
        }
      }
    })
    await get().startDownload(modelId, { source: task?.source, forceRestart: true })
  },

  resetDownload: (modelId: string) => {
    set(state => {
      const prev = state.tasks[modelId]
      const updated: ModelDownloadState = {
        modelId,
        source: prev?.source,
        status: 'pending',
        progress: 0,
        receivedBytes: 0,
        totalBytes: 0,
        speedBps: 0,
        retryCount: 0,
        error: undefined,
        taskId: undefined,
        isDownloading: false,
        isPaused: false
      }
      return {
        tasks: {
          ...state.tasks,
          [modelId]: updated,
          [getTaskKey(modelId, prev?.source)]: updated
        }
      }
    })
  },

  syncActiveTasks: async () => {
    try {
      const backendTasks = await engineApiClient.getDownloadTasks()
      if (!Array.isArray(backendTasks) || backendTasks.length === 0) return

      for (const bt of backendTasks) {
        if (!bt.modelId) continue
        const isRunning = bt.status === 'downloading' || bt.status === 'pending'
        const existing = get().tasks[bt.modelId]

        if (isRunning && !existing?.isDownloading && !activePollingTasks.has(bt.taskId)) {
          activePollingTasks.add(bt.taskId)

          const recoveredState: ModelDownloadState = {
            modelId: bt.modelId,
            source: bt.source,
            taskId: bt.taskId,
            isDownloading: true,
            isPaused: false,
            status: bt.status,
            progress: bt.percent,
            receivedBytes: bt.receivedBytes,
            totalBytes: bt.totalBytes,
            speedBps: bt.speedBps,
            currentFileName: bt.currentFileName,
            fileIndex: bt.fileIndex,
            totalFiles: bt.totalFiles,
            retryCount: 0,
            error: bt.error
          }

          set(state => {
            const nextTasks = {
              ...state.tasks,
              [bt.modelId]: recoveredState,
              [getTaskKey(bt.modelId, bt.source)]: recoveredState
            }
            const activeCount = Object.values(nextTasks).filter(t => t.isDownloading).length
            return { tasks: nextTasks, activeDownloadsCount: activeCount }
          })

          // 启动独立全局轮询监听
          ;(async () => {
            try {
              let done = false
              while (!done) {
                await new Promise(r => setTimeout(r, 600))
                const list = await engineApiClient.getDownloadTasks()
                const current = list.find(x => x.taskId === bt.taskId)
                if (!current) break

                const isCompleted = current.status === 'completed'
                const isError = current.status === 'error'
                const isCanceled = current.status === 'canceled'

                set(state => {
                  const prev = state.tasks[bt.modelId] || recoveredState
                  const upd: ModelDownloadState = {
                    ...prev,
                    progress: isCompleted ? 100 : current.percent,
                    receivedBytes: current.receivedBytes,
                    totalBytes: current.totalBytes,
                    speedBps: current.speedBps,
                    status: current.status,
                    currentFileName: current.currentFileName,
                    isDownloading: !isCompleted && !isError && !isCanceled,
                    error: current.error
                  }
                  const nextTasks = {
                    ...state.tasks,
                    [bt.modelId]: upd,
                    [getTaskKey(bt.modelId, bt.source)]: upd
                  }
                  return {
                    tasks: nextTasks,
                    activeDownloadsCount: Object.values(nextTasks).filter(t => t.isDownloading).length
                  }
                })

                if (isCompleted) {
                  done = true
                  useEngineStore.getState().fetchModels()
                } else if (isError || isCanceled) {
                  done = true
                }
              }
            } finally {
              activePollingTasks.delete(bt.taskId)
            }
          })()
        }
      }
    } catch (err) {
      console.warn('[ModelDownloadStore] 同步后端活跃任务失败:', err)
    }
  }
}))
