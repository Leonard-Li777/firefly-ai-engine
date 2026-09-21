import React, { useState, useEffect } from 'react'
import { Sliders, CheckCircle2, ShieldAlert } from 'lucide-react'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Slider } from '../ui/slider'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import { Badge } from '../ui/badge'
import { useEngineStore } from '../../stores/engine-store'
import { useI18nStore } from '../../lib/i18n'

export const HardwareMonitorPanel: React.FC = () => {
  const { t } = useI18nStore()
  const { runtimeParams, updateRuntimeParams, engineStatus } = useEngineStore()
  const [params, setParams] = useState(runtimeParams)
  const [savedFeedback, setSavedFeedback] = useState(false)

  useEffect(() => {
    setParams(runtimeParams)
  }, [runtimeParams])

  const hw = engineStatus?.hardware
  const totalVramMb = (hw?.total_vram_gb || 8) * 1024
  const usedVramMb = engineStatus?.vram_usage_mb || 0
  const vramPercent = Math.min(100, Math.round((usedVramMb / totalVramMb) * 100))

  const handleSave = async () => {
    const success = await updateRuntimeParams(params)
    if (success) {
      setSavedFeedback(true)
      setTimeout(() => setSavedFeedback(false), 3000)
    }
  }

  return (
    <Card className="p-5 border border-border/80 rounded-2xl bg-card shadow-xs space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1.5">
        <div>
          <Label className="text-base font-bold tracking-tight text-foreground flex items-center gap-2">
            <Sliders className="h-4 w-4 text-primary" />
            <span>{t('运行时监控与安全调度配置')}</span>
          </Label>
          <p className="text-xs text-muted-foreground/80 font-normal mt-1 leading-relaxed">
            {t('实时调控推理参数。严格遵循 ubatch <= batch 防崩溃安全准则与 Max-Fill 显存卸载。')}
          </p>
        </div>
      </div>

      {/* 显存负载实时仪表：柔和弱边框与柔和底色 */}
      <div className="p-3.5 rounded-xl bg-muted/30 border border-border/70 space-y-2 shadow-2xs">
        <div className="flex items-center justify-between text-xs font-semibold">
          <span className="text-foreground">{t('动态显存预测分配')}</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {usedVramMb} MB / {Math.round(totalVramMb)} MB ({vramPercent}%)
          </span>
        </div>
        <Progress
          value={vramPercent}
          className="h-2 bg-muted/60"
          indicatorClassName={vramPercent > 85 ? 'bg-amber-500' : 'bg-primary'}
        />
        <div className="flex flex-wrap items-center justify-between text-[10px] text-muted-foreground font-medium gap-1">
          <span>{t('安全余量')}: {Math.max(0, Math.round(totalVramMb - usedVramMb))} MB</span>
          {vramPercent > 85 && (
            <span className="text-amber-600 dark:text-amber-400 font-bold flex items-center gap-1">
              <ShieldAlert className="h-3 w-3" />
              {t('显存接近饱和，建议适当降低 GPU 卸载层数')}
            </span>
          )}
        </div>
      </div>

      {/* 参数滑块栅格 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* GPU 卸载层数 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-bold">{t('GPU 卸载层数 (-ngl)')}</Label>
            <Badge variant="outline" className="font-mono text-xs font-semibold border-border/40">
              {t('{count} 层', { count: params.n_gpu_layers })}
            </Badge>
          </div>
          <Slider
            value={params.n_gpu_layers}
            min={0}
            max={64}
            step={1}
            onChange={val => setParams(p => ({ ...p, n_gpu_layers: val }))}
          />
          <span className="text-[10px] text-muted-foreground/70 block leading-tight">
            {t('0 为纯 CPU 运算，值越大显存占用越多、推理速度越快')}
          </span>
        </div>

        {/* CPU 物理线程数 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-bold">{t('CPU 计算线程 (-t)')}</Label>
            <Badge variant="outline" className="font-mono text-xs font-semibold border-border/40">
              {t('{count} 线程', { count: params.threads })}
            </Badge>
          </div>
          <Slider
            value={params.threads}
            min={1}
            max={32}
            step={1}
            onChange={val => setParams(p => ({ ...p, threads: val }))}
          />
          <span className="text-[10px] text-muted-foreground/70 block leading-tight">
            {t('建议配置为物理核心数（通常 4 ~ 16），避免线程争抢')}
          </span>
        </div>

        {/* 上下文窗口大小 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-bold">{t('上下文长度 (--ctx-size)')}</Label>
            <Badge variant="outline" className="font-mono text-xs font-semibold border-border/40">
              {params.ctx_size}
            </Badge>
          </div>
          <Slider
            value={params.ctx_size}
            min={1024}
            max={16384}
            step={1024}
            onChange={val => setParams(p => ({ ...p, ctx_size: val }))}
          />
          <span className="text-[10px] text-muted-foreground/70 block leading-tight">
            {t('长文本分析窗口，越大 KV Cache 显存消耗越多')}
          </span>
        </div>
      </div>

      {/* 底部保存与微批安全提示 */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-3 border-t border-border/30">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/80 font-mono">
          <span>batch={params.batch_size}, ubatch={params.ubatch_size}</span>
          <Badge variant="secondary" className="text-[9px] font-bold">
            {t('ubatch ≤ batch 防崩溃保证')}
          </Badge>
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
          {savedFeedback && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-bold">
              <CheckCircle2 className="h-4 w-4" />
              <span>{t('参数已同步生效')}</span>
            </div>
          )}
          <Button
            size="sm"
            onClick={handleSave}
            className="font-bold text-xs h-8.5 px-4 rounded-lg shadow-xs"
          >
            {t('保存调优参数')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

