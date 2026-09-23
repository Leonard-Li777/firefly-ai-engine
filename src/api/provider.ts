import { IEngineApiClient } from './client'
import { mockApiClient } from './mock-client'

/**
 * 回退装饰器（FallbackDecorator）：
 * 包装一个真实 HTTP 客户端，当 HTTP 调用失败时降级到 mock 并记录告警日志。
 * 回退策略集中在此单点 —— 调用方不再需要感知"这次结果是真数据还是兜底数据"，
 * 但通过日志可以显式感知降级发生（不静默伪装成功）。
 */
class FallbackEngineApiClient implements IEngineApiClient {
  constructor(private inner: IEngineApiClient) {}

  private async withFallback<T>(label: string, op: () => Promise<T>, fallback: () => T | Promise<T>): Promise<T> {
    try {
      return await op()
    } catch (e) {
      console.warn(`[EngineApiClient] ${label} 请求失败，已降级为演示数据:`, e)
      return await fallback()
    }
  }

  getEngineStatus() {
    return this.withFallback('getEngineStatus', () => this.inner.getEngineStatus(), () => mockApiClient.getEngineStatus())
  }

  switchEngine(backend: string) {
    return this.withFallback('switchEngine', () => this.inner.switchEngine(backend), () => mockApiClient.switchEngine(backend))
  }

  getEngineList() {
    return this.withFallback('getEngineList', () => this.inner.getEngineList(), () => mockApiClient.getEngineList())
  }

  downloadEngine(backend: string, onProgress?: (p: any) => void) {
    return this.withFallback('downloadEngine', () => this.inner.downloadEngine(backend, onProgress), () => mockApiClient.downloadEngine(backend, onProgress))
  }

  listModels(source?: string) {
    return this.withFallback('listModels', () => this.inner.listModels(source), () => mockApiClient.listModels(source))
  }

  startModelDownload(modelId: string, options?: { source?: string; forceRestart?: boolean }, onProgress?: (e: any) => void) {
    return this.withFallback(
      'startModelDownload',
      () => this.inner.startModelDownload(modelId, options, onProgress),
      () => mockApiClient.startModelDownload(modelId, options, onProgress)
    )
  }

  pauseModelDownload(taskId: string) {
    return this.withFallback('pauseModelDownload', () => this.inner.pauseModelDownload(taskId), () => mockApiClient.pauseModelDownload(taskId))
  }

  resumeModelDownload(taskId: string) {
    // 假契约修复：恢复下载不支持，明确报错而非伪装成功（hook 会以重新 start 方式绕过）
    return this.withFallback('resumeModelDownload', () => this.inner.resumeModelDownload(taskId), () => mockApiClient.resumeModelDownload(taskId))
  }

  cancelModelDownload(taskId: string) {
    return this.withFallback('cancelModelDownload', () => this.inner.cancelModelDownload(taskId), () => mockApiClient.cancelModelDownload(taskId))
  }

  updateModelStoragePath(newPath: string) {
    return this.withFallback('updateModelStoragePath', () => this.inner.updateModelStoragePath(newPath), () => mockApiClient.updateModelStoragePath(newPath))
  }

  rescanModels() {
    return this.withFallback('rescanModels', () => this.inner.rescanModels(), () => mockApiClient.rescanModels())
  }

  updateRuntimeParams(params: any) {
    return this.withFallback('updateRuntimeParams', () => this.inner.updateRuntimeParams(params), () => mockApiClient.updateRuntimeParams(params))
  }

  saveModelParams(modelId: string, params: any) {
    return this.withFallback('saveModelParams', () => this.inner.saveModelParams(modelId, params), () => mockApiClient.saveModelParams(modelId, params))
  }

  async getModelParams(modelId: string) {
    return this.withFallback('getModelParams', () => this.inner.getModelParams(modelId), () => mockApiClient.getModelParams(modelId))
  }

  switchModel(modelId: string, source?: string, localPath?: string, modelName?: string) {
    return this.withFallback(
      'switchModel',
      () => this.inner.switchModel(modelId, source, localPath, modelName),
      () => mockApiClient.switchModel(modelId, source, localPath, modelName)
    )
  }

  resetDowngrade() {
    return this.withFallback('resetDowngrade', () => this.inner.resetDowngrade(), () => mockApiClient.resetDowngrade())
  }

  startEngine() {
    return this.withFallback('startEngine', () => this.inner.startEngine(), () => mockApiClient.startEngine())
  }

  stopEngine() {
    return this.withFallback('stopEngine', () => this.inner.stopEngine(), () => mockApiClient.stopEngine())
  }

  getEngineLogs() {
    return this.withFallback('getEngineLogs', () => this.inner.getEngineLogs(), () => mockApiClient.getEngineLogs())
  }

  clearEngineLogs() {
    return this.withFallback('clearEngineLogs', () => this.inner.clearEngineLogs(), () => mockApiClient.clearEngineLogs())
  }

  addCustomModel(url: string) {
    // 写操作刻意不走 mock 回退：URL 解析/嗅探失败的具体原因必须显式透出给用户，
    // 静默降级到演示数据会伪装"添加成功"，误导用户
    return this.inner.addCustomModel(url)
  }
}

/**
 * 装配点（Provider）：整个应用中唯一允许创建客户端实例的地方。
 * - 浏览器/测试环境（无 Tauri）：直接使用 mock（演示数据模式）
 * - Tauri 环境：HTTP 客户端 + 失败回退装饰器（回退时记录告警日志）
 *
 * 测试通过 setEngineApiClient() 注入受控 fake，即可经由同一 seam
 * 驱动 store / hook / 组件，摆脱对 mock-client 演示数据的隐式依赖。
 */
let instance: IEngineApiClient | null = null

function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__
}

function assemble(): IEngineApiClient {
  if (!isTauriEnvironment()) {
    return mockApiClient
  }
  // 延迟 import 避免浏览器/测试环境加载 HTTP 实现时的副作用
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { HttpEngineApiClient } = require('./client') as typeof import('./client')
  return new FallbackEngineApiClient(new HttpEngineApiClient())
}

/**
 * 获取全局引擎 API 客户端单例（惰性装配）
 */
export function getEngineApiClient(): IEngineApiClient {
  if (!instance) instance = assemble()
  return instance
}

/**
 * 测试注入口：替换全局客户端实例（传 null 恢复默认装配）
 */
export function setEngineApiClient(client: IEngineApiClient | null): void {
  instance = client
}

/**
 * 是否处于演示数据（mock）模式 —— 供 App 顶部沙盒徽标展示
 */
export function isMockMode(): boolean {
  return getEngineApiClient() === mockApiClient
}

/**
 * 惰性转发单例：保持与旧 engineApiClient 相同的使用形态（engineApiClient.xxx()），
 * 属性访问时实时解析到当前装配/注入的实例，兼容测试注入口替换。
 */
export const engineApiClient: IEngineApiClient = new Proxy({} as IEngineApiClient, {
  get: (_target, prop: string) => (getEngineApiClient() as any)[prop]
})
