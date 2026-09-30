import React, { useEffect, useRef, useState } from 'react'
import { Brain, AlertTriangle, RotateCw } from 'lucide-react'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { Button } from '../ui/button'
import { t } from '../../languages'
import { engineApiClient } from '../../api/provider'
import { useEngineStore } from '../../stores/engine-store'

const THINKING_MODE_STORAGE_KEY = 'firefly_enable_thinking_mode'

export const ThinkingModeCard: React.FC = () => {
  const engineStatus = useEngineStore(s => s.engineStatus)
  const startEngine = useEngineStore(s => s.startEngine)
  const stopEngine = useEngineStore(s => s.stopEngine)
  const isEngineRunning = engineStatus?.status === 'ready'

  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      return localStorage.getItem(THINKING_MODE_STORAGE_KEY) === 'true'
    }
    return false
  })
  const [saving, setSaving] = useState(false)
  const [showRestartPrompt, setShowRestartPrompt] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)
  // 用户已手动切换时忽略挂载加载的返回值，避免异步回写覆盖最新选择
  const userTouchedRef = useRef(false)

  // 挂载时从后端 config.json 同步权威值（localStorage 仅作首屏缓存与 Footer 展示）
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const { enableThinking } = await engineApiClient.getThinkingMode()
        if (cancelled || userTouchedRef.current) return
        setEnabled(enableThinking)
        if (typeof window !== 'undefined' && window.localStorage) {
          localStorage.setItem(THINKING_MODE_STORAGE_KEY, String(enableThinking))
          window.dispatchEvent(new Event('thinking-mode-changed'))
        }
      } catch (e) {
        console.warn('[ThinkingModeCard] 读取思考模式配置失败，保留本地缓存:', e)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const handleToggle = async (checked: boolean) => {
    const prev = enabled
    userTouchedRef.current = true
    setEnabled(checked)
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem(THINKING_MODE_STORAGE_KEY, String(checked))
      window.dispatchEvent(new Event('thinking-mode-changed'))
    }

    setSaving(true)
    try {
      await engineApiClient.setThinkingMode(checked)
      // 运行中的引擎仍使用旧启动参数，提示需重启生效
      if (isEngineRunning) {
        setShowRestartPrompt(true)
      } else {
        setShowRestartPrompt(false)
      }
    } catch (e) {
      console.error('[ThinkingModeCard] 持久化思考模式失败:', e)
      setEnabled(prev)
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem(THINKING_MODE_STORAGE_KEY, String(prev))
        window.dispatchEvent(new Event('thinking-mode-changed'))
      }
    } finally {
      setSaving(false)
    }
  }

  const handleImmediateRestart = async () => {
    try {
      setIsRestarting(true)
      await stopEngine()
      await startEngine()
      setShowRestartPrompt(false)
    } catch (e) {
      console.error('[ThinkingModeCard] 重启引擎失败:', e)
    } finally {
      setIsRestarting(false)
    }
  }

  return (
    <Card className="p-5 border border-border/80 shadow-xs rounded-2xl bg-card">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-3.5 flex-1 min-w-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20 mt-0.5">
            <Brain className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Label htmlFor="thinking-mode-switch" className="text-sm font-black text-foreground cursor-pointer">
                {t('模型思考模式')}
              </Label>
              <span className="text-[11px] font-light text-purple-600 dark:text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded-md border border-purple-500/20">
                {t('会增加耗时')}
              </span>
            </div>
            <p className="text-xs text-muted-foreground/90 font-medium mt-1.5 leading-relaxed">
              <span>
                {t('开启后允许本地和云端模型开启思考模式，可能提升AI分析质量，但会大大增加响应时间。')}
              </span>
              <strong className="text-purple-600 dark:text-purple-400 font-semibold ml-1">
                {t('建议在需要与 AI 进行聊天时才开启。')}
              </strong>
              <br />
              <span className="text-muted-foreground/70 text-[11px]">
                {t('不支持标记 Instruct 的模型。')}
              </span>
            </p>
          </div>
        </div>
        <div className="shrink-0 flex items-center">
          <Switch
            id="thinking-mode-switch"
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={saving || isRestarting}
            aria-label={t('模型思考模式')}
          />
        </div>
      </div>

      {showRestartPrompt && (
        <div className="mt-4 p-3.5 rounded-xl border border-amber-500/40 bg-amber-500/10">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="h-4.5 w-4.5 text-amber-500 shrink-0 mt-0.5" />
            <div className="text-xs space-y-1 flex-1">
              <div className="font-bold text-foreground">{t('参数已保存，需重启引擎后生效')}</div>
              <p className="text-muted-foreground leading-relaxed">
                {t('当前模型正在运行中，新启动参数需在服务重新拉起时生效。')}
              </p>
              <div className="flex items-center gap-2 pt-1.5">
                <Button
                  size="sm"
                  variant="default"
                  onClick={handleImmediateRestart}
                  disabled={isRestarting || saving}
                  className="h-7 text-xs font-bold px-3 bg-amber-600 hover:bg-amber-700 text-white"
                >
                  <RotateCw className={`h-3 w-3 mr-1 ${isRestarting ? 'animate-spin' : ''}`} />
                  {isRestarting ? t('正在重启...') : t('立即重启生效')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowRestartPrompt(false)}
                  disabled={isRestarting}
                  className="h-7 text-xs px-2.5 text-muted-foreground"
                >
                  {t('稍后重启')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}
