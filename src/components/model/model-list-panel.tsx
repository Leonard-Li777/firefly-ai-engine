import React, { useState, useEffect } from 'react'
import {
  Boxes,
  Download,
  Check,
  Pause,
  Play,
  X,
  RotateCw,
  Sparkles,
  Eye,
  FileCheck2,
  Globe2
} from 'lucide-react'
import { Card } from '../ui/card'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import { Label } from '../ui/label'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs'
import { useEngineStore } from '../../stores/engine-store'
import { useModelDownload } from '../../hooks/use-model-download'
import { ModelItem, ModelSource } from '../../api/types'
import { formatFileSize, formatSpeed, calculateRemainingTime } from '../../lib/utils'
import { useI18nStore } from '../../lib/i18n'

interface ModelCardProps {
  model: ModelItem
  isCurrent: boolean
}

const ModelCardItem: React.FC<ModelCardProps> = ({ model, isCurrent }) => {
  const { t } = useI18nStore()
  const { fetchModels } = useEngineStore()
  const {
    state: dl,
    startDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    retryDownload
  } = useModelDownload(model.id, {
    source: model.source,
    onDownloadComplete: () => {
      fetchModels()
    }
  })

  // 剩余时间文字
  const remainingTime = calculateRemainingTime(dl.receivedBytes, dl.totalBytes, dl.speedBps)
  let remainingText = ''
  if (remainingTime.kind === 'seconds') remainingText = `剩余约 ${remainingTime.value} 秒`
  else if (remainingTime.kind === 'minutes')
    remainingText = `剩余约 ${remainingTime.value} 分 ${remainingTime.seconds || 0} 秒`
  else if (remainingTime.kind === 'hours')
    remainingText = `剩余约 ${remainingTime.value} 小时`

  const isDownloaded = model.isDownloaded || dl.status === 'completed'

  return (
    <Card className="p-4 border-border/30 rounded-xl bg-card/60 backdrop-blur-xs flex flex-col justify-between hover:border-border/60 transition-all shadow-xs">
      <div>
        <div className="flex items-start justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <h4 className="text-sm font-bold text-foreground truncate">{model.name}</h4>
            {model.isMultiModal && (
              <Badge variant="info" className="text-[10px] h-4.5 px-1.5 py-0 font-semibold flex items-center gap-1 shrink-0">
                <Eye className="h-3 w-3" />
                {t('models.tagMultimodal')}
              </Badge>
            )}
          </div>
          <Badge variant="outline" className="text-[10px] font-mono uppercase shrink-0 border-border/40">
            {model.quant}
          </Badge>
        </div>

        <p className="text-xs text-muted-foreground/80 font-normal mt-1.5 leading-relaxed line-clamp-2">
          {model.description}
        </p>

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] font-mono text-muted-foreground/80 mt-3 pt-2.5 border-t border-border/30">
          <span>大小: <strong>{formatFileSize(model.fileSize)}</strong></span>
          <span>•</span>
          <span>参数: <strong>{model.params}</strong></span>
          <span>•</span>
          <span className="uppercase">源: {model.source}</span>
        </div>
      </div>

      {/* 底部操作与下载状态 */}
      <div className="mt-3.5 pt-2.5 border-t border-border/30">
        {dl.isDownloading || dl.isPaused ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span className="text-primary truncate max-w-[180px]" title={dl.currentFileName}>
                {dl.totalFiles && dl.totalFiles > 1
                  ? `[${(dl.fileIndex || 0) + 1}/${dl.totalFiles}] ${dl.currentFileName}`
                  : dl.currentFileName || '正在下载...'}
              </span>
              <span className="font-mono text-[11px]">{dl.progress}%</span>
            </div>

            <Progress value={dl.progress} className="h-1.5" />

            <div className="flex flex-wrap items-center justify-between text-[10px] text-muted-foreground font-mono gap-1">
              <span>
                {formatFileSize(dl.receivedBytes)} / {formatFileSize(dl.totalBytes || model.fileSize)}
              </span>
              <div className="flex items-center gap-1.5">
                {dl.speedBps > 0 && <span className="text-foreground font-bold">{formatSpeed(dl.speedBps)}</span>}
                {remainingText && <span>{remainingText}</span>}
              </div>
            </div>

            {/* 控制按钮 */}
            <div className="flex items-center justify-end gap-1.5 pt-1">
              {dl.isPaused ? (
                <Button size="sm" variant="outline" className="h-7 text-xs px-2 rounded-lg" onClick={resumeDownload}>
                  <Play className="h-3 w-3 mr-1" />
                  继续
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="h-7 text-xs px-2 rounded-lg" onClick={pauseDownload}>
                  <Pause className="h-3 w-3 mr-1" />
                  暂停
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-7 text-xs px-2 rounded-lg text-destructive" onClick={cancelDownload}>
                <X className="h-3 w-3 mr-1" />
                取消
              </Button>
            </div>
          </div>
        ) : dl.status === 'error' ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-destructive truncate">{dl.error || '下载失败'}</span>
            <Button size="sm" variant="outline" className="h-7.5 text-xs rounded-lg border-border/40" onClick={retryDownload}>
              <RotateCw className="h-3 w-3 mr-1" />
              重试
            </Button>
          </div>
        ) : isDownloaded ? (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-xs font-bold">
              <FileCheck2 className="h-3.5 w-3.5 shrink-0" />
              <span>已就绪</span>
            </div>
            {isCurrent ? (
              <Badge className="bg-primary/90 text-primary-foreground font-bold px-2.5 py-1 rounded-full text-xs">
                <Check className="h-3 w-3 mr-1 shrink-0" />
                {t('models.btnRunning')}
              </Badge>
            ) : (
              <Button size="sm" variant="secondary" className="h-7.5 text-xs px-3 rounded-lg font-bold">
                设为生效
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground/70 font-medium">尚未下载到本地</span>
            <Button
              size="sm"
              variant="default"
              className="h-7.5 text-xs px-3.5 rounded-lg font-bold shadow-xs shrink-0"
              onClick={() => startDownload()}
            >
              <Download className="h-3 w-3 mr-1.5 shrink-0" />
              {t('models.btnDownload')}
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}

export const ModelListPanel: React.FC = () => {
  const { t } = useI18nStore()
  const { models, fetchModels, engineStatus, regionInfo } = useEngineStore()
  const [activeSource, setActiveSource] = useState<ModelSource>('modelscope')

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  const safeModels = Array.isArray(models) ? models : []
  const filteredModels = safeModels.filter(m => m && m.source === activeSource)

  return (
    <Card className="p-5 border-border/30 rounded-xl bg-card shadow-xs space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2">
        <div>
          <Label className="text-base font-bold tracking-tight text-foreground flex items-center gap-2">
            <Boxes className="h-4 w-4 text-primary" />
            <span>{t('models.title')}</span>
          </Label>
          <p className="text-xs text-muted-foreground/80 font-normal mt-1 leading-relaxed">
            支持 ModelScope（魔搭国内镜像直连）与 HuggingFace 双轨源，支持断点续传与 SHA256 完整性校验
          </p>
        </div>

        {/* 生效镜像指示器 */}
        <Badge
          variant={regionInfo?.region === 'cn' ? 'success' : 'info'}
          className="text-[10px] font-semibold h-6 self-start sm:self-auto flex items-center gap-1 shrink-0"
        >
          <Globe2 className="h-3 w-3" />
          <span>
            {regionInfo?.region === 'cn'
              ? '当前已生效国内高速加速源'
              : '当前生效海外官方源'}
          </span>
        </Badge>
      </div>

      <Tabs value={activeSource} onValueChange={val => setActiveSource(val as ModelSource)}>
        <TabsList className="flex flex-wrap h-auto w-full sm:w-auto p-1 gap-1">
          <TabsTrigger value="modelscope" className="flex items-center gap-1.5 h-8 px-3 rounded-lg">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <span>ModelScope (国内推荐)</span>
          </TabsTrigger>
          <TabsTrigger value="huggingface" className="flex items-center gap-1.5 h-8 px-3 rounded-lg">
            <Globe2 className="h-3.5 w-3.5" />
            <span>HuggingFace (国际官方)</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value={activeSource} className="mt-3.5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {filteredModels.map(model => (
              <ModelCardItem
                key={model.id}
                model={model}
                isCurrent={engineStatus?.current_model.toLowerCase().includes(model.name.toLowerCase().split(' ')[0]) || false}
              />
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </Card>
  )
}

