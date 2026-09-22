import React, { useState, useEffect, useMemo } from 'react'
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
  Globe2,
  Star,
  Zap,
  HardDrive,
  FileText,
  Music,
  GraduationCap,
  Settings2,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  AlertCircle
} from 'lucide-react'
import { Card } from '../ui/card'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { Slider } from '../ui/slider'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs'
import { useEngineStore } from '../../stores/engine-store'
import { useModelDownload } from '../../hooks/use-model-download'
import { ModelItem, ModelSource, RuntimeParams } from '../../api/types'
import { formatFileSize, formatSpeed, calculateRemainingTime } from '../../lib/utils'
import { useI18nStore, t } from '../../lib/i18n'
import { sortModels } from '../../lib/model-sorting'
import {
  getModelCustomParams,
  saveModelCustomParams,
  clearModelCustomParams,
  DEFAULT_MODEL_PARAMS
} from '../../lib/model-param-storage'

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
      label: t('models.intelLevel1') || t('小学生'),
      badgeClass: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
    },
    2: {
      label: t('models.intelLevel2') || t('初中生'),
      badgeClass: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30'
    },
    3: {
      label: t('models.intelLevel3') || t('高中生'),
      badgeClass: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30'
    },
    4: {
      label: t('models.intelLevel4') || t('大学生'),
      badgeClass: 'bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/30 font-extrabold'
    }
  }

  return configMap[id]
}

// 别名保留，函数本身接收 id 返回对应配置
export const INTELLIGENCE_CONFIG = getIntelligenceConfig

interface ModelCardProps {
  model: ModelItem
  isCurrent: boolean
  isEx?: boolean
  onActivate: (modelId: string, source?: string) => Promise<boolean | void>
}

