import React, { useState } from 'react'
import { Brain } from 'lucide-react'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { useI18nStore } from '../../lib/i18n'

const THINKING_MODE_STORAGE_KEY = 'firefly_enable_thinking_mode'

export const ThinkingModeCard: React.FC = () => {
  const { t } = useI18nStore()
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      return localStorage.getItem(THINKING_MODE_STORAGE_KEY) === 'true'
    }
    return false
  })

  const handleToggle = (checked: boolean) => {
    setEnabled(checked)
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem(THINKING_MODE_STORAGE_KEY, String(checked))
      window.dispatchEvent(new Event('thinking-mode-changed'))
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
            aria-label={t('模型思考模式')}
          />
        </div>
      </div>
    </Card>
  )
}
