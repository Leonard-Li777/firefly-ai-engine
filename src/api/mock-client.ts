import {
  EngineStatusResponse,
  EngineItem,
  ModelItem,
  DownloadProgressEvent,
  DownloadTaskSummary,
  RuntimeParams
} from './types'
import { IEngineApiClient } from './client'
import { modelMetadataService } from '../lib/model-metadata-service'
import { useI18nStore } from '../lib/i18n'

import { resolveToAbsolutePath } from '../lib/path-utils'
import { LlamaCommandBuilder } from '../lib/command-builder'

/**
 * 独立的 Mock API 仿真客户端
 * 用于纯前端脱离后端独立运行、沙盒交互验证与自动化测试
 */
export class MockApiClient implements IEngineApiClient {
  private currentBackend: 'vulkan' | 'cuda' | 'cpu' | 'metal' = 'vulkan'
  private currentModel = 'Qwen 3.5 0.8B (中文更佳)'
  private modelsDir = resolveToAbsolutePath('build/extraResources/models')
  private vramUsageMb = 1420
  private status: 'ready' | 'starting' | 'stopped' | 'error' = 'ready'

  private downgradeInfo = {
    downgraded: true,
    reason: 'GPU_DRIVER_OUTDATED',
    message: 'NVIDIA 显卡驱动版本过低，已自动降级至 Vulkan 运行。建议前往官网更新驱动以启用最高性能 CUDA 加速。',
    driver_update_url: 'https://www.nvidia.cn/Download/index.aspx'
  }

  private engines: EngineItem[] = [
    {
      id: 'cuda134',
      name: 'CUDA 13.4',
      backend: 'cuda', // 后端标识
      matchType: 'best',
      matchText: '最新最佳',
      performance: '100% 性能利用 (最新驱动)',
      isCurrent: false,
      isInstalled: false,
      downloadSizeMb: 480,
      driverCompliant: false, // 模拟 CUDA 13 驱动版本不足，需升级显卡驱动
      driverUpdateUrl: 'https://www.nvidia.cn/Download/index.aspx'
    },
    {
      id: 'cuda',
      name: 'CUDA 12.4',
      backend: 'cuda',
      matchType: 'best',
      matchText: '最佳匹配',
      performance: '100% 性能利用',
      isCurrent: false,
      isInstalled: false, // 初始未安装，触发【下载引擎】
      downloadSizeMb: 450,
      driverCompliant: true
    },
    {
      id: 'vulkan',
      name: 'Vulkan',
      backend: 'vulkan',
      matchType: 'compatible',
      matchText: '兼容模式',
      performance: '70% 性能利用',
      isCurrent: true,
      isInstalled: true,
      driverCompliant: true
    },
    {
      id: 'cpu',
      name: 'CPU (AVX2)',
      backend: 'cpu',
      matchType: 'fallback',
      matchText: '保底',
      performance: '无显卡加速',
      isCurrent: false,
      isInstalled: true,
      driverCompliant: true
    }
  ]

  private models: ModelItem[] = [
    {
      id: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL',
      name: 'Qwen 3.5 0.8B (中文更佳)',
      author: 'unsloth',
      source: 'modelscope',
      quant: 'Q4_K_XL',
      fileSize: 558000000,
      params: '0.8B',
      description: '极速轻量文本模型，适合低配及 CPU 环境，中文分析表现均衡。',
      isMultiModal: false,
      isDownloaded: true,
      recommended: true,
      localPath: 'D:\\AI_Models\\hub\\models\\unsloth\\Qwen3.5-0.8B-GGUF\\qwen3.5-0.8b-instruct-ud-q4_k_xl.gguf',
      sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
    },
    {
      id: 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M',
      name: 'LFM2.5 1.2B Instruct（英文更佳•高速）',
      author: 'LiquidAI',
      source: 'modelscope',
      quant: 'Q4_K_M',
      fileSize: 873000000,
      params: '1.2B',
      description: '最新 LFM2.5 指令模型，文本分析高效，CPU 推理快速。',
      isMultiModal: false,
      isDownloaded: true,
      recommended: true,
      localPath: 'D:\\AI_Models\\hub\\models\\LiquidAI\\LFM2.5-1.2B-Instruct-GGUF\\lfm2.5-1.2b-instruct-q4_k_m.gguf',
      sha256: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8'
    },
    {
      id: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q5_K_XL',
      name: 'Qwen 3.5 0.8B (中文更佳)',
      author: 'unsloth',
      source: 'huggingface',
      quant: 'UD-Q5_K_XL',
      fileSize: 579000000,
      params: '0.8B',
      description: '极速轻量文本模型，适合低配及 CPU 环境，中文分析表现均衡。',
      isMultiModal: false,
      isDownloaded: false,
      recommended: true,
      sha256: '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a'
    }
  ]

