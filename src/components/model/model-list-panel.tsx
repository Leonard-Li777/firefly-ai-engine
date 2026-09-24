import React, { useState, useEffect, useMemo } from 'react'
import {
  Download,
  Check,
  CircleCheckBig,
  Pause,
  Play,
  X,
  RotateCw,
  Sparkles,
  Eye,
  FileCheck2,
  Globe2,
  Star,
  Zap,
  HardDrive,
  FileText,
  Music,
  GraduationCap,
  Loader2,
  Settings2,
  AlertCircle,
  Power,
  Trash2,
  Tag
} from 'lucide-react'
import { Card } from '../ui/card'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs'
import { useEngineStore } from '../../stores/engine-store'
import { useEngineDownload } from '../../hooks/use-engine-download'
import { useModelDownload } from '../../hooks/use-model-download'
import { ModelItem, ModelSource } from '../../api/types'
import { formatFileSize, formatSpeed, calculateRemainingTime } from '../../lib/utils'
import { t } from '../../languages'
import { toast } from '../common/Toast'
import { sortModels, EnrichedModelItem } from '../../lib/model-sorting'
import { getDisplayRelativeModelPath } from '../../lib/path-utils'
import { ModelParamDrawer } from './model-param-drawer'
import {
  ModelBubbleGuide,
  hasCompletedModelGuideDownload,
  markModelGuideDownloadDone
} from './model-bubble-guide'

export interface IntelligenceLevelItem {
  label: string
  badgeClass: string
}

/**
 * 智能级别映射函数
 * 1: 小学生 (Elementary)
 * 2: 初中生 (Middle School)
 * 3: 高中生 (High School)
 * 4: 大学生 (University)
 * 接收 level id，返回对应的多语言文本与视觉 Badge 样式
 */
export function getIntelligenceConfig(id?: number | null): IntelligenceLevelItem | undefined {
  if (!id) return undefined

  const configMap: Record<number, IntelligenceLevelItem> = {
    1: {
      label: t('小学生'),
      badgeClass: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
    },
    2: {
      label: t('初中生'),
      badgeClass: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30'
    },
    3: {
      label: t('高中生'),
      badgeClass: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30'
    },
    4: {
      label: t('大学生'),
      badgeClass: 'bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/30 font-extrabold'
    }
  }

  return configMap[id]
}

// 别名保留，函数本身接收 id 返回对应配置
export const INTELLIGENCE_CONFIG = getIntelligenceConfig

/**
 * 表格统一列模板：模型名称(弹性) | 推荐 | 智能程度 | 能力 | 参数量 | 量化 | 体积 | 显存
 * 主行与表头共用该模板，保证各指标列纵向严格对齐；
 * 描述、本地路径、状态与操作按钮各自独占整行子行，不参与网格。
 */
const MODEL_GRID =
  'grid grid-cols-[minmax(0,1fr)_64px_72px_104px_52px_88px_72px_60px] items-center gap-x-3'

/** 表头行：各列标题（小号弱化文字，与数据主行共用网格模板） */
const ModelColumnHeader: React.FC = () => {
  return (
    <div
      className={`${MODEL_GRID} border-b border-border/50 bg-muted/30 px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground`}
    >
      <span className="min-w-0 truncate">{t('模型名称')}</span>
      <span>{t('推荐')}</span>
      <span>{t('智能程度')}</span>
      <span>{t('能力')}</span>
      <span>{t('参数量')}</span>
      <span>{t('量化精度')}</span>
      <span className="text-right">{t('模型大小')}</span>
      <span className="text-right">{t('预估显存')}</span>
    </div>
  )
}

interface ModelRowProps {
  model: ModelItem
  isCurrent: boolean
  isEx?: boolean
  onActivate: (modelId: string, source?: string, localPath?: string, modelName?: string) => Promise<boolean | void>
  onOpenConfig: (model: ModelItem) => void
  /** 模型下载提交前的联动回调（PRD-0043：联动提交引擎包下载并提示双 tab 进度） */
  onDownloadSubmit?: () => void
}

/**
 * 表格单行模型条目：主行网格与表头列对齐（名称/推荐/智能程度/能力/参数量/量化/体积/显存），
 * 「已激活」状态条、描述、本地路径、状态与操作按钮各自独占整行子行，互不挤压。
 * 下载进行中以整行子区块展开进度条。
 */
