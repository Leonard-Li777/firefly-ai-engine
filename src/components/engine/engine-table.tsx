import React, { useEffect } from 'react'
import { Cpu, Download, Check, Loader2, Zap } from 'lucide-react'
import { Card } from '../ui/card'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import { Label } from '../ui/label'
import { useEngineStore } from '../../stores/engine-store'
import { useEngineDownload } from '../../hooks/use-engine-download'
import { formatSpeed } from '../../lib/utils'
import { useI18nStore } from '../../lib/i18n'

export const EngineTable: React.FC = () => {
  const { t } = useI18nStore()
  const { engineList, fetchEngineList, switchEngine, switchingBackend, engineStatus } = useEngineStore()
  const { state: downloadState, startDownload } = useEngineDownload()

  useEffect(() => {
    fetchEngineList()
  }, [fetchEngineList])

  const currentBackend = engineStatus?.active_backend || 'vulkan'
  const safeEngineList = Array.isArray(engineList) ? engineList : []

  return (
    <Card className="p-5 border-border/30 rounded-xl bg-card shadow-xs space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1.5">
        <div>
          <Label className="text-base font-bold tracking-tight text-foreground flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            <span>{t('engine.title')}</span>
          </Label>
          <p className="text-xs text-muted-foreground/80 font-normal mt-1 leading-relaxed">
            {t('engine.desc')}
          </p>
        </div>
        <Badge variant="outline" className="text-[11px] font-semibold h-6 self-start sm:self-auto shrink-0 border-border/40">
          基准端口: {engineStatus?.port || 38400}
        </Badge>
      </div>

      {/* 引擎列表表格：平滑滚动容器，解决德文/俄文等长表头溢出问题 */}
      <div className="border border-border/30 rounded-lg overflow-x-auto bg-background/40">
        <table className="w-full text-left border-collapse min-w-[560px]">
          <thead>
            <tr className="border-b border-border/30 bg-muted/30">
              <th className="p-3 text-xs font-semibold text-muted-foreground uppercase text-left pl-4 w-[35%]">
                {t('engine.name')}
              </th>
              <th className="p-3 text-xs font-semibold text-muted-foreground uppercase text-center w-[20%]">
                {t('engine.type')}
              </th>
              <th className="p-3 text-xs font-semibold text-muted-foreground uppercase text-center w-[20%]">
                性能评级
              </th>
              <th className="p-3 text-xs font-semibold text-muted-foreground uppercase text-right pr-4 w-[25%]">
                {t('engine.action')}
              </th>
            </tr>
          </thead>
          <tbody>
            {safeEngineList.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-8 text-center text-xs text-muted-foreground">
                  <Loader2 className="h-4.5 w-4.5 animate-spin mx-auto mb-2 text-primary" />
                  正在扫描已安装计算引擎...
                </td>
              </tr>
            ) : (
              safeEngineList.map(item => {
                const isCurrent = item.backend === currentBackend
                const isSwitching = switchingBackend === item.backend
                const isDownloadingThis = downloadState.isDownloading && downloadState.currentBackend === item.backend

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

                    {/* 性能利用说明 */}
                    <td className="p-3 text-xs text-center text-muted-foreground/90 font-medium">
                      {item.performance}
                    </td>

                    {/* 操作按钮 / 状态 */}
                    <td className="p-3 pr-4 text-right align-middle">
                      {isCurrent ? (
                        <Badge className="bg-primary/90 text-primary-foreground font-bold px-2.5 py-1 rounded-full shadow-xs text-xs whitespace-nowrap">
                          <Check className="h-3 w-3 mr-1 shrink-0" />
                          {t('engine.btnActive')}
                        </Badge>
                      ) : isDownloadingThis ? (
                        <div className="inline-flex flex-col items-end gap-1 min-w-[130px]">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                            <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                            <span>
                              {downloadState.status === 'extracting'
                                ? '校验解压中...'
                                : `下载中 ${downloadState.progress}%`}
                            </span>
                          </div>
                          <Progress value={downloadState.progress} className="h-1.5 w-28" />
                          {downloadState.speedBps > 0 && (
                            <span className="text-[10px] font-mono text-muted-foreground">
                              {formatSpeed(downloadState.speedBps)}
                            </span>
                          )}
                        </div>
                      ) : !item.isInstalled ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-7.5 font-bold text-xs px-3 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 shrink-0"
                          disabled={downloadState.isDownloading}
                          onClick={() => startDownload(item.backend)}
                        >
                          <Download className="h-3 w-3 mr-1 shrink-0" />
                          {t('engine.btnDownload')} {item.downloadSizeMb ? `(${item.downloadSizeMb}MB)` : ''}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7.5 font-bold text-xs px-3.5 rounded-lg border-border/40 hover:border-primary/40 hover:bg-primary/10 hover:text-primary transition-all shrink-0"
                          disabled={isSwitching || downloadState.isDownloading}
                          onClick={() => switchEngine(item.backend)}
                        >
                          {isSwitching ? (
                            <>
                              <Loader2 className="h-3 w-3 animate-spin mr-1 shrink-0" />
                              切换中...
                            </>
                          ) : (
                            t('engine.btnEnable')
                          )}
                        </Button>
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

