import { describe, it, expect } from 'vitest'
import {
  analyzeEngineError,
  classifyEngineErrorCode,
  getEngineErrorInfo
} from '../src/lib/error-analyzer'

describe('error-analyzer：llama.cpp 错误识别与建议（移植 desktop）', () => {
  it('识别显存不足并优先于驱动问题', () => {
    expect(classifyEngineErrorCode('CUDA error: out of memory')).toBe('INSUFFICIENT_VRAM')
    expect(classifyEngineErrorCode('vulkan allocation failed')).toBe('INSUFFICIENT_VRAM')
    expect(classifyEngineErrorCode('failed to allocate 4096 MiB VRAM')).toBe('INSUFFICIENT_VRAM')
    expect(classifyEngineErrorCode('cuda runtime version mismatch')).toBe('GPU_DRIVER_OUTDATED')
    expect(classifyEngineErrorCode('ggml_assert failed')).toBe('GPU_DRIVER_OUTDATED')
  })

  it('识别模型加载失败与服务启动失败', () => {
    expect(classifyEngineErrorCode('exiting due to model loading error')).toBe('MODEL_LOAD_FAILED')
    expect(classifyEngineErrorCode('failed to load clip model')).toBe('MODEL_LOAD_FAILED')
    expect(classifyEngineErrorCode('server startup timed out')).toBe('SERVER_START_FAILED')
    expect(classifyEngineErrorCode('address already in use')).toBe('SERVER_START_FAILED')
  })

  it('识别致命环境崩溃与磁盘不足', () => {
    expect(classifyEngineErrorCode('exception code 0xc0000005')).toBe('LOCAL_AI_UNSUPPORTED')
    expect(classifyEngineErrorCode('no space left on device')).toBe('DISK_FULL')
  })

  it('识别模型缺失（未下载），且不误判为加载失败或服务启动失败', () => {
    // Rust 侧 start_service 在未检测到模型时抛出的原文
    expect(
      classifyEngineErrorCode('当前模型存储目录下未检测到任何 GGUF 模型文件，请先在模型管理中下载模型')
    ).toBe('MODEL_NOT_FOUND')
    expect(
      classifyEngineErrorCode('未找到模型文件: qwen.gguf，且当前存储目录中没有可用 GGUF 模型')
    ).toBe('MODEL_NOT_FOUND')
    expect(classifyEngineErrorCode('模型文件不存在: D:/models/a.gguf，请在模型管理中重新下载')).toBe(
      'MODEL_NOT_FOUND'
    )
    expect(classifyEngineErrorCode('no gguf model found in models dir')).toBe('MODEL_NOT_FOUND')
  })

  it('模型缺失给出「去模型管理下载」类建议', () => {
    const analysis = analyzeEngineError(
      '当前模型存储目录下未检测到任何 GGUF 模型文件，请先在模型管理中下载模型'
    )
    expect(analysis).not.toBeNull()
    expect(analysis!.code).toBe('MODEL_NOT_FOUND')
    expect(analysis!.severity).toBe('high')
    expect(analysis!.canRetry).toBe(true)
    expect(analysis!.solutions.join('\n')).toContain('模型管理')
    expect(analysis!.rawMessage).toContain('GGUF')
  })

  it('输出用户可读标题与解决建议', () => {
    const analysis = analyzeEngineError('CUDA error: out of memory')
    expect(analysis).not.toBeNull()
    expect(analysis!.code).toBe('INSUFFICIENT_VRAM')
    expect(analysis!.title.length).toBeGreaterThan(0)
    expect(analysis!.userMessage.length).toBeGreaterThan(0)
    expect(analysis!.solutions.length).toBeGreaterThan(0)
    expect(analysis!.rawMessage).toContain('out of memory')
  })

  it('清洗调用栈前缀，且清洗失败时回退原文', () => {
    const analysis = analyzeEngineError('model loading error\n    at foo (a.js:1:1)')
    expect(analysis).not.toBeNull()
    expect(analysis!.rawMessage).toContain('model loading error')

    // 仅堆栈行时不丢上下文（回退原文）
    const onlyStack = analyzeEngineError('    at foo (native)')
    expect(onlyStack).not.toBeNull()
    expect(onlyStack!.rawMessage.length).toBeGreaterThan(0)
  })

  it('空错误返回 null，未知错误走兜底建议', () => {
    expect(analyzeEngineError('')).toBeNull()
    expect(analyzeEngineError(null)).toBeNull()
    const fallback = getEngineErrorInfo('UNKNOWN_ERROR')
    expect(fallback.solutions.length).toBeGreaterThan(0)
    expect(fallback.canRetry).toBe(true)
  })
})
