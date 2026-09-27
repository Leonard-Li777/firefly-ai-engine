import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { initPostHog, captureException } from './lib/posthog'
import './index.css'

// PostHog 行为分析初始化（与 desktop renderer.tsx 对齐：模块顶层初始化，未配置 key 时静默跳过）
void initPostHog()

// 全局未捕获异常上报（PostHog 内部亦会 patch，这里兜底记录）
window.addEventListener('error', event => {
  captureException(event.error ?? new Error(event.message), { source: 'window-error-listener' })
})
window.addEventListener('unhandledrejection', event => {
  captureException(
    event.reason instanceof Error ? event.reason : new Error(String(event.reason)),
    { source: 'unhandled-rejection' }
  )
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
