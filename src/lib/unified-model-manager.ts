import { ModelItem } from '../api/types'
import { ModelResolver } from './model-resolver'
import { modelMetadataService, estimateRequiredVRAM } from './model-metadata-service'
import { SupportedLanguage } from './language'
import { toShortPathOnWindows } from './path-utils'

export interface DownloadStrategy {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface SpeculativeDraftPair {
  draftPath?: string
  specType: 'draft-dspark' | 'draft-mtp'
  draftMax: number
  draftMin?: number
  draftGpuLayers?: number
}

/**
 * 统一模型管理器 (UnifiedModelManager)
 * 1:1 对等移植桌面端成熟的模型规范推导、物理路径解析、DSpark 投机配对与下载策略构建
 */
export class UnifiedModelManager {
  private static instance: UnifiedModelManager
  private modelsDir: string = 'build/extraResources/models'
  private currentLanguage: SupportedLanguage = 'zh-CN'

  private constructor() {}

  static getInstance(): UnifiedModelManager {
    if (!UnifiedModelManager.instance) {
      UnifiedModelManager.instance = new UnifiedModelManager()
    }
    return UnifiedModelManager.instance
  }

  /**
   * 设置模型存放根目录
   */
  setModelBaseDir(dir: string): void {
    if (dir && typeof dir === 'string') {
      this.modelsDir = dir.trim()
    }
  }

  /**
   * 获取模型存放根目录
   */
  getModelBaseDir(): string {
    return this.modelsDir
  }

  /**
   * 设置当前语言环境
   */
  setLanguage(lang: SupportedLanguage): void {
    this.currentLanguage = lang
  }

  /**
   * 获取当前语言下的全部可用模型配置
   */
  getAllModels(): ModelItem[] {
    return modelMetadataService.getModelsForLanguage(this.currentLanguage)
  }

  /**
   * 根据 ID 和可选来源获取特定模型
   */
  getModelById(id: string, source?: string): ModelItem | undefined {
    return modelMetadataService.getModelById(id, this.currentLanguage, source)
  }

  /**
   * 获取特定模型的预期物理存放子目录
   * - ModelScope 规范: {baseDir}/hub/models/{org}/{repo}
   * - HuggingFace 规范: {baseDir}/models--{org}--{repo}
   */
  getModelDirectory(modelId: string, source?: string): string {
    const baseDir = this.getModelBaseDir()
    const model = this.getModelById(modelId, source)
    const finalSource = source || model?.source || 'huggingface'
    const effectiveId = model?.downloadId || modelId
    const repoPart = effectiveId.split(':')[0]

    const separator = baseDir.includes('/') ? '/' : '\\'

    if (finalSource === 'modelscope') {
      return `${baseDir}${separator}hub${separator}models${separator}${repoPart.replace(/\//g, separator)}`
    }

    const dirName = `models--${repoPart.replace(/\//g, '--')}`
    return `${baseDir}${separator}${dirName}`
  }

  /**
   * 解析模型的完整物理路径（主模型、多模态投影器、草稿模型）
   */
  resolveModelPaths(
    modelId: string,
    source?: string
  ): {
    modelFile?: string
    mmprojFile?: string
    draftFile?: string
    isMultiModal: boolean
    hasDSpark: boolean
  } {
    const baseDir = this.getModelBaseDir()
    const model = this.getModelById(modelId, source)
    const finalSource = source || model?.source || 'huggingface'

    const resolution = ModelResolver.resolve(modelId, baseDir, undefined, finalSource)

    let draftFile: string | undefined
    if (model?.dspark) {
      const draftRes = ModelResolver.resolve(model.dspark, baseDir, undefined, finalSource)
      draftFile = draftRes?.modelPath
    } else if (model?.draftId) {
      const draftRes = ModelResolver.resolve(model.draftId, baseDir, undefined, finalSource)
      draftFile = draftRes?.modelPath
    }

    return {
      modelFile: resolution?.modelPath,
      mmprojFile: resolution?.mmprojPath,
      draftFile,
      isMultiModal: Boolean(model?.isMultiModal || resolution?.mmprojPath),
      hasDSpark: Boolean(model?.dspark)
    }
  }

  /**
   * 探测并配对投机采样 (Speculative Sampling) 草稿模型
   * 支持 DSpark 与 MTP 草稿格式
   */
  getSpeculativePair(
    modelId: string,
    source?: string,
    gpuLayers: number = 0
  ): SpeculativeDraftPair | null {
    const model = this.getModelById(modelId, source)
    if (!model) return null

    const paths = this.resolveModelPaths(modelId, source)

    if (model.dspark) {
      return {
        draftPath: paths.draftFile,
        specType: 'draft-dspark',
        draftMax: 5,
        draftMin: 0,
        draftGpuLayers: gpuLayers > 0 ? gpuLayers : 0
      }
    }

    if (model.draftId) {
      return {
        draftPath: paths.draftFile,
        specType: 'draft-mtp',
        draftMax: 3,
        draftGpuLayers: gpuLayers > 0 ? gpuLayers : 0
      }
    }

    return null
  }

  /**
   * 构造标准化的下载目标 ID
   * 兼容处理 DSpark 连字符格式转换（如 LiquidAI/LFM2.5-1.2B-Instruct-DSpark-Q4_K_M -> ...-GGUF:Q4_K_M）
   */
  normalizeDownloadTargetId(modelId: string): string {
    let downloadTargetId = modelId
    if (!downloadTargetId.includes(':')) {
      const dsparkMatch = downloadTargetId.match(
        /^(.*LFM2\.5-[0-9.]+B(?:-[A-Za-z0-9]+)?-DSpark)[-_](Q[0-9]_[A-Za-z0-9_]+)$/i
      )
      if (dsparkMatch) {
        downloadTargetId = `${dsparkMatch[1]}-GGUF:${dsparkMatch[2]}`
      }
    }
    return downloadTargetId
  }

  /**
   * 生成生产级下载命令策略 (llama-model-download)
   */
  getDownloadStrategy(
    modelId: string,
    source?: string,
    mirror: 'cn' | 'global' = 'cn',
    downloadBinaryPath: string = 'llama-model-download.exe'
  ): DownloadStrategy {
    const model = this.getModelById(modelId, source)
    const finalSource = source || model?.source || 'huggingface'
    const sourceFlag = finalSource === 'modelscope' ? '-ms' : '-hf'
    const targetId = this.normalizeDownloadTargetId(model?.downloadId || modelId)

    const env: Record<string, string> = {
      LLAMA_CACHE: toShortPathOnWindows(this.getModelBaseDir())
    }

    if (finalSource === 'huggingface' && mirror === 'cn') {
      env['HF_ENDPOINT'] = 'https://hf-mirror.com'
    } else if (finalSource === 'modelscope') {
      env['MODEL_ENDPOINT'] = 'https://www.modelscope.cn/'
      env['HF_ENDPOINT'] = 'https://modelscope.cn'
    }

    return {
      command: toShortPathOnWindows(downloadBinaryPath),
      args: [sourceFlag, targetId, '--json'],
      env
    }
  }

  /**
   * 计算模型显存需求
   */
  calculateVRAM(totalSizeStr?: string): number {
    return estimateRequiredVRAM(totalSizeStr)
  }
}

export const unifiedModelManager = UnifiedModelManager.getInstance()
