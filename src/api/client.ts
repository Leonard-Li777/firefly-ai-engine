import {
  EngineStatusResponse,
  EngineItem,
  ModelItem,
  DownloadProgressEvent,
  DownloadTaskSummary,
  RuntimeParams
} from './types'
import { DownloadTaskPoller } from './download-task-poller'

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
   * 自由添加任意模型：提交托管站点 URL，后端解析并网络嗅探大小后返回标准模型条目
   */
  addCustomModel(url: string): Promise<ModelItem>

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

  /**
   * 绑定真实服务端口（仅 Tauri HTTP 实现提供；mock 实现可忽略）
   */
  ensureReady?(): Promise<void>
}

/**
 * 纯 HTTP 客户端实现：只负责与本地 llama-server HTTP API 通信，
 * 不包含任何 mock 回退逻辑。回退/环境选择统一由 api/provider.ts 装配。
 */
export class HttpEngineApiClient implements IEngineApiClient {
  private baseUrl = 'http://127.0.0.1:38400'

  constructor(baseUrl?: string) {
    if (baseUrl) this.baseUrl = baseUrl
  }

  public setBaseUrl(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  public getBaseUrl(): string {
    return this.baseUrl
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
            return
          }
        } catch {
          // 端口可能仍在启动探测中，稍作等待后重试
        }
        await new Promise(res => setTimeout(res, 100))
      }
    }
  }

  /**
   * 统一的 JSON 请求助手：错误直接向上抛出，由调用方决定处理策略
   */
  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, init)
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`)
    return await res.json()
  }

  async getEngineStatus(): Promise<EngineStatusResponse> {
    await this.ensureReady()
    return this.requestJson<EngineStatusResponse>('/api/engine/status')
  }

  async switchEngine(backend: string): Promise<{ success: boolean; message?: string }> {
    await this.ensureReady()
    return this.requestJson('/api/engine/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend })
    })
  }

  async getEngineList(): Promise<EngineItem[]> {
    await this.ensureReady()
    const data = await this.requestJson<EngineItem[]>('/api/engine/list')
    if (!Array.isArray(data)) throw new Error('引擎列表响应格式异常')
    return data
  }

  async downloadEngine(
    backend: string,
    onProgress?: (progress: DownloadProgressEvent) => void
  ): Promise<{ success: boolean }> {
    await this.ensureReady()
    // 1. 发起引擎下载任务
    const task = await this.requestJson<{ taskId: string }>('/api/engine/download/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend })
    })
    const taskId: string = task.taskId

    // 2. 轮询下载进度直到完成（统一委托 DownloadTaskPoller）
    const poller = new DownloadTaskPoller(id => this.requestJson<any>(`/api/engine/download/status/${id}`))
    const outcome = await poller.pollUntilDone(taskId, status => ({
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
    }), onProgress)

    if (outcome.kind === 'error') throw new Error(outcome.message.replace('下载失败', '引擎下载失败'))
    if (outcome.kind === 'canceled') throw new Error('引擎下载已取消')

    return { success: true }
  }

  async listModels(source?: string): Promise<ModelItem[]> {
    await this.ensureReady()
    const url = source ? `/api/models?source=${source}` : '/api/models'
    const data = await this.requestJson<ModelItem[]>(url)
    if (!Array.isArray(data)) throw new Error('模型列表响应格式异常')
    return data
  }

  async startModelDownload(
    modelId: string,
    options?: { source?: string; forceRestart?: boolean },
    onProgress?: (event: DownloadProgressEvent) => void
  ): Promise<DownloadTaskSummary> {
    await this.ensureReady()
    // 1. 发起下载任务
    const task = await this.requestJson<{ taskId: string }>('/api/models/download/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId,
        source: options?.source || 'modelscope',
        forceRestart: options?.forceRestart || false
      })
    })
    const taskId: string = task.taskId

    // 2. 轮询进度直到完成（统一委托 DownloadTaskPoller）
    const poller = new DownloadTaskPoller(id => this.requestJson<any>(`/api/models/download/status/${id}`))
    const outcome = await poller.pollUntilDone(taskId, status => ({
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
    }), onProgress)

    if (outcome.kind === 'error') throw new Error(outcome.message)
    if (outcome.kind === 'canceled') throw new Error(outcome.message)

    return { taskId, totalBytes: 0, isDownloaded: true }
  }

  async pauseModelDownload(taskId: string): Promise<void> {
    // 暂停等同于取消（llama-model-download 不支持真正暂停）
    await this.requestJson<void>(`/api/models/download/cancel/${taskId}`, { method: 'POST' })
  }

  async resumeModelDownload(_taskId: string): Promise<void> {
    // 明确契约：后端不支持断点恢复，恢复下载必须由 hook 重新发起 startModelDownload
    throw new Error('resumeModelDownload 不受支持：请通过 startModelDownload 重新发起下载')
  }

  async cancelModelDownload(taskId: string): Promise<void> {
    await this.requestJson<void>(`/api/models/download/cancel/${taskId}`, { method: 'POST' })
  }

  async updateModelStoragePath(newPath: string): Promise<{ success: boolean; scannedModelsCount: number }> {
    await this.ensureReady()
    return this.requestJson('/api/engine/models-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newPath })
    })
  }

  async rescanModels(): Promise<ModelItem[]> {
    await this.ensureReady()
    const data = await this.requestJson<ModelItem[]>('/api/models/rescan', { method: 'POST' })
    if (!Array.isArray(data)) throw new Error('模型列表响应格式异常')
    return data
  }

  async updateRuntimeParams(params: Partial<RuntimeParams>): Promise<{ success: boolean }> {
    await this.ensureReady()
    return this.requestJson('/api/engine/params', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    })
  }

  async saveModelParams(modelId: string, params: RuntimeParams): Promise<{ success: boolean }> {
    await this.ensureReady()
    return this.requestJson('/api/models/params', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, params })
    })
  }

  async getModelParams(modelId: string): Promise<RuntimeParams | undefined> {
    await this.ensureReady()
    const data = await this.requestJson<{ params?: RuntimeParams }>(`/api/models/params?modelId=${encodeURIComponent(modelId)}`)
    return data.params
  }

  async addCustomModel(url: string): Promise<ModelItem> {
    await this.ensureReady()
    const res = await fetch(`${this.baseUrl}/api/models/custom/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.success) {
      // 优先透出后端解析/嗅探失败的具体原因
      throw new Error(body?.error || `HTTP ${res.status} /api/models/custom/add`)
    }
    return body.model as ModelItem
  }

  async switchModel(
    modelId: string,
    source?: string,
    localPath?: string,
    modelName?: string
  ): Promise<{ success: boolean; currentModel: string }> {
    await this.ensureReady()
    return this.requestJson('/api/models/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, source, localPath, modelName })
    })
  }

  async resetDowngrade(): Promise<{ status: string }> {
    await this.ensureReady()
    return this.requestJson('/api/engine/reset-downgrade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
  }

  async startEngine(): Promise<{ success: boolean; message?: string; error?: string }> {
    await this.ensureReady()
    return this.requestJson('/api/engine/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
  }

  async stopEngine(): Promise<{ success: boolean; message?: string; error?: string }> {
    await this.ensureReady()
    return this.requestJson('/api/engine/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
  }

  async getEngineLogs(): Promise<{ logs: string[] }> {
    await this.ensureReady()
    return this.requestJson('/api/engine/logs')
  }

  async clearEngineLogs(): Promise<{ success: boolean }> {
    await this.ensureReady()
    return this.requestJson('/api/engine/logs/clear', { method: 'POST' })
  }
}
