import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RegionDetector } from '../src/lib/region-detector'

describe('RegionDetector 网络探针与镜像路由', () => {
  let detector: RegionDetector

  beforeEach(() => {
    detector = new RegionDetector()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('当国内网络正常而国际受限时，正确决策为 cn 并提供国内加速镜像', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('huggingface.co')) {
        throw new Error('Connection timed out')
      }
      return new Response(null, { status: 200 })
    })

    const res = await detector.detect(100, true)

    expect(res.region).toBe('cn')
    expect(res.activeMirror.huggingface).toBe('https://hf-mirror.com')
    expect(res.activeMirror.githubRelease).toContain('ghproxy')
    expect(res.activeMirror.modelscope).toBe('https://www.modelscope.cn')
  })

  it('当能正常访问海外源时，决策为 global 并直连官方镜像', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))

    // 强制探测海外直连模式
    const detectorInstance = new (RegionDetector as any)()
    // 模拟 probeEndpoint 返回海外通、国内不优先
    vi.spyOn(detectorInstance as any, 'probeEndpoint').mockImplementation(async (url: any) => {
      return typeof url === 'string' && url.includes('huggingface.co')
    })

    const res = await detectorInstance.detect(100, true)

    expect(res.region).toBe('global')
    expect(res.activeMirror.huggingface).toBe('https://huggingface.co')
    expect(res.activeMirror.githubRelease).toBe('https://github.com')
  })

  it('探测结果能够在缓存时间内重复读取，无需发起重复网络请求', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))

    await detector.detect(100, true)
    const callCountFirst = fetchSpy.mock.calls.length

    // 第二次无 force 调用，命中缓存
    const cached = await detector.detect(100, false)
    expect(fetchSpy.mock.calls.length).toBe(callCountFirst)
    expect(cached).toBeDefined()
  })
})
