import { describe, it, expect } from 'vitest'
import { LlamaCommandBuilder } from '../src/lib/command-builder'
import { unifiedModelManager } from '../src/lib/unified-model-manager'

describe('LlamaCommandBuilder & Execution Security Matrix', () => {
  beforeEach(() => {
    unifiedModelManager.setModelBaseDir('D:\\AI_Models')
    unifiedModelManager.setLanguage('zh-CN')
  })

  it('should enforce CPU mode constraints: 0 gpu layers, batch-size <= 128, fa off', () => {
    const ctx = LlamaCommandBuilder.buildCommandContext({
      modelId: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL',
      forceCpuMode: true,
      batchSize: 512,
      ubatchSize: 512
    })

    expect(ctx.isCpuMode).toBe(true)
    expect(ctx.calculatedGpuLayers).toBe(0)
    expect(ctx.args).toContain('--device')
    expect(ctx.args).toContain('none')
    expect(ctx.args).toContain('--n-gpu-layers')
    expect(ctx.args).toContain('0')

    // 验证 batchSize 强制缩减至 128
    const batchIdx = ctx.args.indexOf('--batch-size')
    expect(batchIdx).toBeGreaterThan(-1)
    expect(Number(ctx.args[batchIdx + 1])).toBeLessThanOrEqual(128)

    // 验证 Flash Attention 强制禁用
    expect(ctx.args).toContain('-fa')
    const faIdx = ctx.args.indexOf('-fa')
    expect(ctx.args[faIdx + 1]).toBe('off')
  })

  it('should enforce critical safety assertion: ubatch <= batch at all times to prevent 0xC0000005 crash', () => {
    const ctx = LlamaCommandBuilder.buildCommandContext({
      modelId: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL',
      batchSize: 256,
      ubatchSize: 1024, // 故意传入危险的 ubatch > batch 参数
      backend: 'vulkan'
    })

    const batchIdx = ctx.args.indexOf('--batch-size')
    const ubatchIdx = ctx.args.indexOf('--ubatch-size')

    const finalBatch = Number(ctx.args[batchIdx + 1])
    const finalUbatch = Number(ctx.args[ubatchIdx + 1])

    expect(finalUbatch).toBeLessThanOrEqual(finalBatch)
    expect(finalUbatch).toBe(256)
  })

  it('should enable Max-Fill full GPU offloading (-ngl -1) when dGPU VRAM is sufficient', () => {
    const ctx = LlamaCommandBuilder.buildCommandContext({
      modelId: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL', // ~0.55GB 模型
      backend: 'cuda',
      hardware: {
        vramGB: 12.0, // 12GB 显存，充裕
        gpuVendor: 'nvidia',
        isIntegrated: false
      }
    })

    expect(ctx.calculatedGpuLayers).toBe(-1)
    expect(ctx.args).toContain('--n-gpu-layers')
    const nglIdx = ctx.args.indexOf('--n-gpu-layers')
    expect(ctx.args[nglIdx + 1]).toBe('-1')

    // CUDA 且 NVIDIA 显卡下开启 Flash Attention
    expect(ctx.isFlashAttentionEnabled).toBe(true)
    const faIdx = ctx.args.indexOf('-fa')
    expect(ctx.args[faIdx + 1]).toBe('auto')
  })

  it('should disable Flash Attention for Vulkan backend even on NVIDIA hardware', () => {
    const ctx = LlamaCommandBuilder.buildCommandContext({
      modelId: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL',
      backend: 'vulkan',
      hardware: {
        vramGB: 12.0,
        gpuVendor: 'nvidia'
      }
    })

    expect(ctx.isFlashAttentionEnabled).toBe(false)
    const faIdx = ctx.args.indexOf('-fa')
    expect(ctx.args[faIdx + 1]).toBe('off')
  })

  it('should allocate Apple Silicon Metal UMA with 3GB reserved memory', () => {
    const ctx = LlamaCommandBuilder.buildCommandContext({
      modelId: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL',
      backend: 'metal',
      hardware: {
        totalMemGB: 16.0,
        gpuVendor: 'apple'
      }
    })

    expect(ctx.calculatedGpuLayers).toBe(-1)
    expect(ctx.calculatedBatchSize).toBe(1024)
  })

  it('should automatically inject -t thread limit to avoid 100% OS freezing', () => {
    const ctx = LlamaCommandBuilder.buildCommandContext({
      modelId: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL',
      hardware: {
        cpuCores: 8
      }
    })

    const tIdx = ctx.args.indexOf('-t')
    expect(tIdx).toBeGreaterThan(-1)
    const threads = Number(ctx.args[tIdx + 1])
    expect(threads).toBeGreaterThanOrEqual(2)
    expect(threads).toBeLessThanOrEqual(8)
    // 8 核保留 2 核给系统 = 6 线程
    expect(threads).toBe(6)
  })

  it('should inject short path into LLAMA_CACHE environment variable', () => {
    const ctx = LlamaCommandBuilder.buildCommandContext({
      modelId: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL'
    })

    expect(ctx.env['LLAMA_CACHE']).toBeDefined()
    expect(typeof ctx.env['LLAMA_CACHE']).toBe('string')
  })

  it('should inject thinking suppression and chat-template when enableThinking is false', () => {
    const ctx = LlamaCommandBuilder.buildCommandContext({
      modelId: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL',
      enableThinking: false
    })

    expect(ctx.args).toContain('--reasoning')
    expect(ctx.args[ctx.args.indexOf('--reasoning') + 1]).toBe('off')
    expect(ctx.args).toContain('--reasoning-format')
    expect(ctx.args[ctx.args.indexOf('--reasoning-format') + 1]).toBe('none')
    expect(ctx.args).toContain('--reasoning-budget')
    expect(ctx.args[ctx.args.indexOf('--reasoning-budget') + 1]).toBe('0')
    expect(ctx.args).toContain('--chat-template')
    expect(ctx.fullCommandLine).toContain('--reasoning off')
  })

  it('should inject thinking parameters when enableThinking is true', () => {
    const ctx = LlamaCommandBuilder.buildCommandContext({
      modelId: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL',
      enableThinking: true
    })

    expect(ctx.args).not.toContain('--reasoning')
    expect(ctx.args).toContain('--reasoning-budget')
    expect(ctx.args[ctx.args.indexOf('--reasoning-budget') + 1]).toBe('1024')
    expect(ctx.args).toContain('--temp')
    expect(ctx.args[ctx.args.indexOf('--temp') + 1]).toBe('0.9')
    expect(ctx.args).toContain('--top-p')
    expect(ctx.args[ctx.args.indexOf('--top-p') + 1]).toBe('0.95')
  })

  it('should handle MiniCPM5 specific no-think mode and chatml template', () => {
    const ctx = LlamaCommandBuilder.buildCommandContext({
      modelId: 'openbmb/MiniCPM5-1B-GGUF',
      enableThinking: false
    })

    expect(ctx.args).toContain('--chat-template')
    expect(ctx.args[ctx.args.indexOf('--chat-template') + 1]).toBe('chatml')
    expect(ctx.args).toContain('--temp')
    expect(ctx.args[ctx.args.indexOf('--temp') + 1]).toBe('0.7')
    expect(ctx.args).toContain('--top-p')
    expect(ctx.args[ctx.args.indexOf('--top-p') + 1]).toBe('0.95')
  })

  it('should handle Nanbeige4 specific custom template for GBNF sampler compatibility', () => {
    const ctx = LlamaCommandBuilder.buildCommandContext({
      modelId: 'Nanbeige4-3B-GGUF',
      enableThinking: false
    })

    expect(ctx.args).toContain('--chat-template')
    const template = ctx.args[ctx.args.indexOf('--chat-template') + 1]
    expect(template).not.toContain('add_generation_prompt')
    expect(template).toContain('<|im_start|>')
  })

  it('should inject --verbose in production mode', () => {
    const ctx = LlamaCommandBuilder.buildCommandContext({
      modelId: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL',
      isProduction: true
    })

    expect(ctx.args).toContain('--verbose')
  })

  it('should deduplicate and override base args with extraArgs', () => {
    const ctx = LlamaCommandBuilder.buildCommandContext({
      modelId: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL',
      extraArgs: ['--port', '40000', '--parallel', '4']
    })

    const portIndices = ctx.args.reduce<number[]>((acc, cur, idx) => cur === '--port' ? [...acc, idx] : acc, [])
    expect(portIndices.length).toBe(1)
    expect(ctx.args[portIndices[0] + 1]).toBe('40000')

    const parallelIndices = ctx.args.reduce<number[]>((acc, cur, idx) => cur === '--parallel' ? [...acc, idx] : acc, [])
    expect(parallelIndices.length).toBe(1)
    expect(ctx.args[parallelIndices[0] + 1]).toBe('4')
  })
})
