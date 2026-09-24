import React, { useState, useEffect } from 'react'
import {
  Cpu,
  HardDrive,
  Copy,
  Check,
  Zap,
  Server,
  Boxes,
  Sliders,
  CheckCircle2,
  Play,
  Square,
  Loader2,
  AlertCircle,
  ChevronDown,
  Terminal
} from 'lucide-react'
import { Card } from '../ui/card'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import { Label } from '../ui/label'
import { Alert, AlertTitle, AlertDescription } from '../ui/alert'
import { toast } from '../common/Toast'
import { useEngineStore } from '../../stores/engine-store'
import { t } from '../../languages'
import { getModelCustomParams } from '../../lib/model-param-storage'

export const DashboardView: React.FC = () => {
  const {
    engineStatus,
    models,
    runtimeParams,
    activeModelKey,
    startEngine,
    stopEngine,
    logs,
    error: storeError,
    loading: storeLoading
  } = useEngineStore()
  const [actionLoading, setActionLoading] = useState(false)
  // 启动参数折叠面板：默认收起
  const [paramsExpanded, setParamsExpanded] = useState(false)
  const [cmdCopied, setCmdCopied] = useState(false)

  // 从日志缓冲区提取最近一次 [cmd] 完整启动命令行
  const launchCmd = React.useMemo(() => {
    const cmdLines = logs.filter((l: string) => l.startsWith('[cmd]'))
    return cmdLines.length > 0 ? cmdLines[cmdLines.length - 1].replace(/^\[cmd\]\s*/, '') : null
  }, [logs])

  const handleCopyCmd = () => {
    if (!launchCmd) return
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(launchCmd)
      setCmdCopied(true)
      setTimeout(() => setCmdCopied(false), 2500)
    }
  }

  // 展开 / 收起时按需拉取日志（[cmd] 行来自日志缓冲区）
  const handleToggleParams = () => {
    const next = !paramsExpanded
    setParamsExpanded(next)
    if (next) {
      useEngineStore.getState().fetchLogs()
    }
  }

  const hw = engineStatus?.hardware
  const safeModels = Array.isArray(models) ? models : []
  const installedModelsCount = safeModels.filter(m => m && m.isDownloaded).length
  const totalModelsCount = safeModels.length

  // 服务运行状态
  const rawStatus = engineStatus?.status || 'stopped'
  const isRunning = rawStatus === 'ready'
  const isStarting = rawStatus === 'starting'

  // 当前引擎
  const activeBackend = engineStatus?.active_backend || 'vulkan'

  // 根据 activeModelKey 精确获取当前模型对象，并融合专属启动参数
  const currentModelItem = safeModels.find(m => `${m.id}@${m.source}` === activeModelKey)
  const customParams = currentModelItem ? getModelCustomParams(currentModelItem.id) : undefined
  const effectiveParams = { ...runtimeParams, ...customParams }

  // 显存负载统计
  const totalVramMb = (hw?.total_vram_gb || 8) * 1024
  const usedVramMb = engineStatus?.vram_usage_mb || 0
  const vramPercent = Math.min(100, Math.round((usedVramMb / totalVramMb) * 100))

  // 物理内存统计
  const totalRamGb = hw?.total_ram_gb || 16
  const usedRamGb = hw?.used_ram_gb || 6.2
  const ramPercent = Math.min(100, Math.round((usedRamGb / totalRamGb) * 100))

  // 服务监听端口
  const port = engineStatus?.port || 38400

  const [startFailedError, setStartFailedError] = useState<string | null>(null)

  // 轮询服务运行状态，确保进程异常退出或就绪时能第一时间在 UI 上感知（静默轮询，不翻转全局 loading）
  useEffect(() => {
    let isMounted = true
    const interval = setInterval(() => {
      if (isMounted) {
        useEngineStore.getState().fetchEngineStatus(true)
      }
    }, 2500)
    return () => {
      isMounted = false
      clearInterval(interval)
    }
  }, [])

  // 当外部检测到 status 变成 error 时，同步记录并 toast 报错
  useEffect(() => {
    if (rawStatus === 'error' && (engineStatus?.last_error || storeError)) {
      const err = engineStatus?.last_error || storeError || t('启动失败')
      setStartFailedError(err)
    }
  }, [rawStatus, engineStatus?.last_error, storeError, t])

  const handleStart = async () => {
    try {
      setActionLoading(true)
      setStartFailedError(null)
      const ok = await startEngine()
      if (ok) {
        toast.success(t('AI 推理服务已成功启动！'))
      } else {
        const errMsg = useEngineStore.getState().error || engineStatus?.last_error || t('启动失败，请检查模型文件或端口占用')
        setStartFailedError(errMsg)
        toast.error(`${t('启动服务失败')}: ${errMsg}`)
      }
    } catch (err: any) {
      const errMsg = err?.message || t('启动异常')
      setStartFailedError(errMsg)
      toast.error(`${t('启动异常')}: ${errMsg}`)
    } finally {
      setActionLoading(false)
    }
  }

  const handleStop = async () => {
    try {
      setActionLoading(true)
      const ok = await stopEngine()
      if (ok) {
        toast.info(t('AI 推理服务已停止'))
      }
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* 顶部服务启停与运行状态控制区块 */}
      <Card className="p-5 bg-card/95 border border-border/80 rounded-2xl shadow-xs">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border transition-all ${
              isRunning
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
                : isStarting
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-500 animate-pulse'
                  : 'bg-muted/40 border-border/60 text-muted-foreground'
            }`}>
              <Zap className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-lg font-black tracking-tight text-foreground">
                  {t('推理引擎后台服务')}
                </h2>
                <Badge
                  variant="outline"
                  className={`text-xs font-bold px-2 py-0.5 uppercase flex items-center gap-1.5 ${
                    isRunning
                      ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
                      : isStarting
                        ? 'border-amber-500/40 text-amber-500 bg-amber-500/10'
                        : 'border-border text-muted-foreground bg-muted/40'
                  }`}
                >
                  <span className={`h-2 w-2 rounded-full ${
                    isRunning
                      ? 'bg-emerald-500 animate-pulse'
                      : isStarting
                        ? 'bg-amber-500 animate-ping'
                        : 'bg-muted-foreground'
                  }`} />
                  <span>
                    {isRunning
                      ? t('运行中 (就绪)')
                      : isStarting
                        ? t('正在启动...')
                        : rawStatus === 'error'
                          ? t('异常')
                          : t('已停止')}
                  </span>
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {t('核心 llama.cpp 推理进程，提供 OpenAI 兼容的 HTTP 接口响应')}
                <span className="font-mono ml-2 text-foreground/80">127.0.0.1:{port}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            {isRunning ? (
              <Button
                variant="destructive"
                className="h-10 px-5 font-bold text-xs gap-2 rounded-xl shadow-xs flex-1 sm:flex-initial"
                onClick={handleStop}
                disabled={actionLoading || storeLoading}
              >
                {actionLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Square className="h-4 w-4 fill-current" />
                )}
                <span>{t('停止服务')}</span>
              </Button>
            ) : (
              <Button
                className="h-10 px-5 font-bold text-xs gap-2 rounded-xl shadow-xs bg-primary text-primary-foreground hover:bg-primary/90 flex-1 sm:flex-initial"
                onClick={handleStart}
                disabled={actionLoading || storeLoading || isStarting}
              >
                {actionLoading || isStarting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 fill-current" />
                )}
                <span>{isStarting ? t('启动中...') : t('启动服务')}</span>
              </Button>
            )}
          </div>
        </div>

        {/* 启动失败原因详细提示卡片 */}
        {(startFailedError || engineStatus?.last_error || (rawStatus === 'error' && storeError)) && !isRunning && !isStarting && (
          <div className="mt-4 pt-4 border-t border-destructive/20 animate-in fade-in duration-200">
            <Alert variant="destructive" className="bg-destructive/10 border-destructive/30">
              <AlertCircle className="h-4 w-4 text-destructive" />
              <div className="ml-2">
                <AlertTitle className="text-xs font-bold text-destructive">
                  {t('服务启动失败')}
                </AlertTitle>
                <AlertDescription className="text-xs font-mono text-destructive/90 mt-1 break-words">
                  {startFailedError || engineStatus?.last_error || storeError}
                </AlertDescription>
              </div>
            </Alert>
          </div>
        )}

        {/* 当前模型启动参数：默认隐藏，可展开 / 收起 */}
        <div className="mt-4 pt-3 border-t border-border/40">
          <button
            type="button"
            onClick={handleToggleParams}
            className="w-full flex items-center justify-end gap-1.5 group select-none text-muted-foreground/70 hover:text-muted-foreground transition-colors"
            aria-expanded={paramsExpanded}
          >
            <Sliders className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t('当前模型启动参数')}</span>
            <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${paramsExpanded ? 'rotate-180' : ''}`} />
          </button>

          {paramsExpanded && (
            <div className="mt-3 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
              {/* 核心参数网格 */}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                <div className="p-2.5 rounded-lg bg-muted/30 border border-border/60">
                  <span className="text-[10px] text-muted-foreground font-semibold uppercase block">
                    {t('-ngl (GPU 层数)')}
                  </span>
                  <span className="text-sm font-mono font-black text-foreground mt-0.5 block">
                    {effectiveParams.n_gpu_layers}
                  </span>
                </div>

                <div className="p-2.5 rounded-lg bg-muted/30 border border-border/60">
                  <span className="text-[10px] text-muted-foreground font-semibold uppercase block">
                    {t('-c (上下文窗口)')}
                  </span>
                  <span className="text-sm font-mono font-black text-foreground mt-0.5 block">
                    {effectiveParams.ctx_size}
                  </span>
                </div>

                <div className="p-2.5 rounded-lg bg-muted/30 border border-border/60">
                  <span className="text-[10px] text-muted-foreground font-semibold uppercase block">
                    {t('-t (线程数)')}
                  </span>
                  <span className="text-sm font-mono font-black text-foreground mt-0.5 block">
                    {effectiveParams.threads}
                  </span>
                </div>

                <div className="p-2.5 rounded-lg bg-muted/30 border border-border/60">
                  <span className="text-[10px] text-muted-foreground font-semibold uppercase block">
                    {t('-b (Batch Size)')}
                  </span>
                  <span className="text-sm font-mono font-black text-foreground mt-0.5 block">
                    {effectiveParams.batch_size}
                  </span>
                </div>

                <div className="p-2.5 rounded-lg bg-muted/30 border border-border/60">
                  <span className="text-[10px] text-muted-foreground font-semibold uppercase block">
                    {t('-ub (uBatch Size)')}
                  </span>
                  <span className="text-sm font-mono font-black text-foreground mt-0.5 block">
                    {effectiveParams.ubatch_size}
                  </span>
                </div>
              </div>

              {/* 完整启动命令行（来自引擎日志 [cmd] 行） */}
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-1.5">
                    <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground font-semibold uppercase">
                      {t('完整启动命令')}
                    </span>
                  </div>
                  {launchCmd && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[10px] font-bold gap-1 rounded-md"
                      onClick={handleCopyCmd}
                    >
                      {cmdCopied ? (
                        <>
                          <Check className="h-3 w-3" />
                          <span>{t('已复制')}</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          <span>{t('复制')}</span>
                        </>
                      )}
                    </Button>
                  )}
                </div>
                {launchCmd ? (
                  <pre className="text-[11px] font-mono text-foreground/90 whitespace-pre-wrap break-all leading-relaxed max-h-40 overflow-y-auto scrollbar-slim">
                    {launchCmd}
                  </pre>
                ) : (
                  <span className="text-[11px] text-muted-foreground font-mono">
                    {t('暂无启动记录，服务启动后将展示完整命令行')}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </Card>
      {/* 核心指标 KPI 仪表卡片栅格 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* 卡片 1: 已安装模型计数 */}
        <Card className="p-4 bg-card/90 border border-border/80 rounded-2xl shadow-xs hover:border-primary/50 transition-colors flex items-center gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
            <Boxes className="h-5.5 w-5.5" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-tight block">
              {t('已安装模型')}
            </span>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className="text-2xl font-black text-foreground">
                {installedModelsCount}
              </span>
              <span className="text-xs font-mono text-muted-foreground">
                / {totalModelsCount} {t('个可用')}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
              <span>{t('即时就绪，可无缝热切')}</span>
            </div>
          </div>
        </Card>

        {/* 卡片 2: 当前运算引擎 */}
        <Card className="p-4 bg-card/90 border border-border/80 rounded-2xl shadow-xs hover:border-primary/50 transition-colors flex items-center gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
            <Zap className="h-5.5 w-5.5" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-tight block">
              {t('当前计算引擎')}
            </span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-lg font-black text-foreground uppercase truncate">
                {activeBackend}
              </span>
              <Badge variant="outline" className="text-[9px] font-bold h-4.5 px-1.5 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 uppercase">
                {engineStatus?.status === 'ready' ? t('就绪') : t('运行中')}
              </Badge>
            </div>
            <span className="text-[10px] text-muted-foreground truncate block mt-1" title={hw?.gpu_name}>
              {hw?.gpu_name || t('通用加速硬件')}
            </span>
          </div>
        </Card>

        {/* 卡片 3: 服务监听端口与状态 */}
        <Card className="p-4 bg-card/90 border border-border/80 rounded-2xl shadow-xs hover:border-primary/50 transition-colors flex items-center gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
            <Server className="h-5.5 w-5.5" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-tight block">
              {t('API 服务监听')}
            </span>
            <span className="text-base font-black text-foreground font-mono mt-0.5 block">
              127.0.0.1:{port}
            </span>
            <div className="flex items-center gap-1.5 mt-1 text-[10px] text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>{t('OpenAI 兼容协议')}</span>
            </div>
          </div>
        </Card>
      </div>

      {/* 硬件负载与运行时资源占用：左右独立双列卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* 左列：GPU 独立显存 (VRAM) */}
        <Card className="p-5 bg-card border border-border/80 rounded-2xl shadow-xs space-y-4">
          <div className="flex items-center justify-between border-b border-border/40 pb-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500 border border-amber-500/20">
                <HardDrive className="h-4 w-4" />
              </div>
              <div>
                <Label className="text-sm font-bold tracking-tight text-foreground block">
                  {t('GPU 独立显存 (VRAM)')}
                </Label>
                <span className="text-[10px] text-muted-foreground block" title={hw?.gpu_name}>
                  {hw?.gpu_name || t('默认图形加速卡')}
                </span>
              </div>
            </div>
            <Badge variant="outline" className="text-[10px] font-bold font-mono">
              {vramPercent}%
            </Badge>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-muted-foreground">{t('已分配水位')}</span>
              <span className="font-bold text-foreground">
                {usedVramMb} MB / {Math.round(totalVramMb)} MB
              </span>
            </div>
            <Progress
              value={vramPercent}
              className="h-2.5 bg-muted/60"
              indicatorClassName={vramPercent > 85 ? 'bg-amber-500' : 'bg-primary'}
            />
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{t('可用余量')}: <strong className="text-foreground font-mono">{Math.max(0, Math.round(totalVramMb - usedVramMb))} MB</strong></span>
              <span className="font-semibold text-foreground/80">
                {hw?.is_integrated ? t('共享系统显存') : t('独立显存')}
              </span>
            </div>
          </div>
        </Card>

        {/* 右列：系统物理内存 (RAM) */}
        <Card className="p-5 bg-card border border-border/80 rounded-2xl shadow-xs space-y-4">
          <div className="flex items-center justify-between border-b border-border/40 pb-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500 border border-blue-500/20">
                <Cpu className="h-4 w-4" />
              </div>
              <div>
                <Label className="text-sm font-bold tracking-tight text-foreground block">
                  {t('系统物理内存 (RAM)')}
                </Label>
                <span className="text-[10px] text-muted-foreground block">
                  {hw?.cpu_cores ? `${hw.cpu_cores} ${t('核心')} / ${hw.cpu_threads || hw.cpu_cores * 2} ${t('线程')}` : t('中央处理器')}
                </span>
              </div>
            </div>
            <Badge variant="outline" className="text-[10px] font-bold font-mono">
              {ramPercent}%
            </Badge>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-muted-foreground">{t('已使用容量')}</span>
              <span className="font-bold text-foreground">
                {usedRamGb.toFixed(1)} GB / {totalRamGb.toFixed(1)} GB
              </span>
            </div>
            <Progress
              value={ramPercent}
              className="h-2.5 bg-muted/60"
              indicatorClassName="bg-blue-500"
            />
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{t('可用余量')}: <strong className="text-foreground font-mono">{Math.max(0, totalRamGb - usedRamGb).toFixed(1)} GB</strong></span>
              <span className="font-semibold text-foreground/80">
                {t('系统统一调度')}
              </span>
            </div>
          </div>
        </Card>
      </div>

      {/* 第三方应用对接与 API 地址已迁移至顶级 Tab「第三方对接」，见 components/api/third-party-api-view.tsx */}

    </div>
  )
}
