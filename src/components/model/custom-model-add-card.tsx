import React, { useState, useRef, useEffect, useMemo } from 'react'
import {
  Plus,
  Link2,
  Loader2,
  AlertCircle,
  CheckCircle2,
  X,
  Download,
  FileCheck2,
  HardDrive,
  Trash2,
  Settings2,
  Play,
  Pause,
  RotateCw,
  Power,
  Globe2,
  Tag
} from 'lucide-react'
import { Card } from '../ui/card'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Badge } from '../ui/badge'
import { Progress } from '../ui/progress'
import { useEngineStore } from '../../stores/engine-store'
import { useModelDownload } from '../../hooks/use-model-download'
import { ModelItem } from '../../api/types'
import { formatFileSize, formatSpeed, calculateRemainingTime } from '../../lib/utils'
import { getDisplayRelativeModelPath } from '../../lib/path-utils'
import { ModelResolver } from '../../lib/model-resolver'
import { ModelParamDrawer } from './model-param-drawer'
import { t } from '../../languages'
import { toast } from '../common/Toast'

/** 三种受支持的模型地址示例（modelscope file/view、huggingface blob、huggingface resolve） */
const SUPPORTED_URL_EXAMPLES = [
  'https://modelscope.cn/models/Abiray/Qwen-Image-2.1-GGUF/file/view/master/qwen_image_2.1_Q4_K_S.gguf',
  'https://huggingface.co/HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF/blob/main/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf',
  'https://huggingface.co/HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF/resolve/main/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q3_K_P.gguf'
]

interface CustomModelRowProps {
  model: ModelItem
  onOpenConfig: (model: ModelItem) => void
}

