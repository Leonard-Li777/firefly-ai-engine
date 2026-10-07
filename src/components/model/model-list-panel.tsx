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
  ChevronDown,
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
import { useModelDownloadStore } from '../../stores/model-download-store'
import { ModelItem, ModelSource } from '../../api/types'
import { formatFileSize, formatSpeed, calculateRemainingTime } from '../../lib/utils'
import { t } from '../../languages'
import { toast } from '../common/Toast'
import { sortModels, EnrichedModelItem } from '../../lib/model-sorting'
import { getDisplayRelativeModelPath } from '../../lib/path-utils'
import { ModelResolver } from '../../lib/model-resolver'
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
  /** 是否处于自身槽位的「已激活」配置态（语言槽 / 嵌入槽各自独立，可同时为真） */
  isCurrent: boolean
  /**
   * 是否为进程内实际运行（或正在加载）的模型。
   * 与 isCurrent 严格区分：语言模型与嵌入模型可同时「已激活」，但同一时刻进程只运行一个模型，
   * 故「已启动」仅能落在真正被引擎加载的那一个模型上。
   */
  isActiveModel?: boolean
  isEx?: boolean
  /** Desktop 深链引导的目标行：呼吸高亮光晕（Issue 0046 §3） */
  highlighted?: boolean
  onActivate: (modelId: string, source?: string, localPath?: string, modelName?: string) => Promise<boolean | void>
  onOpenConfig: (model: ModelItem) => void
  /** 模型下载提交前的联动回调（PRD-0043：联动提交引擎包下载并提示双 tab 进度） */
  onDownloadSubmit?: (modelName?: string) => void
}

/**
 * 表格单行模型条目：主行网格与表头列对齐（名称/推荐/智能程度/能力/参数量/量化/体积/显存），
 * 「已激活」状态条、描述、本地路径、状态与操作按钮各自独占整行子行，互不挤压。
 * 下载进行中以整行子区块展开进度条。
 */
