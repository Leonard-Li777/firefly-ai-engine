import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useModelDownload } from '../src/hooks/use-model-download'

describe('useModelDownload Hook 状态机测试 (1:1 移植)', () => {
  it('初始状态为 pending 且无活跃任务', () => {
    const { result } = renderHook(() =>
      useModelDownload('Qwen/Qwen2.5-1.5B-Instruct-GGUF', { source: 'modelscope' })
    )

    expect(result.current.state.status).toBe('pending')
    expect(result.current.state.isDownloading).toBe(false)
    expect(result.current.state.progress).toBe(0)
  })

  it('调用 startDownload 后进入 downloading 状态并接收下载进度流', async () => {
    const { result } = renderHook(() =>
      useModelDownload('Qwen/Qwen2.5-1.5B-Instruct-GGUF', { source: 'modelscope' })
    )

    await act(async () => {
      await result.current.startDownload()
    })

    expect(result.current.state.isDownloading).toBe(true)
    expect(result.current.state.status).toBe('downloading')

    // 等待进度模拟跳动
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 250))
    })

    expect(result.current.state.progress).toBeGreaterThan(0)
    expect(result.current.state.speedBps).toBeGreaterThan(0)

    // 暂停与取消验证
    await act(async () => {
      await result.current.cancelDownload()
    })

    expect(result.current.state.isDownloading).toBe(false)
    expect(result.current.state.status).toBe('canceled')
  })

  it('多模态模型下载时能够识别多文件阶段 (含 mmproj 投影器)', async () => {
    const { result } = renderHook(() =>
      useModelDownload('Qwen/Qwen2-VL-2B-Instruct-GGUF', { source: 'modelscope' })
    )

    await act(async () => {
      await result.current.startDownload()
    })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    })

    expect(result.current.state.totalFiles).toBe(2)

    await act(async () => {
      await result.current.cancelDownload()
    })
  })
})
