import { ModelItem, ModelResolution, EngineStatusResponse } from '../api/types'
import { estimateRequiredVRAM } from './model-metadata-service'

/**
 * 虚拟文件系统条目（供前端纯逻辑探测或测试使用）
 */
export interface FileEntry {
  path: string
  isDirectory?: boolean
  size?: number
}

/**
 * 核心模型路径探测算法
 * 1:1 对等移植桌面端 ModelResolver，支持在给定的存储目录和文件列表中寻找匹配的模型与多模态投影器
 */
export class ModelResolver {
  /**
   * 探测模型物理路径
   * @param modelId 模型ID (如 "Qwen/Qwen2.5-1.5B-Instruct-GGUF" 或 "qwen2.5:1.5b")
   * @param baseDir 基础存储目录
   * @param existingFiles 当前目录下的文件完整路径列表（可选，如果提供则无需直接访问磁盘）
   * @param source 模型来源类型 (huggingface / modelscope)
   */
  public static resolve(
    modelId: string,
    baseDir: string,
    existingFiles?: string[] | string,
    source?: string
  ): ModelResolution | null {
    if (!modelId || !baseDir) return null

    // 容错：如果第3个参数传入的是字符串（如 source），自动兼容适配
    let actualFiles: string[] = []
    let actualSource = source
    if (typeof existingFiles === 'string') {
      actualSource = existingFiles
      actualFiles = []
    } else if (Array.isArray(existingFiles)) {
      actualFiles = existingFiles
    }

    // 标准化斜杠
    const normBaseDir = baseDir.replace(/\\/g, '/').replace(/\/$/, '')
    const files = actualFiles.map(f => f.replace(/\\/g, '/'))

    // 生成候选 [repoId, cleanTag] 列表，兼容带冒号及连字符格式的变体
    const candidates: Array<{ repoId: string; cleanTag: string }> = []
    const [rawRepoId, fileTag] = modelId.includes(':') ? modelId.split(':') : [modelId, '']
    candidates.push({ repoId: rawRepoId, cleanTag: (fileTag || '').replace(/^UD-/, '').toLowerCase() })

    if (!modelId.includes(':')) {
      const quantMatch = modelId.match(
        /^(.*)[-_](UD-[A-Za-z0-9_]+|Q[0-9]_[A-Za-z0-9_]+|F16|F32|BF16|Q8_0|Q4_0|Q4_1|Q5_0|Q5_1|IQ[0-9]_[A-Za-z0-9_]+)$/i
      )
      if (quantMatch) {
        const baseRepo = quantMatch[1]
        const tag = quantMatch[2].replace(/^UD-/, '').toLowerCase()
        candidates.push(
          { repoId: `${baseRepo}-GGUF`, cleanTag: tag },
          { repoId: baseRepo, cleanTag: tag }
        )
      }
    }

    for (const { repoId, cleanTag } of candidates) {
      // 1. ModelScope 规范: hub/models/{repoId}/...
      if (!actualSource || actualSource === 'modelscope') {
        const msPrefix = `${normBaseDir}/hub/models/${repoId}`
        const msMatched = files.filter(f => f.startsWith(msPrefix))
        const res = this.findGgufInList(modelId, msMatched, cleanTag)
        if (res) {
          return { ...res, dirType: 'modelscope' }
        }
      }

      // 2. HuggingFace 现代规范: models--{org}--{repo}/snapshots/{hash}/...
      if (!actualSource || actualSource === 'huggingface') {
        const repoDirName = `models--${repoId.replace(/\//g, '--')}`
        const hfPrefix = `${normBaseDir}/${repoDirName}`
        const hfMatched = files.filter(f => f.startsWith(hfPrefix))
        const res = this.findGgufInList(modelId, hfMatched, cleanTag)
        if (res) {
          return { ...res, dirType: 'modern' }
        }

        // 3. Legacy 变体: {org}_{repo} 或 {org}--{repo}
        const legacyPrefixes = [
          `${normBaseDir}/${repoId.replace(/\//g, '_').replace(/:/g, '_')}`,
          `${normBaseDir}/${repoId.replace(/\//g, '--')}`
        ]
        for (const lp of legacyPrefixes) {
          const legMatched = files.filter(f => f.startsWith(lp))
          const legRes = this.findGgufInList(modelId, legMatched, cleanTag)
          if (legRes) {
            return { ...legRes, dirType: 'legacy' }
          }
        }
      }

      // 4. 根目录平铺匹配 (dirType 设为 legacy，与桌面端保持 1:1 一致)
      const rootMatched = files.filter(f => {
        const parent = f.substring(0, f.lastIndexOf('/'))
        return parent === normBaseDir
      })
      const repoShortName = repoId.split('/').pop()?.toLowerCase() || ''
      const effectiveTag = cleanTag || repoShortName
      if (effectiveTag) {
        const rootRes = this.findGgufInList(modelId, rootMatched, effectiveTag)
        if (rootRes) {
          return { ...rootRes, dirType: 'legacy' }
        }
      }
    }

    return null
  }

