import React, { useState, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  X,
  Settings2,
  Cpu,
  Sliders,
  RotateCcw,
  Check,
  AlertTriangle,
  RotateCw,
  HardDrive,
  Eye,
  Zap,
  Sparkles,
  Layers
} from 'lucide-react'
import { ModelItem, RuntimeParams, ModelBudgetInfo } from '../../api/types'
import { useEngineStore } from '../../stores/engine-store'
import { t } from '../../languages'
import { DEFAULT_MODEL_PARAMS, getModelCustomParams, clearModelCustomParams, calculateRecommendedParams } from '../../lib/model-param-storage'
import { Button } from '../ui/button'
import { Slider } from '../ui/slider'
import { Checkbox } from '../ui/checkbox'

interface ModelParamDrawerProps {
  isOpen: boolean
  model: ModelItem | null
  isCurrentRunning: boolean
  onClose: () => void
}

/**
 * 严格比对两份超参配置是否实质相等（覆盖全部 14 个可调超参与伴随模型开关）
 */
function areParamsEqual(a: RuntimeParams | null, b: RuntimeParams | null): boolean {
  if (!a || !b) return a === b
  return (
    Number(a.n_gpu_layers) === Number(b.n_gpu_layers) &&
    Number(a.threads) === Number(b.threads) &&
    Number(a.ctx_size) === Number(b.ctx_size) &&
    Number(a.batch_size) === Number(b.batch_size) &&
    Number(a.ubatch_size) === Number(b.ubatch_size) &&
    String(a.cache_type_k || 'f16') === String(b.cache_type_k || 'f16') &&
    String(a.cache_type_v || 'f16') === String(b.cache_type_v || 'f16') &&
    Number(a.parallel || 1) === Number(b.parallel || 1) &&
    Math.round(Number(a.temp ?? 0.7) * 100) === Math.round(Number(b.temp ?? 0.7) * 100) &&
    Math.round(Number(a.top_p ?? 0.95) * 100) === Math.round(Number(b.top_p ?? 0.95) * 100) &&
    Number(a.top_k ?? 40) === Number(b.top_k ?? 40) &&
    Math.round(Number(a.repeat_penalty ?? 1.1) * 100) === Math.round(Number(b.repeat_penalty ?? 1.1) * 100) &&
    Boolean(a.enableVision !== false) === Boolean(b.enableVision !== false) &&
    Boolean(a.enableDraft !== false) === Boolean(b.enableDraft !== false) &&
    Number(a.draftMaxTokens || 6) === Number(b.draftMaxTokens || 6)
  )
}

