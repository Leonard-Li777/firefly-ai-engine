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

interface ModelCardProps {
  model: ModelItem
  isCurrent: boolean
}

const ModelCardItem: React.FC<ModelCardProps> = ({ model, isCurrent }) => {
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
    <Card className="p-5 border-border/70 rounded-2xl bg-card/60 backdrop-blur-xs flex flex-col justify-between hover:border-primary/40 transition-all shadow-xs">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-black text-foreground">{model.name}</h4>
            {model.isMultiModal && (
              <Badge variant="info" className="text-[10px] h-4.5 px-1.5 py-0 font-bold flex items-center gap-1">
                <Eye className="h-3 w-3" />
                多模态视觉
              </Badge>
            )}
          </div>
          <Badge variant="outline" className="text-[10px] font-mono uppercase">
            {model.quant}
          </Badge>
        </div>

        <p className="text-xs text-muted-foreground font-medium mt-1.5 leading-relaxed line-clamp-2">
          {model.description}
        </p>

        <div className="flex items-center gap-3 text-[11px] font-mono text-muted-foreground/80 mt-3 pt-3 border-t border-border/40">
          <span>大小: <strong>{formatFileSize(model.fileSize)}</strong></span>
          <span>•</span>
          <span>参数量: <strong>{model.params}</strong></span>
          <span>•</span>
          <span className="uppercase">源: {model.source}</span>
        </div>
      </div>

      {/* 底部操作与下载状态 */}
      <div className="mt-4 pt-3 border-t border-border/40">
        {dl.isDownloading || dl.isPaused ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-bold">
              <span className="text-primary truncate max-w-[200px]" title={dl.currentFileName}>
                {dl.totalFiles && dl.totalFiles > 1
                  ? `[${(dl.fileIndex || 0) + 1}/${dl.totalFiles}] ${dl.currentFileName}`
                  : dl.currentFileName || '正在下载...'}
              </span>
              <span className="font-mono">{dl.progress}%</span>
            </div>

            <Progress value={dl.progress} className="h-2" />

            <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono">
              <span>
                {formatFileSize(dl.receivedBytes)} / {formatFileSize(dl.totalBytes || model.fileSize)}
              </span>
              <div className="flex items-center gap-2">
                {dl.speedBps > 0 && <span className="text-foreground font-bold">{formatSpeed(dl.speedBps)}</span>}
                {remainingText && <span>{remainingText}</span>}
              </div>
            </div>

            {/* 控制按钮 */}
            <div className="flex items-center justify-end gap-1.5 pt-1">
              {dl.isPaused ? (
                <Button size="sm" variant="outline" className="h-7 text-xs px-2.5 rounded-lg" onClick={resumeDownload}>
                  <Play className="h-3 w-3 mr-1" />
                  继续
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="h-7 text-xs px-2.5 rounded-lg" onClick={pauseDownload}>
                  <Pause className="h-3 w-3 mr-1" />
                  暂停
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-7 text-xs px-2.5 rounded-lg text-destructive" onClick={cancelDownload}>
                <X className="h-3 w-3 mr-1" />
                取消
              </Button>
            </div>
          </div>
        ) : dl.status === 'error' ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-destructive truncate">{dl.error || '下载失败'}</span>
            <Button size="sm" variant="outline" className="h-8 text-xs rounded-xl" onClick={retryDownload}>
              <RotateCw className="h-3.5 w-3.5 mr-1" />
              重试
            </Button>
          </div>
        ) : isDownloaded ? (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 text-xs font-black">
              <FileCheck2 className="h-4 w-4" />
              <span>已下载就绪</span>
            </div>
            {isCurrent ? (
              <Badge className="bg-primary text-primary-foreground font-black px-3 py-1 rounded-full text-xs">
                <Check className="h-3.5 w-3.5 mr-1" />
                当前生效模型
              </Badge>
            ) : (
              <Button size="sm" variant="secondary" className="h-8 text-xs px-3.5 rounded-xl font-bold">
                设为生效模型
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground font-medium">尚未下载到本地</span>
            <Button
              size="sm"
              variant="default"
              className="h-8 text-xs px-4 rounded-xl font-black shadow-xs"
              onClick={() => startDownload()}
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              下载模型
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}

export const ModelListPanel: React.FC = () => {
  const { models, fetchModels, engineStatus, regionInfo } = useEngineStore()
  const [activeSource, setActiveSource] = useState<ModelSource>('modelscope')

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  const filteredModels = models.filter(m => m.source === activeSource)

  return (
    <Card className="p-6 border-border/70 rounded-3xl bg-card shadow-sm space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2">
        <div>
          <Label className="text-base font-black tracking-tight text-foreground flex items-center gap-2">
            <Boxes className="h-4 w-4 text-primary" />
            <span>双轨模型生态与智能加速下载</span>
          </Label>
          <p className="text-xs text-muted-foreground font-medium mt-1">
            支持 ModelScope（魔搭国内镜像直连）与 HuggingFace 双轨源，支持断点续传与 SHA256 完整性校验
          </p>
        </div>

        {/* 生效镜像指示器 */}
        <Badge
          variant={regionInfo?.region === 'cn' ? 'success' : 'info'}
          className="text-[10px] font-black h-6 self-start sm:self-auto flex items-center gap-1"
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
        <TabsList className="grid w-full sm:w-[320px] grid-cols-2">
          <TabsTrigger value="modelscope" className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <span>ModelScope (国内推荐)</span>
          </TabsTrigger>
          <TabsTrigger value="huggingface" className="flex items-center gap-1.5">
            <Globe2 className="h-3.5 w-3.5" />
            <span>HuggingFace (官方/镜像)</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value={activeSource} className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
