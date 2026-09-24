/**
 * 引擎 UI 意图事件
 * Desktop 经 /api/engine/open-ui 携带 panel 后，由 Tauri 侧 emit 到前端打开对应面板。
 */

export type EngineUiPanel = 'error' | 'logs' | 'default'

export const ENGINE_UI_INTENT_EVENT = 'engine:ui-intent'

export interface EngineUiIntent {
  panel: EngineUiPanel
}

/** 解析 open-ui body 中的 panel 字段 */
export function parseUiPanel(raw: unknown): EngineUiPanel {
  if (raw === 'error' || raw === 'logs' || raw === 'default') return raw
  return 'default'
}
