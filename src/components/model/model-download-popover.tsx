import React, { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, Zap, Eye, Cpu, Layers, AlertCircle, ShieldCheck } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { HardwareSpec, ModelItem } from '../../api/types'
import { t } from '../../languages'
import { estimateRequiredVRAM } from '../../lib/model-metadata-service'
import {
  recommendComponentsForModel,
  formatSizeFromGB,
  ComponentItemDetail
} from '../../lib/model-component-recommender'

export interface ModelDownloadPopoverProps {
  model: ModelItem
  hardware: HardwareSpec | null
  isOpen: boolean
  anchorRect: DOMRect | null
  onClose: () => void
  onConfirmDownload: (options: {
    isMultiModal?: boolean
    mmproj?: string
    dspark?: string
    draftId?: string
  }) => void
}

export const ModelDownloadPopover: React.FC<ModelDownloadPopoverProps> = ({
  model,
  hardware,
  isOpen,
  anchorRect,
  onClose,
  onConfirmDownload
}) => {
  const popoverRef = useRef<HTMLDivElement>(null)

  // 1. 获取硬件自适应推荐初始配置
  const rec = useMemo(() => recommendComponentsForModel(model, hardware), [model, hardware])

  // 2. 本地勾选状态（以推荐策略为初始默认值）
  const [selected, setSelected] = useState({
    main: true,
    mmproj: rec.selectedComponents.mmproj,
    dspark: rec.selectedComponents.dspark,
    draft: rec.selectedComponents.draft
  })

  // 当推荐策略或模型变化时同步更新
  useEffect(() => {
    setSelected({
      main: true,
      mmproj: rec.selectedComponents.mmproj,
      dspark: rec.selectedComponents.dspark,
      draft: rec.selectedComponents.draft
    })
  }, [rec])

  // 3. 点击外部或按 ESC 自动关闭
  useEffect(() => {
    if (!isOpen) return

    const handlePointerDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onClose, true)
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  // 4. 实时计算当前所选项的总下载体积与预估显存
  const compMap = useMemo(() => {
    const map = new Map<string, ComponentItemDetail>()
    for (const c of rec.components) {
      map.set(c.id, c)
    }
    return map
  }, [rec.components])

  const mainComp = compMap.get('main')
  const mmprojComp = compMap.get('mmproj')
  const dsparkComp = compMap.get('dspark')
  const draftComp = compMap.get('draft')

  const currentTotalSizeGB = useMemo(() => {
    let sum = mainComp ? mainComp.sizeGB : 0
    if (selected.mmproj && mmprojComp) sum += mmprojComp.sizeGB
    if (selected.dspark && dsparkComp) sum += dsparkComp.sizeGB
    if (selected.draft && draftComp) sum += draftComp.sizeGB
    return sum
  }, [selected, mainComp, mmprojComp, dsparkComp, draftComp])

  const currentVramGB = useMemo(() => {
    const mainGB = mainComp ? mainComp.sizeGB : 0
    let accelGB = 0
    if (selected.dspark && dsparkComp) accelGB += dsparkComp.sizeGB
    if (selected.draft && draftComp) accelGB += draftComp.sizeGB
    const mmprojGB = selected.mmproj && mmprojComp ? mmprojComp.sizeGB : 0

    return estimateRequiredVRAM(mainGB + accelGB, mmprojGB)
  }, [selected, mainComp, mmprojComp, dsparkComp, draftComp])

  // 预算对比与超标告警
  const safeBudget = rec.effectiveVramGB * 0.85
  const isExceeded = rec.effectiveVramGB > 0 && currentVramGB > safeBudget

  // 5. 动态计算 Popover 定位坐标（基于 anchorRect）
  const popoverStyle = useMemo<React.CSSProperties>(() => {
    if (!anchorRect) return { display: 'none' }

    const width = 360
    const margin = 8

    // 默认对齐按钮右侧
    let left = anchorRect.right - width
    if (left < margin) left = margin
    if (left + width > window.innerWidth - margin) {
      left = window.innerWidth - width - margin
    }

    // 优先展示在下方，若空间不足则翻转至上方
    let top = anchorRect.bottom + margin
    const estimatedHeight = 420
    if (top + estimatedHeight > window.innerHeight && anchorRect.top > estimatedHeight) {
      top = anchorRect.top - estimatedHeight - margin
    }

    return {
      position: 'fixed',
      top: `${Math.max(margin, top)}px`,
      left: `${left}px`,
      width: `${width}px`,
      zIndex: 9999
    }
  }, [anchorRect])

  if (!isOpen || !anchorRect) return null

  // 触发下载
  const handleConfirm = () => {
    onConfirmDownload({
      isMultiModal: selected.mmproj,
      mmproj: selected.mmproj ? (model.mmproj || 'auto') : 'none',
      dspark: selected.dspark ? (model.dspark || 'auto') : 'none',
      draftId: selected.draft ? (model.draftId || 'auto') : 'none'
    })
    onClose()
  }

  // 硬件标签图标与文案
  const getHardwareLabel = () => {
    if (rec.isAppleSilicon) {
      return `⚡ Apple Silicon (${rec.effectiveVramGB.toFixed(0)}GB ${t('统一内存')})`
    }
    if (hardware && hardware.total_vram_gb && hardware.total_vram_gb > 0) {
      return `⚡ ${t('独立显卡')} (${hardware.total_vram_gb}GB ${t('显存')})`
    }
    return `💻 ${t('系统内存 / 核显模式')}`
  }

  const getComponentIcon = (id: string) => {
    switch (id) {
      case 'main':
        return <Layers className="h-4 w-4 text-primary" />
      case 'mmproj':
        return <Eye className="h-4 w-4 text-emerald-500" />
      case 'dspark':
        return <Zap className="h-4 w-4 text-amber-500" />
      case 'draft':
        return <Cpu className="h-4 w-4 text-purple-500" />
      default:
        return <Layers className="h-4 w-4 text-muted-foreground" />
    }
  }

  return createPortal(
    <div
      ref={popoverRef}
      style={popoverStyle}
      className="rounded-xl border border-border/80 bg-popover/95 p-4 text-popover-foreground shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-150"
      role="dialog"
      aria-modal="true"
      aria-label={t('自定义模型组件下载')}
    >
      {/* 头部：标题与关闭 */}
      <div className="flex items-center justify-between border-b border-border/50 pb-2.5">
        <div>
          <h3 className="text-sm font-bold text-foreground tracking-tight">
            {t('自定义组件下载')}
          </h3>
          <p className="text-[11px] text-muted-foreground truncate max-w-[260px]">
            {model.name}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t('关闭')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 硬件环境状态胶囊 */}
      <div className="my-2.5 rounded-lg border border-border/60 bg-muted/40 p-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-primary shrink-0" />
          <span>{getHardwareLabel()}</span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
          {rec.tipText}
        </p>
      </div>

      {/* 组件选项列表 */}
      <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
        {rec.components.map(comp => {
          const isMain = comp.id === 'main'
          const isChecked = selected[comp.id]

          return (
            <div
              key={comp.id}
              onClick={() => {
                if (isMain) return
                setSelected(prev => ({ ...prev, [comp.id]: !prev[comp.id] }))
              }}
              className={`flex items-start gap-2.5 rounded-lg border p-2.5 transition-colors cursor-pointer select-none ${
                isChecked
                  ? 'border-primary/40 bg-primary/5 hover:border-primary/60'
                  : 'border-border/60 bg-card/40 opacity-75 hover:opacity-100 hover:border-border'
              }`}
            >
              <div className="pt-0.5" onClick={e => e.stopPropagation()}>
                <Checkbox
                  checked={isChecked}
                  disabled={isMain}
                  onCheckedChange={checked => {
                    if (isMain) return
                    setSelected(prev => ({ ...prev, [comp.id]: Boolean(checked) }))
                  }}
                  id={`comp-${comp.id}`}
                />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1.5">
                    {getComponentIcon(comp.id)}
                    <span className="text-xs font-bold text-foreground">
                      {comp.name}
                    </span>
                    <Badge variant="outline" className="px-1 py-0 text-[10px] font-medium scale-95 origin-left">
                      {comp.roleLabel}
                    </Badge>
                  </div>
                  <span className="font-mono text-xs font-bold text-foreground shrink-0">
                    {comp.sizeStr}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground leading-normal">
                  {comp.description}
                </p>
              </div>
            </div>
          )
        })}
      </div>

      {/* 底部：显存预估与下载确认 */}
      <div className="mt-3 border-t border-border/50 pt-3">
        <div className="flex items-center justify-between text-xs mb-2.5">
          <div className="space-y-0.5">
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">{t('合计下载')}:</span>
              <span className="font-mono font-bold text-foreground">
                {formatSizeFromGB(currentTotalSizeGB)}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">{t('预估显存')}:</span>
              <span
                className={`font-mono font-bold ${
                  isExceeded ? 'text-amber-500 flex items-center gap-0.5' : 'text-foreground'
                }`}
              >
                {isExceeded && <AlertCircle className="h-3 w-3 shrink-0" />}
                ~{currentVramGB}GB
              </span>
              {isExceeded && (
                <span className="text-[10px] text-amber-500/90 scale-95 origin-left">
                  ({t('超出安全显存')})
                </span>
              )}
            </div>
          </div>

          <Button
            size="sm"
            onClick={handleConfirm}
            className="px-3.5 text-xs font-bold shadow-sm"
          >
            {t('按所选下载')} ({formatSizeFromGB(currentTotalSizeGB)})
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