const ModelParamDrawerInner: React.FC<ModelParamDrawerProps> = ({
  isOpen,
  model,
  isCurrentRunning,
  onClose
}) => {
  // 细粒度订阅：绝不整取 store。
  // 引擎状态由 Footer 每 2.5s 静默轮询刷新，整取会让本抽屉（20+ 滑块与三组卡片）
  // 跟随每一次轮询全量重渲染，主线程被占满后点击勾选的响应就会被明显拖慢。
  const runtimeParams = useEngineStore(s => s.runtimeParams)
  const saveModelParams = useEngineStore(s => s.saveModelParams)
  const startEngine = useEngineStore(s => s.startEngine)
  const stopEngine = useEngineStore(s => s.stopEngine)
  // 硬件信息每轮询都是全新对象引用（后端 JSON 反序列化），用 useShallow 按字段内容比较，
  // 只有显存/核显标记/线程/加速层级真正变化时才重渲染与重算推荐值。
  const hardware = useEngineStore(useShallow(s => s.engineStatus?.hardware ?? null))

  const recommendedParams = React.useMemo(() => {
    return calculateRecommendedParams(model, hardware)
  }, [model, hardware])

  const [params, setParams] = useState<RuntimeParams>(DEFAULT_MODEL_PARAMS)
  // 当前已持久化保存的参数基准（用于脏检查比对与保存按钮高亮/置灰控制）
  const [savedParams, setSavedParams] = useState<RuntimeParams | null>(null)
  const [backendRecommended, setBackendRecommended] = useState<RuntimeParams | null>(null)
  const [backendBudget, setBackendBudget] = useState<ModelBudgetInfo | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [savedSuccess, setSavedSuccess] = useState(false)
  const [showRestartPrompt, setShowRestartPrompt] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)

  // 有效推荐配置：后端 SSOT 优先，无后端推荐时以本地启发式配置兜底
  const effectiveRecommended = backendRecommended ?? recommendedParams

  // 上下文滑块动态上限与压力比率
  const maxContextSize = Math.min(131072, Math.max(32768, backendBudget?.max_train_ctx ?? 32768))
  const pressureRatio = React.useMemo(() => {
    if (!backendBudget || !backendBudget.budget_ctx) return 0
    return params.ctx_size / backendBudget.budget_ctx
  }, [backendBudget, params.ctx_size])

  // 加载逻辑只认「抽屉打开」与「模型切换」两个触发源。
  // 严禁把 runtimeParams / recommendedParams / hardware 放进依赖数组：
  // 引擎状态由 Footer 每 2.5s 静默轮询，后端返回的 runtime_params 与 hardware 每次都是新对象引用，
  // 一旦这些易变值进入依赖，effect 就会在用户点击勾选之后重新请求 /api/models/params
  // 并 setParams(initial) 把用户刚改的勾选覆盖回持久化值——表现为「勾选项点了没反应 /
  // 要连点好几次 / 反应很慢」。易变值改为在 effect 执行时从 store 快照读取，依赖数组保持恒定。
  const modelId = model?.id ?? null

  useEffect(() => {
    if (!isOpen || !modelId) return
    let isCancelled = false

    const loadParams = async () => {
      // 读取执行时刻的最新快照（而非渲染闭包里的旧值），避免依赖抖动
      const { getModelParams: fetchParams, saveModelParams: persistParams, runtimeParams: liveRuntimeParams } =
        useEngineStore.getState()
      const hardwareSnapshot = useEngineStore.getState().engineStatus?.hardware ?? null
      const localRecommended = calculateRecommendedParams(model, hardwareSnapshot)

      // 1. 先尝试从后端获取该模型持久化参数、SSOT 智能推荐与预算
      const resp = await fetchParams(modelId)
      if (isCancelled) return

      const fetchedRecommended = resp?.recommended ?? null
      const fetchedBudget = resp?.budget ?? null
      setBackendRecommended(fetchedRecommended)
      setBackendBudget(fetchedBudget)

      const baseRecommended = fetchedRecommended ?? localRecommended

      let initial: RuntimeParams
      const backendSaved = resp?.params
      if (backendSaved && Object.keys(backendSaved).length > 0) {
        // 已有已保存自定义配置：以智能推荐配置为底合并已保存参数
        initial = { ...baseRecommended, ...liveRuntimeParams, ...backendSaved }
      } else {
        // 尝试从 legacy localStorage 中平滑迁移 (Read-Migrate-Purge)
        const legacySaved = getModelCustomParams(modelId)
        if (legacySaved && Object.keys(legacySaved).length > 0) {
          initial = { ...baseRecommended, ...liveRuntimeParams, ...legacySaved }
          // 异步迁移至后端并清理 localStorage
          persistParams(modelId, initial).catch(err => {
            console.warn('迁移本地历史配置至后端失败:', err)
          })
          clearModelCustomParams(modelId)
        } else {
          // 初始使用智能推荐配置
          initial = { ...baseRecommended }
        }
      }
      setParams(initial)
      setSavedParams(initial)
    }

    loadParams()
    setSavedSuccess(false)
    setShowRestartPrompt(false)

    return () => {
      isCancelled = true
    }
  }, [isOpen, modelId])

  // 脏检查：当前编辑中的 params 与已保存持久化参数基准比对
  const isDirty = React.useMemo(() => {
    return !areParamsEqual(params, savedParams)
  }, [params, savedParams])

  if (!isOpen || !model) return null

  // 联动校验：微批强制 <= 批大小
  const handleBatchSizeChange = (val: number) => {
    setParams(prev => {
      const newUbatch = prev.ubatch_size > val ? val : prev.ubatch_size
      return { ...prev, batch_size: val, ubatch_size: newUbatch }
    })
  }

  const handleUbatchSizeChange = (val: number) => {
    setParams(prev => ({
      ...prev,
      ubatch_size: Math.min(val, prev.batch_size)
    }))
  }

  // 恢复保守配置（恢复系统保守基准超参，需用户主动点击保存才持久化）
  const handleResetConservative = () => {
    setParams({ ...DEFAULT_MODEL_PARAMS, ...runtimeParams })
  }

  // 恢复当前硬件智能推荐（恢复自适应最佳超参，需用户主动点击保存才持久化）
  const handleResetRecommended = () => {
    setParams({ ...effectiveRecommended })
  }

  // 伴随模型能力判定（多模态识图与 DSpark 投机加速，覆盖 mmprojLocalPath 与 draftLocalPath）
  const hasVisionCapability = Boolean(model?.isMultiModal || model?.mmproj || model?.mmprojLocalPath)
  const hasDraftCapability = Boolean(model?.dspark || model?.draftLocalPath)
  const hasCompanionModels = hasVisionCapability || hasDraftCapability

  // 保存参数
  const handleSave = async () => {
    try {
      setIsSaving(true)
      // 确保微批严格小于等于批处理
      const safeParams: RuntimeParams = {
        ...params,
        ubatch_size: Math.min(params.ubatch_size, params.batch_size)
      }

      // 持久化至后端 SSOT config.json
      await saveModelParams(model.id, safeParams)

      // 3. 更新已保存基准，使保存按钮重回未修改（置灰）态
      setSavedParams(safeParams)

      setSavedSuccess(true)
      setTimeout(() => setSavedSuccess(false), 2500)

      // 3. 若当前模型正在运行中，弹出提示询问是否立即重启
      if (isCurrentRunning) {
        setShowRestartPrompt(true)
      } else {
        setTimeout(() => onClose(), 600)
      }
    } catch (e) {
      console.error('保存参数失败:', e)
    } finally {
      setIsSaving(false)
    }
  }

  // 立即重启生效
  const handleImmediateRestart = async () => {
    try {
      setIsRestarting(true)
      await stopEngine()
      await startEngine()
      setShowRestartPrompt(false)
      onClose()
    } catch (e) {
      console.error('重启引擎失败:', e)
    } finally {
      setIsRestarting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-hidden select-none">
      {/* 半透明毛玻璃背景蒙层 */}
      <div
        className="fixed inset-0 bg-background/60 backdrop-blur-xs overlay-fade-in"
        onClick={() => !isSaving && !isRestarting && onClose()}
      />

      {/* 左侧滑出面板 */}
      <div className="fixed inset-y-0 left-0 flex max-w-full pr-10">
        <div className="w-screen max-w-xl bg-card border-r border-border shadow-2xl flex flex-col justify-between drawer-slide-in-from-left">
          
          {/* 抽屉头部 */}
          <div className="p-6 border-b border-border/60 bg-muted/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
                  <Settings2 className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-foreground tracking-tight leading-snug">
                    {t('模型专属启动参数')}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5 font-medium">
                    {model.name}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-all cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* 模型元数据简报 */}
            <div className="mt-3 flex items-center gap-2 flex-wrap text-[11px] font-mono">
              <span className="bg-muted px-2 py-0.5 rounded-md border border-border/60 text-foreground font-bold">
                {model.params || '0.8B'}
              </span>
              <span className="bg-muted/60 px-2 py-0.5 rounded-md border border-border/60 text-muted-foreground font-semibold">
                {model.quant || 'Q4_K_M'}
              </span>
              {isCurrentRunning && (
                <span className="bg-primary/10 text-primary border border-primary/30 px-2 py-0.5 rounded-md font-sans font-bold flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                  {t('正在运行中')}
                </span>
              )}
            </div>
          </div>

          {/* 抽屉内容区：伴随模型与三大功能组 */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-slim">

            {/* 伴随模型与特性 (Companion Models & Capabilities) */}
            {hasCompanionModels && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 pb-2 border-b border-border/40">
                  <Layers className="h-4 w-4 text-primary" />
                  <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">
                    {t('伴随模型与特性 (Companion Models & Capabilities)')}
                  </h4>
                </div>

                {/* 识图模型 Checkbox */}
                {hasVisionCapability && (
                  <div className="bg-muted/15 p-3.5 rounded-xl border border-border/40 space-y-2">
                    <label className="flex items-start gap-3 cursor-pointer select-none">
                      <Checkbox
                        id="enable-vision"
                        checked={params.enableVision !== false}
                        onCheckedChange={checked => setParams(p => ({ ...p, enableVision: checked }))}
                        className="mt-0.5"
                      />
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-foreground">
                          <Eye className="h-3.5 w-3.5 text-purple-500" />
                          <span>{t('加载识图模型')}</span>
                        </div>
                        <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
                          {t('如果不需要识图，关闭可以节约显存')}
                        </p>
                      </div>
                    </label>
                  </div>
                )}

                {/* 加速模型 Checkbox */}
                {hasDraftCapability && (
                  <div className="bg-muted/15 p-3.5 rounded-xl border border-border/40 space-y-3">
                    <label className="flex items-start gap-3 cursor-pointer select-none">
                      <Checkbox
                        id="enable-draft"
                        checked={params.enableDraft !== false}
                        onCheckedChange={checked => setParams(p => ({ ...p, enableDraft: checked }))}
                        className="mt-0.5"
                      />
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-foreground">
                          <Zap className="h-3.5 w-3.5 text-emerald-500" />
                          <span>{t('加载加速模型 (DSpark)')}</span>
                        </div>
                        <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
                          {t('投机采样加速可显著提升生成速度，但需常驻占用 1~2.5GB 显存；在显存紧张或以短文本为主时不建议开启')}
                        </p>
                      </div>
                    </label>

                    {/* 勾选加速后联动展示 1~8 步数滑块 */}
                    {params.enableDraft !== false && (
                      <div className="pt-2 pl-7 space-y-1.5 border-t border-border/30 animate-in fade-in slide-in-from-top-1">
                        <div className="flex items-center justify-between text-xs">
                          <div>
                            <span className="font-bold text-foreground">{t('投机步数')}</span>
                            <span className="font-mono text-muted-foreground ml-1.5">(--draft-max, draft_max_tokens)</span>
                          </div>
                          <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                            {params.draftMaxTokens ?? 6}
                          </span>
                        </div>
                        <Slider
                          value={params.draftMaxTokens ?? 6}
                          min={1}
                          max={8}
                          step={1}
                          onChange={val => setParams(p => ({ ...p, draftMaxTokens: val }))}
                        />
                        <p className="text-[11px] text-muted-foreground/80">
                          {t('单步最大预测 token 数，增大可提升高命中率下的加速比，但会轻微增加显存压力 (默认: 6)')}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 第一组：硬件与计算性能 */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 pb-2 border-b border-border/40">
                <Cpu className="h-4 w-4 text-primary" />
                <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">
                  {t('硬件与计算性能 (Compute & Hardware)')}
                </h4>
              </div>

              {/* 1. GPU 卸载层数 */}
              <div className="space-y-1.5 bg-muted/15 p-3 rounded-xl border border-border/40">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center flex-wrap gap-1">
                    <span className="font-bold text-foreground">{t('GPU 卸载层数')}</span>
                    <span className="font-mono text-muted-foreground">(-ngl)</span>
                    <span className="text-[10px] text-primary/80 bg-primary/10 px-1.5 py-0.5 rounded font-mono">
                      {t('硬件推荐')}: {effectiveRecommended.n_gpu_layers === -1 ? t('全量卸载 (-1)') : effectiveRecommended.n_gpu_layers}
                    </span>
                  </div>
                  <span className="font-mono font-bold text-primary">
                    {params.n_gpu_layers === -1 ? t('全量卸载 (-1)') : params.n_gpu_layers}
                  </span>
                </div>
                <Slider
                  value={params.n_gpu_layers}
                  min={-1}
                  max={99}
                  step={1}
                  onChange={val => setParams(p => ({ ...p, n_gpu_layers: val }))}
                />
                <p className="text-[11px] text-muted-foreground/80">
                  {t('-1 表示将所有层卸载至 GPU 显存，0 为纯 CPU 推理。')}
                </p>
              </div>

              {/* 2. CPU 线程数 */}
              <div className="space-y-1.5 bg-muted/15 p-3 rounded-xl border border-border/40">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center flex-wrap gap-1">
                    <span className="font-bold text-foreground">{t('CPU 推理线程数')}</span>
                    <span className="font-mono text-muted-foreground">(-t, threads)</span>
                    <span className="text-[10px] text-primary/80 bg-primary/10 px-1.5 py-0.5 rounded font-mono">
                      {t('硬件推荐')}: {effectiveRecommended.threads}
                    </span>
                  </div>
                  <span className="font-mono font-bold text-primary">{params.threads}</span>
                </div>
                <Slider
                  value={params.threads}
                  min={1}
                  max={32}
                  step={1}
                  onChange={val => setParams(p => ({ ...p, threads: val }))}
                />
                <p className="text-[11px] text-muted-foreground/80">
                  {t('分配给推理进程的物理 CPU 核心线程数，建议保留 2 核给系统。')}
                </p>
              </div>

              {/* 3. 批处理大小 Batch Size */}
              <div className="space-y-1.5 bg-muted/15 p-3 rounded-xl border border-border/40">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center flex-wrap gap-1">
                    <span className="font-bold text-foreground">{t('Prompt 批处理大小')}</span>
                    <span className="font-mono text-muted-foreground">(-b, batch_size)</span>
                    <span className="text-[10px] text-primary/80 bg-primary/10 px-1.5 py-0.5 rounded font-mono">
                      {t('硬件推荐')}: {effectiveRecommended.batch_size}
                    </span>
                  </div>
                  <span className="font-mono font-bold text-primary">{params.batch_size}</span>
                </div>
                <Slider
                  value={params.batch_size}
                  min={128}
                  max={4096}
                  step={128}
                  onChange={handleBatchSizeChange}
                />
                <p className="text-[11px] text-muted-foreground/80">
                  {t('处理 Prompt 时的最大批次 token 数，值越大预填充越快但消耗更多显存。')}
                </p>
              </div>

              {/* 4. 微批大小 Ubatch Size */}
              <div className="space-y-1.5 bg-muted/15 p-3 rounded-xl border border-border/40">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center flex-wrap gap-1">
                    <span className="font-bold text-foreground">{t('物理微批大小')}</span>
                    <span className="font-mono text-muted-foreground">(-ub, ubatch_size)</span>
                    <span className="text-[10px] text-primary/80 bg-primary/10 px-1.5 py-0.5 rounded font-mono">
                      {t('硬件推荐')}: {effectiveRecommended.ubatch_size}
                    </span>
                  </div>
                  <span className="font-mono font-bold text-primary">{params.ubatch_size}</span>
                </div>
                <Slider
                  value={params.ubatch_size}
                  min={64}
                  max={2048}
                  step={64}
                  onChange={handleUbatchSizeChange}
                />
                <p className="text-[11px] text-muted-foreground/80">
                  {t('实际每次执行推理计算的物理批次大小，严格受限于 Batch Size。')}
                </p>
              </div>
            </div>

            {/* 第二组：显存优化与并发 */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 pb-2 border-b border-border/40">
                <HardDrive className="h-4 w-4 text-primary" />
                <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">
                  {t('显存优化与并发 (Memory & Concurrency)')}
                </h4>
              </div>

              {/* 5. 上下文长度 */}
              <div className="space-y-1.5 bg-muted/15 p-3 rounded-xl border border-border/40">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center flex-wrap gap-1">
                    <span className="font-bold text-foreground">{t('上下文长度')}</span>
                    <span className="font-mono text-muted-foreground">(-c, ctx_size)</span>
                    <span className="text-[10px] text-primary/80 bg-primary/10 px-1.5 py-0.5 rounded font-mono">
                      {t('硬件推荐')}: {effectiveRecommended.ctx_size}
                    </span>
                    {backendBudget?.budget_ctx && (
                      <span className="text-[10px] text-muted-foreground bg-muted/80 px-1.5 py-0.5 rounded font-mono">
                        {t('安全预算')}: {backendBudget.budget_ctx}
                      </span>
                    )}
                  </div>
                  <span className="font-mono font-bold text-primary">{params.ctx_size}</span>
                </div>
                <Slider
                  value={params.ctx_size}
                  min={1024}
                  max={maxContextSize}
                  step={1024}
                  onChange={val => setParams(p => ({ ...p, ctx_size: val }))}
                />
                <p className="text-[11px] text-muted-foreground/80">
                  {t('最大记忆窗口大小。较长的上下文会显著增加显存占用。')}
                </p>

                {/* 预算压力指示条 */}
                {backendBudget && backendBudget.budget_ctx > 0 && (
                  <div className="pt-2 space-y-1.5 border-t border-border/30">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">
                        {t('显存/内存预算压力')}:
                      </span>
                      <span className={`font-mono font-bold ${
                        pressureRatio <= 0.8
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : pressureRatio <= 1.0
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-destructive dark:text-destructive'
                      }`}>
                        {pressureRatio <= 0.8
                          ? t('充裕 (<=80%)')
                          : pressureRatio <= 1.0
                          ? t('承压优化 (80%~100%)')
                          : t('超额 (>100%)')}
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 rounded-full ${
                          pressureRatio <= 0.8
                            ? 'bg-emerald-500'
                            : pressureRatio <= 1.0
                            ? 'bg-amber-500'
                            : 'bg-destructive'
                        }`}
                        style={{ width: `${Math.min(100, Math.round(pressureRatio * 100))}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* 超额告警卡片 */}
                {Boolean(backendBudget?.budget_ctx && params.ctx_size > backendBudget.budget_ctx) && (
                  <div className="mt-2 p-2.5 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-[11px] flex items-start gap-2 animate-in fade-in">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-bold">{t('超过当前硬件安全预算')}</div>
                      <div className="text-destructive/90 leading-tight mt-0.5">
                        {t('当前设定上下文')} ({params.ctx_size}) {t('超过推荐预算')} ({backendBudget?.budget_ctx})。
                        {t('启动时引擎将自动截断或进行显存降级以避免崩溃。')}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 6. KV 缓存量化 */}
              <div className="space-y-2 bg-muted/15 p-3 rounded-xl border border-border/40">
                <div className="flex items-center justify-between text-xs">
                  <div>
                    <span className="font-bold text-foreground">{t('KV 缓存量化')}</span>
                    <span className="font-mono text-muted-foreground ml-1.5">(-ctk, -ctv)</span>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { key: 'f16', label: 'f16 (无损/高显存)' },
                    { key: 'q8_0', label: 'q8_0 (省50%显存•推荐)' },
                    { key: 'q4_0', label: 'q4_0 (极致轻量)' }
                  ].map(item => {
                    const isSelected = (params.cache_type_k || 'f16') === item.key
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() =>
                          setParams(p => ({
                            ...p,
                            cache_type_k: item.key,
                            cache_type_v: item.key
                          }))
                        }
                        className={`py-2 px-2.5 rounded-lg border text-xs font-bold transition-all text-center cursor-pointer ${
                          isSelected
                            ? 'bg-primary text-primary-foreground border-primary shadow-xs'
                            : 'bg-background hover:bg-muted/70 border-border text-foreground'
                        }`}
                      >
                        {item.label}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground/80">
                  {t('q8_0 在长上下文下可节约大量显存且推理精度几乎无损。')}
                </p>
              </div>

              {/* 7. 并发槽位数 */}
              <div className="space-y-1.5 bg-muted/15 p-3 rounded-xl border border-border/40">
                <div className="flex items-center justify-between text-xs">
                  <div>
                    <span className="font-bold text-foreground">{t('并发处理槽位')}</span>
                    <span className="font-mono text-muted-foreground ml-1.5">(-np, parallel)</span>
                  </div>
                  <span className="font-mono font-bold text-primary">{params.parallel || 1}</span>
                </div>
                <Slider
                  value={params.parallel || 1}
                  min={1}
                  max={4}
                  step={1}
                  onChange={val => setParams(p => ({ ...p, parallel: val }))}
                />
                <p className="text-[11px] text-muted-foreground/80">
                  {t('允许服务同时并发响应的请求数（每个并发槽位都会成倍占用 KV 缓存）。')}
                </p>
              </div>
            </div>

            {/* 第三组：生成与采样超参 */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 pb-2 border-b border-border/40">
                <Sliders className="h-4 w-4 text-primary" />
                <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">
                  {t('生成与采样超参 (Sampling & Generation)')}
                </h4>
              </div>

              {/* 8. 温度 Temperature */}
              <div className="space-y-1.5 bg-muted/15 p-3 rounded-xl border border-border/40">
                <div className="flex items-center justify-between text-xs">
                  <div>
                    <span className="font-bold text-foreground">{t('采样温度')}</span>
                    <span className="font-mono text-muted-foreground ml-1.5">(--temp)</span>
                  </div>
                  <span className="font-mono font-bold text-primary">{(params.temp ?? 0.7).toFixed(2)}</span>
                </div>
                <Slider
                  value={Math.round((params.temp ?? 0.7) * 100)}
                  min={0}
                  max={200}
                  step={5}
                  onChange={val => setParams(p => ({ ...p, temp: val / 100 }))}
                />
                <p className="text-[11px] text-muted-foreground/80">
                  {t('温度越低输出越稳定确定；温度越高生成越有创造力和发散性。')}
                </p>
              </div>

              {/* 9. Top-P 采样 */}
              <div className="space-y-1.5 bg-muted/15 p-3 rounded-xl border border-border/40">
                <div className="flex items-center justify-between text-xs">
                  <div>
                    <span className="font-bold text-foreground">{t('Top-P 核采样')}</span>
                    <span className="font-mono text-muted-foreground ml-1.5">(--top-p)</span>
                  </div>
                  <span className="font-mono font-bold text-primary">{(params.top_p ?? 0.95).toFixed(2)}</span>
                </div>
                <Slider
                  value={Math.round((params.top_p ?? 0.95) * 100)}
                  min={10}
                  max={100}
                  step={5}
                  onChange={val => setParams(p => ({ ...p, top_p: val / 100 }))}
                />
                <p className="text-[11px] text-muted-foreground/80">
                  {t('保留累积概率达到 P 的候选词集，通常与温度搭配使用。')}
                </p>
              </div>

              {/* 10. Top-K 采样 */}
              <div className="space-y-1.5 bg-muted/15 p-3 rounded-xl border border-border/40">
                <div className="flex items-center justify-between text-xs">
                  <div>
                    <span className="font-bold text-foreground">{t('Top-K 采样')}</span>
                    <span className="font-mono text-muted-foreground ml-1.5">(--top-k)</span>
                  </div>
                  <span className="font-mono font-bold text-primary">{params.top_k ?? 40}</span>
                </div>
                <Slider
                  value={params.top_k ?? 40}
                  min={1}
                  max={100}
                  step={1}
                  onChange={val => setParams(p => ({ ...p, top_k: val }))}
                />
                <p className="text-[11px] text-muted-foreground/80">
                  {t('每步只从概率最高的前 K 个词中挑选候选词。')}
                </p>
              </div>

              {/* 11. 重复惩罚 Repeat Penalty */}
              <div className="space-y-1.5 bg-muted/15 p-3 rounded-xl border border-border/40">
                <div className="flex items-center justify-between text-xs">
                  <div>
                    <span className="font-bold text-foreground">{t('重复惩罚系数')}</span>
                    <span className="font-mono text-muted-foreground ml-1.5">(--repeat-penalty)</span>
                  </div>
                  <span className="font-mono font-bold text-primary">{(params.repeat_penalty ?? 1.1).toFixed(2)}</span>
                </div>
                <Slider
                  value={Math.round((params.repeat_penalty ?? 1.1) * 100)}
                  min={100}
                  max={200}
                  step={5}
                  onChange={val => setParams(p => ({ ...p, repeat_penalty: val / 100 }))}
                />
                <p className="text-[11px] text-muted-foreground/80">
                  {t('惩罚已生成的重复内容，防止进入无限重复循环。')}
                </p>
              </div>
            </div>

          </div>

          {/* 运行中模型重启确认弹窗/提示 */}
          {showRestartPrompt && (
            <div className="mx-6 mb-4 p-4 rounded-xl border border-amber-500/40 bg-amber-500/10 animate-in fade-in slide-in-from-bottom-2">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                <div className="text-xs space-y-1">
                  <div className="font-bold text-foreground">{t('参数已保存，需重启引擎后生效')}</div>
                  <p className="text-muted-foreground leading-relaxed">
                    {t('当前模型正在运行中，新启动参数需在服务重新拉起时生效。')}
                  </p>
                  <div className="flex items-center gap-2 pt-2">
                    <Button
                      size="sm"
                      variant="default"
                      onClick={handleImmediateRestart}
                      disabled={isRestarting}
                      className="h-7 text-xs font-bold px-3 bg-amber-600 hover:bg-amber-700 text-white"
                    >
                      <RotateCw className={`h-3 w-3 mr-1 ${isRestarting ? 'animate-spin' : ''}`} />
                      {isRestarting ? t('正在重启...') : t('立即重启生效')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setShowRestartPrompt(false)
                        onClose()
                      }}
                      className="h-7 text-xs px-2.5 text-muted-foreground"
                    >
                      {t('稍后重启')}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 抽屉底部操作栏 */}
          <div className="p-5 border-t border-border/60 bg-muted/20 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={handleResetRecommended}
                disabled={isSaving || isRestarting}
                title={t('根据当前检测到的 GPU 与 CPU 硬件自适应恢复最佳参数')}
                className="h-8 text-xs font-bold text-primary border-primary/40 hover:bg-primary/10"
              >
                <Sparkles className="h-3.5 w-3.5 mr-1 text-primary" />
                {t('恢复智能推荐')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleResetConservative}
                disabled={isSaving || isRestarting}
                title={t('恢复系统保守基准配置，适合显存紧张或排查异常稳定性问题')}
                className="h-8 text-xs font-bold text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3 mr-1 text-muted-foreground" />
                {t('恢复保守配置')}
              </Button>
            </div>

            <div className="flex items-center gap-2">
              {savedSuccess && (
                <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1 animate-in fade-in">
                  <Check className="h-3.5 w-3.5" />
                  {t('已保存并同步')}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={onClose}
                disabled={isSaving || isRestarting}
                className="h-8 text-xs"
              >
                {t('取消')}
              </Button>
              <Button
                size="sm"
                variant={isDirty ? 'default' : 'secondary'}
                onClick={handleSave}
                disabled={!isDirty || isSaving || isRestarting}
                title={!isDirty ? t('当前参数与已保存配置一致，未作任何修改') : t('保存当前修改后的模型启动参数')}
                className={`h-8 text-xs px-4 font-bold transition-all ${
                  isDirty
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-md ring-2 ring-primary/30 cursor-pointer'
                    : 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground border border-border/40'
                }`}
              >
                {isSaving ? t('保存中...') : t('保存参数')}
              </Button>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}

/**
 * 抽屉内部持有 20+ 滑块与大量交互状态，用 memo 隔离父级重渲染：
 * 模型列表会因下载进度、引擎状态轮询等原因高频重渲染，父级一旦重渲染
 * 就会把整抽屉（全部滑块与卡片）重跑一遍，直接拖慢勾选项的点击响应。
 * 调用方需保证 onClose 等回调引用稳定（useCallback），否则 memo 失效。
 */
export const ModelParamDrawer = React.memo(ModelParamDrawerInner)
ModelParamDrawer.displayName = 'ModelParamDrawer'