  private runtimeParams: RuntimeParams = {
    n_gpu_layers: 24,
    threads: 8,
    ctx_size: 4096,
    batch_size: 512,
    ubatch_size: 256
  }

  private activeTasks = new Map<string, { intervalId: any; isPaused: boolean }>()

  async getEngineStatus(): Promise<EngineStatusResponse> {
    return {
      status: this.status,
      active_backend: this.currentBackend,
      current_model: this.currentModel,
      models_dir: this.modelsDir,
      vram_usage_mb: this.vramUsageMb,
      port: 38400,
      hardware: {
        gpu_name: 'NVIDIA GeForce RTX 3060',
        total_vram_gb: 12.0,
        used_vram_gb: Math.round((this.vramUsageMb / 1024) * 10) / 10,
        best_tier: 'cuda',
        current_tier: this.currentBackend,
        is_integrated: false,
        cpu_cores: 8,
        cpu_threads: 16,
        os_platform: 'win32',
        total_ram_gb: 32.0,
        used_ram_gb: 9.4
      },
      downgrade_info: this.currentBackend === 'vulkan' ? this.downgradeInfo : undefined,
      runtime_params: this.runtimeParams
    }
  }

  async switchEngine(backend: string): Promise<{ success: boolean; message?: string }> {
    const target = this.engines.find(e => e.backend === backend)
    if (!target) return { success: false, message: '未找到指定引擎' }
    if (!target.isInstalled) return { success: false, message: '引擎尚未安装，请先下载' }

    this.currentBackend = backend as any
    this.engines = this.engines.map(e => ({
      ...e,
      isCurrent: e.backend === backend
    }))
    return { success: true }
  }

  async getEngineList(): Promise<EngineItem[]> {
    return [...this.engines]
  }

  async downloadEngine(
    backend: string,
    onProgress?: (progress: DownloadProgressEvent) => void
  ): Promise<{ success: boolean }> {
    const engine = this.engines.find(e => e.backend === backend)
    if (!engine) return { success: false }

    const taskId = `engine-${backend}-${Date.now()}`
    const totalBytes = (engine.downloadSizeMb || 300) * 1024 * 1024
    let received = 0
    const step = totalBytes / 10

    return new Promise(resolve => {
      const interval = setInterval(() => {
        received += step
        const percent = Math.min(100, Math.round((received / totalBytes) * 100))
        const speed = Math.round(15 * 1024 * 1024 + Math.random() * 5 * 1024 * 1024) // 15-20MB/s

        if (onProgress) {
          onProgress({
            taskId,
            modelId: `engine-${backend}`,
            percent,
            receivedBytes: Math.min(received, totalBytes),
            totalBytes,
            speedBps: speed,
            status: percent >= 100 ? 'completed' : 'downloading',
            currentFileName: `${backend}-toolkit.zip`
          })
        }

        if (percent >= 100) {
          clearInterval(interval)
          engine.isInstalled = true
          resolve({ success: true })
        }
      }, 100)
    })
  }

  async listModels(source?: string): Promise<ModelItem[]> {
    const currentLang = useI18nStore.getState().currentLanguage || 'zh-CN'
    const recommendedList = modelMetadataService.getModelsForLanguage(currentLang)

    // 将已有的已下载模型状态映射至推荐列表，或追加独有本地模型
    const mergedMap = new Map<string, ModelItem>()

    // 优先填入推荐模型
    for (const rec of recommendedList) {
      const existing = this.models.find(m => m.id === rec.id)
      mergedMap.set(rec.id, {
        ...rec,
        isDownloaded: existing ? existing.isDownloaded : false,
        localPath: existing?.localPath,
        sha256: existing?.sha256
      })
    }

    // 填入本地独有模型
    for (const local of this.models) {
      if (!mergedMap.has(local.id)) {
        mergedMap.set(local.id, local)
      }
    }

    const all = Array.from(mergedMap.values())
    if (source) {
      return all.filter(m => m.source === source)
    }
    return all
  }