const ModelCardItem: React.FC<ModelCardProps> = ({ model, isCurrent, isEx = false, onActivate }) => {
  const { t } = useI18nStore()
  const { fetchModels, runtimeParams, updateRuntimeParams } = useEngineStore()
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

  // 如果有投机采样加速模型 (dspark)，为其初始化下载控制
  const dsparkId = model.dspark as string | undefined
  const {
    state: dsparkDl,
    startDownload: startDsparkDownload
  } = useModelDownload(dsparkId || '', {
    source: model.source,
    onDownloadComplete: () => {
      fetchModels()
    }
  })

  // 展开专属参数配置状态
  const [showConfig, setShowConfig] = useState(false)
  const [isActivating, setIsActivating] = useState(false)
  const [customParams, setCustomParams] = useState<RuntimeParams>(() => {
    const saved = getModelCustomParams(model.id)
    return { ...DEFAULT_MODEL_PARAMS, ...runtimeParams, ...saved }
  })
  const [hasSavedConfig, setHasSavedConfig] = useState<boolean>(() => {
    return !!getModelCustomParams(model.id)
  })
  const [configSavedTip, setConfigSavedTip] = useState(false)

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

  // 整理能力列表
  const capabilities = useMemo(() => {
    if (Array.isArray(model.capabilities) && model.capabilities.length > 0) {
      return model.capabilities
    }
    const list = ['TEXT']
    if (model.isMultiModal) list.push('IMAGE')
    return list
  }, [model.capabilities, model.isMultiModal])

  // 保存专属参数
  const handleSaveParams = async () => {
    saveModelCustomParams(model.id, customParams)
    setHasSavedConfig(true)
    setConfigSavedTip(true)
    setTimeout(() => setConfigSavedTip(false), 2500)

    // 如果当前就是运行中的模型，即时应用到运行时
    if (isCurrent) {
      await updateRuntimeParams(customParams)
    }
  }

  // 重置专属参数
  const handleResetParams = () => {
    clearModelCustomParams(model.id)
    setCustomParams({ ...DEFAULT_MODEL_PARAMS, ...runtimeParams })
    setHasSavedConfig(false)
    setConfigSavedTip(true)
    setTimeout(() => setConfigSavedTip(false), 2000)
  }

  // 处理激活/设为生效
  const handleActivate = async () => {
    try {
      setIsActivating(true)
      await onActivate(model.id, model.source)
    } finally {
      setIsActivating(false)
    }
  }

  return (
    <div
      className={`group relative flex flex-col justify-between p-5 rounded-2xl border transition-all ${
        isEx
          ? 'opacity-40 grayscale-[0.6] border-border bg-muted/10'
          : isCurrent
            ? 'bg-primary/5 border-primary shadow-md ring-2 ring-primary/15'
            : 'bg-card/90 border-border hover:border-primary/60 hover:shadow-xs'
      }`}
    >
      {/* 激活角标 */}
      {isCurrent && (
        <Badge className="absolute -top-2.5 -right-2.5 h-5.5 px-2.5 bg-primary text-primary-foreground shadow-xs rounded-full text-[11px] font-bold pointer-events-none z-10 flex items-center gap-1 border border-primary-foreground/20">
          <Check className="h-3 w-3" />
          <span>{t('已激活')}</span>
        </Badge>
      )}
      {/* 显存不足角标 */}
      {isEx && (
        <Badge className="absolute -top-2.5 -right-2.5 h-5.5 px-2.5 bg-destructive text-destructive-foreground shadow-xs rounded-full text-[11px] font-bold pointer-events-none z-10 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          <span>{t('显存不足')}</span>
        </Badge>
      )}

      <div>
        {/* 卡片头部：标题 + 核心徽章 */}
        <div className="flex items-start justify-between gap-2.5 mb-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h4 className="font-bold text-base text-foreground tracking-tight leading-snug">
                {model.name}
              </h4>
              {/* 官方推荐 Badge */}
              {model.recommended && (
                <Badge className="text-[10px] font-bold h-5 px-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white border-none shadow-xs flex items-center gap-1 shrink-0">
                  <Star className="h-3 w-3 fill-current text-white" />
                  <span>{t('推荐')}</span>
                </Badge>
              )}
              {/* 智能级别 Badge */}
              {intelligence && (
                <Badge
                  variant="outline"
                  className={`text-[10px] font-bold h-5 px-2 flex items-center gap-1 shrink-0 ${intelligence.badgeClass}`}
                >
                  <GraduationCap className="h-3 w-3" />
                  <span>{t('智能程度')}：{intelligence.label}</span>
                </Badge>
              )}
            </div>

            {/* 模型架构参数与量化信息 */}
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <span className="font-mono text-xs font-bold text-foreground/90 bg-muted px-2 py-0.5 rounded-md border border-border/70">
                {model.params || '0.8B'}
              </span>
              <span className="font-mono text-xs font-semibold text-muted-foreground bg-muted/60 px-2 py-0.5 rounded-md border border-border/60">
                {model.quant || 'Q4_K_M'}
              </span>
              <span className="font-mono text-xs font-semibold text-muted-foreground flex items-center gap-1">
                <HardDrive className="h-3 w-3 text-muted-foreground/70" />
                {model.size || formatFileSize(model.fileSize)}
              </span>
              {model.vramNeededGB && (
                <span
                  className={`text-[11px] font-bold ${
                    isEx ? 'text-destructive' : 'text-blue-600 dark:text-blue-400'
                  }`}
                >
                  {t('预估显存')} ~{model.vramNeededGB} GB
                </span>
              )}
            </div>
          </div>
        </div>

        {/* 能力标签栏 (文本 / 图片) */}
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          {capabilities.map(cap => {
            const isText = cap === 'TEXT'
            const isImage = cap === 'IMAGE' || cap === 'VISION'
            return (
              <Badge
                key={cap}
                variant="outline"
                className={`text-[10px] font-bold h-5 px-2 flex items-center gap-1 ${
                  isText
                    ? 'border-emerald-500/30 text-emerald-700 dark:text-emerald-400 bg-emerald-500/10'
                    : isImage
                      ? 'border-purple-500/30 text-purple-700 dark:text-purple-400 bg-purple-500/10'
                      : 'border-border/70 text-muted-foreground bg-muted/40'
                }`}
              >
                {isText ? (
                  <FileText className="h-2.5 w-2.5" />
                ) : isImage ? (
                  <Eye className="h-2.5 w-2.5" />
                ) : (
                  <Music className="h-2.5 w-2.5" />
                )}
                <span>
                  {isText ? t('文本理解') : isImage ? t('图片识别') : cap}
                </span>
              </Badge>
            )
          })}
        </div>

        {/* 描述信息 */}
        {model.description && (
          <p className="text-xs text-muted-foreground leading-relaxed mt-2.5 line-clamp-2">
            {model.description}
          </p>
        )}
      </div>

      {/* 展开的自定义模型参数配置表单 */}
      {showConfig && (
        <div className="mt-4 pt-4 border-t border-border/60 space-y-3.5 bg-muted/20 -mx-5 -mb-2 p-5 rounded-b-2xl">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-bold text-foreground flex items-center gap-1.5">
              <Settings2 className="h-3.5 w-3.5 text-primary" />
              <span>{t('模型专属启动参数')}</span>
            </Label>
            {configSavedTip && (
              <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1 animate-in fade-in">
                <Check className="h-3 w-3" />
                {t('参数已即时生效并保存')}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            {/* GPU 卸载层数 */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('GPU 卸载层数 (ngl)')}</span>
                <span className="font-mono font-bold">{customParams.n_gpu_layers}</span>
              </div>
              <Slider
                value={customParams.n_gpu_layers}
                min={0}
                max={99}
                step={1}
                onChange={val => setCustomParams(p => ({ ...p, n_gpu_layers: val }))}
              />
            </div>

            {/* 上下文长度 */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('上下文长度 (ctx_size)')}</span>
                <span className="font-mono font-bold">{customParams.ctx_size}</span>
              </div>
              <Slider
                value={customParams.ctx_size}
                min={1024}
                max={32768}
                step={1024}
                onChange={val => setCustomParams(p => ({ ...p, ctx_size: val }))}
              />
            </div>

            {/* 物理线程数 */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('CPU 线程数 (threads)')}</span>
                <span className="font-mono font-bold">{customParams.threads}</span>
              </div>
              <Slider
                value={customParams.threads}
                min={1}
                max={32}
                step={1}
                onChange={val => setCustomParams(p => ({ ...p, threads: val }))}
              />
            </div>

            {/* 批处理 Batch Size */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('批处理 Batch Size')}</span>
                <span className="font-mono font-bold">{customParams.batch_size}</span>
              </div>
              <Slider
                value={customParams.batch_size}
                min={64}
                max={2048}
                step={64}
                onChange={val => setCustomParams(p => ({ ...p, batch_size: val }))}
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/40">
            {hasSavedConfig && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs px-2.5 text-muted-foreground hover:text-foreground"
                onClick={handleResetParams}
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                {t('恢复默认')}
              </Button>
            )}
            <Button
              size="sm"
              variant="default"
              className="h-7 text-xs px-3 font-bold"
              onClick={handleSaveParams}
            >
              {t('保存参数')}
            </Button>
          </div>
        </div>
      )}

      {/* 底部操作与下载状态 */}
      <div className="mt-4 pt-3 border-t border-border/60">
        {dl.isDownloading || dl.isPaused ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span className="text-primary truncate max-w-[200px]" title={dl.currentFileName}>
                {dl.totalFiles && dl.totalFiles > 1
                  ? `[${(dl.fileIndex || 0) + 1}/${dl.totalFiles}] ${dl.currentFileName}`
                  : dl.currentFileName || t('正在下载...')}
              </span>
              <span className="font-mono text-[11px] font-bold">{dl.progress}%</span>
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
              <Button size="sm" variant="ghost" className="h-7 text-xs px-2.5 rounded-lg text-destructive hover:bg-destructive/10 font-bold" onClick={cancelDownload}>
                <X className="h-3 w-3 mr-1" />
                {t('取消')}
              </Button>
            </div>
          </div>
        ) : dl.status === 'error' ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-destructive truncate">{dl.error || t('下载失败')}</span>
            <Button size="sm" variant="outline" className="h-7.5 text-xs rounded-lg border-border font-bold" onClick={retryDownload}>
              <RotateCw className="h-3 w-3 mr-1" />
              {t('重试')}
            </Button>
          </div>
        ) : isDownloaded ? (
          <div className="space-y-2.5">
            {/* 已就绪模型的物理绝对路径展示 */}
            {model.localPath && (
              <div className="flex items-center justify-between gap-1.5 text-[11px] font-mono text-muted-foreground bg-muted/40 px-2 py-1 rounded-md border border-border/50">
                <div className="flex items-center gap-1 min-w-0 flex-1">
                  <HardDrive className="h-3 w-3 shrink-0 text-muted-foreground/80" />
                  <span className="truncate select-all" title={model.localPath}>
                    {model.localPath}
                  </span>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 text-xs font-bold">
                <FileCheck2 className="h-3.5 w-3.5 shrink-0" />
                <span>{t('已就绪')}</span>
              </div>

              <div className="flex items-center gap-2">
              {/* 配置了 DSpark 加速模型且未下载时，【下载加速模型】按钮始终显示 */}
              {dsparkId && !isDsparkDownloaded && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => startDsparkDownload()}
                  disabled={dsparkDl.isDownloading}
                  title={t('下载投机采样加速模型，大幅提升推理速度')}
                  className="h-7.5 text-xs px-2.5 rounded-lg border-emerald-500/50 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 font-bold flex items-center gap-1 transition-all"
                >
                  <Zap className="h-3 w-3 fill-current text-emerald-500 shrink-0" />
                  <span>{dsparkDl.isDownloading ? t('加速模型下载中...') : t('下载加速模型')}</span>
                </Button>
              )}

              {/* 参数配置按钮：hover 时才显示（如果展开状态则始终保持显示） */}
              <Button
                size="sm"
                variant="outline"
                className={`h-7.5 text-xs px-2.5 rounded-lg border-border hover:border-primary/60 font-bold flex items-center gap-1 transition-all ${
                  showConfig ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                onClick={() => setShowConfig(!showConfig)}
              >
                <Settings2 className="h-3.5 w-3.5 text-primary" />
                <span>{t('参数配置')}</span>
                {showConfig ? <ChevronUp className="h-3 w-3 ml-0.5" /> : <ChevronDown className="h-3 w-3 ml-0.5" />}
              </Button>

              {/* 激活/运行中状态：总是显示 */}
              {isCurrent ? (
                <Badge className="bg-primary text-primary-foreground font-bold px-3 py-1 rounded-full text-xs shadow-xs border border-primary/40 shrink-0">
                  <Check className="h-3 w-3 mr-1 shrink-0" />
                  {t('运行中')}
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
                  variant="secondary"
                  className="h-7.5 text-xs px-3.5 rounded-lg font-bold border border-border hover:border-primary/50 shrink-0"
                  onClick={handleActivate}
                  disabled={isActivating}
                >
                  {isActivating ? t('切换中...') : t('激活')}
                </Button>
              )}
            </div>
          </div>
        </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground/80 font-medium">
              {isEx ? (
                <span className="text-destructive font-semibold flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {t('超出显存限制')}
                </span>
              ) : (
                t('尚未下载到本地')
              )}
            </span>
            <div className="flex items-center gap-2">
              {/* 预设参数按钮：hover 时才显示（如果展开状态则始终保持显示） */}
              <Button
                size="sm"
                variant="outline"
                className={`h-7.5 text-xs px-2.5 rounded-lg border-border hover:border-primary/60 font-bold flex items-center gap-1 transition-all ${
                  showConfig ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                onClick={() => setShowConfig(!showConfig)}
              >
                <Settings2 className="h-3.5 w-3.5" />
                <span>{t('预设参数')}</span>
                {showConfig ? <ChevronUp className="h-3 w-3 ml-0.5" /> : <ChevronDown className="h-3 w-3 ml-0.5" />}
              </Button>

              {/* 下载模型按钮：未超标时 hover 显示，超标时禁用显示 */}
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
                  variant="default"
                  className="h-7.5 text-xs px-3.5 rounded-lg font-bold shadow-xs shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => startDownload()}
                >
                  <Download className="h-3 w-3 mr-1.5 shrink-0" />
                  {t('下载模型')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export const ModelListPanel: React.FC = () => {
  const { t } = useI18nStore()
  const { models, fetchModels, activeModelKey, switchModel, regionInfo, engineStatus } = useEngineStore()
  const [activeSource, setActiveSource] = useState<ModelSource>('modelscope')
  const [showRecommendedOnly, setShowRecommendedOnly] = useState<boolean>(true)

  useEffect(() => {
    fetchModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const safeModels = Array.isArray(models) ? models : []
  const userVramGB = engineStatus?.hardware?.total_vram_gb

  // 按渠道和推荐过滤，并执行超标计算与加权排序
  const filteredModels = useMemo(() => {
    const matched = safeModels.filter(m => {
      if (!m) return false
      if (m.source !== activeSource) return false
      if (showRecommendedOnly && !m.recommended) return false
      return true
    })
    return sortModels(matched, userVramGB)
  }, [safeModels, activeSource, showRecommendedOnly, userVramGB])

  // 统计各来源数量
  const counts = useMemo(() => {
    const scopeCount = safeModels.filter(m => m && m.source === 'modelscope').length
    const hfCount = safeModels.filter(m => m && m.source === 'huggingface').length
    return { modelscope: scopeCount, huggingface: hfCount }
  }, [safeModels])

  return (
    <Card className="p-0 overflow-hidden border border-border/70 rounded-2xl bg-card shadow-xs">
      {/* 头部面板说明与来源镜像指示 */}
      <div className="p-5 border-b border-border/40 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <Label className="text-base font-bold tracking-tight text-foreground flex items-center gap-2">
            <Boxes className="h-4 w-4 text-primary" />
            <span>{t('模型下载与管理')}</span>
          </Label>
          <p className="text-xs text-muted-foreground font-normal mt-1 leading-relaxed">
            {t('模型决定了文本与多模态分析的准确率与速度。支持为每个模型单独配置引擎启动参数。')}
          </p>
        </div>

        {/* 生效镜像指示器 */}
        <Badge
          variant={regionInfo?.region === 'cn' ? 'success' : 'info'}
          className="text-[10px] font-semibold h-6 self-start sm:self-auto flex items-center gap-1 shrink-0 border border-border/40"
        >
          <Globe2 className="h-3 w-3" />
          <span>
            {regionInfo?.region === 'cn'
              ? t('当前已生效国内高速加速源')
              : t('当前生效海外官方直连源')}
          </span>
        </Badge>
      </div>

      {/* Tabs 栏：复刻 Desktop 风格 + 右侧 Switch 仅显示推荐 */}
      <Tabs value={activeSource} onValueChange={val => setActiveSource(val as ModelSource)} className="w-full">
        <div className="flex items-center justify-between border-b border-border/40 bg-muted/30 px-4">
          <TabsList className="flex justify-start h-12 bg-transparent p-0 border-b-0 rounded-none overflow-x-auto no-scrollbar gap-2">
            <TabsTrigger
              value="modelscope"
              className="flex-shrink-0 px-4 h-full rounded-none font-bold text-xs data-[state=active]:border-b-[3px] data-[state=active]:border-primary data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=inactive]:text-muted-foreground transition-all border-b-[3px] border-transparent hover:text-foreground hover:bg-muted/40 relative flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5 text-inherit" />
              <span>ModelScope ({t('国内高速')})</span>
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

        {/* 列表内容区 */}
        <TabsContent value={activeSource} className="p-5 focus-visible:ring-0 m-0">
          {filteredModels.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground/50 font-bold text-xs">
              {showRecommendedOnly ? t('暂无官方推荐模型') : t('该来源暂无可用模型')}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredModels.map(model => {
                const modelKey = `${model.id}@${model.source}`
                const isCurrent = activeModelKey === modelKey
                return (
                  <ModelCardItem
                    key={modelKey}
                    model={model}
                    isCurrent={isCurrent}
                    isEx={model.isEx}
                    onActivate={async (id, source) => {
                      await switchModel(id, source)
                    }}
                  />
                )
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </Card>
  )
}
