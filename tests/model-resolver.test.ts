import { describe, it, expect } from 'vitest'
import { ModelResolver, mergeScannedWithRecommended } from '../src/lib/model-resolver'
import type { ModelItem } from '../src/api/types'

describe('ModelResolver 路径探测算法 (1:1 移植)', () => {
  const baseDir = 'D:/AI_Models'

  it('能够根据现代 HuggingFace 缓存结构探测到主模型与多模态投影器', () => {
    const existingFiles = [
      'D:/AI_Models/models--Qwen--Qwen2-VL-2B-Instruct-GGUF/snapshots/123456/qwen2-vl-2b-instruct-q4_k_m.gguf',
      'D:/AI_Models/models--Qwen--Qwen2-VL-2B-Instruct-GGUF/snapshots/123456/mmproj-qwen2-vl-2b-instruct-f16.gguf',
      'D:/AI_Models/models--Qwen--Qwen2-VL-2B-Instruct-GGUF/snapshots/123456/README.md'
    ]

    const result = ModelResolver.resolve(
      'Qwen/Qwen2-VL-2B-Instruct-GGUF',
      baseDir,
      existingFiles,
      'huggingface'
    )

    expect(result).not.toBeNull()
    expect(result?.dirType).toBe('modern')
    expect(result?.modelPath).toBe(
      'D:/AI_Models/models--Qwen--Qwen2-VL-2B-Instruct-GGUF/snapshots/123456/qwen2-vl-2b-instruct-q4_k_m.gguf'
    )
    expect(result?.mmprojPath).toBe(
      'D:/AI_Models/models--Qwen--Qwen2-VL-2B-Instruct-GGUF/snapshots/123456/mmproj-qwen2-vl-2b-instruct-f16.gguf'
    )
  })

  it('能够根据 ModelScope 目录规范正确探测 hub/models 结构', () => {
    const existingFiles = [
      'D:/AI_Models/hub/models/Qwen/Qwen2.5-1.5B-Instruct-GGUF/qwen2.5-1.5b-instruct-q4_k_m.gguf'
    ]

    const result = ModelResolver.resolve(
      'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
      baseDir,
      existingFiles,
      'modelscope'
    )

    expect(result).not.toBeNull()
    expect(result?.dirType).toBe('modelscope')
    expect(result?.modelPath).toBe(
      'D:/AI_Models/hub/models/Qwen/Qwen2.5-1.5B-Instruct-GGUF/qwen2.5-1.5b-instruct-q4_k_m.gguf'
    )
    expect(result?.mmprojPath).toBeUndefined()
  })

  it('支持根目录扁平化 GGUF 模型探测', () => {
    const existingFiles = [
      'D:/AI_Models/qwen2.5-1.5b-instruct-q4_k_m.gguf'
    ]

    const result = ModelResolver.resolve(
      'qwen2.5-1.5b-instruct-q4_k_m',
      baseDir,
      existingFiles
    )

    expect(result).not.toBeNull()
    expect(result?.dirType).toBe('legacy')
    expect(result?.modelPath).toBe('D:/AI_Models/qwen2.5-1.5b-instruct-q4_k_m.gguf')
  })

  it('当目录中不存在匹配文件时返回 null', () => {
    const existingFiles = [
      'D:/AI_Models/other-model.gguf'
    ]

    const result = ModelResolver.resolve(
      'NonExistent/Model-GGUF',
      baseDir,
      existingFiles
    )

    expect(result).toBeNull()
  })
})

// ─── mergeScannedWithRecommended 匹配启发式 ────────────────

function makeModel(overrides: Partial<ModelItem>): ModelItem {
  return {
    id: 'Test/Model-GGUF',
    name: 'Test Model',
    source: 'modelscope',
    quant: 'q4_k_m',
    fileSize: 1000,
    params: '2B',
    description: '',
    isDownloaded: false,
    ...overrides
  } as ModelItem
}

