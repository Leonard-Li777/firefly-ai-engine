import React, { useState, useEffect } from 'react'
import { Sliders, CheckCircle2, ShieldAlert } from 'lucide-react'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Slider } from '../ui/slider'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import { Badge } from '../ui/badge'
import { useEngineStore } from '../../stores/engine-store'

export const HardwareMonitorPanel: React.FC = () => {
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
    <Card className="p-6 border-border/70 rounded-3xl bg-card shadow-sm space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1">
        <div>
          <Label className="text-base font-black tracking-tight text-foreground flex items-center gap-2">
            <Sliders className="h-4 w-4 text-primary" />
            <span>显存负载与动态推理参数调优</span>
          </Label>
          <p className="text-xs text-muted-foreground font-medium mt-1">
            视显卡显存规格精确调整 GPU 卸载层数与并发线程，系统内置内存保护断言（防止 OOM 崩溃）
          </p>
        </div>
      </div>

      {/* 显存负载实时仪表 */}
      <div className="p-4 rounded-2xl bg-muted/20 border border-border/50 space-y-2">
        <div className="flex items-center justify-between text-xs font-bold">
          <span className="text-foreground font-black">显存已载入负载</span>
          <span className="font-mono text-muted-foreground">
            {usedVramMb} MB / {Math.round(totalVramMb)} MB ({vramPercent}%)
          </span>
        </div>
        <Progress
          value={vramPercent}
          className="h-2.5 bg-muted/60"
          indicatorClassName={vramPercent > 85 ? 'bg-amber-500' : 'bg-primary'}
        />
        <div className="flex items-center justify-between text-[10px] text-muted-foreground font-medium">
          <span>安全余量: {Math.max(0, Math.round(totalVramMb - usedVramMb))} MB</span>
          {vramPercent > 85 && (
            <span className="text-amber-600 dark:text-amber-400 font-bold flex items-center gap-1">
              <ShieldAlert className="h-3 w-3" />
              显存接近饱和，建议适当降低 GPU 卸载层数
            </span>
          )}
        </div>
      </div>

      {/* 参数滑块栅格 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* GPU 卸载层数 */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-black">GPU 卸载层数 (n_gpu_layers)</Label>
            <Badge variant="outline" className="font-mono text-xs font-bold">
              {params.n_gpu_layers} 层
            </Badge>
          </div>
          <Slider
            value={params.n_gpu_layers}
            min={0}
            max={64}
            step={1}
            onChange={val => setParams(p => ({ ...p, n_gpu_layers: val }))}
          />
          <span className="text-[10px] text-muted-foreground block">
            0 为纯 CPU 运算，值越大 GPU 显存占用越多、推理速度越快
          </span>
        </div>

        {/* CPU 物理线程数 */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-black">并发计算线程数 (threads)</Label>
            <Badge variant="outline" className="font-mono text-xs font-bold">
              {params.threads} 线程
            </Badge>
          </div>
          <Slider
            value={params.threads}
            min={1}
            max={32}
            step={1}
            onChange={val => setParams(p => ({ ...p, threads: val }))}
          />
          <span className="text-[10px] text-muted-foreground block">
            建议配置为 CPU 物理核心数（通常 4 ~ 16），避免线程争抢
          </span>
        </div>

        {/* 上下文窗口大小 */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-black">上下文窗口大小 (ctx_size)</Label>
            <Badge variant="outline" className="font-mono text-xs font-bold">
              {params.ctx_size} tokens
            </Badge>
          </div>
          <Slider
            value={params.ctx_size}
            min={1024}
            max={16384}
            step={1024}
            onChange={val => setParams(p => ({ ...p, ctx_size: val }))}
          />
          <span className="text-[10px] text-muted-foreground block">
            支持长文本文件上下文分析，窗口越大 KV Cache 显存消耗越多
          </span>
        </div>
      </div>

      {/* 底部保存与微批安全提示 */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-3 border-t border-border/40">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground font-mono">
          <span>当前调度约束: batch_size={params.batch_size}, ubatch_size={params.ubatch_size}</span>
          <Badge variant="secondary" className="text-[9px] font-bold">
            ubatch &le; batch 防崩溃保证
          </Badge>
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
          {savedFeedback && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-bold">
              <CheckCircle2 className="h-4 w-4" />
              <span>参数已同步生效</span>
            </div>
          )}
          <Button
            size="sm"
            onClick={handleSave}
            className="font-black text-xs h-9 px-5 rounded-xl shadow-xs"
          >
            保存调优参数
          </Button>
        </div>
      </div>
    </Card>
  )
}
