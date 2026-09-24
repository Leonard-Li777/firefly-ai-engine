/**
 * 引擎错误分析侧边栏
 * 面向普通用户：展示可读分析、解决建议，并保留运行日志入口。
 */

import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  HelpCircle,
  RefreshCw,
  Stethoscope,
  X
} from 'lucide-react'
import { t } from '../../languages'
import { analyzeEngineError, EngineErrorAnalysis } from '../../lib/error-analyzer'
import { Button } from '../ui/button'

export interface ErrorAnalysisSidebarProps {
  isOpen: boolean
  /** 原始错误文本（来自 last_error / storeError） */
  rawError: string | null | undefined
  onClose: () => void
  /** 点击「查看运行日志」 */
  onViewLogs?: () => void
  /** 可选：重试启动 */
  onRetry?: () => void
}

const SEVERITY_BADGE: Record<
  EngineErrorAnalysis['severity'],
  { label: string; className: string }
> = {
  low: { label: '低', className: 'bg-muted text-muted-foreground border-border' },
  medium: {
    label: '中',
    className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30'
  },
  high: {
    label: '高',
    className: 'bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/30'
  },
  critical: {
    label: '严重',
    className: 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30'
  }
}

export const ErrorAnalysisSidebar: React.FC<ErrorAnalysisSidebarProps> = ({
  isOpen,
  rawError,
  onClose,
  onViewLogs,
  onRetry
}) => {
  const [showRaw, setShowRaw] = useState(false)

  const analysis = useMemo(() => analyzeEngineError(rawError), [rawError])

  // 打开时默认收起原始详情，优先展示分析与建议
  useEffect(() => {
    if (isOpen) setShowRaw(false)
  }, [isOpen, rawError])

  if (!isOpen || !analysis) return null

  const badge = SEVERITY_BADGE[analysis.severity]

  return (
    <div className="fixed inset-0 z-50 overflow-hidden select-none">
      <div
        className="fixed inset-0 bg-background/60 backdrop-blur-xs overlay-fade-in"
        onClick={onClose}
      />

      <div className="fixed inset-y-0 right-0 flex max-w-full pl-10">
        <div className="w-screen max-w-md bg-card border-l border-border shadow-2xl flex flex-col drawer-slide-in-from-left">
          {/* 头部 */}
          <div className="p-5 border-b border-border/60 bg-muted/20">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5 min-w-0">
                <div className="h-9 w-9 shrink-0 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-500">
                  <Stethoscope className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-base font-bold text-foreground tracking-tight leading-snug">
                    {t('错误分析与解决建议')}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5 font-medium">
                    {t('面向普通用户的引擎错误解读')}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-all cursor-pointer"
                aria-label={t('关闭')}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <span
                className={`px-2 py-0.5 rounded-md border text-[11px] font-bold ${badge.className}`}
              >
                {t('严重级别')}: {badge.label}
              </span>
              <span className="px-2 py-0.5 rounded-md border border-border/60 bg-muted text-[11px] font-mono text-muted-foreground">
                {analysis.code}
              </span>
            </div>
          </div>

          {/* 内容 */}
          <div className="flex-1 overflow-y-auto p-5 space-y-5 scrollbar-slim">
            {/* 标题 + 用户可读说明 */}
            <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
              <div className="flex gap-3">
                <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                <div className="space-y-1 min-w-0">
                  <p className="text-sm font-bold text-destructive">{analysis.title}</p>
                  <p className="text-sm text-foreground/90 leading-relaxed">
                    {analysis.userMessage}
                  </p>
                </div>
              </div>
            </div>

            {/* 解决建议 */}
            <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
              <h4 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                {t('建议解决方案')}
              </h4>
              <ul className="space-y-2.5">
                {analysis.solutions.map((suggestion, index) => (
                  <li
                    key={index}
                    className="flex items-start gap-3 text-sm text-muted-foreground leading-snug"
                  >
                    <div className="mt-1.5 h-1.5 w-1.5 rounded-full bg-primary/40 shrink-0" />
                    {suggestion}
                  </li>
                ))}
              </ul>
            </div>

            {/* 原始错误详情（可折叠，专家路径） */}
            <div className="rounded-xl border border-border/50 bg-muted/10">
              <button
                type="button"
                className="w-full flex items-center justify-between px-4 py-3 text-left cursor-pointer"
                onClick={() => setShowRaw(v => !v)}
              >
                <span className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <HelpCircle className="h-4 w-4 text-blue-500" />
                  {t('原始错误详情')}
                </span>
                {showRaw ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
              {showRaw && (
                <div className="px-4 pb-4">
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all text-muted-foreground bg-background/60 border border-border/40 rounded-lg p-3 max-h-48 overflow-y-auto">
                    {analysis.rawMessage}
                  </pre>
                </div>
              )}
            </div>
          </div>

          {/* 底部操作 */}
          <div className="p-5 pt-3 border-t bg-muted/10 flex flex-col gap-2">
            {onRetry && (
              <Button
                onClick={onRetry}
                className="w-full h-10 font-semibold"
                variant="default"
              >
                <RefreshCw className="h-4 w-4 mr-1.5" />
                {t('重试启动服务')}
              </Button>
            )}
            {onViewLogs && (
              <Button
                onClick={onViewLogs}
                variant="outline"
                className="w-full h-10 font-semibold"
              >
                <FileText className="h-4 w-4 mr-1.5" />
                {t('查看运行日志')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
