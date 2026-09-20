/**
 * 网络区域探针服务
 * 1:1 对等移植桌面端 RegionDetectionService，支持 300ms 快速探测并自适应切换镜像源
 */

export interface RegionDetectionResult {
  region: 'cn' | 'global'
  latencyMs: number
  activeMirror: {
    modelscope: string
    huggingface: string
    githubRelease: string
  }
  timestamp: number
}

export class RegionDetector {
  private static instance: RegionDetector | null = null
  private cachedResult: RegionDetectionResult | null = null
  private readonly CACHE_TTL_MS = 15 * 60 * 1000 // 15分钟缓存

  public static getInstance(): RegionDetector {
    if (!RegionDetector.instance) {
      RegionDetector.instance = new RegionDetector()
    }
    return RegionDetector.instance
  }

  /**
   * 探测网络区域并返回镜像配置
   * @param timeoutMs 单次探测超时（默认 300ms 极速响应）
   * @param force 是否忽略缓存强制重测
   */
  public async detect(timeoutMs = 300, force = false): Promise<RegionDetectionResult> {
    const now = Date.now()
    if (!force && this.cachedResult && now - this.cachedResult.timestamp < this.CACHE_TTL_MS) {
      return this.cachedResult
    }

    const startTime = performance.now()

    // 并行测试国际端点与国内端点
    const [canReachGlobal, canReachCN] = await Promise.all([
      this.probeEndpoint('https://huggingface.co', timeoutMs),
      this.probeEndpoint('https://www.modelscope.cn', timeoutMs)
    ])

    const latencyMs = Math.round(performance.now() - startTime)

    // 决策逻辑：如果国际直连失败但国内正常，或全局连通性差，选用国内高速镜像
    const isCN = !canReachGlobal || canReachCN

    const result: RegionDetectionResult = {
      region: isCN ? 'cn' : 'global',
      latencyMs,
      activeMirror: isCN
        ? {
            modelscope: 'https://www.modelscope.cn',
            huggingface: 'https://hf-mirror.com',
            githubRelease: 'https://ghproxy.net/https://github.com'
          }
        : {
            modelscope: 'https://www.modelscope.cn',
            huggingface: 'https://huggingface.co',
            githubRelease: 'https://github.com'
          },
      timestamp: now
    }

    this.cachedResult = result
    return result
  }

  /**
   * 获取最近一次的探测缓存（若无则返回默认 cn 推荐）
   */
  public getLastResult(): RegionDetectionResult {
    if (this.cachedResult) return this.cachedResult
    return {
      region: 'cn',
      latencyMs: 0,
      activeMirror: {
        modelscope: 'https://www.modelscope.cn',
        huggingface: 'https://hf-mirror.com',
        githubRelease: 'https://ghproxy.net/https://github.com'
      },
      timestamp: Date.now()
    }
  }

  /**
   * 使用 fetch HEAD 或 GET 探测指定端点连通性
   */
  private async probeEndpoint(url: string, timeoutMs: number): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      // 在浏览器环境下部分跨域请求会受同源策略限制，使用 mode: 'no-cors' 探测连通状态
      const response = await fetch(url, {
        method: 'HEAD',
        mode: 'no-cors',
        signal: controller.signal,
        cache: 'no-store'
      }).catch(async () => {
        // 如果 HEAD 报错，尝试 GET 兜底
        return await fetch(url, {
          method: 'GET',
          mode: 'no-cors',
          signal: controller.signal,
          cache: 'no-store'
        })
      })

      clearTimeout(timeoutId)
      return !!response
    } catch {
      return false
    }
  }
}

export const regionDetector = RegionDetector.getInstance()
