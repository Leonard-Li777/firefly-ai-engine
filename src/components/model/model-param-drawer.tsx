import React, { useState, useEffect } from 'react'
import {
  X,
  Settings2,
  Cpu,
  Sliders,
  RotateCcw,
  Check,
  AlertTriangle,
  RotateCw,
  HardDrive
} from 'lucide-react'
import { ModelItem, RuntimeParams } from '../../api/types'
import { useEngineStore } from '../../stores/engine-store'
import { useI18nStore } from '../../lib/i18n'
import { DEFAULT_MODEL_PARAMS, saveModelCustomParams } from '../../lib/model-param-storage'
import { Button } from '../ui/button'
import { Slider } from '../ui/slider'

interface ModelParamDrawerProps {
  isOpen: boolean
  model: ModelItem | null
  isCurrentRunning: boolean
  onClose: () => void
}

export const ModelParamDrawer: React.FC<ModelParamDrawerProps> = ({
  isOpen,
  model,
  isCurrentRunning,
  onClose
}) => {
  const { t } = useI18nStore()
  const {
    runtimeParams,
    saveModelParams,
    getModelParams,
    startEngine,
    stopEngine
  } = useEngineStore()

  const [params, setParams] = useState<RuntimeParams>(DEFAULT_MODEL_PARAMS)
  const [isSaving, setIsSaving] = useState(false)
  const [savedSuccess, setSavedSuccess] = useState(false)
  const [showRestartPrompt, setShowRestartPrompt] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)

  // 当 Drawer 打开或模型变更时，从后端持久化配置中加载（回退到全局运行时参数）
  useEffect(() => {
    if (!isOpen || !model) return
    let isCancelled = false

    const loadParams = async () => {
      // 1. 先尝试从后端 config.json 获取
      const backendSaved = await getModelParams(model.id)
      if (isCancelled) return

      if (backendSaved) {
        setParams({ ...DEFAULT_MODEL_PARAMS, ...runtimeParams, ...backendSaved })
      } else {
        setParams({ ...DEFAULT_MODEL_PARAMS, ...runtimeParams })
      }
    }

    loadParams()
    setSavedSuccess(false)
    setShowRestartPrompt(false)

    return () => {
      isCancelled = true
    }
  }, [isOpen, model, getModelParams, runtimeParams])

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

  // 恢复系统默认
  const handleResetDefaults = () => {
    setParams({ ...DEFAULT_MODEL_PARAMS, ...runtimeParams })
  }

  // 保存参数
  const handleSave = async () => {
    try {
      setIsSaving(true)
      // 确保微批严格小于等于批处理
      const safeParams: RuntimeParams = {
        ...params,
        ubatch_size: Math.min(params.ubatch_size, params.batch_size)
      }

      // 1. 同步保存至前端 LocalStorage 缓存
      saveModelCustomParams(model.id, safeParams)

      // 2. 持久化至后端 config.json
      await saveModelParams(model.id, safeParams)

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
    <div className="fixed inset-0 z-50 overflow-hidden select-none animate-in fade-in duration-200">
      {/* 半透明毛玻璃背景蒙层 */}
      <div
        className="fixed inset-0 bg-background/60 backdrop-blur-xs transition-opacity"
        onClick={() => !isSaving && !isRestarting && onClose()}
      />

      {/* 右侧滑出面板 */}
      <div className="fixed inset-y-0 right-0 flex max-w-full pl-10">
        <div className="w-screen max-w-xl bg-card border-l border-border shadow-2xl flex flex-col justify-between animate-in slide-in-from-right duration-300 ease-out">
          
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

          {/* 抽屉内容区：三大功能组，每行一个参数 */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">

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
                  <div>
                    <span className="font-bold text-foreground">{t('GPU 卸载层数')}</span>
                    <span className="font-mono text-muted-foreground ml-1.5">(-ngl)</span>
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
                  <div>
                    <span className="font-bold text-foreground">{t('CPU 推理线程数')}</span>
                    <span className="font-mono text-muted-foreground ml-1.5">(-t, threads)</span>
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
                  <div>
                    <span className="font-bold text-foreground">{t('Prompt 批处理大小')}</span>
                    <span className="font-mono text-muted-foreground ml-1.5">(-b, batch_size)</span>
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
                  <div>
                    <span className="font-bold text-foreground">{t('物理微批大小')}</span>
                    <span className="font-mono text-muted-foreground ml-1.5">(-ub, ubatch_size)</span>
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
                  <div>
                    <span className="font-bold text-foreground">{t('上下文长度')}</span>
                    <span className="font-mono text-muted-foreground ml-1.5">(-c, ctx_size)</span>
                  </div>
                  <span className="font-mono font-bold text-primary">{params.ctx_size}</span>
                </div>
                <Slider
                  value={params.ctx_size}
                  min={1024}
                  max={32768}
                  step={1024}
                  onChange={val => setParams(p => ({ ...p, ctx_size: val }))}
                />
                <p className="text-[11px] text-muted-foreground/80">
                  {t('最大记忆窗口大小。较长的上下文会显著增加显存占用。')}
                </p>
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
            <Button
              size="sm"
              variant="outline"
              onClick={handleResetDefaults}
              disabled={isSaving || isRestarting}
              className="h-8 text-xs font-bold"
            >
              <RotateCcw className="h-3 w-3 mr-1 text-muted-foreground" />
              {t('恢复默认')}
            </Button>

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
                variant="default"
                onClick={handleSave}
                disabled={isSaving || isRestarting}
                className="h-8 text-xs px-4 font-bold"
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