/** 单行自定义模型条目：展示来源 Badge、名称、参数、下载进度、已就绪状态、启动与高级管理操作 */
const CustomModelRowItem: React.FC<CustomModelRowProps> = ({ model, onOpenConfig }) => {
  const { fetchModels, modelsDir, engineStatus, activateAndStart, removeCustomModel, deleteModel, activeModelKey } =
    useEngineStore()

  const handleDownloadComplete = React.useCallback(() => {
    fetchModels()
  }, [fetchModels])

  const dlOptions = useMemo(
    () => ({
      source: model.source,
      quantization: model.quantization,
      isDownloaded: model.isDownloaded,
      onDownloadComplete: handleDownloadComplete
    }),
    [model.source, model.quantization, model.isDownloaded, handleDownloadComplete]
  )

  const {
    state: dl,
    startDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    retryDownload,
    resetDownload
  } = useModelDownload(model.id, dlOptions)

  const isDownloaded = Boolean(model.isDownloaded || dl.status === 'completed')
  const isDownloadingOrPaused = dl.isDownloading || dl.isPaused

  // 物理本地路径与相对路径解析
  const resolvedLocalPath = useMemo(() => {
    let lp = model.localPath
    if (!lp && isDownloaded && modelsDir) {
      const resolution = ModelResolver.resolve(model.id, modelsDir, undefined, model.source)
      if (resolution?.modelPath) lp = resolution.modelPath
    }
    return lp
  }, [model.localPath, isDownloaded, modelsDir, model.id, model.source])

  const displayRelativePath = useMemo(() => {
    return getDisplayRelativeModelPath(resolvedLocalPath, modelsDir)
  }, [resolvedLocalPath, modelsDir])

  // 启动与激活状态判定
  const [isStartLaunching, setIsStartLaunching] = useState(false)
  const isEngineReady = engineStatus?.status === 'ready' || engineStatus?.status === 'processing'
  const isEngineStarting = engineStatus?.status === 'starting' || engineStatus?.status === 'model_loading'
  const modelKey = `${model.id}@${model.source}`
  const isActiveModel =
    isDownloaded &&
    (activeModelKey === modelKey ||
      (engineStatus?.current_model ? engineStatus.current_model.includes(model.id) : false))
  const isModelRunning = isActiveModel && isEngineReady
  const isModelLaunching = isStartLaunching || (isActiveModel && isEngineStarting)

  const handleActivateAndStart = async () => {
    try {
      setIsStartLaunching(true)
      await activateAndStart(model.id, model.source, resolvedLocalPath, model.name, model.isEmbedding)
    } finally {
      setIsStartLaunching(false)
    }
  }

  // 高级操作与确认
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const [isDeleteConfirm, setIsDeleteConfirm] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleRemove = async () => {
    try {
      setIsDeleting(true)
      const ok = await removeCustomModel(model.id)
      if (ok) {
        resetDownload()
        setIsDeleteConfirm(false)
        setIsAdvancedOpen(false)
      }
    } finally {
      setIsDeleting(false)
    }
  }

  const handleDelete = async () => {
    try {
      setIsDeleting(true)
      const ok = await deleteModel(model.id, resolvedLocalPath || model.localPath)
      if (ok) {
        resetDownload()
        setIsDeleteConfirm(false)
        setIsAdvancedOpen(false)
      }
    } finally {
      setIsDeleting(false)
    }
  }

  // 剩余下载时间
  const remainingTime = calculateRemainingTime(dl.receivedBytes, dl.totalBytes, dl.speedBps)
  let remainingText = ''
  if (remainingTime.kind === 'seconds') {
    remainingText = t('剩余约 {value} 秒', { value: remainingTime.value ?? 0 })
  } else if (remainingTime.kind === 'minutes') {
    remainingText = t('剩余约 {value} 分 {seconds} 秒', {
      value: remainingTime.value ?? 0,
      seconds: remainingTime.seconds ?? 0
    })
  } else if (remainingTime.kind === 'hours') {
    remainingText = t('剩余约 {value} 小时', { value: remainingTime.value ?? 0 })
  }

  const isModelScope = model.source === 'modelscope'

  return (
    <div
      data-custom-model-id={model.id}
      className="p-4 rounded-xl border border-border/50 bg-background/50 hover:bg-muted/20 transition-colors space-y-2.5"
    >
      {/* 顶部主信息行：来源 Badge + 名称 + 关键指标 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Badge
            variant="outline"
            className={`text-[10px] font-bold h-5 px-1.5 shrink-0 border ${
              isModelScope
                ? 'border-blue-500/40 text-blue-600 dark:text-blue-400 bg-blue-500/10'
                : 'border-purple-500/40 text-purple-600 dark:text-purple-400 bg-purple-500/10'
            }`}
          >
            <Globe2 className="h-3 w-3 mr-1 shrink-0" />
            {isModelScope ? 'ModelScope' : 'Hugging Face'}
          </Badge>
          <span className="font-bold text-sm text-foreground truncate" title={model.name}>
            {model.name}
          </span>
        </div>

        {/* 规格标签：量化、大小、预估显存 */}
        <div className="flex items-center gap-2 text-xs font-mono shrink-0">
          {model.quant && (
            <Badge variant="secondary" className="text-[10px] h-5 px-1.5 font-bold">
              {model.quant}
            </Badge>
          )}
          <span className="text-muted-foreground tabular-nums">
            {model.size || (model.fileSize > 0 ? formatFileSize(model.fileSize) : '-')}
          </span>
          {model.vramNeededGB && (
            <span className="text-blue-600 dark:text-blue-400 font-bold tabular-nums">
              ~{model.vramNeededGB} GB
            </span>
          )}
        </div>
      </div>

      {/* 相对存储路径（已就绪展示） */}
      {isDownloaded && displayRelativePath && (
        <div className="flex items-start gap-1 text-[11px] font-mono text-muted-foreground min-w-0">
          <HardDrive className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground/70" />
          <span className="break-all select-all" title={displayRelativePath}>
            {displayRelativePath}
          </span>
        </div>
      )}

      {/* 状态与控制操作行 */}
      <div className="flex items-center justify-between gap-2 pt-1">
        {/* 左侧状态文本 */}
        <div>
          {isDownloadingOrPaused ? (
            <span
              className={`font-mono text-xs font-bold tabular-nums ${
                dl.isPaused ? 'text-amber-600 dark:text-amber-400' : 'text-primary'
              }`}
            >
              {dl.isPaused
                ? t('已暂停')
                : dl.status === 'pending'
                  ? t('准备下载中...')
                  : `${t('正在下载')} ${dl.progress}%`}
            </span>
          ) : dl.status === 'error' ? (
            <span className="text-xs font-semibold text-destructive truncate" title={dl.error || undefined}>
              {dl.error || t('下载失败')}
            </span>
          ) : isDownloaded ? (
            <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 text-xs font-bold">
              <FileCheck2 className="h-3.5 w-3.5 shrink-0" />
              <span>{t('已就绪')}</span>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground/70 font-medium">{t('尚未下载到本地')}</span>
          )}
        </div>

        {/* 右侧操作按钮组 */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* 高级操作收纳：移除记录 / 删除文件 / 参数配置 */}
          {!isDownloadingOrPaused && dl.status !== 'error' && (
            isDeleteConfirm ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs px-2.5 rounded-lg border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20 font-bold shrink-0"
                  onClick={isDownloaded ? handleDelete : handleRemove}
                  disabled={isDeleting}
                >
                  <Trash2 className="h-3 w-3 mr-1 shrink-0" />
                  {isDeleting ? t('处理中...') : isDownloaded ? t('确认删除') : t('确认移除')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs px-2.5 rounded-lg font-bold text-muted-foreground shrink-0"
                  onClick={() => setIsDeleteConfirm(false)}
                  disabled={isDeleting}
                >
                  {t('取消')}
                </Button>
              </>
            ) : isAdvancedOpen ? (
              <>
                {isDownloaded ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs px-2.5 rounded-lg font-bold text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 shrink-0"
                    title={t('删除物理模型文件，释放磁盘空间')}
                    onClick={() => setIsDeleteConfirm(true)}
                  >
                    <Trash2 className="h-3 w-3 mr-1 shrink-0" />
                    {t('删除')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs px-2.5 rounded-lg font-bold text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 shrink-0"
                    title={t('移除此自定义模型记录')}
                    onClick={() => setIsDeleteConfirm(true)}
                  >
                    <Trash2 className="h-3 w-3 mr-1 shrink-0" />
                    {t('移除')}
                  </Button>
                )}
                {isDownloaded && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs px-2.5 rounded-lg border-border hover:border-primary/60 font-bold flex items-center gap-1 transition-all shrink-0"
                    onClick={() => onOpenConfig(model)}
                  >
                    <Settings2 className="h-3 w-3 text-primary shrink-0" />
                    <span>{t('参数配置')}</span>
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs px-2.5 rounded-lg font-bold text-muted-foreground shrink-0"
                  onClick={() => setIsAdvancedOpen(false)}
                >
                  {t('收起')}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs px-2.5 rounded-lg font-bold text-muted-foreground/60 hover:text-foreground shrink-0 opacity-80 hover:opacity-100"
                onClick={() => setIsAdvancedOpen(true)}
              >
                <Settings2 className="h-3 w-3 mr-1 shrink-0" />
                {t('高级')}
              </Button>
            )
          )}

          {/* 下载状态控制按钮 */}
          {isDownloadingOrPaused ? (
            <>
              {dl.isPaused ? (
                <Button size="sm" variant="outline" className="h-7 text-xs px-2.5 rounded-lg font-bold" onClick={resumeDownload}>
                  <Play className="h-3 w-3 mr-1" />
                  {t('继续')}
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="h-7 text-xs px-2.5 rounded-lg font-bold" onClick={pauseDownload}>
                  <Pause className="h-3 w-3 mr-1" />
                  {t('暂停')}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs px-2.5 rounded-lg font-bold text-destructive hover:bg-destructive/10"
                onClick={cancelDownload}
              >
                <X className="h-3 w-3 mr-1" />
                {t('取消')}
              </Button>
            </>
          ) : dl.status === 'error' ? (
            <Button size="sm" variant="outline" className="h-7 text-xs px-2.5 rounded-lg border-border font-bold" onClick={retryDownload}>
              <RotateCw className="h-3 w-3 mr-1" />
              {t('重试')}
            </Button>
          ) : isDownloaded ? (
            /* 已就绪：启动控制 */
            isModelRunning ? (
              <Badge className="h-7 text-xs px-2.5 rounded-lg font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 shrink-0 flex items-center gap-1.5">
                <Play className="h-3 w-3 shrink-0 fill-current" />
                {t('已启动')}
              </Badge>
            ) : isModelLaunching ? (
              <Badge className="h-7 text-xs px-2.5 rounded-lg font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 shrink-0 flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                {t('启动中...')}
              </Badge>
            ) : (
              <Button
                size="sm"
                variant="default"
                className="h-7 text-xs px-3 rounded-lg font-bold shadow-xs shrink-0"
                onClick={handleActivateAndStart}
                disabled={isStartLaunching}
              >
                <Power className="h-3 w-3 mr-1 shrink-0" />
                {isStartLaunching ? t('启动中...') : t('激活并启动')}
              </Button>
            )
          ) : (
            /* 未下载：下载按钮 */
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs px-3 rounded-lg font-bold border-border hover:border-primary/60 shrink-0"
              onClick={() => startDownload()}
            >
              <Download className="h-3 w-3 mr-1 shrink-0" />
              {t('下载模型')}
            </Button>
          )}
        </div>
      </div>

      {/* 下载进度条与速度子区块 */}
      {isDownloadingOrPaused && (
        <div className="pt-1 space-y-1">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span
              className={`truncate max-w-[280px] ${
                dl.isPaused ? 'text-amber-600 dark:text-amber-400' : 'text-primary'
              }`}
            >
              {dl.currentFileName || (dl.status === 'pending' ? t('准备中...') : t('下载中...'))}
            </span>
            <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
              <span>
                {formatFileSize(dl.receivedBytes)} / {formatFileSize(dl.totalBytes || model.fileSize)}
              </span>
              {!dl.isPaused && dl.speedBps > 0 && (
                <span className="text-foreground font-bold">{formatSpeed(dl.speedBps)}</span>
              )}
              {!dl.isPaused && remainingText && <span>{remainingText}</span>}
            </div>
          </div>
          <Progress value={dl.progress} className={`h-1.5 ${dl.isPaused ? 'opacity-70' : ''}`} />
        </div>
      )}
    </div>
  )
}

/**
 * 「增加任意模型」卡片：
 * 1. 顶部提供通栏展开输入行，提交托管站点模型文件地址进行后端网络嗅探；
 * 2. 下方直接展示用户已添加的全部自定义模型（不区分 ModelScope / HuggingFace Tab），并支持下载/启动/配置/移除。
 */
export const CustomModelAddCard: React.FC = () => {
  const { models, addCustomModel } = useEngineStore()

  // 展开输入行状态
  const [expanded, setExpanded] = useState(false)
  const [url, setUrl] = useState('')
  const [sniffing, setSniffing] = useState(false)
  const [feedback, setFeedback] = useState<{ type: 'error' | 'success'; message: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 模型专属参数侧边栏抽屉状态
  const [drawerModel, setDrawerModel] = useState<ModelItem | null>(null)

  // 筛选出所有用户自定义模型（不分 Tab，统一展示）
  const customModels = useMemo(() => {
    return Array.isArray(models) ? models.filter(m => Boolean(m && m.custom)) : []
  }, [models])

  useEffect(() => {
    if (expanded) {
      inputRef.current?.focus()
    }
  }, [expanded])

  const resetPanel = () => {
    setExpanded(false)
    setUrl('')
    setFeedback(null)
    setSniffing(false)
  }

  const handleSubmit = async () => {
    const trimmed = url.trim()
    if (!trimmed || sniffing) return
    setSniffing(true)
    setFeedback(null)
    const res = await addCustomModel(trimmed)
    setSniffing(false)
    if (res.ok) {
      toast.success(t('已成功添加到自定义模型列表中'))
      setFeedback({ type: 'success', message: t('嗅探完成，已加入下方自定义模型列表') })
      setUrl('')
    } else {
      setFeedback({ type: 'error', message: res.error || t('添加模型失败') })
    }
  }

  return (
    <Card className="p-0 overflow-hidden border border-border/70 rounded-2xl bg-card shadow-xs">
      {/* 头部说明与数量角标 */}
      <div className="p-5 border-b border-border/40 flex items-center justify-between gap-3">
        <div>
          <Label className="text-base font-bold tracking-tight text-foreground flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary" />
            <span>{t('增加任意模型')}</span>
          </Label>
          <p className="text-xs text-muted-foreground font-normal mt-1 leading-relaxed">
            {t('自由添加 ModelScope / HuggingFace 托管的任意 GGUF 模型文件，保存在本地配置并集中管理。')}
          </p>
        </div>
        {customModels.length > 0 && (
          <Badge variant="secondary" className="font-mono text-xs font-bold px-2 py-0.5 shrink-0">
            {customModels.length} {t('个自定义模型')}
          </Badge>
        )}
      </div>

      <div className="p-5 space-y-5">
        {/* 输入添加区 */}
        {!expanded ? (
          /* 收起态：通栏添加按钮 */
          <Button
            variant="outline"
            className="w-full h-10 rounded-xl border-dashed border-border/70 text-sm font-bold text-foreground/80 hover:border-primary/60 hover:text-primary gap-2"
            onClick={() => setExpanded(true)}
          >
            <Plus className="h-4 w-4 shrink-0" />
            <span>{t('自由添加指定模型')}</span>
          </Button>
        ) : (
          /* 展开态：输入行 + 三种格式示例说明 */
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Input
                ref={inputRef}
                value={url}
                disabled={sniffing}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleSubmit()
                  } else if (e.key === 'Escape') {
                    resetPanel()
                  }
                }}
                placeholder="https://modelscope.cn/models/Abiray/Qwen-Image-2.1-GGUF/file/view/master/qwen_image_2.1_Q4_K_S.gguf"
                className="h-10 flex-1 text-sm font-mono placeholder:font-sans placeholder:text-muted-foreground/60"
              />
              <Button
                size="sm"
                className="h-10 px-4 rounded-lg font-bold shrink-0 gap-1.5"
                disabled={sniffing || !url.trim()}
                onClick={() => void handleSubmit()}
              >
                {sniffing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                    <span>{t('嗅探中...')}</span>
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4 shrink-0" />
                    <span>{t('添加并嗅探')}</span>
                  </>
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-10 w-10 p-0 rounded-lg shrink-0 text-muted-foreground"
                disabled={sniffing}
                onClick={resetPanel}
                aria-label={t('取消')}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* 支持格式说明（三例） */}
            <div className="rounded-lg bg-muted/40 border border-border/40 px-3 py-2.5 space-y-1">
              <p className="text-[11px] font-semibold text-muted-foreground">
                {t('支持如下三种模型文件地址格式：')}
              </p>
              {SUPPORTED_URL_EXAMPLES.map(example => (
                <p
                  key={example}
                  className="text-[11px] font-mono text-muted-foreground/80 break-all leading-relaxed select-all"
                >
                  {example}
                </p>
              ))}
            </div>

            {/* 嗅探状态与结果反馈 */}
            {sniffing && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                {t('正在通过网络探测模型文件大小与同目录投影文件，请稍候...')}
              </p>
            )}
            {feedback && (
              <p
                className={`text-xs flex items-start gap-1.5 ${
                  feedback.type === 'error'
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-emerald-600 dark:text-emerald-400'
                }`}
              >
                {feedback.type === 'error' ? (
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                )}
                <span className="break-all">{feedback.message}</span>
              </p>
            )}

            {feedback?.type === 'success' && (
              <p className="text-xs text-muted-foreground">{t('可继续添加下一个模型，或收起本卡片。')}</p>
            )}
          </div>
        )}

        {/* 用户自定义模型集中展示列表（不区分 Tab，统一展示） */}
        {customModels.length > 0 && (
          <div className="pt-2 border-t border-border/40 space-y-3">
            <div className="flex items-center gap-2">
              <Tag className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-bold text-foreground/90 tracking-wide">
                {t('已添加的自定义模型')}
              </span>
              <span className="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-muted border border-border/60 text-muted-foreground tabular-nums">
                {customModels.length}
              </span>
            </div>

            <div className="space-y-2.5">
              {customModels.map(model => (
                <CustomModelRowItem
                  key={`${model.id}@${model.source}`}
                  model={model}
                  onOpenConfig={m => setDrawerModel(m)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 模型专属启动参数滑出侧边栏抽屉 */}
      <ModelParamDrawer
        isOpen={Boolean(drawerModel)}
        model={drawerModel}
        isCurrentRunning={
          drawerModel
            ? useEngineStore.getState().activeModelKey === `${drawerModel.id}@${drawerModel.source}` &&
              (useEngineStore.getState().engineStatus?.status === 'ready' ||
                useEngineStore.getState().engineStatus?.status === 'processing')
            : false
        }
        onClose={() => setDrawerModel(null)}
      />
    </Card>
  )
}
