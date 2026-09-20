import React from 'react'
import { Cpu, HardDrive, AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react'
import { Card } from '../ui/card'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { useEngineStore } from '../../stores/engine-store'
import { useI18nStore } from '../../lib/i18n'

export const HardwareCard: React.FC = () => {
  const { t } = useI18nStore()
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
      {/* 驱动降级告警卡片 - 采用低反差琥珀金深海微光调，按钮多语言防挤压自适应换行 */}
      {downgradeInfo?.downgraded && (
        <Alert variant="warning" className="border-amber-500/25 bg-amber-500/8 rounded-xl shadow-xs">
          <AlertTriangle className="h-4.5 w-4.5 text-amber-500 shrink-0" />
          <div className="min-w-0 flex-1">
            <AlertTitle className="text-amber-900 dark:text-amber-300 flex flex-wrap items-center gap-2">
              <span className="font-bold">{t('hardware.driverWarningTitle')}</span>
              <Badge variant="warning" className="text-[10px] uppercase font-bold tracking-wider">
                {downgradeInfo.reason || 'DRIVER_OUTDATED'}
              </Badge>
            </AlertTitle>
            <AlertDescription className="text-amber-800/90 dark:text-amber-400/80 mt-1 leading-relaxed break-words text-xs">
              {downgradeInfo.message || t('hardware.driverWarningTip')}
            </AlertDescription>
            <div className="flex flex-wrap items-center gap-2.5 mt-3">
              {downgradeInfo.driver_update_url && (
                <Button
                  size="sm"
                  variant="default"
                  className="bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs h-8 rounded-lg shadow-xs"
                  onClick={() => openExternal(downgradeInfo.driver_update_url!)}
                >
                  <ExternalLink className="h-3.5 w-3.5 mr-1" />
                  前往官网更新驱动
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="border-amber-500/30 text-amber-900 dark:text-amber-300 hover:bg-amber-500/15 font-bold text-xs h-8 rounded-lg"
                disabled={loading}
                onClick={() => fetchEngineStatus()}
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} />
                重新检测驱动
              </Button>
            </div>
          </div>
        </Alert>
      )}

      {/* 硬件信息非对称栅格：针对长GPU名称（如 NVIDIA GeForce RTX 3060 Laptop GPU）与多语言标签，提供充裕宽度与柔和切线 */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3.5">
        {/* GPU 卡片：占 5 列，显卡名称支持两行包裹 break-words，彻底根除单行被 ... 粗暴截断 */}
        <Card className="md:col-span-5 p-4 flex items-start gap-3 bg-card/60 backdrop-blur-xs border-border/30 hover:border-border/60 transition-colors rounded-xl">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary border border-primary/20 mt-0.5">
            <Cpu className="h-5 w-5" />
          </div>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[10px] font-bold uppercase text-muted-foreground/80 tracking-wider">
              {t('hardware.gpuModel')}
            </span>
            <span
              className="text-sm font-bold text-foreground leading-snug break-words mt-0.5"
              title={hw?.gpu_name || '探测中...'}
            >
              {hw?.gpu_name || '通用加速设备'}
            </span>
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <Badge variant="outline" className="text-[10px] h-5 px-1.5 py-0 font-bold border-border/40">
                {hw?.is_integrated ? '集成显卡 (核显)' : '独立显卡 (dGPU)'}
              </Badge>
              {hw?.best_tier && (
                <Badge variant="secondary" className="text-[10px] h-5 px-1.5 py-0 font-bold uppercase">
                  {hw.best_tier}
                </Badge>
              )}
            </div>
          </div>
        </Card>

        {/* 显存信息卡片：占 4 列 */}
        <Card className="md:col-span-4 p-4 flex items-start gap-3 bg-card/60 backdrop-blur-xs border-border/30 hover:border-border/60 transition-colors rounded-xl">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20 mt-0.5">
            <HardDrive className="h-5 w-5" />
          </div>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[10px] font-bold uppercase text-muted-foreground/80 tracking-wider">
              {t('hardware.vram')}
            </span>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className="text-base font-bold text-foreground">
                {hw?.total_vram_gb ? `${hw.total_vram_gb} GB` : '--'}
              </span>
              {engineStatus?.vram_usage_mb !== undefined && (
                <span className="text-xs font-semibold text-muted-foreground">
                  (已用 {engineStatus.vram_usage_mb} MB)
                </span>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground/80 font-medium mt-1 truncate">
              {t('hardware.activeBackend')}: <strong className="text-primary uppercase">{engineStatus?.active_backend || '未知'}</strong>
            </span>
          </div>
        </Card>

        {/* CPU 调度卡片：占 3 列 */}
        <Card className="md:col-span-3 p-4 flex items-start gap-3 bg-card/60 backdrop-blur-xs border-border/30 hover:border-border/60 transition-colors rounded-xl">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 mt-0.5">
            <Cpu className="h-5 w-5" />
          </div>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[10px] font-bold uppercase text-muted-foreground/80 tracking-wider">
              {t('hardware.totalMem')}
            </span>
            <span className="text-sm font-bold text-foreground mt-0.5">
              {hw?.cpu_cores ? `${hw.cpu_cores} 核 / ${hw.cpu_threads || hw.cpu_cores * 2} 线程` : 'CPU 自适应'}
            </span>
            <span className="text-[10px] text-muted-foreground/80 font-medium mt-1 truncate">
              平台: <strong className="text-foreground uppercase">{hw?.os_platform || 'Windows'}</strong>
            </span>
          </div>
        </Card>
      </div>
    </div>
  )
}

