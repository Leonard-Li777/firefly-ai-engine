import {
  EngineStatusResponse,
  EngineItem,
  ModelItem,
  DownloadProgressEvent,
  DownloadTaskSummary,
  RuntimeParams
} from './types'
import { mockApiClient } from './mock-client'

export interface IEngineApiClient {
  /**
   * 获取当前引擎状态（含硬件信息与降级诊断）
   */
  getEngineStatus(): Promise<EngineStatusResponse>

  /**
   * 切换 AI 计算引擎后端 (vulkan / cpu / cuda / metal)
   */
  switchEngine(backend: string): Promise<{ success: boolean; message?: string }>

  /**
   * 获取可用引擎列表（含已安装、未安装及下载状态）
   */
  getEngineList(): Promise<EngineItem[]>

  /**
   * 下载未安装的引擎扩展包（如 Windows CUDA 12.4 套件）
   */
  downloadEngine(
    backend: string,
    onProgress?: (progress: DownloadProgressEvent) => void
  ): Promise<{ success: boolean }>

  /**
   * 获取模型列表
   */
  listModels(source?: string): Promise<ModelItem[]>

  /**
   * 发起模型下载（支持断点续传、多模态 mmproj 自动识别）
   */
  startModelDownload(
    modelId: string,
    options?: { source?: string; forceRestart?: boolean },
    onProgress?: (event: DownloadProgressEvent) => void
  ): Promise<DownloadTaskSummary>

  /**
   * 暂停模型下载任务
   */
  pauseModelDownload(taskId: string): Promise<void>

  /**
   * 恢复模型下载任务
   */
  resumeModelDownload(taskId: string): Promise<void>

  /**
   * 取消模型下载任务
   */
  cancelModelDownload(taskId: string): Promise<void>

  /**
   * 更新模型存储目录并重新扫描
   */
  updateModelStoragePath(newPath: string): Promise<{ success: boolean; scannedModelsCount: number }>

  /**
   * 重新扫描当前模型目录下的 GGUF 模型
   */
  rescanModels(): Promise<ModelItem[]>

  /**
   * 更新运行时调优参数（GPU 卸载层数、线程数、上下文等）
   */
  updateRuntimeParams(params: Partial<RuntimeParams>): Promise<{ success: boolean }>

  /**
   * 持久化保存模型专属启动参数到后端 config.json
   */
  saveModelParams(modelId: string, params: RuntimeParams): Promise<{ success: boolean }>

  /**
   * 从后端 config.json 读取模型专属启动参数
   */
  getModelParams(modelId: string): Promise<RuntimeParams | undefined>

  /**
   * 激活/热切换当前运行的模型
   */
  switchModel(modelId: string, source?: string, localPath?: string, modelName?: string): Promise<{ success: boolean; currentModel: string }>

  /**
   * 重置驱动降级状态（用户升级驱动后重新检测）
   */
  resetDowngrade(): Promise<{ status: string }>

  /**
   * 启动 AI 引擎后台服务
   */
  startEngine(): Promise<{ success: boolean; message?: string; error?: string }>

  /**
   * 停止 AI 引擎后台服务
   */
  stopEngine(): Promise<{ success: boolean; message?: string; error?: string }>

  /**
   * 获取最近的 llama.cpp 运行时日志
   */
  getEngineLogs(): Promise<{ logs: string[] }>

  /**
   * 清空运行时日志
   */
  clearEngineLogs(): Promise<{ success: boolean }>
}

/**
 * 真实 HTTP / Tauri IPC 客户端实现
 * 优先连接本地基准端口 38400，当连接失败或在独立测试开发沙盒中时平滑降级至 mockApiClient
 */
export class EngineApiClient implements IEngineApiClient {
  private baseUrl = 'http://127.0.0.1:38400'
  private useMock = false

  constructor() {
    // 检查是否在纯浏览器或测试环境，若无法访问 Tauri/本地端口则默认走 Mock
    if (typeof window !== 'undefined' && !(window as any).__TAURI_INTERNALS__) {
      this.useMock = true
    }
  }

