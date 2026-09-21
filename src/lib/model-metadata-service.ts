import { ModelItem } from '../api/types'
import { SupportedLanguage } from './i18n/types'

import modelZhCN from '../assets/models/model_zh-CN.json'
import modelEnUS from '../assets/models/model_en-US.json'
import modelJaJP from '../assets/models/model_ja-JP.json'
import modelKoKR from '../assets/models/model_ko-KR.json'
import modelFrFR from '../assets/models/model_fr-FR.json'
import modelDeDE from '../assets/models/model_de-DE.json'
import modelEsES from '../assets/models/model_es-ES.json'
import modelRuRU from '../assets/models/model_ru-RU.json'
import modelPtPT from '../assets/models/model_pt-PT.json'
import modelArEG from '../assets/models/model_ar-EG.json'

// 10 语种模型元数据包映射
const MODEL_REGISTRY: Record<SupportedLanguage, any> = {
  'zh-CN': modelZhCN,
  'en-US': modelEnUS,
  'ja-JP': modelJaJP,
  'ko-KR': modelKoKR,
  'fr-FR': modelFrFR,
  'de-DE': modelDeDE,
  'es-ES': modelEsES,
  'ru-RU': modelRuRU,
  'pt-PT': modelPtPT,
  'ar-EG': modelArEG
}

/**
 * 将任意体积字符串（如 "558MB", "1.56GB", "4.37 GB"）转换为 GB 浮点数
 */
export function parseSizeToGB(sizeStr?: string): number {
  if (!sizeStr) return 0
  const clean = sizeStr.trim().toUpperCase()
  if (clean.endsWith('GB')) {
    return parseFloat(clean.replace('GB', '').trim()) || 0
  }
  if (clean.endsWith('MB')) {
    const mb = parseFloat(clean.replace('MB', '').trim()) || 0
    return mb / 1024
  }
  if (clean.endsWith('KB')) {
    const kb = parseFloat(clean.replace('KB', '').trim()) || 0
    return kb / (1024 * 1024)
  }
  const val = parseFloat(clean)
  return isNaN(val) ? 0 : val
}

/**
 * 计算模型在推理时所需的预估显存 (VRAM)
 * 算法：模型体积 * 1.15 (权重与膨胀冗余) + 0.5GB (基础 KV Cache 上下文 Buffer)，向上取整
 */
export function estimateRequiredVRAM(totalSizeStr?: string): number {
  const sizeGB = parseSizeToGB(totalSizeStr)
  if (sizeGB <= 0) return 2
  const overheadFactor = 1.15
  const contextBuffer = 0.5
  return Math.ceil(sizeGB * overheadFactor + contextBuffer)
}

/**
 * 规范化并转换原始 model json 条目至 ModelItem
 */
function normalizeRawModel(raw: any): ModelItem {
  const sizeGB = parseSizeToGB(raw.totalSize)
  return {
    id: raw.id,
    name: raw.name || raw.id,
    description: raw.description || '',
    source: raw.source || 'huggingface',
    quant: raw.quantization || 'Q4_K_M',
    quantization: raw.quantization,
    fileSize: Math.round(sizeGB * 1024 * 1024 * 1024),
    size: raw.totalSize,
    params: raw.parameterSize || '7B',
    parameterSize: raw.parameterSize,
    isMultiModal: Boolean(raw.isMultiModal),
    dspark: raw.dspark,
    draftId: raw.draftId,
    vramNeededGB: estimateRequiredVRAM(raw.totalSize),
    downloadId: raw.downloadId,
    isDownloaded: false,
    recommended: Boolean(raw.recommended),
    intelligenceLevel: raw.intelligenceLevel,
    capabilities: raw.capabilities
  }
}

export class ModelMetadataService {
  private static instance: ModelMetadataService

  static getInstance(): ModelMetadataService {
    if (!ModelMetadataService.instance) {
      ModelMetadataService.instance = new ModelMetadataService()
    }
    return ModelMetadataService.instance
  }

  /**
   * 获取指定语言下的所有官方推荐模型列表
   */
  getModelsForLanguage(lang: SupportedLanguage = 'zh-CN'): ModelItem[] {
    const bundle = MODEL_REGISTRY[lang] || MODEL_REGISTRY['zh-CN']
    if (!bundle || !Array.isArray(bundle.models)) {
      return []
    }
    return bundle.models.map(normalizeRawModel)
  }

  /**
   * 根据模型 ID 和可选语言/来源获取模型详细元数据
   */
  getModelById(id: string, lang: SupportedLanguage = 'zh-CN', source?: string): ModelItem | undefined {
    const models = this.getModelsForLanguage(lang)
    if (source) {
      const match = models.find(m => m.id === id && m.source === source)
      if (match) return match
    }
    return models.find(m => m.id === id)
  }

  /**
   * 获取某语言下的内置开箱默认模型 ID
   */
  getBuiltinModelId(lang: SupportedLanguage = 'zh-CN'): string {
    const models = this.getModelsForLanguage(lang)
    const builtin = models.find(m => m.recommended)
    return builtin?.id || (models.length > 0 ? models[0].id : 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL')
  }

  /**
   * 获取所有支持内置元数据的语言列表
   */
  getSupportedLanguages(): SupportedLanguage[] {
    return Object.keys(MODEL_REGISTRY) as SupportedLanguage[]
  }
}

export const modelMetadataService = ModelMetadataService.getInstance()