const ModelRowItem: React.FC<ModelRowProps> = ({ model, isCurrent, isEx = false, onActivate, onOpenConfig, onDownloadSubmit }) => {
  const { fetchModels, modelsDir } = useEngineStore()
  const handleDownloadComplete = React.useCallback(() => {
    fetchModels()
  }, [fetchModels])

  const dlOptions = React.useMemo(() => ({
    source: model.source,
    onDownloadComplete: handleDownloadComplete
  }), [model.source, handleDownloadComplete])

  const {
    state: dl,
    startDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    retryDownload
  } = useModelDownload(model.id, dlOptions)

  // 如果有投机采样加速模型 (dspark)，为其初始化下载控制
  const dsparkId = model.dspark as string | undefined
  const {
    state: dsparkDl,
    startDownload: startDsparkDownload
  } = useModelDownload(dsparkId || '', dlOptions)

  const [isActivating, setIsActivating] = useState(false)

  // 「激活并启动」：读取引擎状态判断当前模型是否已启动/启动中，并触发切换+启动
  const engineStatus = useEngineStore(s => s.engineStatus)
  const activateAndStart = useEngineStore(s => s.activateAndStart)
  const [isStartLaunching, setIsStartLaunching] = useState(false)
  const isEngineReady = engineStatus?.status === 'ready'
  const isEngineStarting = engineStatus?.status === 'starting' || engineStatus?.status === 'model_loading'
  const isModelRunning = isCurrent && isEngineReady
  const isModelLaunching = isCurrent && (isEngineStarting || isStartLaunching)

  // 处理「激活并启动」：切换模型 → 启动引擎服务
  const handleActivateAndStart = async () => {
    try {
      setIsStartLaunching(true)
      await activateAndStart(model.id, model.source, model.localPath, model.name)
    } finally {
      setIsStartLaunching(false)
    }
  }

  // 删除模型：弱化按钮 + 二次确认（首次点击进入确认态，再次点击才真正删除）
  const deleteModel = useEngineStore(s => s.deleteModel)
  const [isDeleteConfirm, setIsDeleteConfirm] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const startDeleteConfirm = () => setIsDeleteConfirm(true)
  const cancelDelete = () => setIsDeleteConfirm(false)
  const handleDelete = async () => {
    try {
      setIsDeleting(true)
      await deleteModel(model.id, model.localPath)
      setIsDeleteConfirm(false)
    } finally {
      setIsDeleting(false)
    }
  }

  // 移除自定义模型：仅删除配置条目，不删除磁盘文件（与「删除」逻辑不同）
  const removeCustomModel = useEngineStore(s => s.removeCustomModel)
  const handleRemove = async () => {
    try {
      setIsDeleting(true)
      await removeCustomModel(model.id)
      setIsDeleteConfirm(false)
    } finally {
      setIsDeleting(false)
    }
  }

  // 格式化展示相对路径（不显示 base 存储路径）
  const displayRelativePath = React.useMemo(() => {
    return getDisplayRelativeModelPath(model.localPath, modelsDir)
  }, [model.localPath, modelsDir])

  // 剩余时间文字
  const remainingTime = calculateRemainingTime(dl.receivedBytes, dl.totalBytes, dl.speedBps)
  let remainingText = ''
  if (remainingTime.kind === 'seconds')
    remainingText = t('剩余约 {value} 秒', { value: remainingTime.value ?? 0 })
  else if (remainingTime.kind === 'minutes')
    remainingText = t('剩余约 {value} 分 {seconds} 秒', { value: remainingTime.value ?? 0, seconds: remainingTime.seconds ?? 0 })
  else if (remainingTime.kind === 'hours')
    remainingText = t('剩余约 {value} 小时', { value: remainingTime.value ?? 0 })

  const isDownloaded = model.isDownloaded || dl.status === 'completed'
  const isDsparkDownloaded = dsparkDl.status === 'completed'
  const intelligence = INTELLIGENCE_CONFIG(model.intelligenceLevel)
  const isDownloadingOrPaused = dl.isDownloading || dl.isPaused

  // 整理能力列表（自由添加模型未探测到能力时保持为空，不渲染徽章）
  const capabilities = useMemo(() => {
    if (Array.isArray(model.capabilities) && model.capabilities.length > 0) {
      return model.capabilities
    }
    if (model.isMultiModal) return ['TEXT', 'IMAGE']
    if (model.custom) return []
    const list = ['TEXT']
    return list
  }, [model.capabilities, model.isMultiModal, model.custom])

  // 处理激活/设为生效
  const handleActivate = async () => {
    try {
      setIsActivating(true)
      await onActivate(model.id, model.source, model.localPath, model.name)
    } finally {
      setIsActivating(false)
    }
  }

  return (
    <div
      className={`group relative transition-colors rounded-lg ${isEx
          ? 'opacity-50 grayscale-[0.5]'
          : isCurrent
            ? 'bg-primary/10 ring-1 ring-primary/50 shadow-xs hover:bg-primary/10'
            : 'hover:bg-muted/30'
        }`}
    >

      {/* 主行网格：与表头 8 列严格对齐 */}
      <div className={`${MODEL_GRID} px-4 pt-3 pb-1.5`}>
        {/* 列1：模型名称（徽章已拆分为独立列） */}
        <h4 className="min-w-0 font-bold text-sm text-foreground tracking-tight leading-snug break-words">
          {model.name}
        </h4>

        {/* 列2：推荐来源标识（自定义模型显示「自定义」，官方推荐显示「推荐」，其余占位） */}
        {model.custom ? (
          <Badge className="text-[10px] font-bold h-5 px-1.5 bg-sky-500/15 text-sky-700 dark:text-sky-400 border border-sky-500/30 shadow-none flex items-center gap-1 w-fit max-w-full">
            <Tag className="h-3 w-3 shrink-0" />
            <span className="truncate">{t('自定义')}</span>
          </Badge>
        ) : model.recommended ? (
          <Badge className="text-[10px] font-bold h-5 px-1.5 bg-gradient-to-r from-amber-500 to-orange-600 text-white border-none shadow-xs flex items-center gap-1 w-fit max-w-full">
            <Star className="h-3 w-3 fill-current text-white shrink-0" />
            <span className="truncate">{t('推荐')}</span>
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground/40">-</span>
        )}

        {/* 列3：智能程度级别（完整含义悬停查看） */}
        {intelligence ? (
          <Badge
            variant="outline"
            className={`text-[10px] font-bold h-5 px-1.5 flex items-center gap-1 w-fit max-w-full ${intelligence.badgeClass}`}
            title={`${t('智能程度')}：${intelligence.label}`}
          >
            <GraduationCap className="h-3 w-3 shrink-0" />
            <span className="truncate">{intelligence.label}</span>
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground/40">-</span>
        )}

        {/* 列4：能力标签栏 (文本 / 图片 / 音频)，纵向堆叠避免横向拥挤 */}
        <div className="flex flex-col items-start gap-1 min-w-0">
          {capabilities.map(cap => {
            const isText = cap === 'TEXT'
            const isImage = cap === 'IMAGE' || cap === 'VISION'
            return (
              <Badge
                key={cap}
                variant="outline"
                className={`text-[10px] font-bold h-4.5 px-1.5 flex items-center gap-1 max-w-full ${isText
                    ? 'border-emerald-500/30 text-emerald-700 dark:text-emerald-400 bg-emerald-500/10'
                    : isImage
                      ? 'border-purple-500/30 text-purple-700 dark:text-purple-400 bg-purple-500/10'
                      : 'border-border/70 text-muted-foreground bg-muted/40'
                  }`}
              >
                {isText ? (
                  <FileText className="h-2.5 w-2.5 shrink-0" />
                ) : isImage ? (
                  <Eye className="h-2.5 w-2.5 shrink-0" />
                ) : (
                  <Music className="h-2.5 w-2.5 shrink-0" />
                )}
                <span className="truncate">
                  {isText ? t('文本理解') : isImage ? t('图片识别') : cap}
                </span>
              </Badge>
            )
          })}
        </div>

        {/* 列5：参数量（自由添加模型无法探测时不显示） */}
        {model.params ? (
          <span className="font-mono text-xs font-bold text-foreground/90">{model.params}</span>
        ) : (
          <span className="text-xs text-muted-foreground/40">-</span>
        )}

        {/* 列6：量化精度（无法探测时不显示） */}
        {model.quant ? (
          <span className="font-mono text-xs text-muted-foreground truncate" title={model.quant}>
            {model.quant}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/40">-</span>
        )}

        {/* 列7：模型体积（右对齐等宽数字，探测失败为 0 时不显示） */}
        <span className="font-mono text-xs text-muted-foreground text-right tabular-nums">
          {model.size || (model.fileSize > 0 ? formatFileSize(model.fileSize) : '-')}
        </span>

        {/* 列8：预估显存（右对齐，超标红色警示） */}
        <span
          className={`font-mono text-xs font-bold text-right tabular-nums whitespace-nowrap ${isEx ? 'text-destructive' : 'text-blue-600 dark:text-blue-400'
            }`}
          title={model.vramNeededGB ? t('预估显存') : undefined}
        >
          {model.vramNeededGB ? `~${model.vramNeededGB} GB` : '-'}
        </span>
      </div>

      {/* 描述独占整行 */}
      {!isDownloadingOrPaused && model.description && (
        <p className="px-4 pb-1.5 text-xs text-muted-foreground leading-relaxed break-words" title={model.description}>
          {model.description}
        </p>
      )}

      {/* 本地路径独占整行（已下载模型展示相对路径，可换行完整查看） */}
      {isDownloaded && displayRelativePath && (
        <div className="flex items-start gap-1 px-4 pb-1.5 min-w-0">
          <HardDrive className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground/80" />
          <span className="break-all select-all text-[11px] font-mono text-muted-foreground" title={displayRelativePath}>
            {displayRelativePath}
          </span>
        </div>
      )}

      {/* 状态与操作按钮独占整行：状态在左，按钮全部显示完整文字标签 */}
      <div className="flex items-center justify-between gap-3 px-4 pb-3">
        {isDownloadingOrPaused ? (
          <span className={`font-mono text-xs font-bold tabular-nums ${dl.isPaused ? 'text-amber-600 dark:text-amber-400' : 'text-primary'}`}>
            {dl.isPaused ? t('已暂停') : t('正在下载')} {dl.progress}%
          </span>
        ) : dl.status === 'error' ? (
          <span className="text-xs font-semibold text-destructive truncate min-w-0" title={dl.error || undefined}>
            {dl.error || t('下载失败')}
          </span>
        ) : isDownloaded ? (
          <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 text-xs font-bold">
            <FileCheck2 className="h-3.5 w-3.5 shrink-0" />
            <span>{t('已就绪')}</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground/70 font-medium">
            {isEx ? t('超出显存限制') : t('尚未下载到本地')}
          </span>
        )}

        <div className="flex items-center gap-1.5 shrink-0">
          {/* 「移除」（仅未下载的自定义模型显示）：删除自定义配置条目，不触碰磁盘文件 */}
          {model.custom && !isDownloaded && (
            isDeleteConfirm ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7.5 text-xs px-3 rounded-lg border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20 font-bold shrink-0"
                  onClick={handleRemove}
                  disabled={isDeleting}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1 shrink-0" />
                  {isDeleting ? t('删除中...') : t('确认移除')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7.5 text-xs px-3 rounded-lg font-bold text-muted-foreground shrink-0"
                  onClick={cancelDelete}
                  disabled={isDeleting}
                >
                  {t('取消')}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-7.5 text-xs px-3 rounded-lg font-bold text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 shrink-0 opacity-70 hover:opacity-100"
                title={t('删除该自定义模型记录，不再显示于列表')}
                onClick={startDeleteConfirm}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1 shrink-0" />
                {t('移除')}
              </Button>
            )
          )}
          {isDownloadingOrPaused ? (
            <>
              {dl.isPaused ? (
                <Button size="sm" variant="outline" className="h-7.5 text-xs px-3 rounded-lg font-bold" onClick={resumeDownload}>
                  <Play className="h-3 w-3 mr-1" />
                  {t('继续')}
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="h-7.5 text-xs px-3 rounded-lg font-bold" onClick={pauseDownload}>
                  <Pause className="h-3 w-3 mr-1" />
                  {t('暂停')}
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-7.5 text-xs px-3 rounded-lg font-bold text-destructive hover:bg-destructive/10" onClick={cancelDownload}>
                <X className="h-3 w-3 mr-1" />
                {t('取消')}
              </Button>
            </>
          ) : dl.status === 'error' ? (
            <Button size="sm" variant="outline" className="h-7.5 text-xs px-3 rounded-lg border-border font-bold" onClick={retryDownload}>
              <RotateCw className="h-3 w-3 mr-1" />
              {t('重试')}
            </Button>
          ) : isDownloaded ? (
            <>
              {/* 删除模型按钮（固定操作区第一位）：弱化样式，二次确认（首次点击进入确认态，再次点击才真正删除） */}
              {!isEx && (isDeleteConfirm ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7.5 text-xs px-3 rounded-lg border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20 font-bold shrink-0"
                    onClick={handleDelete}
                    disabled={isDeleting}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1 shrink-0" />
                    {isDeleting ? t('删除中...') : t('确认删除')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7.5 text-xs px-3 rounded-lg font-bold text-muted-foreground shrink-0"
                    onClick={cancelDelete}
                    disabled={isDeleting}
                  >
                    {t('取消')}
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7.5 text-xs px-3 rounded-lg font-bold text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 shrink-0 opacity-70 hover:opacity-100"
                  title={t('删除模型文件并移除相关配置，释放磁盘空间')}
                  onClick={startDeleteConfirm}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1 shrink-0" />
                  {t('删除')}
                </Button>
              ))}

              {/* 配置了 DSpark 加速模型且未下载时，展示【下载加速模型】按钮 */}
              {dsparkId && !isDsparkDownloaded && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => startDsparkDownload()}
                  disabled={dsparkDl.isDownloading}
                  title={t('下载投机采样加速模型，大幅提升推理速度')}
                  className="h-7.5 text-xs px-3 rounded-lg border-emerald-500/50 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 font-bold flex items-center gap-1 transition-all"
                >
                  <Zap className={`h-3 w-3 shrink-0 ${dsparkDl.isDownloading ? 'fill-current animate-pulse' : ''}`} />
                  <span>{dsparkDl.isDownloading ? t('加速模型下载中...') : t('下载加速模型')}</span>
                </Button>
              )}

              {/* 参数配置按钮：仅已下载且显存未超标 (!isEx) 时才显示 */}
              {!isEx && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7.5 text-xs px-3 rounded-lg border-border hover:border-primary/60 font-bold flex items-center gap-1 transition-all"
                  onClick={() => onOpenConfig(model)}
                >
                  <Settings2 className="h-3.5 w-3.5 text-primary shrink-0" />
                  <span>{t('参数配置')}</span>
                </Button>
              )}

              {/* 当前模型展示「已激活」Badge 标识；非当前模型展示【激活】按钮，显存超标时展示禁用按钮 */}
              {isCurrent ? (
                <Badge className="h-7.5 text-xs px-3 rounded-lg font-bold bg-primary/15 text-primary border border-primary/30 shrink-0 flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 shrink-0" />
                  {t('已激活')}
                </Badge>
              ) : isEx ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7.5 text-xs px-3 rounded-lg font-bold border-destructive/30 text-destructive/80 bg-destructive/5 shrink-0 cursor-not-allowed opacity-80"
                  disabled={true}
                >
                  <AlertCircle className="h-3.5 w-3.5 mr-1 text-destructive" />
                  {t('显存不足')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7.5 text-xs px-3.5 rounded-lg font-bold border-border hover:border-primary/60 shrink-0"
                  onClick={handleActivate}
                  disabled={isActivating}
                >
                  <CircleCheckBig className="h-3 w-3 mr-1.5 shrink-0" />
                  {isActivating ? t('切换中...') : t('激活')}
                </Button>
              )}

              {/* 「激活并启动」（操作区最后一位）：当前模型已启动展示 Badge；启动中展示启动中 Badge；未启动时展示切换并启动按钮 */}
              {isModelRunning ? (
                <Badge className="h-7.5 text-xs px-3 rounded-lg font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 shrink-0 flex items-center gap-1.5">
                  <Play className="h-3.5 w-3.5 shrink-0 fill-current" />
                  {t('已启动')}
                </Badge>
              ) : isModelLaunching ? (
                <Badge className="h-7.5 text-xs px-3 rounded-lg font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 shrink-0 flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  {t('启动中...')}
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant="default"
                  className="h-7.5 text-xs px-3.5 rounded-lg font-bold shadow-xs shrink-0"
                  onClick={handleActivateAndStart}
                  disabled={isStartLaunching || isActivating}
                >
                  <Power className="h-3 w-3 mr-1.5 shrink-0" />
                  {isStartLaunching ? t('启动中...') : t('激活并启动')}
                </Button>
              )}
            </>
          ) : (
            /* 未下载模型只显示下载按钮，若显存不足则显示禁用显存不足按钮，绝不显示任何参数配置按钮；
               自由添加的自定义模型即便未下载，也提供「移除记录」按钮（删除后不再显示于列表） */
            <>
              {isEx ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7.5 text-xs px-3 rounded-lg font-bold border-destructive/30 text-destructive/80 bg-destructive/5 shrink-0 cursor-not-allowed opacity-80"
                  disabled={true}
                >
                  <AlertCircle className="h-3.5 w-3.5 mr-1 text-destructive" />
                  {t('显存不足')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7.5 text-xs px-3.5 rounded-lg font-bold border-border hover:border-primary/60 shrink-0"
                  onClick={() => {
                    // 提交首次模型下载：标记引导完成（气泡此后永久消失，PRD-0043）
                    handleModelDownloadSubmitted()
                    // 联动下载（PRD-0043）：提交模型下载前联动提交引擎包下载并提示双 tab 进度
                    onDownloadSubmit?.()
                    startDownload()
                  }}
                >
                  <Download className="h-3 w-3 mr-1.5 shrink-0" />
                  {t('下载模型')}
                </Button>
              )}


            </>
          )}
        </div>
      </div>

      {/* 下载进行中：整行展开进度子区块（文件名+分片、进度条、速率、剩余时间） */}
      {isDownloadingOrPaused && (
        <div className="px-4 pb-3 space-y-1.5">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className={`truncate max-w-[360px] ${dl.isPaused ? 'text-amber-600 dark:text-amber-400' : 'text-primary'}`} title={dl.currentFileName}>
              {dl.totalFiles && dl.totalFiles > 1
                ? `[${(dl.fileIndex || 0) + 1}/${dl.totalFiles}] ${dl.currentFileName}`
                : dl.currentFileName || (dl.isPaused ? t('下载已暂停') : t('正在下载...'))}
            </span>
            <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
              <span>
                {formatFileSize(dl.receivedBytes)} / {formatFileSize(dl.totalBytes || model.fileSize)}
              </span>
              {!dl.isPaused && dl.speedBps > 0 && <span className="text-foreground font-bold">{formatSpeed(dl.speedBps)}</span>}
              {!dl.isPaused && remainingText && <span>{remainingText}</span>}
              {dl.isPaused && <span className="text-amber-600 dark:text-amber-400 font-bold">{t('等待继续')}</span>}
            </div>
          </div>

          <Progress value={dl.progress} className={`h-1.5 ${dl.isPaused ? 'opacity-70' : ''}`} />
        </div>
      )}
    </div>
  )
}