  /**
   * 从文件名中提取标准化的量化标签（如 q4_k_m, q4km, q4_k_xl, q5_k_xl, ptq1_0, pq2_0, f16 等）
   */
  public static extractQuantTag(name: string): string | null {
    if (!name) return null
    const clean = name.trim().replace(/\.gguf$/i, '')
    // 纯量化标签直接匹配 (如 PTQ1_0, PQ2_0, Q4_K_M, Q4KM, IQ4_XS 等)
    const directMatch = clean.match(/^(?:ud-)?(q[0-9](?:_?k)?(?:_?[smlx0-9]+)?|ptq[0-9]_[0-9]+|pq[0-9]_[0-9]+|iq[0-9]_[0-9a-z_]+|bf16|fp16|f16|f32)$/i)
    if (directMatch) {
      return directMatch[1].toLowerCase()
    }
    const match = name.match(/[-_.](?:ud-)?(q[0-9](?:_?k)?(?:_?[smlx0-9]+)?|ptq[0-9]_[0-9]+|pq[0-9]_[0-9]+|iq[0-9]_[0-9a-z_]+|bf16|fp16|f16|f32)(?:\.gguf|$)/i)
    if (match) {
      return match[1].toLowerCase()
    }
    // 兼容其他形式量化标记如 Q4_K_M, Q4KM
    const fallbackMatch = name.match(/(q[0-9](?:_?k)?(?:_?[smlx0-9]+)?|iq[0-9]_[0-9a-z_]+|bf16|fp16|f16|f32)/i)
    return fallbackMatch ? fallbackMatch[1].toLowerCase() : null
  }

  /**
   * 从候选文件路径列表中寻找符合条件的主模型与多模态投影器
   */
  private static findGgufInList(
    modelId: string,
    filePaths: string[],
    cleanTag: string
  ): Omit<ModelResolution, 'dirType'> | null {
    if (!filePaths || filePaths.length === 0) return null

    const targetNorm = normalizeQuantTag(cleanTag)

    // 寻找主模型文件 (.gguf, 非 mmproj, 严格匹配量化 tag)
    const mainModelPath = filePaths.find(p => {
      const fileName = p.substring(p.lastIndexOf('/') + 1).toLowerCase()
      if (!fileName.endsWith('.gguf') || fileName.includes('mmproj')) {
        return false
      }
      if (!targetNorm) {
        return true
      }
      // 提取文件中的量化 tag 严格比对
      const fileQuant = this.extractQuantTag(fileName)
      if (fileQuant) {
        return normalizeQuantTag(fileQuant) === targetNorm
      }
      // 若未能正则匹配出 quant，则要求完整包含 targetTag 且不与其他常见量化冲突
      return normalizeQuantTag(fileName).includes(targetNorm)
    })

    if (!mainModelPath) return null

    const dirPath = mainModelPath.substring(0, mainModelPath.lastIndexOf('/'))

    // 寻找多模态投影器 (--mmproj)
    const mmprojPath = filePaths.find(p => {
      const fileName = p.substring(p.lastIndexOf('/') + 1).toLowerCase()
      return (
        p.startsWith(dirPath) &&
        fileName.endsWith('.gguf') &&
        fileName.includes('mmproj')
      )
    })

    return {
      modelId,
      modelPath: mainModelPath,
      mmprojPath: mmprojPath || undefined,
      dirPath
    }
  }

  /**
   * 检查模型是否完全下载且可用（主模型存在，多模态时 mmproj 投影器也必须存在）
   * 严格对齐 Desktop ModelDownloadManager 的 checkModelDownloadStatus 逻辑
   */
  public static checkModelFullyDownloaded(
    modelId: string,
    baseDir: string,
    isMultiModal: boolean = false,
    existingFiles?: string[] | string,
    source?: string
  ): { isDownloaded: boolean; resolution: ModelResolution | null } {
    const resolution = this.resolve(modelId, baseDir, existingFiles, source)
    if (!resolution || !resolution.modelPath) {
      return { isDownloaded: false, resolution: null }
    }

    // 多模态模型必须同时具备 mmproj 投影器文件
    if (isMultiModal && !resolution.mmprojPath) {
      return { isDownloaded: false, resolution }
    }

    return { isDownloaded: true, resolution }
  }
}

