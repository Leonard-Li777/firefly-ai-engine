import { describe, it, expect } from 'vitest'
import { unifiedModelManager } from '../src/lib/unified-model-manager'

describe('UnifiedModelManager & DSpark Speculative Pairing', () => {
  it('should initialize and switch languages properly', () => {
    unifiedModelManager.setLanguage('zh-CN')
    const zhList = unifiedModelManager.getAllModels()
    expect(zhList.length).toBeGreaterThan(0)

    unifiedModelManager.setLanguage('en-US')
    const enList = unifiedModelManager.getAllModels()
    expect(enList.length).toBeGreaterThan(0)
  })

  it('should compute model directories following HF and ModelScope specs', () => {
    unifiedModelManager.setModelBaseDir('D:\\AI_Models')

    // ModelScope 规范: D:\AI_Models\hub\models\Qwen\Qwen2.5-1.5B
    const msDir = unifiedModelManager.getModelDirectory('Qwen/Qwen2.5-1.5B', 'modelscope')
    expect(msDir).toContain('hub\\models\\Qwen\\Qwen2.5-1.5B')

    // HuggingFace 规范: D:\AI_Models\models--Qwen--Qwen2.5-1.5B
    const hfDir = unifiedModelManager.getModelDirectory('Qwen/Qwen2.5-1.5B', 'huggingface')
    expect(hfDir).toContain('models--Qwen--Qwen2.5-1.5B')
  })

  it('should normalize DSpark hyphenated model id to GGUF tag format', () => {
    const rawId = 'LiquidAI/LFM2.5-1.2B-Instruct-DSpark-Q4_K_M'
    const normalized = unifiedModelManager.normalizeDownloadTargetId(rawId)
    expect(normalized).toBe('LiquidAI/LFM2.5-1.2B-Instruct-DSpark-GGUF:Q4_K_M')

    // 标准格式不应该被破坏
    const standardId = 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL'
    expect(unifiedModelManager.normalizeDownloadTargetId(standardId)).toBe(standardId)
  })

  it('should generate download strategy with correct flags, mirrors and short cache path', () => {
    unifiedModelManager.setModelBaseDir('D:\\AI_Models')

    // ModelScope 下载策略
    const msStrategy = unifiedModelManager.getDownloadStrategy(
      'Qwen/Qwen2.5-1.5B-GGUF',
      'modelscope',
      'cn'
    )
    expect(msStrategy.args[0]).toBe('-ms')
    expect(msStrategy.args).toContain('--json')
    expect(msStrategy.env['MODEL_ENDPOINT']).toBe('https://www.modelscope.cn/')
    expect(msStrategy.env['LLAMA_CACHE']).toBeDefined()

    // HuggingFace 国内镜像下载策略
    const hfStrategy = unifiedModelManager.getDownloadStrategy(
      'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL',
      'huggingface',
      'cn'
    )
    expect(hfStrategy.args[0]).toBe('-hf')
    expect(hfStrategy.env['HF_ENDPOINT']).toBe('https://hf-mirror.com')
  })

  it('should calculate VRAM with safety margin', () => {
    expect(unifiedModelManager.calculateVRAM('558MB')).toBe(2)
    expect(unifiedModelManager.calculateVRAM('4.37GB')).toBe(6)
  })
})
