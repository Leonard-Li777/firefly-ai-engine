/**
 * DownloadTaskPoller 单元测试：下载进度轮询唯一实现的契约验证
 * 验证：
 * 1. 进度事件按后端状态逐 tick 映射并回调
 * 2. 终态语义：completed 正常返回 / error、canceled 以明确消息返回
 * 3. 轮询间隔与终态即停（fake timer 驱动，无真实等待）
 * 4. fetchStatus 抛错时异常向上传播（由调用方决定处理策略）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DownloadTaskPoller } from '../src/api/download-task-poller'
import type { DownloadProgressEvent } from '../src/api/types'

function mapEvent(taskId: string, modelId: string) {
  return (raw: any): DownloadProgressEvent => ({
    taskId,
    modelId,
    percent: raw.percent || 0,
    receivedBytes: raw.receivedBytes || 0,
    totalBytes: raw.totalBytes || 0,
    speedBps: raw.speedBps || 0,
    status: raw.status,
    currentFileName: raw.currentFileName,
    fileIndex: raw.fileIndex,
    totalFiles: raw.totalFiles,
    error: raw.error
  })
}

describe('DownloadTaskPoller 轮询契约', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('按状态序列逐 tick 回调进度事件，completed 正常结束', async () => {
    const statuses = [
      { percent: 25, receivedBytes: 250, totalBytes: 1000, speedBps: 1024, status: 'downloading', currentFileName: 'a.gguf', fileIndex: 0, totalFiles: 1 },
      { percent: 75, receivedBytes: 750, totalBytes: 1000, speedBps: 2048, status: 'downloading', currentFileName: 'a.gguf', fileIndex: 0, totalFiles: 1 },
      { percent: 100, receivedBytes: 1000, totalBytes: 1000, speedBps: 0, status: 'completed', fileIndex: 0, totalFiles: 1 }
    ]
    let call = 0
    const fetchStatus = vi.fn(async () => statuses[Math.min(call++, statuses.length - 1)])
    const onEvent = vi.fn()
    const poller = new DownloadTaskPoller(fetchStatus)

    const done = poller.pollUntilDone('t-1', mapEvent('t-1', 'm-1'), onEvent)
    // 驱动两个间隔 tick 后 flush 微任务
    await vi.advanceTimersByTimeAsync(1000)
    const outcome = await done

    expect(outcome).toEqual({ kind: 'completed' })
    expect(onEvent).toHaveBeenCalledTimes(3)
    expect(onEvent.mock.calls[0][0]).toMatchObject({ percent: 25, status: 'downloading', taskId: 't-1', modelId: 'm-1' })
    expect(onEvent.mock.calls[2][0]).toMatchObject({ percent: 100, status: 'completed' })
  })

  it('error 终态返回明确错误消息', async () => {
    const fetchStatus = vi.fn(async () => ({ percent: 10, status: 'error', error: '磁盘空间不足' }))
    const poller = new DownloadTaskPoller(fetchStatus)

    const outcome = await poller.pollUntilDone('t-2', mapEvent('t-2', 'm-2'))

    expect(outcome).toEqual({ kind: 'error', message: '磁盘空间不足' })
  })

  it('error 终态缺省消息时回退为"下载失败"', async () => {
    const fetchStatus = vi.fn(async () => ({ percent: 10, status: 'error' }))
    const poller = new DownloadTaskPoller(fetchStatus)

    const outcome = await poller.pollUntilDone('t-3', mapEvent('t-3', 'm-3'))

    expect(outcome).toEqual({ kind: 'error', message: '下载失败' })
  })

  it('canceled 终态返回取消语义', async () => {
    const fetchStatus = vi.fn(async () => ({ percent: 40, status: 'canceled' }))
    const poller = new DownloadTaskPoller(fetchStatus)

    const outcome = await poller.pollUntilDone('t-4', mapEvent('t-4', 'm-4'))

    expect(outcome).toEqual({ kind: 'canceled', message: '下载已取消' })
  })

  it('非终态时按配置间隔轮询，终态后立即停止', async () => {
    const statuses = [
      { percent: 10, status: 'downloading' },
      { percent: 20, status: 'downloading' },
      { percent: 100, status: 'completed' }
    ]
    let call = 0
    const fetchStatus = vi.fn(async () => statuses[Math.min(call++, statuses.length - 1)])
    const poller = new DownloadTaskPoller(fetchStatus, 250) // 自定义间隔

    const done = poller.pollUntilDone('t-5', mapEvent('t-5', 'm-5'))
    await vi.advanceTimersByTimeAsync(1000)
    await done

    expect(fetchStatus).toHaveBeenCalledTimes(3)
  })

  it('fetchStatus 抛错时异常向上传播（不吞错）', async () => {
    const fetchStatus = vi.fn(async () => {
      throw new Error('HTTP 500 /status')
    })
    const poller = new DownloadTaskPoller(fetchStatus)

    await expect(poller.pollUntilDone('t-6', mapEvent('t-6', 'm-6'))).rejects.toThrow('HTTP 500')
  })
})
