import React, { useState, useEffect, useMemo } from 'react'
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  PauseCircle,
  HelpCircle,
  Server,
  Zap,
  Activity,
  Brain
} from 'lucide-react'
import { useEngineStore } from '../../stores/engine-store'
import { useI18nStore } from '../../lib/i18n'
import pkg from '../../../package.json'

const THINKING_MODE_STORAGE_KEY = 'firefly_enable_thinking_mode'

interface FooterProps {
  onNavigateTab: (tab: string) => void
}

export const Footer: React.FC<FooterProps> = ({ onNavigateTab }) => {
  const { t } = useI18nStore()
  const {
    engineStatus,
    models,
    activeModelKey,
    error: storeError
  } = useEngineStore()

  // 思考模式状态维护，监听本地自定义事件与 storage 事件
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      return localStorage.getItem(THINKING_MODE_STORAGE_KEY) === 'true'
    }
    return false
  })

  useEffect(() => {
    const handleSyncThinking = () => {
      if (typeof window !== 'undefined' && window.localStorage) {
        setThinkingEnabled(localStorage.getItem(THINKING_MODE_STORAGE_KEY) === 'true')
      }
    }

    window.addEventListener('thinking-mode-changed', handleSyncThinking)
    window.addEventListener('storage', handleSyncThinking)
    return () => {
      window.removeEventListener('thinking-mode-changed', handleSyncThinking)
      window.removeEventListener('storage', handleSyncThinking)
    }
  }, [])

  // 当前模型信息解析
  const safeModels = Array.isArray(models) ? models : []
  const currentModelItem = safeModels.find(m => `${m.id}@${m.source}` === activeModelKey)
  const currentModelName =
    currentModelItem?.name || engineStatus?.current_model || 'Qwen 3.5 0.8B (内置快速)'

  const rawStatus = engineStatus?.status || 'stopped'
  const activeBackend = (engineStatus?.active_backend || 'vulkan').toUpperCase()
  const port = engineStatus?.port || 38400
  const hw = engineStatus?.hardware
  const lastError = engineStatus?.last_error || storeError

  // 1:1 映射 Desktop 状态与呈现
  const statusDisplay = useMemo(() => {
    const header = `[${t('本地')}] ${activeBackend} - ${currentModelName}`

    switch (rawStatus) {
      case 'starting':
        return {
          text: t('{modelInfo} 正在启动服务...', { modelInfo: header }),
          icon: Loader2,
          color: 'text-blue-500',
          animate: 'animate-spin'
        }
      case 'model_loading':
        return {
          text: t('{modelInfo} 模型资源加载中...', { modelInfo: header }),
          icon: RefreshCw,
          color: 'text-yellow-500',
          animate: 'animate-spin'
        }
      case 'downloading':
        return {
          text: t('{modelInfo} 模型下载准备中...', { modelInfo: header }),
          icon: Loader2,
          color: 'text-amber-500',
          animate: 'animate-spin'
        }
      case 'ready':
        return {
          text: t('{modelInfo} AI 服务就绪', { modelInfo: header }),
          icon: CheckCircle2,
          color: 'text-emerald-500',
          animate: ''
        }
      case 'error':
        return {
          text: t('{modelInfo} 服务异常: {error}', {
            modelInfo: header,
            error: lastError || t('未知异常')
          }),
          icon: AlertCircle,
          color: 'text-red-500',
          animate: ''
        }
      case 'stopped':
        return {
          text: t('{modelInfo} AI 服务已停止', { modelInfo: header }),
          icon: PauseCircle,
          color: 'text-muted-foreground',
          animate: ''
        }
      default:
        return {
          text: t('{modelInfo} 状态未知', { modelInfo: header }),
          icon: HelpCircle,
          color: 'text-muted-foreground',
          animate: ''
        }
    }
  }, [rawStatus, activeBackend, currentModelName, lastError, t])

  // 次级提示 1：服务错误详情
  const showAiError = rawStatus === 'error' || Boolean(lastError)

  // 次级提示 2：最佳引擎升级警告
  const bestTier = hw?.best_tier?.toUpperCase() || ''
  const currentTier = (hw?.current_tier || engineStatus?.active_backend || '').toUpperCase()
  const isDowngraded = Boolean(engineStatus?.downgrade_info?.downgraded)
  const accelerationBelowBest = Boolean(
    bestTier && currentTier && bestTier !== currentTier && (isDowngraded || currentTier === 'CPU')
  )

  // 次级提示 3：显卡推荐提示（高性能显卡 VRAM >= 4GB 且当前模型智能等级为「小学生」level 1 时显示）
  const shouldShowRecommendation = useMemo(() => {
    if (!hw || rawStatus !== 'ready') return false
    const totalVramGb = hw.total_vram_gb || 0
    if (totalVramGb < 4) return false

    // 智能等级：1 小学生 / 2 初中生 / 3 高中生 / 4 大学生；
    // 无匹配模型项时回退为内置 0.8B 快速模型（小学生）
    const level = currentModelItem?.intelligenceLevel ?? 1
    return level <= 1
  }, [hw, rawStatus, currentModelItem])

  const StatusIcon = statusDisplay.icon

  return (
    <footer className="shrink-0 border-t border-border/80 bg-background/95 backdrop-blur-md px-5 py-2.5 flex justify-between items-center text-xs text-foreground overflow-hidden gap-3 shadow-xs">
      {/* 左侧模型状态与次级告警提示区 */}
      <div className="flex items-center gap-3 min-w-0 shrink">
        <div className="flex items-center space-x-2.5 min-w-0">
          <StatusIcon
            className={`h-4 w-4 shrink-0 ${statusDisplay.color} ${statusDisplay.animate}`}
          />
          <div className="min-w-0">
            {/* 主状态条：点击直接进入 models 模型管理页 */}
            <button
              type="button"
              className={`${statusDisplay.color} font-medium transition-all duration-200 hover:underline cursor-pointer truncate max-w-[420px] sm:max-w-[560px] block text-left`}
              onClick={() => onNavigateTab('models')}
              title={statusDisplay.text}
            >
              {statusDisplay.text}
            </button>

            {/* 次级提示行 */}
            <div className="min-w-0 flex items-center gap-2 mt-0.5">
              {/* 1. 服务异常详情：点击跳转到 logs 运行日志页排查 */}
              {showAiError && (
                <button
                  type="button"
                  className="text-[11px] leading-tight text-red-500 font-medium transition-all duration-200 hover:underline cursor-pointer flex items-center gap-1 text-left truncate max-w-[420px]"
                  onClick={() => onNavigateTab('logs')}
                  title={t('点击查看引擎运行日志详情')}
                >
                  <AlertCircle className="h-3 w-3 shrink-0 animate-pulse text-red-500" />
                  <span className="truncate">
                    {lastError || t('服务异常')}，{t('点击查看日志原因')}
                  </span>
                </button>
              )}

              {/* 2. 最佳引擎警告：点击跳转到 engine 计算引擎与硬件环境设置 */}
              {accelerationBelowBest && (
                <button
                  type="button"
                  onClick={() => onNavigateTab('engine')}
                  className="text-amber-500 dark:text-amber-400 text-[11px] font-medium hover:underline cursor-pointer flex items-center gap-1 truncate max-w-[420px]"
                  title={t('警告：{current}非最佳可用引擎，请点击切换{best}！', {
                    current: currentTier,
                    best: bestTier
                  })}
                >
                  <Zap className="h-3 w-3 shrink-0 text-amber-500" />
                  <span className="truncate">
                    {t('警告：{current}非最佳可用引擎，请点击切换{best}！', {
                      current: currentTier,
                      best: bestTier
                    })}
                  </span>
                </button>
              )}

              {/* 3. 显卡推荐提示：点击跳转到 models 选择更高参数模型 */}
              {shouldShowRecommendation && !accelerationBelowBest && !showAiError && (
                <button
                  type="button"
                  className="text-[11px] leading-tight text-purple-600 dark:text-purple-400 font-medium transition-all duration-200 hover:underline cursor-pointer flex items-center gap-1 truncate max-w-[420px]"
                  onClick={() => onNavigateTab('models')}
                  title={t('检测到您有高性能独立显卡，请切换更聪明的AI模型，立即设置')}
                >
                  <Activity className="h-3 w-3 shrink-0 text-purple-500" />
                  <span className="truncate">
                    {t('检测到您有高性能显卡，请切换更聪明的AI模型，立即设置')}
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 右侧思考模式与服务监听信息 */}
      <div className="flex items-center gap-3 shrink-0">
        {/* 思考模式 ON | OFF：点击直接快捷跳转到 engine 选项卡 */}
        <button
          type="button"
          onClick={() => onNavigateTab('engine')}
          className="flex items-center gap-1 px-2 py-0.5 rounded-lg border border-border/70 bg-muted/30 hover:bg-muted/60 transition-colors cursor-pointer text-xs select-none"
          title={t('点击前往引擎配置页面调整模型思考模式')}
        >
          <Brain className="h-3.5 w-3.5 text-muted-foreground opacity-70" />
          <span className="text-muted-foreground font-medium">{t('思考')}:</span>
          <span
            className={`font-black px-1.5 py-0.2 rounded text-[11px] ${
              thinkingEnabled
                ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/30'
                : 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30'
            }`}
          >
            {thinkingEnabled ? 'ON' : 'OFF'}
          </span>
        </button>

        <span className="text-muted-foreground/30 hidden sm:inline">|</span>

        {/* 基准服务监听地址与协议 */}
        <div className="hidden md:flex items-center gap-2 text-muted-foreground/80 font-mono text-[11px]">
          <span className="flex items-center gap-1">
            <Server className="h-3 w-3" />
            127.0.0.1:{port}
          </span>
          <span>•</span>
          <span>OpenAI /v1</span>
        </div>

        <span className="text-muted-foreground/30 hidden sm:inline">|</span>

        {/* 版本号 */}
        <span className="text-[11px] font-mono text-muted-foreground/60 select-none">
          v{pkg.version}
        </span>
      </div>
    </footer>
  )
}
