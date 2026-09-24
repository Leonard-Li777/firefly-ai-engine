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
