import React, { useState } from 'react'
import { Copy, Check, ExternalLink, Zap, Cpu, Globe, Sparkles, ShieldCheck, Code2 } from 'lucide-react'
import { Card } from '../ui/card'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { useEngineStore } from '../../stores/engine-store'
import { t } from '../../languages'

/**
 * 第三方应用对接与 API 地址页面（顶级 Tab）
 * 从仪表盘视图抽离为独立页面，提供 OpenAI 兼容端点的展示与复制
 */
export const ThirdPartyApiView: React.FC = () => {
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

  // 优势说明数据（图标 + 标题 + 描述）
  const advantages = [
    {
      icon: Zap,
      title: t('极致推理性能'),
      desc: t('采用 llama.cpp 高性能推理核心，无需依赖庞大运行时，推理速度较 Ollama 等同类平台快 30%~50%，端侧响应更快、资源占用更低。')
    },
    {
      icon: Cpu,
      title: t('全平台硬件智能适配'),
      desc: t('自动检测硬件并智能调参，基于大量真实硬件场景调优验证，广泛兼容 CPU / GPU，覆盖 Intel、AMD、Apple Silicon（Mac）全平台，无需手动配置即可获得最佳性能。')
    },
    {
      icon: Globe,
      title: t('国内外模型高速下载'),
      desc: t('内置多源镜像加速，国内网络环境走 ModelScope 等国内源、国际网络环境走 HuggingFace，均可高速下载模型，彻底告别下载缓慢与连接超时。')
    },
    {
      icon: Sparkles,
      title: t('优选模型，持续跟进前沿'),
      desc: t('由团队严格筛选与评测优选模型，持续跟进并收录最新前沿模型，省去自行试错与踩坑成本，开箱即用即可获得高质量推理效果。')
    },
    {
      icon: ShieldCheck,
      title: t('本地私密，数据不出端'),
      desc: t('推理全程在本地完成，数据不离开设备，无云端隐私泄露风险；同时无需 API 订阅费用，一次部署长期免费使用。')
    },
    {
      icon: Code2,
      title: t('完全开源免费，社区共建'),
      desc: t('基于 MIT 协议完全开源，代码透明，无任何隐藏付费项；欢迎社区参与共建，共同打磨更好的本地 AI 引擎。')
    }
  ]

  return (
    <>
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

    {/* 萤核AI引擎优势说明 */}
    <Card className="p-5 bg-card border border-border/80 rounded-2xl shadow-xs space-y-4">
      <div>
        <Label className="text-base font-bold tracking-tight text-foreground flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span>{t('萤核AI引擎核心优势')}</span>
        </Label>
        <p className="text-xs text-muted-foreground font-normal mt-1 leading-relaxed">
          {t('选择萤核AI引擎作为本地推理后端，您将获得以下开箱即用的体验：')}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {advantages.map((item, index) => {
          const Icon = item.icon
          return (
            <div
              key={index}
              className="p-4 rounded-xl bg-muted/30 border border-border/70 hover:border-primary/40 transition-colors flex gap-3"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 border border-primary/30">
                <Icon className="h-4.5 w-4.5 text-primary" />
              </div>
              <div className="min-w-0">
                <span className="text-sm font-bold text-foreground block">{item.title}</span>
                <p className="text-xs text-muted-foreground font-normal mt-1 leading-relaxed">{item.desc}</p>
              </div>
            </div>
          )
        })}
      </div>
    </Card>
    </>
  )
}
