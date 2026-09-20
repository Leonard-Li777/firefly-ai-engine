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

export const EngineTable: React.FC = () => {
  const { engineList, fetchEngineList, switchEngine, switchingBackend, engineStatus } = useEngineStore()
  const { state: downloadState, startDownload } = useEngineDownload()

  useEffect(() => {
    fetchEngineList()
  }, [fetchEngineList])

  const currentBackend = engineStatus?.active_backend || 'vulkan'

  return (
    <Card className="p-6 border-border/70 rounded-3xl bg-card shadow-sm space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1">
        <div>
          <Label className="text-base font-black tracking-tight text-foreground flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            <span>AI 计算引擎管理与动态切换</span>
          </Label>
          <p className="text-xs text-muted-foreground font-medium mt-1">
            原生支持多套高性能后端，可根据显卡硬件特性无缝切换算力模式或按需扩展
          </p>
        </div>
        <Badge variant="outline" className="text-[11px] font-black h-6 self-start sm:self-auto">
          基准端口: {engineStatus?.port || 38400}
        </Badge>
      </div>

      {/* 引擎列表表格 */}
      <div className="border border-border/60 rounded-2xl overflow-hidden bg-background/50">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border/70 bg-muted/40">
              <th className="p-3.5 text-xs font-black text-muted-foreground uppercase text-left pl-5">AI 引擎</th>
              <th className="p-3.5 text-xs font-black text-muted-foreground uppercase text-center">适配类型</th>
              <th className="p-3.5 text-xs font-black text-muted-foreground uppercase text-center">性能说明</th>
              <th className="p-3.5 text-xs font-black text-muted-foreground uppercase text-right pr-6">操作 / 状态</th>
            </tr>
          </thead>
          <tbody>
            {engineList.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-8 text-center text-xs text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2 text-primary" />
                  正在扫描已安装计算引擎...
                </td>
              </tr>
            ) : (
              engineList.map(item => {
                const isCurrent = item.backend === currentBackend
                const isSwitching = switchingBackend === item.backend
                const isDownloadingThis = downloadState.isDownloading && downloadState.currentBackend === item.backend

                return (
                  <tr
                    key={item.id}
                    className={`border-b last:border-0 border-border/40 transition-colors ${
                      isCurrent ? 'bg-primary/5 dark:bg-primary/10 font-semibold' : 'hover:bg-muted/20'
                    }`}
                  >
                    {/* 引擎名称 */}
                    <td className="p-3.5 pl-5 text-sm">
                      <div className="flex items-center gap-2.5">
                        <div
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                            isCurrent
                              ? 'bg-primary text-primary-foreground shadow-xs'
                              : 'bg-muted text-muted-foreground/80'
                          }`}
                        >
                          <Cpu className="h-4 w-4" />
                        </div>
                        <div className="flex flex-col">
                          <span className="font-black text-foreground">{item.name}</span>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            backend: {item.backend}
                          </span>
                        </div>
                      </div>
                    </td>

                    {/* 适配类型 */}
                    <td className="p-3.5 text-center align-middle">
                      <Badge
                        variant={
                          item.matchType === 'best'
                            ? 'success'
                            : item.matchType === 'compatible'
                              ? 'warning'
                              : 'outline'
                        }
                      >
                        {item.matchText}
                      </Badge>
                    </td>

                    {/* 性能利用说明 */}
                    <td className="p-3.5 text-xs text-center text-muted-foreground font-bold">
                      {item.performance}
                    </td>

                    {/* 操作按钮 / 状态 */}
                    <td className="p-3.5 pr-6 text-right align-middle">
                      {isCurrent ? (
                        <Badge className="bg-primary text-primary-foreground font-black px-3 py-1 rounded-full shadow-xs">
                          <Check className="h-3.5 w-3.5 mr-1" />
                          当前运行中
                        </Badge>
                      ) : isDownloadingThis ? (
                        <div className="inline-flex flex-col items-end gap-1 min-w-[140px]">
                          <div className="flex items-center gap-2 text-xs font-bold text-primary">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <span>
                              {downloadState.status === 'extracting'
                                ? '校验解压中...'
                                : `下载中 ${downloadState.progress}%`}
                            </span>
                          </div>
                          <Progress value={downloadState.progress} className="h-1.5 w-32" />
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
                          className="h-8 font-black text-xs px-3.5 rounded-xl bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20"
                          disabled={downloadState.isDownloading}
                          onClick={() => startDownload(item.backend)}
                        >
                          <Download className="h-3.5 w-3.5 mr-1.5" />
                          下载 {item.downloadSizeMb ? `(${item.downloadSizeMb}MB)` : ''}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 font-black text-xs px-4 rounded-xl border-border hover:border-primary/40 hover:bg-primary/10 hover:text-primary transition-all"
                          disabled={isSwitching || downloadState.isDownloading}
                          onClick={() => switchEngine(item.backend)}
                        >
                          {isSwitching ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                              切换中...
                            </>
                          ) : (
                            '启用'
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