  async startModelDownload(
    modelId: string,
    options?: { source?: string; forceRestart?: boolean },
    onProgress?: (event: DownloadProgressEvent) => void
  ): Promise<DownloadTaskSummary> {
    // 优先在本地已知列表中查找，找不到则从元数据推荐列表中动态补充
    let model = this.models.find(m => m.id === modelId)
    if (!model) {
      const currentLang = useI18nStore.getState().currentLanguage || 'zh-CN'
      const fromMeta = modelMetadataService.getModelById(modelId, currentLang)
      if (fromMeta) {
        // 将推荐模型加入本地缓存，便于后续状态更新（如 isDownloaded）
        this.models.push({ ...fromMeta, isDownloaded: false })
        model = this.models[this.models.length - 1]
      }
    }
    if (!model) throw new Error(`未找到模型: ${modelId}`)

    const taskId = `dl-${modelId}-${Date.now()}`
    const isMultiModal = !!model.isMultiModal
    const totalFiles = isMultiModal ? 2 : 1
    const totalBytes = model.fileSize

    let received = 0
    const step = totalBytes / 10

    const interval = setInterval(() => {
      const taskMeta = this.activeTasks.get(taskId)
      if (taskMeta?.isPaused) return

      received += step
      const percent = Math.min(100, Math.round((received / totalBytes) * 100))
      const speed = Math.round(25 * 1024 * 1024 + Math.random() * 8 * 1024 * 1024)

      // 多模态阶段模拟
      let fileIndex = 0
      let currentFileName = `${model.name.replace(/\s+/g, '_')}.gguf`
      if (isMultiModal) {
        if (percent < 50) {
          fileIndex = 0
          currentFileName = `${model.name.replace(/\s+/g, '_')}.gguf`
        } else {
          fileIndex = 1
          currentFileName = model.mmprojFileName || 'mmproj.gguf'
        }
      }

      if (onProgress) {
        onProgress({
          taskId,
          modelId,
          source: options?.source as any || model.source,
          percent,
          receivedBytes: Math.min(received, totalBytes),
          totalBytes,
          speedBps: speed,
          status: percent >= 100 ? 'completed' : 'downloading',
          currentFileName,
          fileIndex,
          totalFiles
        })
      }

      if (percent >= 100) {
        clearInterval(interval)
        this.activeTasks.delete(taskId)
        model.isDownloaded = true
        model.localPath = `${this.modelsDir}\\${model.id.replace(/\//g, '\\')}\\model.gguf`
        if (isMultiModal) {
          model.mmprojLocalPath = `${this.modelsDir}\\${model.id.replace(/\//g, '\\')}\\mmproj.gguf`
        }
      }
    }, 100)

    this.activeTasks.set(taskId, { intervalId: interval, isPaused: false })

    return {
      taskId,
      totalBytes,
      isDownloaded: model.isDownloaded
    }
  }

  async pauseModelDownload(taskId: string): Promise<void> {
    const task = this.activeTasks.get(taskId)
    if (task) task.isPaused = true
  }

  async resumeModelDownload(taskId: string): Promise<void> {
    const task = this.activeTasks.get(taskId)
    if (task) task.isPaused = false
  }

  async cancelModelDownload(taskId: string): Promise<void> {
    const task = this.activeTasks.get(taskId)
    if (task) {
      clearInterval(task.intervalId)
      this.activeTasks.delete(taskId)
    }
  }

  async updateModelStoragePath(newPath: string): Promise<{ success: boolean; scannedModelsCount: number }> {
    this.modelsDir = resolveToAbsolutePath(newPath)
    return {
      success: true,
      scannedModelsCount: this.models.filter(m => m.isDownloaded).length
    }
  }

  async rescanModels(): Promise<ModelItem[]> {
    return this.listModels()
  }

  async updateRuntimeParams(params: Partial<RuntimeParams>): Promise<{ success: boolean }> {
    this.runtimeParams = { ...this.runtimeParams, ...params }
    return { success: true }
  }

