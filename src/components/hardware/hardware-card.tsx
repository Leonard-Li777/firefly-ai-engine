import React from 'react'
import { Cpu, HardDrive, AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react'
import { Card } from '../ui/card'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { useEngineStore } from '../../stores/engine-store'

export const HardwareCard: React.FC = () => {
  const { engineStatus, fetchEngineStatus, loading } = useEngineStore()
  const hw = engineStatus?.hardware
  const downgradeInfo = engineStatus?.downgrade_info

  const openExternal = (url: string) => {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank')
    }
  }

  return (
    <div className="space-y-4">
      {/* 驱动降级告警卡片 */}
      {downgradeInfo?.downgraded && (
        <Alert variant="warning" className="border-amber-500/40 bg-amber-500/10 shadow-sm">
          <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          <div>
            <AlertTitle className="text-amber-900 dark:text-amber-300 flex items-center gap-2">
              <span>驱动升级建议与降级诊断告警</span>
              <Badge variant="warning" className="text-[10px] uppercase font-black tracking-wider">
                {downgradeInfo.reason || 'DRIVER_OUTDATED'}
              </Badge>
            </AlertTitle>
            <AlertDescription className="text-amber-800 dark:text-amber-400/90 mt-1 leading-relaxed">
              {downgradeInfo.message ||
                '显卡驱动版本过低，已自动降级至兼容模式运行。升级显卡驱动后可开启最高性能加速。'}
            </AlertDescription>
            <div className="flex items-center gap-2.5 mt-3">
              {downgradeInfo.driver_update_url && (
                <Button
                  size="sm"
                  variant="default"
                  className="bg-amber-600 hover:bg-amber-700 text-white font-black text-xs h-8 rounded-lg shadow-sm"
                  onClick={() => openExternal(downgradeInfo.driver_update_url!)}
                >
                  <ExternalLink className="h-3.5 w-3.5 mr-1" />
                  前往官网更新驱动
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="border-amber-500/30 text-amber-900 dark:text-amber-300 hover:bg-amber-500/20 font-black text-xs h-8 rounded-lg"
                disabled={loading}
                onClick={() => fetchEngineStatus()}
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} />
                我已升级，重新检测
              </Button>
            </div>
          </div>
        </Alert>
      )}

      {/* 硬件信息栅格 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* GPU 卡片 */}
        <Card className="p-4 flex items-center gap-3.5 bg-card/60 backdrop-blur-xs border-border/70 rounded-2xl">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
            <Cpu className="h-5 w-5" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-[10px] font-black uppercase text-muted-foreground/70 tracking-wider">
              GPU / 显卡型号
            </span>
            <span className="text-sm font-black text-foreground truncate" title={hw?.gpu_name || '探测中...'}>
              {hw?.gpu_name || '通用加速设备'}
            </span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <Badge variant="outline" className="text-[10px] h-4.5 px-1.5 py-0 font-bold">
                {hw?.is_integrated ? '集成显卡 (核显)' : '独立显卡 (dGPU)'}
              </Badge>
              {hw?.best_tier && (
                <Badge variant="secondary" className="text-[10px] h-4.5 px-1.5 py-0 font-bold uppercase">
                  推荐: {hw.best_tier}
                </Badge>
              )}
            </div>
          </div>
        </Card>

        {/* 显存信息卡片 */}
        <Card className="p-4 flex items-center gap-3.5 bg-card/60 backdrop-blur-xs border-border/70 rounded-2xl">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
            <HardDrive className="h-5 w-5" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-[10px] font-black uppercase text-muted-foreground/70 tracking-wider">
              物理显存总量 / 已占用
            </span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-black text-foreground">
                {hw?.total_vram_gb ? `${hw.total_vram_gb} GB` : '--'}
              </span>
              {engineStatus?.vram_usage_mb !== undefined && (
                <span className="text-xs font-bold text-muted-foreground">
                  (已载入 {engineStatus.vram_usage_mb} MB)
                </span>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground/80 font-medium mt-0.5">
              当前计算后端: <strong className="text-primary uppercase">{engineStatus?.active_backend || '未知'}</strong>
            </span>
          </div>
        </Card>

        {/* CPU 调度卡片 */}
        <Card className="p-4 flex items-center gap-3.5 bg-card/60 backdrop-blur-xs border-border/70 rounded-2xl">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
            <Cpu className="h-5 w-5" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-[10px] font-black uppercase text-muted-foreground/70 tracking-wider">
              系统架构与 CPU 线程
            </span>
            <span className="text-sm font-black text-foreground">
              {hw?.cpu_cores ? `${hw.cpu_cores} 核 / ${hw.cpu_threads || hw.cpu_cores * 2} 线程` : 'CPU 线程自适应'}
            </span>
            <span className="text-[10px] text-muted-foreground/80 font-medium mt-0.5">
              平台: <strong className="text-foreground uppercase">{hw?.os_platform || 'Windows'}</strong> (端口: {engineStatus?.port || 38400})
            </span>
          </div>
        </Card>
      </div>
    </div>
  )
}
