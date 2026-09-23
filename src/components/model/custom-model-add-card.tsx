import React, { useState, useRef, useEffect } from 'react'
import { Plus, Link2, Loader2, AlertCircle, CheckCircle2, X } from 'lucide-react'
import { Card } from '../ui/card'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { useEngineStore } from '../../stores/engine-store'
import { t } from '../../lib/i18n'

/** 三种受支持的模型地址示例（modelscope file/view、huggingface blob、huggingface resolve） */
const SUPPORTED_URL_EXAMPLES = [
  'https://modelscope.cn/models/Abiray/Qwen-Image-2.1-GGUF/file/view/master/qwen_image_2.1_Q4_K_S.gguf',
  'https://huggingface.co/HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF/blob/main/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf',
  'https://huggingface.co/HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF/resolve/main/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q3_K_P.gguf'
]

/**
 * 「增加任意模型」卡片：
 * 通栏按钮展开输入行 → 提交托管站点模型文件地址 → 后端网络嗅探（大小检测，不下载）
 * → 成功后模型以标准卡片行进入上方模型列表；无法探测的值不填不显示。
 */
export const CustomModelAddCard: React.FC = () => {
  const addCustomModel = useEngineStore(s => s.addCustomModel)

  // expanded：是否显示输入行；sniffing：嗅探请求进行中
  const [expanded, setExpanded] = useState(false)
  const [url, setUrl] = useState('')
  const [sniffing, setSniffing] = useState(false)
  const [feedback, setFeedback] = useState<{ type: 'error' | 'success'; message: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 展开后自动聚焦输入框
  useEffect(() => {
    if (expanded) {
      inputRef.current?.focus()
    }
  }, [expanded])

  const resetPanel = () => {
    setExpanded(false)
    setUrl('')
    setFeedback(null)
    setSniffing(false)
  }

  const handleSubmit = async () => {
    const trimmed = url.trim()
    if (!trimmed || sniffing) return
    setSniffing(true)
    setFeedback(null)
    const res = await addCustomModel(trimmed)
    setSniffing(false)
    if (res.ok) {
      setFeedback({ type: 'success', message: t('嗅探完成，已作为标准模型卡片加入下方模型列表') })
      setUrl('')
    } else {
      setFeedback({ type: 'error', message: res.error || t('添加模型失败') })
    }
  }

  return (
    <Card className="p-0 overflow-hidden border border-border/70 rounded-2xl bg-card shadow-xs">
      {/* 头部说明 */}
      <div className="p-5 border-b border-border/40">
        <Label className="text-base font-bold tracking-tight text-foreground flex items-center gap-2">
          <Link2 className="h-4 w-4 text-primary" />
          <span>{t('增加任意模型')}</span>
        </Label>
        <p className="text-xs text-muted-foreground font-normal mt-1 leading-relaxed">
          {t('自由添加 ModelScope / HuggingFace 托管的任意 GGUF 模型文件，提交后自动通过网络嗅探模型大小（全程不下载任何文件）。')}
        </p>
      </div>

      <div className="p-5">
        {!expanded ? (
          /* 收起态：通栏添加按钮 */
          <Button
            variant="outline"
            className="w-full h-10 rounded-xl border-dashed border-border/70 text-sm font-bold text-foreground/80 hover:border-primary/60 hover:text-primary gap-2"
            onClick={() => setExpanded(true)}
          >
            <Plus className="h-4 w-4 shrink-0" />
            <span>{t('自由添加指定模型')}</span>
          </Button>
        ) : (
          /* 展开态：输入行 + 三种格式示例说明 */
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Input
                ref={inputRef}
                value={url}
                disabled={sniffing}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleSubmit()
                  } else if (e.key === 'Escape') {
                    resetPanel()
                  }
                }}
                placeholder="https://modelscope.cn/models/Abiray/Qwen-Image-2.1-GGUF/file/view/master/qwen_image_2.1_Q4_K_S.gguf"
                className="h-10 flex-1 text-sm font-mono placeholder:font-sans placeholder:text-muted-foreground/60"
              />
              <Button
                size="sm"
                className="h-10 px-4 rounded-lg font-bold shrink-0 gap-1.5"
                disabled={sniffing || !url.trim()}
                onClick={() => void handleSubmit()}
              >
                {sniffing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                    <span>{t('嗅探中...')}</span>
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4 shrink-0" />
                    <span>{t('添加并嗅探')}</span>
                  </>
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-10 w-10 p-0 rounded-lg shrink-0 text-muted-foreground"
                disabled={sniffing}
                onClick={resetPanel}
                aria-label={t('取消')}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* 支持格式说明（三例） */}
            <div className="rounded-lg bg-muted/40 border border-border/40 px-3 py-2.5 space-y-1">
              <p className="text-[11px] font-semibold text-muted-foreground">{t('支持如下三种模型文件地址格式：')}</p>
              {SUPPORTED_URL_EXAMPLES.map(example => (
                <p
                  key={example}
                  className="text-[11px] font-mono text-muted-foreground/80 break-all leading-relaxed select-all"
                >
                  {example}
                </p>
              ))}
            </div>

            {/* 嗅探状态与结果反馈 */}
            {sniffing && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                {t('正在通过网络探测模型文件大小与同目录投影文件，请稍候...')}
              </p>
            )}
            {feedback && (
              <p
                className={`text-xs flex items-start gap-1.5 ${
                  feedback.type === 'error' ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'
                }`}
              >
                {feedback.type === 'error' ? (
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                )}
                <span className="break-all">{feedback.message}</span>
              </p>
            )}

            {/* 嗅探成功后提供继续添加入口 */}
            {feedback?.type === 'success' && (
              <p className="text-xs text-muted-foreground">
                {t('可继续添加下一个模型，或收起本卡片。')}
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