/**
 * 标准化量化标签（剥离 ud- 前缀，全部小写并去除所有下划线，使得 Q4_K_M 与 Q4KM 互相等价）
 */
export function normalizeQuantTag(tag?: string | null): string {
  if (!tag) return ''
  return tag.replace(/^ud-/i, '').toLowerCase().replace(/_/g, '')
}

/**
 * 将扫描到的物理模型（或已下载标记）合并至推荐模型底表，确保列表永不丢失。
 * 多策略模糊匹配：量化 tag 归一化（UD- 前缀剥离、下划线归一）、ID 完全相同 / 清除量化后缀的
 * repo ID 相同 / 物理文件路径与文件名包含核心仓库名，且双方量化 tag 齐备时严格一致（禁止跨量化串绑）。
 * 纯函数：推荐底表（语言相关）与扫描结果均由调用方注入，不读取任何全局状态。
 *
 * @param recommendedList 当前语言的官方推荐模型底表
 * @param scanned 扫描到的本地物理模型列表
 */
export function mergeScannedWithRecommended(recommendedList: ModelItem[], scanned: ModelItem[]): ModelItem[] {
  const map = new Map<string, ModelItem>()

  // 1. 填入所有官方推荐模型，并通过多级特征精准匹配扫描到的下载状态
  for (const rec of recommendedList) {
    const recIdClean = rec.id.split(':')[0].toLowerCase()
    const recTail = recIdClean.split('/').pop()?.replace(/-gguf$/i, '') || recIdClean
    // 推荐模型的量化 tag（标准化去除 UD- 前缀，大小写不敏感，转小写）
    // 优先级策略：
    // 1. 优先使用模型列表的 quant / quantization 字段获取量化参数
    // 2. 若无 quant 字段，从 rec.id 冒号后提取：若为 .gguf 文件名则从中提取标准量化 tag，否则直接作为 tag
    // 3. Fallback：从 rec.id 全名中提取量化标识
    let rawRecTag = rec.quant || (rec as any).quantization || ''
    if (!rawRecTag && rec.id.includes(':')) {
      const tagOrFile = rec.id.split(':')[1]
      if (tagOrFile.toLowerCase().endsWith('.gguf')) {
        rawRecTag = ModelResolver.extractQuantTag(tagOrFile) || ''
      } else {
        rawRecTag = tagOrFile
      }
    }
    if (!rawRecTag) {
      rawRecTag = ModelResolver.extractQuantTag(rec.id) || ''
    }
    const recTag = rawRecTag.replace(/^ud-/i, '').toLowerCase()

    const existing = scanned.find(m => {
      // 必须是已经确认下载就绪的扫描模型条目
      if (!m.isDownloaded && !m.localPath) return false

      // 提取被扫描模型的量化 tag：以物理文件名实际量化为准，次之从 m.id / m.quant 提取
      const localFileName = m.localPath ? (m.localPath.split(/[\\/]/).pop() || '') : ''
      const fileQuant = localFileName ? ModelResolver.extractQuantTag(localFileName) : null
      let rawMTag = fileQuant || ''
      if (!rawMTag) {
        if (m.id.includes(':')) {
          const mTagOrFile = m.id.split(':')[1]
          rawMTag = mTagOrFile.toLowerCase().endsWith('.gguf')
            ? (ModelResolver.extractQuantTag(mTagOrFile) || '')
            : mTagOrFile
        } else {
          rawMTag = m.quant || (m as any).quantization || ''
        }
      }
      const mTag = rawMTag.replace(/^ud-/i, '').toLowerCase()

      // 策略 D: 推荐模型 ID 中直接指定了物理文件名（以 .gguf 结尾）且与本地文件名完全一致
      if (rec.id.includes(':')) {
        const expectedFile = rec.id.split(':')[1]
        if (expectedFile.toLowerCase().endsWith('.gguf') && localFileName.toLowerCase() === expectedFile.toLowerCase()) {
          return true
        }
      }

      // 若双方均指定了量化 tag，则量化 tag 必须严格一致，禁止跨量化串绑！
      const recTagNorm = normalizeQuantTag(recTag)
      const mTagNorm = normalizeQuantTag(mTag)
      if (recTagNorm && mTagNorm && recTagNorm !== mTagNorm) {
        return false
      }

      // 策略 A: ID 完全相同
      if (m.id === rec.id) return true

      // 策略 B: 清除量化后缀后 repo ID 相同且量化 tag 吻合
      const mIdClean = m.id.split(':')[0].toLowerCase()
      if (mIdClean === recIdClean) {
        return recTagNorm ? recTagNorm === mTagNorm : true
      }

      // 策略 C: 物理文件路径（或文件名）包含模型核心仓库名且量化 tag 吻合
      const localPathNorm = (m.localPath || '').replace(/\\/g, '/').toLowerCase()
      const localFileNameLower = localFileName.toLowerCase()
      const recTailClean = recTail.replace(/_/g, '-')
      const recTailUnder = recTail.replace(/-/g, '_')
      const matchesRepo =
        (localPathNorm && (
          localPathNorm.includes(recTail) ||
          localPathNorm.includes(recTailClean) ||
          localPathNorm.includes(recTailUnder) ||
          localPathNorm.includes(recIdClean)
        )) ||
        localFileNameLower.includes(recTail) ||
        localFileNameLower.replace(/\.gguf$/, '').includes(recTail.replace(/-gguf$/, ''))

      if (matchesRepo) {
        return recTagNorm ? recTagNorm === mTagNorm : true
      }

      return false
    })

    const isDownloaded = existing ? Boolean(existing.isDownloaded) : false
    map.set(rec.id, {
      ...rec,
      isDownloaded,
      localPath: existing?.localPath,
      sha256: existing?.sha256 || rec.sha256
    })
  }

  // 2. 填入扫描到的本地自定义/独有模型（保证本地模型不被丢弃）；
  //    此类条目不经过 normalizeRawModel，缺失 vramNeededGB 时按体积估算补齐，保证预估显存列可显示
  for (const item of scanned) {
    const localFileName = item.localPath ? (item.localPath.split(/[\\/]/).pop() || '') : ''
    // 严格过滤：投影模型（mmproj）永远只是辅助投影器，绝不能作为独立的主模型添加到模型列表
    if (
      item.id.toLowerCase().includes('mmproj') ||
      item.name.toLowerCase().includes('mmproj') ||
      localFileName.toLowerCase().includes('mmproj')
    ) {
      continue
    }

    const enriched: ModelItem = {
      ...item,
      vramNeededGB:
        item.vramNeededGB ??
        (item.fileSize > 0 ? estimateRequiredVRAM(formatFileSizeToSizeStr(item.fileSize)) : undefined)
    }
    const isAlreadyMapped = Array.from(map.values()).some(m => {
      if (m.id === enriched.id) return true
      if (
        enriched.localPath &&
        m.localPath &&
        m.localPath.replace(/\\/g, '/').toLowerCase() === enriched.localPath.replace(/\\/g, '/').toLowerCase()
      ) {
        return true
      }
      return false
    })
    if (!isAlreadyMapped) {
      map.set(enriched.id, enriched)
    }
  }

  return Array.from(map.values())
}

