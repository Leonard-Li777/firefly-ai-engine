import React, { useState } from 'react'
import {
  Activity,
  Cpu,
  HardDrive,
  Copy,
  Check,
  Zap,
  Server,
  Boxes,
  Sliders,
  ExternalLink,
  ShieldCheck,
  CheckCircle2
} from 'lucide-react'
import { Card } from '../ui/card'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import { Label } from '../ui/label'
import { useEngineStore } from '../../stores/engine-store'
import { useI18nStore } from '../../lib/i18n'
import { getModelCustomParams } from '../../lib/model-param-storage'

export const DashboardView: React.FC = () => {
  const { t } = useI18nStore()
  const { engineStatus, models, runtimeParams, activeModelKey } = useEngineStore()
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)

  const hw = engineStatus?.hardware
  const safeModels = Array.isArray(models) ? models : []
  const installedModelsCount = safeModels.filter(m => m && m.isDownloaded).length
  const totalModelsCount = safeModels.length

  // 当前引擎
  const activeBackend = engineStatus?.active_backend || 'vulkan'

  // 根据 activeModelKey 精确获取当前模型对象，并融合专属启动参数
  const currentModelItem = safeModels.find(m => `${m.id}@${m.source}` === activeModelKey)
  const currentModelName = currentModelItem?.name || engineStatus?.current_model || 'Qwen 3.5 0.8B (内置快速)'
  const customParams = currentModelItem ? getModelCustomParams(currentModelItem.id) : undefined
  const effectiveParams = { ...runtimeParams, ...customParams }

  // 显存负载统计
  const totalVramMb = (hw?.total_vram_gb || 8) * 1024
  const usedVramMb = engineStatus?.vram_usage_mb || 0
  const vramPercent = Math.min(100, Math.round((usedVramMb / totalVramMb) * 100))

  // 物理内存统计
  const totalRamGb = hw?.total_ram_gb || 16
  const usedRamGb = hw?.used_ram_gb || 6.2
  const ramPercent = Math.min(100, Math.round((usedRamGb / totalRamGb) * 100))

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
    <div className="space-y-6">
      {/* 顶部核心指标 KPI 仪表卡片栅格 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* 卡片 1: 已安装模型计数 */}
        <Card className="p-4 bg-card/90 border border-border/80 rounded-2xl shadow-xs hover:border-primary/50 transition-colors flex items-center gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
            <Boxes className="h-5.5 w-5.5" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-tight block">
              {t('已安装模型')}
            </span>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className="text-2xl font-black text-foreground">
                {installedModelsCount}
              </span>
              <span className="text-xs font-mono text-muted-foreground">
                / {totalModelsCount} {t('个可用')}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
              <span>{t('即时就绪，可无缝热切')}</span>
            </div>
          </div>
        </Card>

        {/* 卡片 2: 当前运算引擎 */}
        <Card className="p-4 bg-card/90 border border-border/80 rounded-2xl shadow-xs hover:border-primary/50 transition-colors flex items-center gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
            <Zap className="h-5.5 w-5.5" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-tight block">
              {t('当前计算引擎')}
            </span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-lg font-black text-foreground uppercase truncate">
                {activeBackend}
              </span>
              <Badge variant="outline" className="text-[9px] font-bold h-4.5 px-1.5 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 uppercase">
                {engineStatus?.status === 'ready' ? t('就绪') : t('运行中')}
              </Badge>
            </div>
            <span className="text-[10px] text-muted-foreground truncate block mt-1" title={hw?.gpu_name}>
              {hw?.gpu_name || t('通用加速硬件')}
            </span>
          </div>
        </Card>

        {/* 卡片 3: 当前加载模型 */}
        <Card className="p-4 bg-card/90 border border-border/80 rounded-2xl shadow-xs hover:border-primary/50 transition-colors flex items-center gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
            <Activity className="h-5.5 w-5.5" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-tight block">
              {t('活动推理模型')}
            </span>
            <span className="text-sm font-black text-foreground truncate block mt-0.5" title={currentModelName}>
              {currentModelName}
            </span>
            <div className="flex items-center gap-1.5 mt-1 text-[10px] text-muted-foreground">
              <ShieldCheck className="h-3 w-3 text-purple-500" />
              <span>{t('GGUF Q4 量化')}</span>
            </div>
          </div>
        </Card>

        {/* 卡片 4: 服务监听端口与状态 */}
        <Card className="p-4 bg-card/90 border border-border/80 rounded-2xl shadow-xs hover:border-primary/50 transition-colors flex items-center gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
            <Server className="h-5.5 w-5.5" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-tight block">
              {t('API 服务监听')}
            </span>
            <span className="text-base font-black text-foreground font-mono mt-0.5 block">
              127.0.0.1:{port}
            </span>
            <div className="flex items-center gap-1.5 mt-1 text-[10px] text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>{t('OpenAI 兼容协议')}</span>
            </div>
          </div>
        </Card>
      </div>

      {/* 核心双栏：左侧【显存与内存负载监控】+ 右侧【第三方应用集成配置与 URL 复制】 */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* 左侧：显存与物理内存双仪表 (占 6 列) */}
        <Card className="lg:col-span-6 p-5 bg-card border border-border/80 rounded-2xl shadow-xs space-y-5">
          <div>
            <Label className="text-base font-bold tracking-tight text-foreground flex items-center gap-2">
              <Cpu className="h-4 w-4 text-primary" />
              <span>{t('硬件负载与运行时资源占用')}</span>
            </Label>
            <p className="text-xs text-muted-foreground font-normal mt-1 leading-relaxed">
              {t('实时检测独立显卡显存 (VRAM) 与系统物理内存 (RAM) 动态分配水位。')}
            </p>
          </div>

          {/* 显存负载条 */}
          <div className="p-4 rounded-xl bg-muted/30 border border-border/70 space-y-2.5">
            <div className="flex items-center justify-between text-xs font-bold">
              <div className="flex items-center gap-2">
                <HardDrive className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-foreground">{t('GPU 独立显存 (VRAM)')}</span>
              </div>
              <span className="font-mono text-xs text-muted-foreground">
                {usedVramMb} MB / {Math.round(totalVramMb)} MB ({vramPercent}%)
              </span>
            </div>
            <Progress
              value={vramPercent}
              className="h-2.5 bg-muted/60"
              indicatorClassName={vramPercent > 85 ? 'bg-amber-500' : 'bg-primary'}
            />
            <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono">
              <span>{t('可用余量')}: {Math.max(0, Math.round(totalVramMb - usedVramMb))} MB</span>
              <span className="font-sans font-semibold text-foreground/80">
                {hw?.is_integrated ? t('共享系统显存') : t('独立显存')}
              </span>
            </div>
          </div>

          {/* 物理内存负载条 */}
          <div className="p-4 rounded-xl bg-muted/30 border border-border/70 space-y-2.5">
            <div className="flex items-center justify-between text-xs font-bold">
              <div className="flex items-center gap-2">
                <Cpu className="h-3.5 w-3.5 text-blue-500" />
                <span className="text-foreground">{t('系统物理内存 (RAM)')}</span>
              </div>
              <span className="font-mono text-xs text-muted-foreground">
                {usedRamGb.toFixed(1)} GB / {totalRamGb.toFixed(1)} GB ({ramPercent}%)
              </span>
            </div>
            <Progress
              value={ramPercent}
              className="h-2.5 bg-muted/60"
              indicatorClassName="bg-blue-500"
            />
            <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono">
              <span>{t('可用余量')}: {Math.max(0, totalRamGb - usedRamGb).toFixed(1)} GB</span>
              <span className="font-sans font-semibold text-foreground/80">
                {hw?.cpu_cores ? `${hw.cpu_cores} ${t('核心')} / ${hw.cpu_threads || hw.cpu_cores * 2} ${t('线程')}` : t('CPU 自适应')}
              </span>
            </div>
          </div>
        </Card>

        {/* 右侧：第三方集成接口与启动参数 (占 6 列) */}
        <Card className="lg:col-span-6 p-5 bg-card border border-border/80 rounded-2xl shadow-xs space-y-5">
          <div>
            <Label className="text-base font-bold tracking-tight text-foreground flex items-center gap-2">
              <ExternalLink className="h-4 w-4 text-primary" />
              <span>{t('第三方应用对接与 API 地址')}</span>
            </Label>
            <p className="text-xs text-muted-foreground font-normal mt-1 leading-relaxed">
              {t('完全兼容 OpenAI 标准协议，可无缝配置至 Cherry Studio、ChatBox、NextChat 等客户端。')}
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
      </div>

      {/* 底部：当前模型实时启动参数快照 */}
      <Card className="p-5 bg-card border border-border/80 rounded-2xl shadow-xs space-y-3">
        <div className="flex items-center justify-between border-b border-border/40 pb-2.5">
          <div className="flex items-center gap-2">
            <Sliders className="h-4 w-4 text-primary" />
            <span className="font-bold text-sm text-foreground">{t('当前模型引擎启动参数')}</span>
            <Badge variant="outline" className="text-[10px] border-border/60 font-mono">
              llama-server CLI flags
            </Badge>
          </div>
          <span className="text-xs font-mono text-muted-foreground">
            --host 127.0.0.1 --port {port}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 pt-1">
          <div className="p-2.5 rounded-lg bg-muted/30 border border-border/60">
            <span className="text-[10px] text-muted-foreground font-semibold uppercase block">
              {t('-ngl (GPU 层数)')}
            </span>
            <span className="text-sm font-mono font-black text-foreground mt-0.5 block">
              {effectiveParams.n_gpu_layers}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-muted/30 border border-border/60">
            <span className="text-[10px] text-muted-foreground font-semibold uppercase block">
              {t('-c (上下文窗口)')}
            </span>
            <span className="text-sm font-mono font-black text-foreground mt-0.5 block">
              {effectiveParams.ctx_size}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-muted/30 border border-border/60">
            <span className="text-[10px] text-muted-foreground font-semibold uppercase block">
              {t('-t (线程数)')}
            </span>
            <span className="text-sm font-mono font-black text-foreground mt-0.5 block">
              {effectiveParams.threads}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-muted/30 border border-border/60">
            <span className="text-[10px] text-muted-foreground font-semibold uppercase block">
              {t('-b (Batch Size)')}
            </span>
            <span className="text-sm font-mono font-black text-foreground mt-0.5 block">
              {effectiveParams.batch_size}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-muted/30 border border-border/60">
            <span className="text-[10px] text-muted-foreground font-semibold uppercase block">
              {t('-ub (uBatch Size)')}
            </span>
            <span className="text-sm font-mono font-black text-foreground mt-0.5 block">
              {effectiveParams.ubatch_size}
            </span>
          </div>
        </div>
      </Card>
    </div>
  )
}
