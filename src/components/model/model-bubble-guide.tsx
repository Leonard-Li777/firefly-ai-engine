import React from 'react'
import { GraduationCap, Zap, X, Lightbulb } from 'lucide-react'
import { Button } from '../ui/button'
import { t } from '../../languages'

/**
 * 首次下载引导永久完成标记的本地存储键。
 * 用户提交首次模型下载后置位，气泡引导此后永不出现（PRD-0043）。
 */
const GUIDE_DONE_KEY = 'firefly.modelGuide.downloadDone'

/** 是否已完成首次模型下载提交（气泡引导永久消失标记） */
export function hasCompletedModelGuideDownload(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(GUIDE_DONE_KEY) === '1'
  } catch {
    return false
  }
}

/** 标记首次模型下载已提交（在用户点击下载模型时调用） */
export function markModelGuideDownloadDone(): void {
  try {
    window.localStorage.setItem(GUIDE_DONE_KEY, '1')
  } catch {
    // 本地存储不可用时静默跳过，不影响下载主流程
  }
}

interface ModelBubbleGuideProps {
  /** 会话内关闭（关闭后本次进入不再显示，下次进入仍会出现，直至首次下载提交） */
  onSessionDismiss: () => void
}

/**
 * 模型列表页气泡引导（PRD-0043）
 *
 * 触发条件：模型列表已加载 且 本机无任何已下载模型 且 未完成过首次下载提交。
 * 逐条介绍模型列表关键列的含义，重点覆盖两列：
 * - 智能程度列：推理能力层级，越高分析质量越好，耗时与资源占用也越高；
 * - 预估显存列：运行该模型所需的大致显存（VRAM），用于对照本机硬件判断能否流畅运行。
 */
export const ModelBubbleGuide: React.FC<ModelBubbleGuideProps> = ({ onSessionDismiss }) => {
  return (
    <div
      data-testid="model-bubble-guide"
      className="relative mb-4 rounded-xl border-2 border-primary/40 bg-primary/5 px-4 py-3 shadow-sm"
    >
      <Button
        size="sm"
        variant="ghost"
        className="absolute top-1.5 right-1.5 h-6 w-6 p-0 text-muted-foreground/60 hover:text-foreground"
        title={t('下次进入仍会显示，直至完成首次模型下载')}
        onClick={onSessionDismiss}
      >
        <X className="h-3.5 w-3.5" />
      </Button>

      <div className="flex items-center gap-2 mb-2 pr-6">
        <Lightbulb className="h-4 w-4 text-amber-500 shrink-0" />
        <span className="text-sm font-bold text-foreground">{t('欢迎使用模型库')}</span>
      </div>

      <div className="space-y-1.5 text-xs text-muted-foreground">
        <div className="flex items-start gap-2">
          <GraduationCap className="h-3.5 w-3.5 mt-0.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span>
            <span className="font-bold text-foreground/90">{t('智能程度')}</span>
            {t('：表示模型的推理能力层级，智能程度越高分析质量越好，但下载体积、耗时与资源占用也相应更高。')}
          </span>
        </div>
        <div className="flex items-start gap-2">
          <Zap className="h-3.5 w-3.5 mt-0.5 text-amber-500 shrink-0" />
          <span>
            <span className="font-bold text-foreground/90">{t('预估显存')}</span>
            {t('：表示运行该模型所需的大致显存（VRAM），请与本机显存对照，红色标注表示超出本机显存、无法流畅运行。')}
          </span>
        </div>
        <div className="flex items-start gap-2">
          <Zap className="h-3.5 w-3.5 mt-0.5 text-primary shrink-0" />
          <span>
            {t('选择模型开始下载时，系统会自动为您匹配并下载最佳计算引擎包，无需手动选择。可在「模型」与「引擎」标签页查看各自下载进度。')}
          </span>
        </div>
      </div>
    </div>
  )
}
