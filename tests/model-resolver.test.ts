import { describe, it, expect } from 'vitest'
import { ModelResolver } from '../src/lib/model-resolver'

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
