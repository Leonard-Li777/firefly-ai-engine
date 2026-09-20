import { ModelResolution } from '../api/types'

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
   * 从候选文件路径列表中寻找符合条件的主模型与多模态投影器
   */
  private static findGgufInList(
    modelId: string,
    filePaths: string[],
    cleanTag: string
  ): Omit<ModelResolution, 'dirType'> | null {
    if (!filePaths || filePaths.length === 0) return null

    // 寻找主模型文件 (.gguf, 非 mmproj, 包含 cleanTag)
    const mainModelPath = filePaths.find(p => {
      const fileName = p.substring(p.lastIndexOf('/') + 1).toLowerCase()
      return (
        fileName.endsWith('.gguf') &&
        !fileName.includes('mmproj') &&
        (cleanTag ? fileName.includes(cleanTag) : true)
      )
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
}
