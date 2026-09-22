import React, { useState } from 'react'
import { Copy, Check, ExternalLink } from 'lucide-react'
import { Card } from '../ui/card'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { useEngineStore } from '../../stores/engine-store'
import { useI18nStore } from '../../lib/i18n'

/**
 * 第三方应用对接与 API 地址页面（顶级 Tab）
 * 从仪表盘视图抽离为独立页面，提供 OpenAI 兼容端点的展示与复制
 */
export const ThirdPartyApiView: React.FC = () => {
  const { t } = useI18nStore()
  const { engineStatus } = useEngineStore()
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)

  // 复制对外服务 URL
  const port = engineStatus?.port || 38400
  const apiBaseUrl = `http://127.0.0.1:${port}/v1`
  const chatCompletionsUrl = `http://127.0.0.1:${port}/v1/chat/completions`

  const handleCopy = (text: string, type: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text)
      setCopiedUrl(type)
      setTimeout(() => setCopiedUrl(null), 2500)
    }
  }

  return (
    <Card className="p-5 bg-card border border-border/80 rounded-2xl shadow-xs space-y-5">
      <div>
        <Label className="text-base font-bold tracking-tight text-foreground flex items-center gap-2">
          <ExternalLink className="h-4 w-4 text-primary" />
          <span>{t('第三方应用对接与 API 地址')}</span>
        </Label>
        <p className="text-xs text-muted-foreground font-normal mt-1 leading-relaxed">
          {t('完全兼容 OpenAI 标准协议，可无缝配置至 萤核智能文件夹、龙虾、Cherry Studio、ChatBox、NextChat 等客户端。')}
        </p>
      </div>

      <div className="space-y-3">
        {/* API Base URL */}
        <div className="p-3 rounded-xl bg-muted/30 border border-border/70 flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <span className="text-[10px] font-bold uppercase text-muted-foreground block">
              API Base URL ({t('基础端点')})
            </span>
            <span className="text-xs font-mono font-bold text-foreground truncate block mt-0.5">
              {apiBaseUrl}
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-3 font-bold text-xs border-border/80 hover:border-border shrink-0"
            onClick={() => handleCopy(apiBaseUrl, 'base')}
          >
            {copiedUrl === 'base' ? (
              <>
                <Check className="h-3.5 w-3.5 mr-1 text-emerald-500" />
                <span>{t('已复制')}</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5 mr-1" />
                <span>{t('复制')}</span>
              </>
            )}
          </Button>
        </div>

        {/* Chat Completions URL */}
        <div className="p-3 rounded-xl bg-muted/30 border border-border/70 flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <span className="text-[10px] font-bold uppercase text-muted-foreground block">
              Chat Completions URL ({t('聊天接口')})
            </span>
            <span className="text-xs font-mono font-bold text-foreground truncate block mt-0.5">
              {chatCompletionsUrl}
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-3 font-bold text-xs border-border/80 hover:border-border shrink-0"
            onClick={() => handleCopy(chatCompletionsUrl, 'chat')}
          >
            {copiedUrl === 'chat' ? (
              <>
                <Check className="h-3.5 w-3.5 mr-1 text-emerald-500" />
                <span>{t('已复制')}</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5 mr-1" />
                <span>{t('复制')}</span>
              </>
            )}
          </Button>
        </div>

        {/* API Key 提示 */}
        <div className="p-3 rounded-xl bg-muted/30 border border-border/70 flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <span className="text-[10px] font-bold uppercase text-muted-foreground block">
              API Key ({t('授权秘钥')})
            </span>
            <span className="text-xs font-mono font-semibold text-muted-foreground truncate block mt-0.5">
              {t('无需秘钥 (可任意填写，如 sk-firefly)')}
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-3 font-bold text-xs border-border/80 hover:border-border shrink-0"
            onClick={() => handleCopy('sk-firefly', 'key')}
          >
            {copiedUrl === 'key' ? (
              <>
                <Check className="h-3.5 w-3.5 mr-1 text-emerald-500" />
                <span>{t('已复制')}</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5 mr-1" />
                <span>{t('复制')}</span>
              </>
            )}
          </Button>
        </div>
      </div>
    </Card>
  )
}
