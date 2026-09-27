import React, { useEffect, useState } from 'react'
import { Cpu, Download, Check, Loader2, Zap, ExternalLink, Sparkles, Trash2 } from 'lucide-react'
import { Card } from '../ui/card'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import { Label } from '../ui/label'
import { useEngineStore } from '../../stores/engine-store'
import { useEngineDownload } from '../../hooks/use-engine-download'
import { formatSpeed } from '../../lib/utils'
import { t } from '../../languages'

export const EngineTable: React.FC = () => {
  const { engineList, fetchEngineList, switchEngine, deleteEngine, switchingBackend, engineStatus } = useEngineStore()
  const { state: downloadState, startDownload } = useEngineDownload()
  const [deletingBackend, setDeletingBackend] = useState<string | null>(null)

  useEffect(() => {
    fetchEngineList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 当前引擎：后端未上报（如从未下载任何引擎）时为空串，不硬编码兜底，UI 不标记任何"当前引擎"
  const currentBackend = engineStatus?.active_backend || ''
  const hw = engineStatus?.hardware
  const isDarwin = hw?.os_platform === 'darwin' || (typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent))

  // 1:1 复刻 Desktop getGpuVendor 逻辑
  const getGpuVendor = (): string => {
    const rawGpu = (hw?.gpu_name || '').toLowerCase()
    if (rawGpu.includes('nvidia') || rawGpu.includes('geforce')) return 'NVIDIA'
    if (rawGpu.includes('amd') || rawGpu.includes('radeon')) return 'AMD'
    if (rawGpu.includes('intel') || rawGpu.includes('arc')) return 'Intel'
    if (rawGpu.includes('apple') || rawGpu.includes('m1') || rawGpu.includes('m2') || rawGpu.includes('m3') || rawGpu.includes('m4')) return 'Apple'
    return 'CPU'
  }

  // 严格依据平台过滤：Windows / Linux 平台绝对不向用户展示 Apple Metal
  const safeEngineList = (Array.isArray(engineList) ? engineList : []).filter(item => {
    if (!isDarwin && item.backend === 'metal') {
      return false
    }
    return true
  })

  return (
    <Card className="p-5 border border-border/80 rounded-2xl bg-card shadow-xs space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1.5">
        <div>
          <Label className="text-base font-bold tracking-tight text-foreground flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            <span>{t('切换本地AI引擎')}</span>
          </Label>
          <p className="text-xs text-muted-foreground/80 font-normal mt-1 leading-relaxed">
            {t('您的 {vendor} 显卡可切换以下引擎', { vendor: getGpuVendor() })}
          </p>
        </div>
        <Badge variant="outline" className="text-[11px] font-semibold h-6 self-start sm:self-auto shrink-0 border-border/60">
          基准端口: {engineStatus?.port || 38400}
        </Badge>
      </div>

      {/* 引擎列表表格：平滑滚动容器，解决德文/俄文等长表头溢出问题 */}
      <div className="border border-border/70 rounded-xl overflow-x-auto bg-background/50 shadow-2xs scrollbar-slim">
        <table className="w-full text-left border-collapse min-w-[760px]">
          <thead>
            <tr className="border-b border-border/60 bg-muted/40">
              <th className="p-3 text-xs font-semibold text-muted-foreground uppercase text-left pl-4 w-[18%]">
                {t('AI 引擎')}
              </th>
              <th className="p-3 text-xs font-semibold text-muted-foreground uppercase text-center w-[8%]">
                {t('推荐')}
              </th>
              <th className="p-3 text-xs font-semibold text-muted-foreground uppercase text-center w-[12%]">
                {t('适配类型')}
              </th>
              <th className="p-3 text-xs font-semibold text-muted-foreground uppercase text-center w-[11%]">
                {t('引擎大小')}
              </th>
              <th className="p-3 text-xs font-semibold text-muted-foreground uppercase text-left">
                {t('性能说明')}
              </th>
              <th className="p-3 text-xs font-semibold text-muted-foreground uppercase text-right w-[15%]">
                {t('下载引擎')}
              </th>
              <th className="p-3 text-xs font-semibold text-muted-foreground uppercase text-right pr-4 w-[15%]">
                {t('当前引擎')}
              </th>
            </tr>
          </thead>
          <tbody>
            {safeEngineList.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-8 text-center text-xs text-muted-foreground">
                  <Loader2 className="h-4.5 w-4.5 animate-spin mx-auto mb-2 text-primary" />
                  {t('正在扫描已安装计算引擎...')}
                </td>
              </tr>
            ) : (
              safeEngineList.map(item => {
                const isCurrent = item.backend === currentBackend
                const isSwitching = switchingBackend === item.backend
                const isDownloadingThis = downloadState.isDownloading && downloadState.currentBackend === item.backend
                const isRecommended = item.isRecommended ?? (item.matchType === 'best')

                return (
                  <tr
                    key={item.id}
                    className={`border-b last:border-0 border-border/20 transition-colors ${
                      isCurrent ? 'bg-primary/5 dark:bg-primary/8 font-medium' : 'hover:bg-muted/15'
                    }`}
                  >
                    {/* 引擎名称 */}
                    <td className="p-3 pl-4 text-sm">
                      <div className="flex items-center gap-2.5">
                        <div
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                            isCurrent
                              ? 'bg-primary text-primary-foreground shadow-xs'
                              : 'bg-muted/60 text-muted-foreground/80'
                          }`}
                        >
                          <Cpu className="h-4 w-4" />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="font-bold text-foreground truncate">{item.name}</span>
                          <span className="text-[10px] text-muted-foreground/70 font-mono">
                            backend: {item.backend}
                          </span>
                        </div>
                      </div>
                    </td>

                    {/* 推荐标记 */}
                    <td className="p-3 text-center align-middle">
                      {isRecommended ? (
                        <Badge
                          variant="default"
                          className="text-[10px] font-bold px-2 py-0.5 bg-amber-500/15 hover:bg-amber-500/25 text-amber-700 dark:text-amber-400 border border-amber-500/30 gap-1 shadow-2xs inline-flex"
                        >
                          <Sparkles className="h-2.5 w-2.5 text-amber-500 shrink-0" />
                          <span>{t('推荐')}</span>
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground/50 select-none">-</span>
                      )}
                    </td>

                    {/* 适配类型 */}
                    <td className="p-3 text-center align-middle">
                      <Badge
                        variant={
                          item.matchType === 'best'
                            ? 'success'
                            : item.matchType === 'compatible'
                              ? 'warning'
                              : 'outline'
                        }
                        className="text-[10px] font-semibold"
                      >
                        {item.matchText}
                      </Badge>
                    </td>

                    {/* 引擎大小列 */}
                    <td className="p-3 text-xs text-center text-muted-foreground/80 font-mono">
                      {item.downloadSizeMb ? `${item.downloadSizeMb} MB` : '-'}
                    </td>

                    {/* 性能利用说明 */}
                    <td className="p-3 text-xs text-left text-muted-foreground/90 font-medium leading-relaxed">
                      {item.performance}
                    </td>

                    {/* 下载引擎列 (未安装下载 / 已安装版本更新 / 弱化删除) */}
                    <td className="p-3 text-right align-middle">
                      {isDownloadingThis ? (
                        <div className="inline-flex flex-col items-end gap-1 min-w-[130px]">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                            <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                            <span>
                              {downloadState.status === 'extracting'
                                ? '校验解压中...'
                                : `下载中 ${downloadState.progress}%`}
                            </span>
                          </div>
                          <Progress value={downloadState.progress} className="h-1.5 w-24" />
                          <div className="flex items-center justify-between w-full text-[10px] text-muted-foreground font-mono">
                            {downloadState.sourceName && (
                              <span className="text-primary/80 font-sans">{downloadState.sourceName}</span>
                            )}
                            {downloadState.speedBps > 0 && (
                              <span>{formatSpeed(downloadState.speedBps)}</span>
                            )}
                          </div>
                        </div>
                      ) : !item.isInstalled ? (
                        item.driverCompliant === false ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7.5 font-bold text-xs px-2.5 rounded-lg border-amber-500/40 text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 hover:border-amber-500/60 transition-all shrink-0"
                            onClick={() => {
                              const targetUrl = item.driverUpdateUrl || 'https://www.nvidia.cn/Download/index.aspx'
                              window.open(targetUrl, '_blank')
                            }}
                          >
                            <ExternalLink className="h-3 w-3 mr-1 shrink-0" />
                            {t('更新显卡驱动')}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="h-7.5 font-bold text-xs px-2.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 shrink-0 inline-flex items-center"
                            disabled={downloadState.isDownloading}
                            onClick={() => startDownload(item.backend)}
                          >
                            <Download className="h-3 w-3 mr-1 shrink-0" />
                            {t('下载引擎')}
                          </Button>
                        )
                      ) : (
                        <div className="inline-flex items-center justify-end gap-1.5">
                          {/* 弱化删除按钮：仅当引擎已安装且不是当前激活引擎时显示（放在前面） */}
                          {!isCurrent && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7.5 w-7.5 text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors shrink-0"
                              disabled={deletingBackend === item.backend || downloadState.isDownloading}
                              title={t('删除此引擎目录以释放空间')}
                              onClick={async () => {
                                if (window.confirm(t('确定要删除引擎 {name} 吗？删除后可随时重新下载。', { name: item.name }))) {
                                  setDeletingBackend(item.backend)
                                  await deleteEngine(item.backend)
                                  setDeletingBackend(null)
                                }
                              }}
                            >
                              {deletingBackend === item.backend ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-destructive" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          )}

                          {item.hasUpdate ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7.5 font-bold text-xs px-2.5 rounded-lg border-primary/40 text-primary hover:bg-primary/10 transition-all shrink-0 inline-flex items-center"
                              disabled={downloadState.isDownloading}
                              onClick={() => startDownload(item.backend)}
                              title={item.latestVersion ? `最新版本: ${item.latestVersion}` : undefined}
                            >
                              <Download className="h-3 w-3 mr-1 shrink-0" />
                              {t('更新引擎')}
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground/50 select-none pr-1">-</span>
                          )}
                        </div>
                      )}
                    </td>

                    {/* 当前引擎/切换引擎列 */}
                    <td className="p-3 pr-4 text-right align-middle">
                      {isCurrent ? (
                        <Badge className="h-7.5 font-bold text-xs px-3 rounded-full bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 shrink-0">
                          <Check className="h-3 w-3 mr-1 shrink-0" />
                          {t('当前引擎')}
                        </Badge>
                      ) : item.isInstalled ? (
                        <Button
                          size="sm"
                          variant="default"
                          className="h-7.5 font-bold text-xs px-3 rounded-lg shadow-xs shrink-0"
                          disabled={switchingBackend !== null || downloadState.isDownloading}
                          onClick={() => switchEngine(item.backend)}
                        >
                          {isSwitching ? (
                            <>
                              <Loader2 className="h-3 w-3 animate-spin mr-1 shrink-0" />
                              {t('切换中...')}
                            </>
                          ) : (
                            t('切换引擎')
                          )}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground/40 select-none pr-3">{t('未安装')}</span>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
