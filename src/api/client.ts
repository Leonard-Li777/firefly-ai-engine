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

  async getEngineStatus(): Promise<EngineStatusResponse> {
    if (this.useMock) return mockApiClient.getEngineStatus()
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
    return mockApiClient.downloadEngine(backend, onProgress)
  }

  async listModels(source?: string): Promise<ModelItem[]> {
    if (this.useMock) return mockApiClient.listModels(source)
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
    return mockApiClient.startModelDownload(modelId, options, onProgress)
  }

  async pauseModelDownload(taskId: string): Promise<void> {
    return mockApiClient.pauseModelDownload(taskId)
  }

  async resumeModelDownload(taskId: string): Promise<void> {
    return mockApiClient.resumeModelDownload(taskId)
  }

  async cancelModelDownload(taskId: string): Promise<void> {
    return mockApiClient.cancelModelDownload(taskId)
  }

  async updateModelStoragePath(newPath: string): Promise<{ success: boolean; scannedModelsCount: number }> {
    if (this.useMock) return mockApiClient.updateModelStoragePath(newPath)
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
}

export const engineApiClient = new EngineApiClient()
