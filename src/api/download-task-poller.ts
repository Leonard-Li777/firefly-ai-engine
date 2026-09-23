import { DownloadProgressEvent } from './types'

/**
 * 轮询终态：completed 正常结束，error/canceled 以异常结束
 */
export type PollOutcome =
  | { kind: 'completed' }
  | { kind: 'error'; message: string }
  | { kind: 'canceled'; message: string }

/**
 * DownloadTaskPoller 深模块：下载任务进度轮询的唯一实现。
 * 契约在此单点定义：
 * - pollUntilDone：以固定间隔请求状态端点，映射为 DownloadProgressEvent 并回调，
 *   到达终态（completed / error / canceled）时结束；
 * - 后端无真正暂停能力：pause 语义 = 调用 cancel 端点（由调用方显式选择，
 *   本模块不隐藏该事实）；resume = 重新发起下载（由调用方经 start 接口实现）。
 * 引擎下载与模型下载此前各自维护一份近似的 poll 循环，现统一收敛至此。
 */
export class DownloadTaskPoller {
  constructor(
    /** 状态端点请求：返回后端原始状态 JSON */
    private fetchStatus: (taskId: string) => Promise<any>,
    /** 轮询间隔（毫秒），默认 500ms */
    private intervalMs: number = 500
  ) {}

  /**
   * 轮询直到终态。每次tick构造进度事件并回调 onEvent。
   * 事件映射由调用方注入（引擎下载与模型下载的字段映射略有差异）。
   */
  async pollUntilDone(
    taskId: string,
    mapEvent: (raw: any) => DownloadProgressEvent,
    onEvent?: (event: DownloadProgressEvent) => void
  ): Promise<PollOutcome> {
    for (;;) {
      const status = await this.fetchStatus(taskId)
      const event = mapEvent(status)
      onEvent?.(event)

      if (status.status === 'completed') {
        return { kind: 'completed' }
      }
      if (status.status === 'error') {
        return { kind: 'error', message: status.error || '下载失败' }
      }
      if (status.status === 'canceled') {
        return { kind: 'canceled', message: '下载已取消' }
      }
      await new Promise(res => setTimeout(res, this.intervalMs))
    }
  }
}