describe('mergeScannedWithRecommended 推荐底表合并', () => {
  it('量化 tag 归一化：UD- 前缀与大小写差异不阻断匹配（策略 A）', () => {
    const recommended = [makeModel({ id: 'Test/Model-GGUF:UD-Q4_K_M', quant: '' })]
    const scanned = [
      makeModel({ id: 'Test/Model-GGUF:q4_k_m', isDownloaded: true, localPath: 'D:/M/model-ud-q4_k_m.gguf' })
    ]

    const merged = mergeScannedWithRecommended(recommended, scanned)

    expect(merged[0].isDownloaded).toBe(true)
    expect(merged[0].localPath).toBe('D:/M/model-ud-q4_k_m.gguf')
  })

  it('禁止跨量化串绑：量化 tag 不同的扫描模型不得标记为已下载', () => {
    const recommended = [makeModel({ id: 'Test/Model-GGUF:q4_k_m', quant: 'q4_k_m' })]
    const scanned = [
      makeModel({ id: 'Test/Model-GGUF', isDownloaded: true, localPath: 'D:/M/model-q8_0.gguf' })
    ]

    const merged = mergeScannedWithRecommended(recommended, scanned)

    expect(merged[0].isDownloaded).toBe(false)
  })

  it('策略 B：清除量化后缀的 repo ID 相同且量化吻合时匹配', () => {
    const recommended = [makeModel({ id: 'Test/Model-GGUF:q5_k_xl', quant: '' })]
    const scanned = [
      makeModel({ id: 'test/model-gguf', isDownloaded: true, localPath: 'D:/M/Model-q5_k_xl.gguf' })
    ]

    const merged = mergeScannedWithRecommended(recommended, scanned)

    expect(merged[0].isDownloaded).toBe(true)
  })

  it('策略 C：文件名包含核心仓库名且量化吻合时匹配', () => {
    const recommended = [makeModel({ id: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF:q4_k_m', quant: '' })]
    const scanned = [
      makeModel({ id: 'local-scan-xyz', isDownloaded: true, localPath: 'D:/M/qwen2.5-1.5b-instruct-q4_k_m.gguf' })
    ]

    const merged = mergeScannedWithRecommended(recommended, scanned)

    expect(merged[0].id).toBe('Qwen/Qwen2.5-1.5B-Instruct-GGUF:q4_k_m')
    expect(merged[0].isDownloaded).toBe(true)
  })

  it('未下载的扫描条目不参与匹配，推荐项保持未下载', () => {
    const recommended = [makeModel({ id: 'Test/Model-GGUF:q4_k_m' })]
    const scanned = [
      makeModel({ id: 'Test/Model-GGUF:q4_k_m', isDownloaded: false, localPath: undefined })
    ]

    const merged = mergeScannedWithRecommended(recommended, scanned)

    expect(merged[0].isDownloaded).toBe(false)
  })

  it('本地独有模型不被丢弃，追加到合并结果尾部', () => {
    const recommended = [makeModel({ id: 'Test/Model-GGUF:q4_k_m' })]
    const scanned = [
      makeModel({ id: 'MyCustom/local-only', name: 'Local Only', isDownloaded: true, localPath: 'D:/M/local-only.gguf' })
    ]

    const merged = mergeScannedWithRecommended(recommended, scanned)

    expect(merged.length).toBe(2)
    expect(merged[1].id).toBe('MyCustom/local-only')
  })

  it('推荐模型缺失时 sha256 从扫描结果回填', () => {
    const recommended = [makeModel({ id: 'Test/Model-GGUF:q4_k_m', sha256: 'rec-sha' })]
    const scanned = [
      makeModel({ id: 'Test/Model-GGUF:q4_k_m', isDownloaded: true, localPath: 'D:/M/m-q4_k_m.gguf', sha256: 'scan-sha' })
    ]

    const merged = mergeScannedWithRecommended(recommended, scanned)

    expect(merged[0].sha256).toBe('scan-sha')
  })
})