/**
 * 分组区块：标题行（图标 + 标题 + 计数）+ 边框包裹的表格化行列表
 */
interface ModelGroupSectionProps {
  icon: React.ReactNode
  iconClass: string
  title: string
  count: number
  children: React.ReactNode
}

const ModelGroupSection: React.FC<ModelGroupSectionProps> = ({ icon, iconClass, title, count, children }) => (
  <section aria-label={title}>
    <div className="mb-2 flex items-center gap-2">
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${iconClass}`}>
        {icon}
      </span>
      <h3 className="text-xs font-bold text-foreground/90 tracking-wide whitespace-nowrap">{title}</h3>
      <span className="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-muted border border-border/60 text-muted-foreground tabular-nums">
        {count}
      </span>
      <div className="h-px flex-1 bg-border/50" />
    </div>
    <div className="rounded-xl border border-border/60 bg-card/60 divide-y divide-border/40">
      {children}
    </div>
  </section>
)

/** 单行下载提交时的引导标记回调：首次提交后气泡引导永久消失 */
function handleModelDownloadSubmitted(): void {
  markModelGuideDownloadDone()
}

/** 统计模型列表中已下载模型数量（列表未加载时返回 -1 以区分"空列表"与"未加载"） */
function safeModelsLen(models: ModelItem[] | null | undefined): number {
  if (!Array.isArray(models)) return -1
  return models.filter(m => m && m.isDownloaded).length
}

export const ModelListPanel: React.FC = () => {
  const { models, fetchModels, activeModelKey, switchModel, engineStatus, engineList, fetchEngineList, lastAddedSource } = useEngineStore()
  const [activeSource, setActiveSource] = useState<ModelSource>('modelscope')
  const [showRecommendedOnly, setShowRecommendedOnly] = useState<boolean>(true)
  const [drawerModel, setDrawerModel] = useState<ModelItem | null>(null)

  // 引擎包联动下载（PRD-0043）：实例化引擎下载 hook，提交模型下载时若最佳引擎包未安装则自动同时下载
  const { startDownload: startEngineDownload } = useEngineDownload()

  /**
   * 模型下载提交前的联动处理（PRD-0043）：
   * - 硬件最佳适配引擎包（matchType === 'best'）未安装时，联动提交引擎包下载（用户无需感知选择）；
   * - 无论是否联动，均提示用户可在「模型」与「引擎」两个标签页查看各自下载进度。
   */
  const handleModelDownloadSubmit = React.useCallback(() => {
    const bestEngine = (engineList || []).find(e => e.matchType === 'best')
    if (bestEngine && !bestEngine.isInstalled) {
      // 联动提交引擎包下载：不 await，两个下载任务并行进行
      startEngineDownload(bestEngine.backend).catch(() => {
        // 引擎包下载失败不阻塞模型下载主流程，引擎 tab 内可重试
      })
      toast.info(
        t('已为您自动匹配并开始下载最佳引擎包（{name}），可在「模型」与「引擎」标签页查看下载进度', { name: bestEngine.name })
      )
    } else if (bestEngine) {
      toast.info(t('已开始下载模型，可在「模型」与「引擎」标签页查看下载进度'))
    }
  }, [engineList, startEngineDownload])

  // 气泡引导（PRD-0043）：模型列表已加载且本机无任何已下载模型时激活；
  // 会话内关闭后本次不再显示，下次进入仍会出现，直至完成首次模型下载提交（localStorage 永久标记）
  const [guideSessionDismissed, setGuideSessionDismissed] = useState(false)
  const isModelsLoaded = models !== null && models !== undefined
  const hasAnyDownloadedModel = safeModelsLen(models) > 0
  const isGuideActive =
    isModelsLoaded && !hasAnyDownloadedModel && !guideSessionDismissed && !hasCompletedModelGuideDownload()

  // 自由添加成功后，自动切换到新模型所属来源页签，保证列表立即可见
  useEffect(() => {
    if (lastAddedSource) {
      setActiveSource(lastAddedSource.source as ModelSource)
    }
  }, [lastAddedSource])

  useEffect(() => {
    fetchModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const safeModels = Array.isArray(models) ? models : []
  const userVramGB = engineStatus?.hardware?.total_vram_gb

  // 按渠道和推荐过滤，并执行超标计算与加权排序后，分为三组：
  // 已下载 / 待下载（未下载且显存够用）/ 显存不足不可下载
  const groupedModels = useMemo(() => {
    const matched = safeModels.filter(m => {
      if (!m) return false
      if (m.source !== activeSource) return false
      // 自由添加的模型为用户显式提交，不受"只看推荐"过滤
      if (showRecommendedOnly && !m.recommended && !m.custom) return false
      return true
    })
    const sorted = sortModels(matched, userVramGB)
    return {
      downloaded: sorted.filter(m => m.isDownloaded),
      notDownloaded: sorted.filter(m => !m.isDownloaded && !m.isEx),
      vramLimited: sorted.filter(m => !m.isDownloaded && m.isEx)
    }
  }, [safeModels, activeSource, showRecommendedOnly, userVramGB])

  const totalCount =
    groupedModels.downloaded.length + groupedModels.notDownloaded.length + groupedModels.vramLimited.length

  // 统计各来源数量
  const counts = useMemo(() => {
    const scopeCount = safeModels.filter(m => m && m.source === 'modelscope').length
    const hfCount = safeModels.filter(m => m && m.source === 'huggingface').length
    return { modelscope: scopeCount, huggingface: hfCount }
  }, [safeModels])

  // 统一渲染单行模型条目
  const renderModelRow = (model: EnrichedModelItem) => {
    const modelKey = `${model.id}@${model.source}`
    const isCurrent = activeModelKey === modelKey
    return (
      <ModelRowItem
        key={modelKey}
        model={model}
        isCurrent={isCurrent}
        isEx={model.isEx}
        onActivate={async (id, source, localPath, modelName) => {
          await switchModel(id, source, localPath, modelName || model.name)
        }}
        onOpenConfig={targetModel => setDrawerModel(targetModel)}
        onDownloadSubmit={handleModelDownloadSubmit}
      />
    )
  }

  return (
    <Card className="p-0 overflow-hidden border border-border/70 rounded-2xl bg-card shadow-xs">

      {/* Tabs 栏：复刻 Desktop 风格 + 右侧 Switch 仅显示推荐 */}
      <Tabs value={activeSource} onValueChange={val => setActiveSource(val as ModelSource)} className="w-full">
        <div className="flex items-center justify-between border-b border-border/40 bg-muted/30 px-4">
          <TabsList className="flex justify-start h-12 bg-transparent p-0 border-b-0 rounded-none overflow-x-auto no-scrollbar gap-2">
            <TabsTrigger
              value="modelscope"
              className="flex-shrink-0 px-4 h-full rounded-none font-bold text-xs data-[state=active]:border-b-[3px] data-[state=active]:border-primary data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=inactive]:text-muted-foreground transition-all border-b-[3px] border-transparent hover:text-foreground hover:bg-muted/40 relative flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5 text-inherit" />
              <span>ModelScope ({t('中国高速')})</span>
              <span className="ml-1.5 text-[10px] data-[state=active]:bg-primary data-[state=active]:text-primary-foreground bg-muted/80 px-2 py-0.5 rounded-full text-muted-foreground font-mono border border-border/40 transition-colors">
                {counts.modelscope}
              </span>
            </TabsTrigger>

            <TabsTrigger
              value="huggingface"
              className="flex-shrink-0 px-4 h-full rounded-none font-bold text-xs data-[state=active]:border-b-[3px] data-[state=active]:border-primary data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=inactive]:text-muted-foreground transition-all border-b-[3px] border-transparent hover:text-foreground hover:bg-muted/40 relative flex items-center gap-1.5"
            >
              <Globe2 className="w-3.5 h-3.5 text-inherit" />
              <span>HuggingFace ({t('国际官方')})</span>
              <span className="ml-1.5 text-[10px] data-[state=active]:bg-primary data-[state=active]:text-primary-foreground bg-muted/80 px-2 py-0.5 rounded-full text-muted-foreground font-mono border border-border/40 transition-colors">
                {counts.huggingface}
              </span>
            </TabsTrigger>
          </TabsList>

          {/* 仅显示推荐 Switch */}
          <div className="flex items-center gap-2 shrink-0 py-2">
            <Switch
              id="filter-recommended-toggle"
              checked={showRecommendedOnly}
              onCheckedChange={setShowRecommendedOnly}
            />
            <Label
              htmlFor="filter-recommended-toggle"
              className="text-xs font-bold text-muted-foreground cursor-pointer select-none"
            >
              {t('仅显示推荐')}
            </Label>
          </div>
        </div>

        {/* 列表内容区：表头 + 单行表格布局，按 已下载 / 待下载 / 显存不足 三组显示 */}
        <TabsContent value={activeSource} className="p-5 focus-visible:ring-0 m-0">
          {/* 首次下载气泡引导（PRD-0043）：无任何已下载模型时激活 */}
          {isGuideActive && (
            <ModelBubbleGuide onSessionDismiss={() => setGuideSessionDismissed(true)} />
          )}
          {totalCount === 0 ? (
            <div className="text-center py-16 text-muted-foreground/50 font-bold text-xs">
              {showRecommendedOnly ? t('暂无官方推荐模型') : t('该来源暂无可用模型')}
            </div>
          ) : (
            <div className="space-y-6">
              {/* 全列表共用一个表头，保证三组之间列宽一致对齐 */}
              <div className="rounded-xl border border-border/60 overflow-hidden">
                <ModelColumnHeader />
              </div>

              {groupedModels.downloaded.length > 0 && (
                <ModelGroupSection
                  icon={<FileCheck2 className="h-3 w-3" />}
                  iconClass="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"
                  title={t('已下载模型')}
                  count={groupedModels.downloaded.length}
                >
                  {groupedModels.downloaded.map(renderModelRow)}
                </ModelGroupSection>
              )}

              {groupedModels.notDownloaded.length > 0 && (
                <ModelGroupSection
                  icon={<Download className="h-3 w-3" />}
                  iconClass="border-primary/30 text-primary bg-primary/10"
                  title={t('待下载模型')}
                  count={groupedModels.notDownloaded.length}
                >
                  {groupedModels.notDownloaded.map(renderModelRow)}
                </ModelGroupSection>
              )}

              {groupedModels.vramLimited.length > 0 && (
                <ModelGroupSection
                  icon={<AlertCircle className="h-3 w-3" />}
                  iconClass="border-destructive/30 text-destructive bg-destructive/10"
                  title={t('显存不足 · 不可下载')}
                  count={groupedModels.vramLimited.length}
                >
                  {groupedModels.vramLimited.map(renderModelRow)}
                </ModelGroupSection>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* 模型专属启动参数滑出侧边栏抽屉 */}
      <ModelParamDrawer
        isOpen={!!drawerModel}
        model={drawerModel}
        isCurrentRunning={
          drawerModel
            ? activeModelKey === `${drawerModel.id}@${drawerModel.source}` &&
            engineStatus?.status === 'ready'
            : false
        }
        onClose={() => setDrawerModel(null)}
      />
    </Card>
  )
}