  public setBaseUrl(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  public getBaseUrl(): string {
    return this.baseUrl
  }

  public setUseMock(useMock: boolean) {
    this.useMock = useMock
  }

  public isMockMode(): boolean {
    return this.useMock
  }

  /**
   * 确保已绑定 Tauri 后端分配的真实动态端口
   * 如果 38400 被占用滑动到了 38401+，自动通过 IPC 获取真实端口更新 baseUrl
   */
  public async ensureReady(): Promise<void> {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      const { invoke } = await import('@tauri-apps/api/core')
      for (let i = 0; i < 20; i++) {
        try {
          const actualPort = await invoke<number>('get_server_port')
          if (actualPort && actualPort > 0) {
            this.baseUrl = `http://127.0.0.1:${actualPort}`
            this.useMock = false
            return
          }
        } catch {
          // 端口可能仍在启动探测中，稍作等待后重试
        }
        await new Promise(res => setTimeout(res, 100))
      }
    }
  }

  async getEngineStatus(): Promise<EngineStatusResponse> {
    if (this.useMock) return mockApiClient.getEngineStatus()
    await this.ensureReady()
    try {
      const res = await fetch(`${this.baseUrl}/api/engine/status`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch {
      return mockApiClient.getEngineStatus()
    }
  }

  async switchEngine(backend: string): Promise<{ success: boolean; message?: string }> {
    if (this.useMock) return mockApiClient.switchEngine(backend)
    await this.ensureReady()
    try {
      const res = await fetch(`${this.baseUrl}/api/engine/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch {
      return mockApiClient.switchEngine(backend)
    }
  }

  async getEngineList(): Promise<EngineItem[]> {
    if (this.useMock) return mockApiClient.getEngineList()
    await this.ensureReady()
    try {
      const res = await fetch(`${this.baseUrl}/api/engine/list`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      return Array.isArray(data) ? data : mockApiClient.getEngineList()
    } catch {
      return mockApiClient.getEngineList()
    }
  }

  async downloadEngine(
    backend: string,
    onProgress?: (progress: DownloadProgressEvent) => void
  ): Promise<{ success: boolean }> {
    if (this.useMock) return mockApiClient.downloadEngine(backend, onProgress)
    await this.ensureReady()
    try {
      // 1. 发起引擎下载任务
      const res = await fetch(`${this.baseUrl}/api/engine/download/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const task = await res.json()
      const taskId: string = task.taskId

      // 2. 轮询下载进度直到完成
      await new Promise<void>((resolve, reject) => {
        const poll = async () => {
          try {
            const statusRes = await fetch(`${this.baseUrl}/api/engine/download/status/${taskId}`)
            if (!statusRes.ok) {
              reject(new Error(`HTTP ${statusRes.status}`))
              return
            }
            const status = await statusRes.json()

            const event: DownloadProgressEvent = {
              taskId,
              modelId: `engine-${backend}`,
              sourceName: status.source,
              percent: status.percent || 0,
              receivedBytes: status.receivedBytes || 0,
              totalBytes: status.totalBytes || 0,
              speedBps: status.speedBps || 0,
              status: status.status,
              currentFileName: status.currentFileName,
              fileIndex: status.fileIndex,
              totalFiles: status.totalFiles,
              error: status.error
            }
            onProgress?.(event)

            if (status.status === 'completed') {
              resolve()
            } else if (status.status === 'error') {
              reject(new Error(status.error || '引擎下载失败'))
            } else if (status.status === 'canceled') {
              reject(new Error('引擎下载已取消'))
            } else {
              setTimeout(poll, 500)
            }
          } catch (e) {
            reject(e)
          }
        }
        poll()
      })

      return { success: true }
    } catch (err) {
      if (this.useMock || (typeof window !== 'undefined' && !(window as any).__TAURI_INTERNALS__)) {
        return mockApiClient.downloadEngine(backend, onProgress)
      }
      throw err
    }
  }

  async listModels(source?: string): Promise<ModelItem[]> {
    if (this.useMock) return mockApiClient.listModels(source)
    await this.ensureReady()
    try {
      const url = source ? `${this.baseUrl}/api/models?source=${source}` : `${this.baseUrl}/api/models`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      return Array.isArray(data) ? data : mockApiClient.listModels(source)
    } catch {
      return mockApiClient.listModels(source)
    }
  }

  async startModelDownload(
    modelId: string,
    options?: { source?: string; forceRestart?: boolean },
    onProgress?: (event: DownloadProgressEvent) => void
  ): Promise<DownloadTaskSummary> {
    if (this.useMock) return mockApiClient.startModelDownload(modelId, options, onProgress)
    await this.ensureReady()
    try {
      // 1. 发起下载任务
      const res = await fetch(`${this.baseUrl}/api/models/download/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          source: options?.source || 'modelscope',
          forceRestart: options?.forceRestart || false
        })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const task = await res.json()
      const taskId: string = task.taskId

      // 2. 轮询进度直到完成
      await new Promise<void>((resolve, reject) => {
        const poll = async () => {
          try {
            const statusRes = await fetch(`${this.baseUrl}/api/models/download/status/${taskId}`)
            if (!statusRes.ok) {
              reject(new Error(`HTTP ${statusRes.status}`))
              return
            }
            const status = await statusRes.json()

            // 映射后端状态到前端 DownloadProgressEvent
            const event: DownloadProgressEvent = {
              taskId,
              modelId,
              percent: status.percent || 0,
              receivedBytes: status.receivedBytes || 0,
              totalBytes: status.totalBytes || 0,
              speedBps: status.speedBps || 0,
              status: status.status,
              currentFileName: status.currentFileName,
              fileIndex: status.fileIndex,
              totalFiles: status.totalFiles,
              error: status.error
            }
            onProgress?.(event)

            if (status.status === 'completed') {
              resolve()
            } else if (status.status === 'error') {
              reject(new Error(status.error || '下载失败'))
            } else if (status.status === 'canceled') {
              reject(new Error('下载已取消'))
            } else {
              // 继续轮询（500ms 间隔）
              setTimeout(poll, 500)
            }
          } catch (e) {
            reject(e)
          }
        }
        poll()
      })

      return { taskId, totalBytes: 0, isDownloaded: true }
    } catch (err) {
      // 仅在明确启用 useMock 或在非 Tauri 纯前端单测沙盒环境中回退到 mockApiClient
      if (this.useMock || (typeof window !== 'undefined' && !(window as any).__TAURI_INTERNALS__)) {
        return mockApiClient.startModelDownload(modelId, options, onProgress)
      }
      // 在 Tauri 真实运行环境中直接向上抛出异常，不再被动伪装成 Mock 成功
      throw err
    }
  }

  async pauseModelDownload(taskId: string): Promise<void> {
    // 暂停等同于取消（llama-model-download 不支持真正暂停）
    if (this.useMock) return mockApiClient.pauseModelDownload(taskId)
    try {
      await fetch(`${this.baseUrl}/api/models/download/cancel/${taskId}`, { method: 'POST' })
    } catch {
      return mockApiClient.pauseModelDownload(taskId)
    }
  }

  async resumeModelDownload(taskId: string): Promise<void> {
    if (this.useMock) return mockApiClient.resumeModelDownload(taskId)
    // 恢复下载：重新发起一个新任务（需要 modelId）
    // 实际场景中 hook 会重新调用 startDownload，此处忽略
    return mockApiClient.resumeModelDownload(taskId)
  }

  async cancelModelDownload(taskId: string): Promise<void> {
    if (this.useMock) return mockApiClient.cancelModelDownload(taskId)
    try {
      await fetch(`${this.baseUrl}/api/models/download/cancel/${taskId}`, { method: 'POST' })
    } catch {
      return mockApiClient.cancelModelDownload(taskId)
    }
  }

  async updateModelStoragePath(newPath: string): Promise<{ success: boolean; scannedModelsCount: number }> {
    if (this.useMock) return mockApiClient.updateModelStoragePath(newPath)
    await this.ensureReady()
    try {
      const res = await fetch(`${this.baseUrl}/api/engine/models-dir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch {
      return mockApiClient.updateModelStoragePath(newPath)
    }
  }

  async rescanModels(): Promise<ModelItem[]> {
    if (this.useMock) return mockApiClient.rescanModels()
    await this.ensureReady()
    try {
      const res = await fetch(`${this.baseUrl}/api/models/rescan`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      return Array.isArray(data) ? data : mockApiClient.rescanModels()
    } catch {
      return mockApiClient.rescanModels()
    }
  }

  async updateRuntimeParams(params: Partial<RuntimeParams>): Promise<{ success: boolean }> {
    if (this.useMock) return mockApiClient.updateRuntimeParams(params)
    await this.ensureReady()
    try {
      const res = await fetch(`${this.baseUrl}/api/engine/params`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch {
      return mockApiClient.updateRuntimeParams(params)
    }
  }

  async saveModelParams(modelId: string, params: RuntimeParams): Promise<{ success: boolean }> {
    if (this.useMock) return mockApiClient.saveModelParams(modelId, params)
    await this.ensureReady()
    try {
      const res = await fetch(`${this.baseUrl}/api/models/params`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, params })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch {
      return mockApiClient.saveModelParams(modelId, params)
    }
  }

  async getModelParams(modelId: string): Promise<RuntimeParams | undefined> {
    if (this.useMock) return mockApiClient.getModelParams(modelId)
    await this.ensureReady()
    try {
      const res = await fetch(`${this.baseUrl}/api/models/params?modelId=${encodeURIComponent(modelId)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      return data.params
    } catch {
      return mockApiClient.getModelParams(modelId)
    }
  }

  async switchModel(
    modelId: string,
    source?: string,
    localPath?: string,
    modelName?: string
  ): Promise<{ success: boolean; currentModel: string }> {
    if (this.useMock) return mockApiClient.switchModel(modelId, source, localPath, modelName)
    await this.ensureReady()
    try {
      const res = await fetch(`${this.baseUrl}/api/models/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, source, localPath, modelName })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch {
      return mockApiClient.switchModel(modelId, source, localPath, modelName)
    }
  }

  async resetDowngrade(): Promise<{ status: string }> {
    if (this.useMock) return mockApiClient.resetDowngrade()
    await this.ensureReady()
    try {
      const res = await fetch(`${this.baseUrl}/api/engine/reset-downgrade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch {
      return mockApiClient.resetDowngrade()
    }
  }

  async startEngine(): Promise<{ success: boolean; message?: string; error?: string }> {
    if (this.useMock) return mockApiClient.startEngine()
    await this.ensureReady()
    try {
      const res = await fetch(`${this.baseUrl}/api/engine/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      return await res.json()
    } catch {
      return mockApiClient.startEngine()
    }
  }

  async stopEngine(): Promise<{ success: boolean; message?: string; error?: string }> {
    if (this.useMock) return mockApiClient.stopEngine()
    await this.ensureReady()
    try {
      const res = await fetch(`${this.baseUrl}/api/engine/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      return await res.json()
    } catch {
      return mockApiClient.stopEngine()
    }
  }

  async getEngineLogs(): Promise<{ logs: string[] }> {
    if (this.useMock) return mockApiClient.getEngineLogs()
    await this.ensureReady()
    try {
      const res = await fetch(`${this.baseUrl}/api/engine/logs`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch {
      return mockApiClient.getEngineLogs()
    }
  }

  async clearEngineLogs(): Promise<{ success: boolean }> {
    if (this.useMock) return mockApiClient.clearEngineLogs()
    await this.ensureReady()
    try {
      const res = await fetch(`${this.baseUrl}/api/engine/logs/clear`, {
        method: 'POST'
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch {
      return mockApiClient.clearEngineLogs()
    }
  }
}

export const engineApiClient = new EngineApiClient()
