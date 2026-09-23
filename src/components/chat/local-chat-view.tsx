import React, { useState } from 'react'
import { Bot, RefreshCw, ExternalLink, AlertCircle, Play, Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Badge } from '../ui/badge'
import { useEngineStore } from '../../stores/engine-store'
import { t } from '../../languages'

export const LocalChatView: React.FC = () => {
    const { engineStatus, startEngine, loading: storeLoading } = useEngineStore()
  const [iframeKey, setIframeKey] = useState<number>(0)
  const [starting, setStarting] = useState(false)

  const port = engineStatus?.port || 38400
  const isReady = engineStatus?.status === 'ready'
  const chatUrl = `http://127.0.0.1:${port}`

  const handleReload = () => {
    setIframeKey(prev => prev + 1)
  }

  const handleOpenExternal = () => {
    if (typeof window !== 'undefined') {
      window.open(chatUrl, '_blank')
    }
  }

  const handleStartService = async () => {
    try {
      setStarting(true)
      await startEngine()
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="w-full h-full flex-1 min-h-0 flex flex-col rounded-2xl overflow-hidden border border-border/80 bg-background shadow-xs">
      {/* 顶部轻量级工具栏 */}
      <div className="h-10 px-4 bg-muted/40 border-b border-border/70 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
            <Bot className="h-3.5 w-3.5" />
          </div>
          <span className="text-xs font-bold text-foreground truncate">
            {t('与本地AI私密聊天')}
          </span>
          <Badge
            variant="outline"
            className={`text-[10px] h-5 px-1.5 py-0 font-mono shrink-0 ${
              isReady
                ? 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
                : 'border-amber-500/30 text-amber-500 bg-amber-500/10'
            }`}
          >
            {isReady ? `127.0.0.1:${port}` : t('服务未就绪')}
          </Badge>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted"
            onClick={handleReload}
            title={t('刷新页面')}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            <span className="hidden sm:inline">{t('刷新')}</span>
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted"
            onClick={handleOpenExternal}
            title={t('外部浏览器打开')}
          >
            <ExternalLink className="h-3.5 w-3.5 mr-1" />
            <span className="hidden sm:inline">{t('浏览器打开')}</span>
          </Button>
        </div>
      </div>

      {/* 核心内容区：就绪时全屏自适应 iframe，未启动时提示卡片 */}
      <div className="flex-1 w-full h-full relative bg-card overflow-hidden">
        {isReady ? (
          <iframe
            key={iframeKey}
            src={chatUrl}
            title="llama.cpp local chat"
            className="w-full h-full border-none block"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center">
            <Card className="max-w-md p-6 border-border/80 shadow-md rounded-2xl flex flex-col items-center gap-4 bg-card/90">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500 border border-amber-500/30">
                <AlertCircle className="h-6 w-6" />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-bold text-foreground">
                  {t('本地推理服务未就绪')}
                </h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t('请先在仪表盘启动本地 AI 引擎服务，或等待模型加载完成。')}
                </p>
              </div>
              <Button
                onClick={handleStartService}
                disabled={starting || storeLoading}
                className="h-9 px-4 text-xs font-bold gap-2 rounded-xl bg-primary text-primary-foreground shadow-xs hover:bg-primary/90"
              >
                {starting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 fill-current" />
                )}
                <span>{starting ? t('启动中...') : t('立即启动服务')}</span>
              </Button>
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}
