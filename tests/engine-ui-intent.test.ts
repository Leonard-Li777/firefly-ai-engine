import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { IEngineApiClient } from '../src/api/client'
import { setEngineApiClient } from '../src/api/provider'

// ---------------------------------------------------------------------------
// Tauri 事件通道 mock
// 捕获 listen() 注册的 handler，便于测试中手工投递事件（jsdom 无真实 IPC）
// ---------------------------------------------------------------------------
const registeredListeners = new Map<string, (event: { payload: unknown }) => void>()
const unlistenSpy = vi.fn()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
    registeredListeners.set(eventName, handler)
    return () => {
      registeredListeners.delete(eventName)
      unlistenSpy()
    }
  })
}))

import {
  bindEngineUiIntentBridge,
  ENGINE_UI_INTENT_EVENT,
  parseUiPanel,
  type EngineUiPanel
} from '../src/lib/engine-ui-intent'

/** 注入受控 fake 客户端，返回 consumeUiIntent 的 spy */
function installFakeClient(intent: { panel: string; seq: number } | null) {
  const consumeUiIntent = vi.fn(async () => ({ intent }))
  setEngineApiClient({ consumeUiIntent } as unknown as IEngineApiClient)
  return consumeUiIntent
}

/** 进入 Tauri 环境（isTauriEnvironment 读的是 __TAURI_INTERNALS__） */
function enterTauriEnvironment() {
  ;(window as any).__TAURI_INTERNALS__ = {}
}

/** 捕获 window 上派发的 UI 意图 DOM 事件（模块级单次注册，逐例重置，避免监听器泄漏） */
const domIntents: EngineUiPanel[] = []
window.addEventListener(ENGINE_UI_INTENT_EVENT, (e) => {
  domIntents.push((e as CustomEvent<{ panel: EngineUiPanel }>).detail.panel)
})

describe('parseUiPanel', () => {
  it('仅接受白名单面板，其余一律归一为 default', () => {
    expect(parseUiPanel('models')).toBe('models')
    expect(parseUiPanel('error')).toBe('error')
    expect(parseUiPanel('logs')).toBe('logs')
    expect(parseUiPanel('default')).toBe('default')
    expect(parseUiPanel('bogus')).toBe('default')
    expect(parseUiPanel(undefined)).toBe('default')
    expect(parseUiPanel(123)).toBe('default')
  })
})

describe('bindEngineUiIntentBridge', () => {
  beforeEach(() => {
    registeredListeners.clear()
    unlistenSpy.mockClear()
    domIntents.length = 0
    delete (window as any).__TAURI_INTERNALS__
  })

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__
    setEngineApiClient(null)
  })

  it('非 Tauri 环境为空操作：不注册监听、不消费补偿意图', async () => {
    const consumeUiIntent = installFakeClient({ panel: 'models', seq: 1 })

    const dispose = bindEngineUiIntentBridge()
    await new Promise((r) => setTimeout(r, 0))

    expect(registeredListeners.size).toBe(0)
    expect(consumeUiIntent).not.toHaveBeenCalled()
    expect(() => dispose()).not.toThrow()
  })

  it('Tauri 实时事件经桥接派发为 DOM 事件，并清空引擎侧待消费意图', async () => {
    const consumeUiIntent = installFakeClient(null)
    enterTauriEnvironment()
    const dispose = bindEngineUiIntentBridge()
    await vi.waitFor(() => expect(registeredListeners.has(ENGINE_UI_INTENT_EVENT)).toBe(true))

    // 模拟 Rust `window.emit("engine:ui-intent", { panel: "models" })`
    registeredListeners.get(ENGINE_UI_INTENT_EVENT)!({ payload: { panel: 'models' } })

    expect(domIntents).toEqual(['models'])
    // 实时事件送达后必须调用 consume，避免 WebView 重载后重复跳转
    await vi.waitFor(() => expect(consumeUiIntent).toHaveBeenCalled())

    dispose()
    expect(registeredListeners.has(ENGINE_UI_INTENT_EVENT)).toBe(false)
    expect(unlistenSpy).toHaveBeenCalled()
  })

  it('未知 panel 经桥接归一为 default 后派发', async () => {
    installFakeClient(null)
    enterTauriEnvironment()
    bindEngineUiIntentBridge()
    await vi.waitFor(() => expect(registeredListeners.has(ENGINE_UI_INTENT_EVENT)).toBe(true))

    registeredListeners.get(ENGINE_UI_INTENT_EVENT)!({ payload: { panel: 'oops' } })

    expect(domIntents).toEqual(['default'])
  })

  it('冷启动补偿：前端挂载时取回待消费意图并派发（事件已丢失场景）', async () => {
    const consumeUiIntent = installFakeClient({ panel: 'models', seq: 1 })
    enterTauriEnvironment()
    bindEngineUiIntentBridge()

    await vi.waitFor(() => expect(domIntents).toEqual(['models']))
    expect(consumeUiIntent).toHaveBeenCalledTimes(1)
  })

  it('无待消费意图时不派发任何 DOM 事件', async () => {
    const consumeUiIntent = installFakeClient(null)
    enterTauriEnvironment()
    bindEngineUiIntentBridge()
    await vi.waitFor(() => expect(consumeUiIntent).toHaveBeenCalledTimes(1))

    expect(domIntents).toEqual([])
  })

  it('消费接口异常时静默降级，不影响前端挂载', async () => {
    const consumeUiIntent = vi.fn(async () => {
      throw new Error('引擎尚未就绪')
    })
    setEngineApiClient({ consumeUiIntent } as unknown as IEngineApiClient)
    enterTauriEnvironment()
    bindEngineUiIntentBridge()
    await vi.waitFor(() => expect(consumeUiIntent).toHaveBeenCalledTimes(1))

    expect(domIntents).toEqual([])
  })
})
