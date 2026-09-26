/**
 * 引擎 UI 意图事件
 * Desktop 经 /api/engine/open-ui 携带 panel 后，由 Tauri 侧 emit 到前端打开对应面板。
 *
 * 关键点：Tauri 的 `window.emit` 走的是 IPC 事件通道，必须用 `@tauri-apps/api/event`
 * 的 `listen()` 接收，**不会**自动变成 DOM 事件。本模块负责把 Tauri 事件桥接为
 * `window` 上的 DOM CustomEvent（`ENGINE_UI_INTENT_EVENT`），App 只需监听 DOM 事件，
 * 从而与运行环境解耦，并便于在 jsdom 中直接派发事件做单测。
 */

import { getEngineApiClient, isTauriEnvironment } from '../api/provider'

export type EngineUiPanel = 'error' | 'logs' | 'models' | 'default'

/** 推荐模型源（与 model-source 的 source 字段对齐） */
export type EngineUiSource = 'modelscope' | 'huggingface'

export const ENGINE_UI_INTENT_EVENT = 'engine:ui-intent'

export interface EngineUiIntent {
  panel: EngineUiPanel
  /** 目标模型关键词（Issue 0046 §3）：模型面板滚动聚焦 + 呼吸高亮 */
  focusModel?: string
  /** 推荐模型源：模型面板据此预选可顺畅下载的源页签 */
  source?: EngineUiSource
}

/** 解析 open-ui body 中的 panel 字段 */
export function parseUiPanel(raw: unknown): EngineUiPanel {
  if (raw === 'error' || raw === 'logs' || raw === 'models' || raw === 'default') return raw
  return 'default'
}

/** 解析 open-ui body 中的 source 字段（非法值返回 undefined，避免误切页签） */
export function parseUiSource(raw: unknown): EngineUiSource | undefined {
  return raw === 'modelscope' || raw === 'huggingface' ? raw : undefined
}

/** 解析 focus_model 字段：空白串视为未指定 */
export function parseFocusModel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * 在 window 上派发 UI 意图 DOM 事件（App 的订阅契约）。
 * 桥接层与测试都经由本函数投递，保证两者走完全相同的路径。
 */
export function dispatchEngineUiIntent(intent: EngineUiIntent): void {
  window.dispatchEvent(new CustomEvent<EngineUiIntent>(ENGINE_UI_INTENT_EVENT, { detail: intent }))
}

/** 从任意形态的 payload 中规整出完整意图（实时事件与补偿取回共用） */
export function normalizeUiIntent(payload: unknown): EngineUiIntent {
  const raw = (payload ?? {}) as Record<string, unknown>
  return {
    panel: parseUiPanel(raw.panel),
    focusModel: parseFocusModel(raw.focus_model ?? raw.focusModel),
    source: parseUiSource(raw.source)
  }
}

/**
 * 绑定 Tauri UI 意图桥接，返回解绑函数。
 *
 * 两条投递路径：
 * 1. 实时事件：Tauri `window.emit('engine:ui-intent')` → DOM 事件（前端已挂载时）；
 * 2. 冷启动补偿：Desktop 引导条会**并行**发起「静默拉起引擎」与 `openUI({panel:'models'})`，
 *    此时引擎可能刚启动、WebView 前端尚未挂载，实时事件必然丢失。引擎侧把意图暂存在
 *    `/api/engine/ui-intent/consume`，前端挂载后一次性取回。
 *
 * 消费语义：无论实时事件还是补偿取回，都会调用 consume 端点清空引擎侧记录，
 * 避免 WebView 重载（开发态 HMR / 手动刷新）后重复跳转。
 *
 * 非 Tauri 环境（浏览器沙盒）下为空操作。
 */
export function bindEngineUiIntentBridge(): () => void {
  if (!isTauriEnvironment()) return () => {}

  let disposed = false
  let unlisten: (() => void) | null = null

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event')
      const off = await listen<Record<string, unknown>>(ENGINE_UI_INTENT_EVENT, (event) => {
        dispatchEngineUiIntent(normalizeUiIntent(event.payload))
        // 实时事件已送达，清空引擎侧待消费记录
        void consumePendingUiIntent()
      })
      // StrictMode 下 effect 会挂载→卸载→再挂载，若已卸载则立即解绑，避免监听器泄漏
      if (disposed) {
        off()
        return
      }
      unlisten = off

      // 补偿：open-ui 早于前端挂载时实时事件已丢失，此处一次性取回
      const pending = await consumePendingUiIntent()
      if (pending && !disposed) dispatchEngineUiIntent(pending)
    } catch (err) {
      console.warn('[engine-ui-intent] 绑定 Tauri 事件桥接失败:', err)
    }
  })()

  return () => {
    disposed = true
    unlisten?.()
    unlisten = null
  }
}

/** 取回并清空引擎侧待消费意图；失败时静默返回 null（不阻塞前端挂载） */
async function consumePendingUiIntent(): Promise<EngineUiIntent | null> {
  try {
    const res = await getEngineApiClient().consumeUiIntent()
    const intent = res?.intent
    if (!intent) return null
    return normalizeUiIntent(intent)
  } catch {
    return null
  }
}
