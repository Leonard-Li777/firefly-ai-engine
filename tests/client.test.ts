import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HttpEngineApiClient } from '../src/api/client'
import { getEngineApiClient, setEngineApiClient, isMockMode } from '../src/api/provider'
import type { IEngineApiClient } from '../src/api/client'

// ---------------------------------------------------------------------------
// fetch stub 基础设施：拦截全局 fetch，按注册的路径返回响应
// ---------------------------------------------------------------------------
type RouteHandler = (init?: RequestInit) => { status?: number; body: any }

function installFetchStub() {
  const routes = new Map<string, RouteHandler>()
  const calls: Array<{ url: string; init?: RequestInit }> = []

  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const handler = routes.get(path)
    if (!handler) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    const { status = 200, body } = handler(init)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }))

  return {
    routes,
    calls,
    on(path: string, handler: RouteHandler) {
      routes.set(path, handler)
    },
    lastCall() {
      return calls[calls.length - 1]
    }
  }
}

describe('HttpEngineApiClient 纯 HTTP 分支测试', () => {
  let stub: ReturnType<typeof installFetchStub>
  // jsdom 无 Tauri internals，ensureReady 会自动跳过端口探测
  const client = new HttpEngineApiClient('http://127.0.0.1:38400')

  beforeEach(() => {
    stub = installFetchStub()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getEngineStatus 请求正确 URL 并返回解析后的 JSON', async () => {
    stub.on('/api/engine/status', () => ({ body: { status: 'ready', port: 38400 } }))

    const status = await client.getEngineStatus()

    expect(status.status).toBe('ready')
    expect(stub.lastCall().url).toBe('http://127.0.0.1:38400/api/engine/status')
  })

  it('startEngine 发送 POST 且 Content-Type 为 application/json', async () => {
    stub.on('/api/engine/start', () => ({ body: { success: true } }))

    const res = await client.startEngine()

    expect(res.success).toBe(true)
    const { init } = stub.lastCall()
    expect(init?.method).toBe('POST')
    expect((init?.headers as any)['Content-Type']).toBe('application/json')
  })

  it('HTTP 500 时抛出含状态码与路径的明确错误（不再静默伪装成功）', async () => {
    stub.on('/api/engine/start', () => ({ status: 500, body: {} }))

    await expect(client.startEngine()).rejects.toThrow(/HTTP 500 .*\/api\/engine\/start/)
  })

  it('switchModel 请求体包含 modelId/source/localPath/modelName', async () => {
    stub.on('/api/models/switch', () => ({ body: { success: true, currentModel: 'm' } }))

    await client.switchModel('qwen-2b', 'modelscope', 'D:/m.gguf', 'Qwen2')

    const body = JSON.parse((stub.lastCall().init?.body as string) || '{}')
    expect(body).toEqual({ modelId: 'qwen-2b', source: 'modelscope', localPath: 'D:/m.gguf', modelName: 'Qwen2' })
  })

  it('listModels 支持 source 查询参数拼接', async () => {
    stub.on('/api/models?source=huggingface', () => ({ body: [] }))

    await client.listModels('huggingface')

    expect(stub.lastCall().url).toBe('http://127.0.0.1:38400/api/models?source=huggingface')
  })

  it('响应非数组时抛出格式异常错误（不再回退 mock 数据）', async () => {
    stub.on('/api/models', () => ({ body: { unexpected: true } }))

    await expect(client.listModels()).rejects.toThrow('模型列表响应格式异常')
  })

  it('resumeModelDownload 为明确不支持的契约（抛错而非 no-op 伪装）', async () => {
    await expect(client.resumeModelDownload('task-1')).rejects.toThrow('resumeModelDownload 不受支持')
  })

  it('pauseModelDownload 走 cancel 端点（后端无真正暂停能力）', async () => {
    stub.on('/api/models/download/cancel/task-9', () => ({ body: { success: true } }))

    await client.pauseModelDownload('task-9')

    expect(stub.lastCall().url).toBe('http://127.0.0.1:38400/api/models/download/cancel/task-9')
  })
})

describe('Provider 注入 seam 测试', () => {
  afterEach(() => {
    // 恢复默认装配，避免污染其它测试
    setEngineApiClient(null)
    vi.unstubAllGlobals()
  })

  it('浏览器/测试环境（无 Tauri）默认装配 mock 演示数据', () => {
    expect(isMockMode()).toBe(true)
  })

  it('setEngineApiClient 可注入受控 fake，store/hook 经同一 seam 拿到它', async () => {
    const fake: IEngineApiClient = {
      getEngineStatus: vi.fn(async () => ({ status: 'ready', port: 38400 } as any)),
      startEngine: vi.fn(async () => ({ success: true })),
      clearEngineLogs: vi.fn(async () => ({ success: true }))
    } as unknown as IEngineApiClient

    setEngineApiClient(fake)

    expect(isMockMode()).toBe(false)
    expect(getEngineApiClient()).toBe(fake)
    await getEngineApiClient().startEngine()
    expect(fake.startEngine).toHaveBeenCalledTimes(1)
  })

  it('setEngineApiClient(null) 恢复默认装配', () => {
    const fake = {} as IEngineApiClient
    setEngineApiClient(fake)
    expect(getEngineApiClient()).toBe(fake)

    setEngineApiClient(null)
    expect(isMockMode()).toBe(true)
  })
})
