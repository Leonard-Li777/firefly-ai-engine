import { ModelItem, ModelResolution } from '../api/types'

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
   * 从文件名中提取标准化的量化标签（如 q4_k_m, q4_k_xl, q5_k_xl, f16 等）
   */
  public static extractQuantTag(name: string): string | null {
    if (!name) return null
    const match = name.match(/[-_.](?:ud-)?([a-z0-9]+_[a-z0-9_]+|q[0-9]_[0-9a-z_]+|iq[0-9]_[0-9a-z_]+|f16|f32|bf16)(?:\.gguf|$)/i)
    if (match) {
      return match[1].toLowerCase()
    }
    // 兼容其他形式量化标记如 Q4_K_M
    const fallbackMatch = name.match(/(q[0-9]_[a-z0-9_]+|iq[0-9]_[a-z0-9_]+|f16|f32|bf16)/i)
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

    const targetTag = cleanTag ? cleanTag.replace(/^ud-/, '').toLowerCase() : ''

    // 寻找主模型文件 (.gguf, 非 mmproj, 严格匹配量化 tag)
    const mainModelPath = filePaths.find(p => {
      const fileName = p.substring(p.lastIndexOf('/') + 1).toLowerCase()
      if (!fileName.endsWith('.gguf') || fileName.includes('mmproj')) {
        return false
      }
      if (!targetTag) {
        return true
      }
      // 提取文件中的量化 tag 严格比对
      const fileQuant = this.extractQuantTag(fileName)
      if (fileQuant) {
        return fileQuant === targetTag
      }
      // 若未能正则匹配出 quant，则要求完整包含 targetTag 且不与其他常见量化冲突
      return fileName.includes(targetTag)
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
 * 将扫描到的物理模型（或已下载标记）合并至推荐模型底表，确保列表永不丢失。
 * 多策略模糊匹配：量化 tag 归一化（UD- 前缀剥离）、ID 完全相同 / 清除量化后缀的
 * repo ID 相同 / 物理文件名包含核心仓库名，且双方量化 tag 齐备时严格一致（禁止跨量化串绑）。
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
    const recTag = (rec.id.includes(':')
      ? rec.id.split(':')[1]
      : rec.quant || ''
    ).replace(/^ud-/i, '').toLowerCase()

    const existing = scanned.find(m => {
      // 必须是已经确认下载就绪的扫描模型条目
      if (!m.isDownloaded && !m.localPath) return false

      // 提取被扫描模型的量化 tag：优先从本地文件名提取，次之从 m.id/m.quant 提取
      const localFileName = m.localPath ? (m.localPath.split(/[\\/]/).pop() || '') : ''
      const fileQuant = localFileName ? ModelResolver.extractQuantTag(localFileName) : null
      const mTag = fileQuant || (m.id.includes(':') ? m.id.split(':')[1] : m.quant || '').replace(/^ud-/i, '').toLowerCase()

      // 若双方均指定了量化 tag，则量化 tag 必须严格一致，禁止跨量化串绑！
      if (recTag && mTag && recTag !== mTag) {
        return false
      }

      // 策略 A: ID 完全相同
      if (m.id === rec.id) return true

      // 策略 B: 清除量化后缀后 repo ID 相同且量化 tag 吻合
      const mIdClean = m.id.split(':')[0].toLowerCase()
      if (mIdClean === recIdClean) {
        return recTag ? recTag === mTag : true
      }

      // 策略 C: 物理文件路径包含模型核心仓库名且量化 tag 吻合
      if (localFileName) {
        const localLower = localFileName.toLowerCase()
        if (localLower.includes(recTail) || localLower.replace(/\.gguf$/, '').includes(recTail.replace(/-gguf$/, ''))) {
          return recTag ? recTag === mTag : true
        }
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

  // 2. 填入扫描到的本地自定义/独有模型（保证本地模型不被丢弃）
  for (const item of scanned) {
    const isAlreadyMapped = Array.from(map.values()).some(m => {
      if (m.id === item.id) return true
      if (item.localPath && m.localPath === item.localPath) return true
      return false
    })
    if (!isAlreadyMapped) {
      map.set(item.id, item)
    }
  }

  return Array.from(map.values())
}