  async switchModel(modelId: string, source?: string): Promise<{ success: boolean; currentModel: string }> {
    const currentLang = useI18nStore.getState().currentLanguage || 'zh-CN'
    const meta = modelMetadataService.getModelById(modelId, currentLang, source)
    const targetName = meta ? meta.name : modelId
    this.currentModel = targetName
    return {
      success: true,
      currentModel: this.currentModel
    }
  }

  async resetDowngrade(): Promise<{ status: string }> {
    this.downgradeInfo = {
      downgraded: false,
      reason: '',
      message: '',
      driver_update_url: ''
    }
    return { status: 'ok' }
  }

  private mockLogs: string[] = [
    `[cmd] "llama-server.exe" --host 127.0.0.1 --model "D:\\AI_Models\\hub\\models\\unsloth\\Qwen3.5-0.8B-GGUF\\qwen3.5-0.8b-instruct-ud-q4_k_xl.gguf" --port 38400 --ctx-size 4096 --alias unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL --jinja --no-context-shift --load-mode auto --repeat-penalty 1.1 --parallel 1 --reasoning off --reasoning-format none --reasoning-budget 0 --chat-template "{% for message in messages %}{{'<|im_start|>' + message['role'] + '\\n' + message['content'] + '<|im_end|>\\n'}}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant\\n' }}{% endif %}" -fa off --n-gpu-layers 24 --batch-size 512 --ubatch-size 256 -t 6`,
    '[stdout] system_info: n_threads = 6 / 16 | AVX = 1 | AVX_VNNI = 0 | AVX2 = 1 | FMA = 1 | NEON = 0 | ARM_FMA = 0 | F16C = 1 | FP16_VA = 0 | WASM_SIMD = 0 | BLAS = 1 | SSE3 = 1 | SSSE3 = 1 | VSX = 0 | MATMUL_INT8 = 0 | LLAMAFILE = 1 |',
    '[stdout] main: model = qwen3.5-0.8b-instruct-ud-q4_k_xl.gguf',
    '[stdout] main: load time = 486.25 ms',
    '[stdout] llama server listening at http://127.0.0.1:38400',
    '[stdout] all slots are idle and ready to accept inference requests'
  ]

  async startEngine(): Promise<{ success: boolean; message?: string }> {
    this.status = 'ready'

    // 通过 LlamaCommandBuilder 计算完整的启动命令上下文
    const targetModel = this.models.find(m => m.name === this.currentModel) || this.models[0]
    const cmdCtx = LlamaCommandBuilder.buildCommandContext({
      modelId: targetModel?.id || 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL',
      modelPath: targetModel?.localPath,
      source: targetModel?.source,
      port: 38400,
      contextWindow: this.runtimeParams.ctx_size,
      batchSize: this.runtimeParams.batch_size,
      ubatchSize: this.runtimeParams.ubatch_size,
      gpuLayers: this.runtimeParams.n_gpu_layers,
      threads: this.runtimeParams.threads,
      backend: this.currentBackend,
      hardware: {
        vramGB: 12.0,
        gpuVendor: 'nvidia',
        isIntegrated: false,
        cpuCores: 8
      }
    })

    this.mockLogs.push(`[cmd] ${cmdCtx.fullCommandLine}`)
    this.mockLogs.push(`[stdout] service started at ${new Date().toLocaleTimeString()}`)
    this.mockLogs.push('[stdout] llama server listening at http://127.0.0.1:38400')
    this.mockLogs.push('[stdout] all slots are idle and ready to accept inference requests')
    return { success: true, message: '服务启动成功' }
  }

  async stopEngine(): Promise<{ success: boolean; message?: string }> {
    this.status = 'stopped'
    this.mockLogs.push(`[stdout] service stopped at ${new Date().toLocaleTimeString()}`)
    return { success: true, message: '服务已停止' }
  }

  async getEngineLogs(): Promise<{ logs: string[] }> {
    return { logs: [...this.mockLogs] }
  }

  async clearEngineLogs(): Promise<{ success: boolean }> {
    this.mockLogs = []
    return { success: true }
  }
}

export const mockApiClient = new MockApiClient()