const ModelRowItem: React.FC<ModelRowProps> = ({ model, isCurrent, isActiveModel = false, isEx = false, highlighted = false, onActivate, onOpenConfig, onDownloadSubmit }) => {
  const { fetchModels, modelsDir } = useEngineStore()
  const handleDownloadComplete = React.useCallback(() => {
    fetchModels()
  }, [fetchModels])

  const dlOptions = React.useMemo(() => ({
    source: model.source,
    quantization: model.quantization,
    isDownloaded: model.isDownloaded,
    onDownloadComplete: handleDownloadComplete
  }), [model.source, model.quantization, model.isDownloaded, handleDownloadComplete])

  const {
    state: dl,
    startDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    retryDownload,
    resetDownload
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
  const isEngineReady = engineStatus?.status === 'ready' || engineStatus?.status === 'processing'
  const isEngineStarting = engineStatus?.status === 'starting' || engineStatus?.status === 'model_loading'
  // 运行态判定必须锚定「进程内实际运行的模型」（isActiveModel），而非「槽位已激活」（isCurrent）：
  // 语言槽与嵌入槽可同时为「已激活」，但进程同一时刻只运行一个模型，
  // 若用 isCurrent 判定会把另一槽位的模型也误标为「已启动」。
  const isModelRunning = isActiveModel && isEngineReady
  const isModelLaunching = isStartLaunching || (isActiveModel && isEngineStarting)

  // 处理「激活并启动」：切换模型 → 启动引擎服务
  const handleActivateAndStart = async () => {
    try {
      setIsStartLaunching(true)
      await activateAndStart(model.id, model.source, resolvedLocalPath, model.name, model.isEmbedding)
    } finally {
      setIsStartLaunching(false)
    }
  }

  // 删除模型：弱化按钮 + 二次确认（首次点击进入确认态，再次点击才真正删除）
  const deleteModel = useEngineStore(s => s.deleteModel)
  const [isDeleteConfirm, setIsDeleteConfirm] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  // 「高级」操作收纳：删除/移除/参数配置默认折叠为一个弱化按钮，点击后原位展开
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const startDeleteConfirm = () => setIsDeleteConfirm(true)
  const cancelDelete = () => setIsDeleteConfirm(false)
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

  // 移除自定义模型：仅删除配置条目，不删除磁盘文件（与「删除」逻辑不同）
  const removeCustomModel = useEngineStore(s => s.removeCustomModel)
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

  // 确保无论 model.localPath 是否由后端提前填入，都能从 modelsDir 解析得到有效物理路径
  const resolvedLocalPath = React.useMemo(() => {
    let lp = model.localPath
    if (!lp && isDownloaded && modelsDir) {
      const resolution = ModelResolver.resolve(model.id, modelsDir, undefined, model.source)
      if (resolution?.modelPath) lp = resolution.modelPath
    }
    return lp
  }, [model.localPath, isDownloaded, modelsDir, model.id, model.source])

  // 高级操作可见性：移除（未下载的自定义模型）/ 删除（已下载且显存未超标）/ 参数配置（已下载且显存未超标）
  const canRemoveCustom = !!model.custom && !isDownloaded
  const canDeleteModel = isDownloaded && !isEx
  const canOpenConfig = isDownloaded && !isEx
  const hasAdvancedActions = canRemoveCustom || canDeleteModel || canOpenConfig

  // 格式化展示相对路径（不显示 base 存储路径）
  // 兜底：模型已判定为已下载但 localPath 缺失（如下载完成瞬间 fetchModels 尚未刷新、
  // 或合并匹配失配）时，用 ModelResolver 从当前 modelsDir 主动推导物理路径，
  // 避免"已就绪却无路径"的悬空状态。
  const displayRelativePath = React.useMemo(() => {
    return getDisplayRelativeModelPath(resolvedLocalPath, modelsDir)
  }, [resolvedLocalPath, modelsDir])

  // 自动修复：已下载但 localPath 持续缺失（推导也失败）时，触发一次后端重扫描刷新列表，
  // 让磁盘上已存在的物理文件条目（含 localPath）合并进推荐底表。组件生命周期内仅触发一次。
  const rescanModels = useEngineStore(s => s.rescanModels)
  const hasRescannedRef = React.useRef(false)
  useEffect(() => {
    if (!isDownloaded || model.localPath || hasRescannedRef.current) return
    if (!displayRelativePath) {
      hasRescannedRef.current = true
      rescanModels()
    }
  }, [isDownloaded, model.localPath, displayRelativePath, rescanModels])

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
      await onActivate(model.id, model.source, resolvedLocalPath, model.name)
    } finally {
      setIsActivating(false)
    }
  }

  return (
    <div
      data-model-key={`${model.id}@${model.source}`}
      className={`group relative transition-colors rounded-lg ${highlighted ? 'model-row-highlight' : ''} ${isEx
          ? 'opacity-50 grayscale-[0.5]'
          : isCurrent
            ? 'bg-primary/10 ring-1 ring-primary/50 shadow-xs hover:bg-primary/10'
            : 'hover:bg-muted/30'
        }`}
    >
      {/* 引导安装提示横幅（Desktop 深链聚焦目标模型时呈现，Issue 0046 §3） */}
      {highlighted && (
        <div className="flex items-center gap-2 rounded-t-lg border-b border-primary/30 bg-primary/10 px-4 py-1.5 text-[11px] font-medium text-primary">
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          <span>{t('高维修正需要该模型，请下载后启用')}</span>
        </div>
      )}

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
            {dl.isPaused ? t('已暂停') : dl.status === 'pending' ? t('准备下载中...') : `${t('正在下载')} ${dl.progress}%`}
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
          {/* 高级操作收纳区：默认仅显示弱化的「高级」按钮，点击后原位展开 删除/移除/参数配置 */}
          {hasAdvancedActions && !isDownloadingOrPaused && dl.status !== 'error' && (
            isDeleteConfirm ? (
              <>
                {canRemoveCustom ? (
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
                ) : (
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
                )}
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
            ) : isAdvancedOpen ? (
              <>
                {/* 展开态：删除（已下载模型文件）/ 移除（自定义配置条目）/ 参数配置 */}
                {canDeleteModel && (
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
                )}
                {canRemoveCustom && (
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
                )}
                {canOpenConfig && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7.5 text-xs px-3 rounded-lg border-border hover:border-primary/60 font-bold flex items-center gap-1 transition-all shrink-0"
                    onClick={() => onOpenConfig(model)}
                  >
                    <Settings2 className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span>{t('参数配置')}</span>
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7.5 text-xs px-3 rounded-lg font-bold text-muted-foreground shrink-0"
                  onClick={() => setIsAdvancedOpen(false)}
                >
                  {t('收起')}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-7.5 text-xs px-3 rounded-lg font-bold text-muted-foreground/60 hover:text-foreground shrink-0 opacity-70 hover:opacity-100"
                title={t('删除、移除与参数配置等高级操作')}
                onClick={() => setIsAdvancedOpen(true)}
              >
                <Settings2 className="h-3.5 w-3.5 mr-1 shrink-0" />
                {t('高级')}
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
              {/* 删除与参数配置已收纳进操作区首位的「高级」按钮 */}

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
               自由添加的自定义模型即便未下载，也可通过「高级」按钮展开「移除记录」（删除后不再显示于列表） */
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
                    onDownloadSubmit?.(model.name)
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
                ? `[${(dl.fileIndex || 0) + 1}/${dl.totalFiles}] ${dl.currentFileName || (dl.status === 'pending' ? t('正在连接源站...') : t('正在下载...'))}`
                : dl.currentFileName || (dl.isPaused ? t('下载已暂停') : dl.status === 'pending' ? t('准备下载中...') : t('正在下载...'))}
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
 * 分组区块：标题行（图标 + 标题 + 计数）+ 边框包裹的表格化行列表。
 * `collapsible` 分组默认收起，标题右侧提供「展开/收起」开关（用于「显存不足 · 不可下载」）。
 */
interface ModelGroupSectionProps {
  icon: React.ReactNode
  iconClass: string
  title: string
  count: number
  /** 可折叠分组：默认收起，用户点击标题行开关后再渲染行列表 */
  collapsible?: boolean
  children: React.ReactNode
}

const ModelGroupSection: React.FC<ModelGroupSectionProps> = ({ icon, iconClass, title, count, children, collapsible = false }) => {
  const [isOpen, setIsOpen] = useState(!collapsible)

  return (
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
        {collapsible && (
          <button
            type="button"
            aria-expanded={isOpen}
            onClick={() => setIsOpen(prev => !prev)}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-bold text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            {isOpen ? t('收起') : t('展开')}
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
      {isOpen && (
        <div className="rounded-xl border border-border/60 bg-card/60 divide-y divide-border/40">
          {children}
        </div>
      )}
    </section>
  )
}

/** 单行下载提交时的引导标记回调：首次提交后气泡引导永久消失 */
function handleModelDownloadSubmitted(): void {
  markModelGuideDownloadDone()
}

/** 统计模型列表中已下载模型数量（列表未加载时返回 -1 以区分"空列表"与"未加载"） */
function safeModelsLen(models: ModelItem[] | null | undefined): number {
  if (!Array.isArray(models)) return -1
  return models.filter(m => m && m.isDownloaded).length
}

/** 高亮呼吸光晕持续时长（毫秒）：足够用户看清目标行，又不长期干扰浏览 */
const FOCUS_HIGHLIGHT_DURATION_MS = 6000

export interface ModelListPanelProps {
  /**
   * Desktop 深链聚焦目标（Issue 0046 §3）：模型 id/名称关键词。
   * 命中后自动切到对应来源页签、滚动居中并呈现呼吸高亮光晕 + 引导横幅。
   */
  focusModel?: string
  /** 推荐模型源：命中时自动切换页签，保证可顺畅下载的源在前 */
  focusSource?: ModelSource
}

export const ModelListPanel: React.FC<ModelListPanelProps> = ({ focusModel, focusSource }) => {
  const { models, fetchModels, activeModelKey, activeLanguageModelKey, activeEmbeddingModelKey, switchModel, engineStatus, engineList, fetchEngineList, lastAddedSource } = useEngineStore()
  const [activeSource, setActiveSource] = useState<ModelSource>('modelscope')
  const [showRecommendedOnly, setShowRecommendedOnly] = useState<boolean>(true)
  const [drawerModel, setDrawerModel] = useState<ModelItem | null>(null)
  /** 当前处于呼吸高亮状态的模型行 key（`${id}@${source}`） */
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null)
  const listContainerRef = React.useRef<HTMLDivElement | null>(null)
  /** 已成功应用过聚焦的关键词：避免列表刷新时重复滚动/高亮 */
  const focusAppliedRef = React.useRef<string | null>(null)

  // 全局下载任务订阅与各源活跃下载计数统计
  const downloadTasks = useModelDownloadStore(s => s.tasks)
  const downloadingBySource = useMemo(() => {
    let ms = 0
    let hf = 0
    let activeTaskDesc: { modelId: string; source: ModelSource; progress: number; speedBps: number } | null = null
    for (const t of Object.values(downloadTasks)) {
      if (t.isDownloading) {
        if (t.source === 'huggingface') {
          hf++
        } else {
          ms++
        }
        if (!activeTaskDesc) {
          activeTaskDesc = {
            modelId: t.modelId,
            source: (t.source || 'modelscope') as ModelSource,
            progress: Math.round(t.progress),
            speedBps: t.speedBps
          }
        }
      }
    }
    return { modelscope: ms, huggingface: hf, activeTask: activeTaskDesc }
  }, [downloadTasks])

  // 引擎包联动下载（PRD-0043）：实例化引擎下载 hook，提交模型下载时若最佳引擎包未安装则自动同时下载
  const { startDownload: startEngineDownload } = useEngineDownload()

  /**
   * 模型下载提交前的联动处理（PRD-0043）：
   * - 硬件最佳适配引擎包（matchType === 'best'）未安装时，联动提交引擎包下载（用户无需感知选择）；
   * - 无论是否联动，均提示用户可在「模型」与「引擎」两个标签页查看各自下载进度。
   */
  const handleModelDownloadSubmit = React.useCallback((modelName?: string) => {
    const bestEngine = (engineList || []).find(e => e.matchType === 'best')
    if (bestEngine && !bestEngine.isInstalled) {
      // 联动提交引擎包下载：不 await，两个下载任务并行进行
      startEngineDownload(bestEngine.backend).catch(() => {
        // 引擎包下载失败不阻塞模型下载主流程，引擎 tab 内可重试
      })
      toast.info(
        t('已为您自动匹配并开始下载最佳引擎包（{name}），可在「模型」与「引擎」标签页查看下载进度', { name: bestEngine.name })
      )
    } else {
      if (modelName) {
        toast.info(t('已开始下载模型「{name}」，可在「模型」标签页查看下载进度', { name: modelName }))
      } else {
        toast.info(t('已开始下载模型，可在「模型」标签页查看下载进度'))
      }
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
    // 联动下载（PRD-0043）：确保引擎列表已加载，供提交下载时判定最佳引擎包安装态
    fetchEngineList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const safeModels = Array.isArray(models) ? models : []

  // 推荐源优先：初次进入或外部切换时切到可顺畅下载的源页签
  useEffect(() => {
    if (focusSource) {
      setActiveSource(focusSource)
    }
  }, [focusSource])

  /**
   * Desktop 深链聚焦（Issue 0046 §3）：
   * 命中关键词后自动切源、滚动居中并呈现呼吸高亮光晕。
   * 用户切换到任何一个安装源（ModelScope / HuggingFace）均可高亮匹配模型。
   * 关键词为空时不动作；高亮在 FOCUS_HIGHLIGHT_DURATION_MS 后自动消退。
   */
  useEffect(() => {
    const keyword = focusModel?.trim().toLowerCase()
    if (!keyword) {
      setHighlightedKey(null)
      focusAppliedRef.current = null
      return
    }
    const currentKey = `${keyword}@${activeSource}`
    // 同一来源下的同一关键词只自动滚动定位一次，避免列表刷新重复滚动；切换来源后允许再次高亮
    if (focusAppliedRef.current === currentKey) return

    let cancelled = false
    let clearTimer: ReturnType<typeof setTimeout> | null = null

    // 等待列表渲染完成（models 可能仍在加载）后再定位；双 rAF 保证 DOM 已提交
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return
        const container = listContainerRef.current
        if (!container) return
        const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-model-key]'))
        const target = rows.find(el => (el.dataset.modelKey || '').toLowerCase().includes(keyword))
        if (!target) return
        focusAppliedRef.current = currentKey
        setHighlightedKey(target.dataset.modelKey || null)
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        clearTimer = setTimeout(() => {
          if (!cancelled) setHighlightedKey(null)
        }, FOCUS_HIGHLIGHT_DURATION_MS)
      })
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      if (clearTimer) clearTimeout(clearTimer)
    }
  }, [focusModel, activeSource, safeModels, showRecommendedOnly])
  const userVramGB = engineStatus?.hardware?.total_vram_gb

  // 按渠道和推荐过滤，并执行超标计算与加权排序后，分为三组：
  // 已下载 / 待下载（未下载且显存够用）/ 显存不足不可下载
  // 每组内再按 isEmbedding 拆分为「语言模型」与「Embedding 嵌入模型」两类
  const groupedModels = useMemo(() => {
    const matched = safeModels.filter(m => {
      if (!m) return false
      // 用户自定义模型（custom: true）完全脱离主列表，独占下方 CustomModelAddCard 卡片呈现
      if (m.custom) return false
      if (m.source !== activeSource) return false
      // 仅显示推荐打开时过滤非推荐；关闭时展示当前源下全部官方注册模型（含 recommended = false）
      if (showRecommendedOnly && !m.recommended) return false
      return true
    })
    const sorted = sortModels(matched, userVramGB)

    /** 按 isEmbedding 拆分为两类 */
    const splitGroup = (list: typeof sorted) => ({
      language: list.filter(m => !m.isEmbedding),
      embedding: list.filter(m => !!m.isEmbedding)
    })

    return {
      downloaded: splitGroup(sorted.filter(m => m.isDownloaded)),
      notDownloaded: splitGroup(sorted.filter(m => !m.isDownloaded && !m.isEx)),
      vramLimited: splitGroup(sorted.filter(m => !m.isDownloaded && m.isEx))
    }
  }, [safeModels, activeSource, showRecommendedOnly, userVramGB])

  const totalCount =
    groupedModels.downloaded.language.length + groupedModels.downloaded.embedding.length +
    groupedModels.notDownloaded.language.length + groupedModels.notDownloaded.embedding.length +
    groupedModels.vramLimited.language.length + groupedModels.vramLimited.embedding.length

  // 统计各来源官方注册模型数量（排除用户自定义模型）
  const counts = useMemo(() => {
    const scopeCount = safeModels.filter(m => m && !m.custom && m.source === 'modelscope').length
    const hfCount = safeModels.filter(m => m && !m.custom && m.source === 'huggingface').length
    return { modelscope: scopeCount, huggingface: hfCount }
  }, [safeModels])

  // 查找外部聚焦目标在当前来源下的模型信息（Issue 0046 §3：模型上方安装提示）
  const targetFocusModel = useMemo(() => {
    const kw = focusModel?.trim().toLowerCase()
    if (!kw) return null
    return safeModels.find(
      m => m && !m.custom && m.source === activeSource && (m.id.toLowerCase().includes(kw) || m.name.toLowerCase().includes(kw))
    ) || null
  }, [focusModel, activeSource, safeModels])

  // 统一渲染单行模型条目
  const renderModelRow = (model: EnrichedModelItem) => {
    const modelKey = `${model.id}@${model.source}`
    // 双槽位解耦判定：
    // - 嵌入向量模型：对比 activeEmbeddingModelKey，未配置时已下载的 WeMM 默认视为就绪
    // - 语言模型：对比 activeLanguageModelKey，未启动或未配置时降级使用 activeModelKey
    // 强制守卫：未下载模型绝不可标记为已激活状态（isCurrent 必须以 isDownloaded 为前提）
    const isCurrent = Boolean(model.isDownloaded) && (model.isEmbedding
      ? (activeEmbeddingModelKey === modelKey || (!activeEmbeddingModelKey && (activeModelKey === modelKey || model.id.toLowerCase().includes('wemm'))))
      : (activeLanguageModelKey === modelKey || (!activeLanguageModelKey && activeModelKey === modelKey)))
    // 运行态（已启动/启动中）只归属于引擎进程实际加载的模型（activeModelKey 由 current_model 反查得到）；
    // 与槽位激活态解耦，避免「语言模型在跑，嵌入模型却显示已启动」以及由此导致的无法手动切换。
    const isActiveModel = Boolean(model.isDownloaded) && activeModelKey === modelKey

    return (
      <ModelRowItem
        key={modelKey}
        model={model}
        isCurrent={isCurrent}
        isActiveModel={isActiveModel}
        isEx={model.isEx}
        highlighted={highlightedKey === modelKey}
        onActivate={async (id, source, localPath, modelName) => {
          await switchModel(id, source, localPath, modelName || model.name, model.isEmbedding)
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
              {downloadingBySource.modelscope > 0 && (
                <span className="ml-1 flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" title={t('正在下载中')} />
              )}
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
              {downloadingBySource.huggingface > 0 && (
                <span className="ml-1 flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" title={t('正在下载中')} />
              )}
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
          {/* 跨源下载进行中提示条：当用户切到另一源时，明确告知后台正在下载并允许一键切回 */}
          {downloadingBySource.activeTask && downloadingBySource.activeTask.source !== activeSource && (
            <div className="mb-4 flex items-center justify-between gap-3 p-3 rounded-xl border border-primary/30 bg-primary/10 text-primary shadow-2xs animate-in fade-in duration-200">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                <span>
                  {t('正在从 {source} 下载模型（进度 {progress}%，速度 {speed}），切回即可查看实时卡片。', {
                    source: downloadingBySource.activeTask.source === 'modelscope' ? 'ModelScope' : 'HuggingFace',
                    progress: downloadingBySource.activeTask.progress,
                    speed: formatSpeed(downloadingBySource.activeTask.speedBps)
                  })}
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs px-2.5 rounded-lg border-primary/40 bg-background/80 hover:bg-background font-bold text-primary shrink-0"
                onClick={() => setActiveSource(downloadingBySource.activeTask!.source)}
              >
                {t('切回查看')}
              </Button>
            </div>
          )}
          {/* 外部深链聚焦且目标模型尚未下载时，在模型上方显示明确安装引导提示（Issue 0046 §3） */}
          {targetFocusModel && !targetFocusModel.isDownloaded && (
            <div className="mb-4 flex items-center justify-between gap-3 p-3.5 rounded-xl border border-primary/30 bg-primary/10 text-primary shadow-2xs animate-in fade-in slide-in-from-top-2 duration-300">
              <div className="flex items-center gap-2.5 min-w-0">
                <Sparkles className="w-4 h-4 text-primary shrink-0" />
                <span className="text-xs font-semibold leading-relaxed">
                  {t('主程序已开启高维修正与视频检索，请先下载安装下方高亮的 {name} 嵌入模型。', { name: targetFocusModel.name })}
                </span>
              </div>
            </div>
          )}

          {/* 首次下载气泡引导（PRD-0043）：无任何已下载模型时激活 */}
          {isGuideActive && (
            <ModelBubbleGuide onSessionDismiss={() => setGuideSessionDismissed(true)} />
          )}
          {totalCount === 0 ? (
            <div className="text-center py-16 text-muted-foreground/50 font-bold text-xs">
              {showRecommendedOnly ? t('暂无官方推荐模型') : t('该来源暂无可用模型')}
            </div>
          ) : (
            <div className="space-y-8" ref={listContainerRef}>
              {/* ── 语言模型区块 ── */}
              {(groupedModels.downloaded.language.length > 0 ||
                groupedModels.notDownloaded.language.length > 0 ||
                groupedModels.vramLimited.language.length > 0) && (
                <div className="space-y-5">
                  {/* 语言模型区块标题 + 说明 */}
                  <div className="flex items-start gap-3">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary mt-0.5">
                      <FileText className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-sm font-extrabold text-foreground tracking-tight leading-snug">
                        {t('语言模型')}
                      </h2>
                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                        {t('用于文件内容理解、标签生成与智能描述。激活后引擎将加载该模型进行 AI 分析。')}
                      </p>
                    </div>
                  </div>

                  {/* 语言模型共用表头 */}
                  <div className="rounded-xl border border-border/60 overflow-hidden">
                    <ModelColumnHeader />
                  </div>

                  {groupedModels.downloaded.language.length > 0 && (
                    <ModelGroupSection
                      icon={<FileCheck2 className="h-3 w-3" />}
                      iconClass="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"
                      title={t('已下载模型')}
                      count={groupedModels.downloaded.language.length}
                    >
                      {groupedModels.downloaded.language.map(renderModelRow)}
                    </ModelGroupSection>
                  )}

                  {groupedModels.notDownloaded.language.length > 0 && (
                    <ModelGroupSection
                      icon={<Download className="h-3 w-3" />}
                      iconClass="border-primary/30 text-primary bg-primary/10"
                      title={t('待下载模型')}
                      count={groupedModels.notDownloaded.language.length}
                    >
                      {groupedModels.notDownloaded.language.map(renderModelRow)}
                    </ModelGroupSection>
                  )}

                  {groupedModels.vramLimited.language.length > 0 && (
                    <ModelGroupSection
                      icon={<AlertCircle className="h-3 w-3" />}
                      iconClass="border-destructive/30 text-destructive bg-destructive/10"
                      title={t('显存不足 · 不可下载')}
                      count={groupedModels.vramLimited.language.length}
                      collapsible
                    >
                      {groupedModels.vramLimited.language.map(renderModelRow)}
                    </ModelGroupSection>
                  )}
                </div>
              )}

              {/* ── Embedding 嵌入模型区块 ── */}
              {(groupedModels.downloaded.embedding.length > 0 ||
                groupedModels.notDownloaded.embedding.length > 0 ||
                groupedModels.vramLimited.embedding.length > 0) && (
                <div className="space-y-5">
                  {/* 分隔线 */}
                  <div className="h-px bg-border/50" />

                  {/* Embedding 模型区块标题 + 说明 */}
                  <div className="flex items-start gap-3">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400 mt-0.5">
                      <Sparkles className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-sm font-extrabold text-foreground tracking-tight leading-snug">
                        {t('Embedding 嵌入模型')}
                      </h2>
                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                        {t('用于高维向量修正与视频内容语义检索。安装后可大幅提升标签精准度，并支持自然语言搜索视频内容。不参与语言模型的激活与推理流程，独立静默运行。')}
                      </p>
                    </div>
                  </div>

                  {/* Embedding 模型共用表头 */}
                  <div className="rounded-xl border border-border/60 overflow-hidden">
                    <ModelColumnHeader />
                  </div>

                  {groupedModels.downloaded.embedding.length > 0 && (
                    <ModelGroupSection
                      icon={<FileCheck2 className="h-3 w-3" />}
                      iconClass="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"
                      title={t('已下载模型')}
                      count={groupedModels.downloaded.embedding.length}
                    >
                      {groupedModels.downloaded.embedding.map(renderModelRow)}
                    </ModelGroupSection>
                  )}

                  {groupedModels.notDownloaded.embedding.length > 0 && (
                    <ModelGroupSection
                      icon={<Download className="h-3 w-3" />}
                      iconClass="border-primary/30 text-primary bg-primary/10"
                      title={t('待下载模型')}
                      count={groupedModels.notDownloaded.embedding.length}
                    >
                      {groupedModels.notDownloaded.embedding.map(renderModelRow)}
                    </ModelGroupSection>
                  )}

                  {groupedModels.vramLimited.embedding.length > 0 && (
                    <ModelGroupSection
                      icon={<AlertCircle className="h-3 w-3" />}
                      iconClass="border-destructive/30 text-destructive bg-destructive/10"
                      title={t('显存不足 · 不可下载')}
                      count={groupedModels.vramLimited.embedding.length}
                      collapsible
                    >
                      {groupedModels.vramLimited.embedding.map(renderModelRow)}
                    </ModelGroupSection>
                  )}
                </div>
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
            (engineStatus?.status === 'ready' || engineStatus?.status === 'processing')
            : false
        }
        onClose={() => setDrawerModel(null)}
      />
    </Card>
  )
}
