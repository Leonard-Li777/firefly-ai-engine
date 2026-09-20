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

/**
 * 独立的 Mock API 仿真客户端
 * 用于纯前端脱离后端独立运行、沙盒交互验证与自动化测试
 */
export class MockApiClient implements IEngineApiClient {
  private currentBackend: 'vulkan' | 'cuda' | 'cpu' | 'metal' = 'vulkan'
  private currentModel = 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'
  private modelsDir = 'D:\\AI_Models'
  private vramUsageMb = 1420

  private downgradeInfo = {
    downgraded: true,
    reason: 'GPU_DRIVER_OUTDATED',
    message: 'NVIDIA 显卡驱动版本过低，已自动降级至 Vulkan 运行。建议前往官网更新驱动以启用最高性能 CUDA 加速。',
    driver_update_url: 'https://www.nvidia.cn/Download/index.aspx'
  }

  private engines: EngineItem[] = [
    {
      id: 'cuda',
      name: 'CUDA 12.4',
      backend: 'cuda',
      matchType: 'best',
      matchText: '最佳匹配',
      performance: '100% 性能利用',
      isCurrent: false,
      isInstalled: false, // 初始未安装，触发【下载】
      downloadSizeMb: 450
    },
    {
      id: 'vulkan',
      name: 'Vulkan (GPU通用)',
      backend: 'vulkan',
      matchType: 'compatible',
      matchText: '兼容模式',
      performance: '70% 性能利用',
      isCurrent: true,
      isInstalled: true
    },
    {
      id: 'cpu',
      name: 'CPU (AVX2)',
      backend: 'cpu',
      matchType: 'fallback',
      matchText: '保底模式',
      performance: '无显卡加速',
      isCurrent: false,
      isInstalled: true
    },
    {
      id: 'metal',
      name: 'Apple Metal',
      backend: 'metal',
      matchType: 'best',
      matchText: 'macOS 专属',
      performance: '100% 统一内存利用',
      isCurrent: false,
      isInstalled: false,
      downloadSizeMb: 120
    }
  ]

  private models: ModelItem[] = [
    {
      id: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
      name: 'Qwen 2.5 1.5B Instruct',
      author: 'Qwen',
      source: 'modelscope',
      quant: 'Q4_K_M',
      fileSize: 986000000,
      params: '1.5B',
      description: '通义千问官方小参数指令模型，极佳的中文理解与润色命名能力',
      isMultiModal: false,
      isDownloaded: true,
      localPath: 'D:\\AI_Models\\hub\\models\\Qwen\\Qwen2.5-1.5B-Instruct-GGUF\\qwen2.5-1.5b-instruct-q4_k_m.gguf',
      sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
    },
    {
      id: 'Qwen/Qwen2-VL-2B-Instruct-GGUF',
      name: 'Qwen2-VL 2B Instruct (多模态)',
      author: 'Qwen',
      source: 'modelscope',
      quant: 'Q4_K_M',
      fileSize: 1650000000,
      params: '2B',
      description: '视觉多模态模型，支持图片理解与视觉文档结构化（含 mmproj 投影器）',
      isMultiModal: true,
      mmprojFileName: 'mmproj-qwen2-vl-2b-instruct-f16.gguf',
      isDownloaded: false,
      sha256: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8'
    },
    {
      id: 'unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF',
      name: 'DeepSeek R1 Distill Qwen 1.5B',
      author: 'DeepSeek',
      source: 'huggingface',
      quant: 'Q4_K_M',
      fileSize: 1120000000,
      params: '1.5B',
      description: '开源推理强化模型，具备思维链深度推理能力',
      isMultiModal: false,
      isDownloaded: false,
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
      status: 'ready',
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
        os_platform: 'win32'
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
    const model = this.models.find(m => m.id === modelId)
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
    this.modelsDir = newPath
    return {
      success: true,
      scannedModelsCount: this.models.filter(m => m.isDownloaded).length
    }
  }

  async rescanModels(): Promise<ModelItem[]> {
    return [...this.models]
  }

  async updateRuntimeParams(params: Partial<RuntimeParams>): Promise<{ success: boolean }> {
    this.runtimeParams = { ...this.runtimeParams, ...params }
    return { success: true }
  }
}

export const mockApiClient = new MockApiClient()