/**
 * 将字节数转换为体积字符串（如 "558MB", "1.56GB"），供 estimateRequiredVRAM 解析
 */
function formatFileSizeToSizeStr(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`
  }
  return `${Math.round(bytes / (1024 * 1024))}MB`
}

export interface DisplayModelResolutionOptions {
  engineStatus?: EngineStatusResponse | null
  models?: ModelItem[]
  activeModelKey?: string | null
  activeLanguageModelKey?: string | null
  activeEmbeddingModelKey?: string | null
}

export interface DisplayModelResult {
  modelItem: ModelItem | null
  modelName: string | null
  sourceType: 'running' | 'active_language' | 'active_embedding' | 'fallback' | 'none'
}

/**
 * 解析当前界面应展示的模型与友好名称
 * 严格遵循优先级规则：
 * 启动模型 (Running Model, 仅实际运行态) > 激活模型 (Active Models: 语言模型 > Embedding模型) > 兜底可用模型
 */
export function resolveDisplayModel(options: DisplayModelResolutionOptions): DisplayModelResult {
  const {
    engineStatus,
    models = [],
    activeModelKey,
    activeLanguageModelKey,
    activeEmbeddingModelKey
  } = options

  const safeModels = Array.isArray(models) ? models : []
  const rawStatus = engineStatus?.status || 'stopped'
  const isRunningOrStarting = rawStatus === 'ready' || rawStatus === 'starting'

  const matchModel = (model: ModelItem, target: string): boolean => {
    if (!target) return false
    if (model.name === target || model.id === target) return true
    if (`${model.id}@${model.source}` === target) return true

    // 兼容忽略组织前缀（如 LiquidAI/LFM2.5-1.2B... 与 LFM2.5-1.2B... 互相匹配）
    const targetBase = target.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || ''
    const idBase = model.id.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || ''
    if (targetBase && idBase && (targetBase === idBase || targetBase.includes(idBase) || idBase.includes(targetBase))) {
      return true
    }

    if (model.localPath) {
      const a = model.localPath.toLowerCase()
      const b = target.toLowerCase()
      if (a === b || a.includes(b) || b.includes(a)) return true
      const fileName = model.localPath.replace(/\\/g, '/').split('/').pop()?.replace(/\.gguf$/i, '').toLowerCase()
      if (fileName && (b.includes(fileName) || fileName.includes(b))) return true
    }
    return false
  }

  // ──────────────────────────────────────────────────────────
  // 优先级 1：启动模型（Running Model）
  // 严格约束：仅在引擎服务处于实际运行态 (ready/starting) 且有明确运行中模型时生效，
  // 服务停止态绝不使用残留的 current_model 或 activeModelKey。
  // ──────────────────────────────────────────────────────────
  if (isRunningOrStarting) {
    if (engineStatus?.current_model) {
      const matched = safeModels.find(m => matchModel(m, engineStatus.current_model!))
      if (matched) {
        return { modelItem: matched, modelName: matched.name, sourceType: 'running' }
      }
      const displayName =
        engineStatus.current_model_name ||
        engineStatus.current_model.replace(/\\/g, '/').split('/').pop()?.replace(/\.gguf$/i, '')
      return { modelItem: null, modelName: displayName || null, sourceType: 'running' }
    }
    if (activeModelKey) {
      const matched = safeModels.find(m => `${m.id}@${m.source}` === activeModelKey || m.id === activeModelKey)
      if (matched) {
        return { modelItem: matched, modelName: matched.name, sourceType: 'running' }
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // 优先级 2：激活模型 - 主语言模型 (Active Language Model)
  // ──────────────────────────────────────────────────────────
  if (activeLanguageModelKey) {
    const matched = safeModels.find(
      m => !m.isEmbedding && (`${m.id}@${m.source}` === activeLanguageModelKey || m.id === activeLanguageModelKey)
    )
    if (matched) {
      return { modelItem: matched, modelName: matched.name, sourceType: 'active_language' }
    }
  }
  if (engineStatus?.active_language_model) {
    const target = engineStatus.active_language_model
    const matched = safeModels.find(
      m => !m.isEmbedding && (`${m.id}@${m.source}` === target || m.id === target || matchModel(m, target))
    )
    if (matched) {
      return { modelItem: matched, modelName: matched.name, sourceType: 'active_language' }
    }
  }

  // ──────────────────────────────────────────────────────────
  // 优先级 3：激活模型 - 嵌入向量模型 (Active Embedding Model)
  // ──────────────────────────────────────────────────────────
  if (activeEmbeddingModelKey) {
    const matched = safeModels.find(
      m => m.isEmbedding && (`${m.id}@${m.source}` === activeEmbeddingModelKey || m.id === activeEmbeddingModelKey)
    )
    if (matched) {
      return { modelItem: matched, modelName: matched.name, sourceType: 'active_embedding' }
    }
  }
  if (engineStatus?.active_embedding_model) {
    const target = engineStatus.active_embedding_model
    const matched = safeModels.find(
      m => m.isEmbedding && (`${m.id}@${m.source}` === target || m.id === target || matchModel(m, target))
    )
    if (matched) {
      return { modelItem: matched, modelName: matched.name, sourceType: 'active_embedding' }
    }
  }

  // ──────────────────────────────────────────────────────────
  // 优先级 4：兜底已下载可用模型 (语言模型 > 嵌入模型)
  // ──────────────────────────────────────────────────────────
  const downloadedLang = safeModels.find(m => m.isDownloaded && !m.isEmbedding)
  if (downloadedLang) {
    return { modelItem: downloadedLang, modelName: downloadedLang.name, sourceType: 'fallback' }
  }
  const downloadedEmb = safeModels.find(m => m.isDownloaded && m.isEmbedding)
  if (downloadedEmb) {
    return { modelItem: downloadedEmb, modelName: downloadedEmb.name, sourceType: 'fallback' }
  }

  return { modelItem: null, modelName: null, sourceType: 'none' }
}
