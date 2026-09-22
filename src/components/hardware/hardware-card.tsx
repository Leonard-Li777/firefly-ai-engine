import React from 'react'
import { Cpu, HardDrive, AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react'
import { Card } from '../ui/card'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { useEngineStore } from '../../stores/engine-store'
import { useI18nStore } from '../../lib/i18n'

export const HardwareCard: React.FC = () => {
  const { t } = useI18nStore()
  const { engineStatus, loading } = useEngineStore()
  const hw = engineStatus?.hardware
  const downgradeInfo = engineStatus?.downgrade_info

  const openExternal = (url: string) => {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank')
    }
  }

  const getDriverUpdateUrl = () => {
    if (downgradeInfo?.driver_update_url) return downgradeInfo.driver_update_url
    const vendor = (hw?.gpu_name || '').toLowerCase()
    if (vendor.includes('nvidia') || vendor.includes('geforce')) {
      return 'https://www.nvidia.cn/Download/index.aspx'
    } else if (vendor.includes('amd') || vendor.includes('radeon')) {
      return 'https://www.amd.com/zh-hans/support'
    } else if (vendor.includes('intel') || vendor.includes('arc')) {
      return 'https://www.intel.com/content/www/us/en/download-center/home.html'
    }
    return 'https://www.nvidia.cn/Download/index.aspx'
  }

  const handleResetAndRecheck = async () => {
    await useEngineStore.getState().resetDowngrade()
  }

  // 格式化当前活动后端展示：
  // 如果当前已在运行/已选定具体后端（如 vulkan/cuda/metal 等），直接展示；
  // 如果当前尚未启动或回退为 cpu，但检测到了显卡最佳加速层级（如 cuda / vulkan），则展示推荐层级
  const formatActiveBackend = (active?: string, best?: string) => {
    if (active && active.toLowerCase() !== 'cpu') {
      return active.toUpperCase()
    }
    if (best && best.toLowerCase() !== 'cpu') {
      return `${best.toUpperCase()} (待命)`
    }
    return active ? active.toUpperCase() : 'CPU'
  }

  return (
    <div className="space-y-4">
      {/* 驱动升级告警与自动降级诊断 - 1:1 完美复刻 Desktop 样式与交互 */}
      {downgradeInfo?.downgraded && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 p-4 rounded-2xl flex flex-col gap-3 shadow-xs">
          <div className="flex items-start gap-3">
            <AlertTriangle className="text-yellow-600 dark:text-yellow-500 h-5 w-5 shrink-0 mt-0.5" />
            <span className="text-sm font-medium text-yellow-800 dark:text-yellow-500 leading-relaxed">
              {t('目前使用兼容模式，能发挥您显卡70% AI算力，显卡驱动需要升级，才能发挥满血性能')}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2.5 sm:pl-8">
            <Button
              variant="destructive"
              size="sm"
              className="font-bold text-xs shadow-xs"
              onClick={() => openExternal(getDriverUpdateUrl())}
            >
              <ExternalLink className="h-3.5 w-3.5 mr-1" />
              {t('升级显卡驱动')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="font-bold text-xs bg-amber-500/20 hover:bg-amber-500/30 text-amber-700 dark:text-amber-500"
              disabled={loading}
              onClick={handleResetAndRecheck}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} />
              {t('我已升级驱动，重新检测')}
            </Button>
          </div>
        </div>
      )}

      {/* 硬件信息非对称栅格：针对长GPU名称（如 NVIDIA GeForce RTX 3060 Laptop GPU）与多语言标签，提供充裕宽度与柔和切线 */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3.5">
        {/* GPU 卡片：占 5 列，显卡名称支持两行包裹 break-words，彻底根除单行被 ... 粗暴截断 */}
        <Card className="md:col-span-5 p-4 flex items-start gap-3 bg-card border border-border/80 hover:border-primary/50 transition-colors rounded-xl shadow-2xs">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary border border-primary/20 mt-0.5">
            <Cpu className="h-5 w-5" />
          </div>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider">
              {t('显卡型号')}
            </span>
            <span
              className="text-sm font-bold text-foreground leading-snug break-words mt-0.5"
              title={hw?.gpu_name || t('探测中...')}
            >
              {hw?.gpu_name || t('通用加速设备')}
            </span>
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <Badge variant="outline" className="text-[10px] h-5 px-1.5 py-0 font-bold border-border/60">
                {hw?.is_integrated ? t('集成显卡 (核显)') : t('独立显卡 (dGPU)')}
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
        <Card className="md:col-span-4 p-4 flex items-start gap-3 bg-card border border-border/80 hover:border-primary/50 transition-colors rounded-xl shadow-2xs">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20 mt-0.5">
            <HardDrive className="h-5 w-5" />
          </div>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider">
              {t('可用显存')}
            </span>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className="text-base font-bold text-foreground">
                {hw?.total_vram_gb !== undefined ? `${Number(hw.total_vram_gb.toFixed(1))} GB` : '--'}
              </span>
              {engineStatus?.vram_usage_mb != null && typeof engineStatus.vram_usage_mb === 'number' && (
                <span className="text-xs font-semibold text-muted-foreground">
                  {t('(已用 {used} MB)', { used: Math.round(engineStatus.vram_usage_mb) })}
                </span>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground font-medium mt-1 truncate">
              {t('当前活动后端')}: <strong className="text-primary uppercase">{formatActiveBackend(engineStatus?.active_backend, hw?.best_tier)}</strong>
            </span>
          </div>
        </Card>

        {/* CPU 调度卡片：占 3 列 */}
        <Card className="md:col-span-3 p-4 flex items-start gap-3 bg-card border border-border/80 hover:border-primary/50 transition-colors rounded-xl shadow-2xs">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 mt-0.5">
            <Cpu className="h-5 w-5" />
          </div>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider">
              {t('系统物理内存')}
            </span>
            <span className="text-sm font-bold text-foreground mt-0.5">
              {hw?.cpu_cores ? t('{cores} 核 / {threads} 线程', { cores: hw.cpu_cores, threads: hw.cpu_threads || hw.cpu_cores * 2 }) : t('CPU 自适应')}
            </span>
            <span className="text-[10px] text-muted-foreground font-medium mt-1 truncate">
              {t('平台')}: <strong className="text-foreground uppercase">{hw?.os_platform || 'Windows'}</strong>
            </span>
          </div>
        </Card>
      </div>
    </div>
  )
}

