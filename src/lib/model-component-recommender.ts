import { HardwareSpec, ModelItem } from '../api/types'
import { t } from '../languages'
import { estimateRequiredVRAM, parseSizeToGB } from './model-metadata-service'

export interface ComponentItemDetail {
  id: 'main' | 'mmproj' | 'dspark' | 'draft'
  name: string
  sizeStr: string
  sizeGB: number
  roleLabel: string
  description: string
  required?: boolean
  available: boolean
  recommended: boolean
}

export interface HardwareRecommendationResult {
  tier: 'full' | 'balanced' | 'minimal'
  selectedComponents: {
    main: boolean
    mmproj: boolean
    dspark: boolean
    draft: boolean
  }
  components: ComponentItemDetail[]
  recommendedTotalSizeGB: number
  recommendedTotalSizeStr: string
  estimatedVramGB: number
  tipText: string
  effectiveVramGB: number
  isAppleSilicon: boolean
}

export function formatSizeFromGB(sizeGB: number): string {
  if (sizeGB <= 0) return '0MB'
  if (sizeGB < 1) {
    return `${Math.round(sizeGB * 1024)}MB`
  }
  return `${sizeGB.toFixed(2).replace(/\.?0+$/, '')}GB`
}

/**
 * 通用模型伴随组件通俗功能释义与硬件影响
 */
export const COMPONENT_EXPLANATIONS = {
  main: {
    name: () => t('主语言模型'),
    role: () => t('核心中枢'),
    desc: () => t('负责文本理解、实体识别、分类打标与智能总结（核心必备底座）')
  },
  mmproj: {
    name: () => t('识图多模态模型'),
    role: () => t('视觉之眼'),
    desc: () => t('赋予模型看图能力，用于图片理解、图表分析与 OCR 图文提取；若无需看图可取消以节约显存')
  },
  dspark: {
    name: () => t('DSpark 加速模型'),
    role: () => t('提速 50%'),
    desc: () => t('轻量投机草稿头，大幅提升生成速度 30%~70%，仅占用微小显存，极力推荐')
  },
  draft: {
    name: () => t('MTP 草稿模型'),
    role: () => t('推测加速'),
    desc: () => t('独立辅助小模型进行多 Token 投机验证，提升长文本与代码分析速率')
  }
}

/**
 * 基于动态显存水位比计算当前模型的组件推荐配置
 */
export function recommendComponentsForModel(
  model: ModelItem,
  hardware: HardwareSpec | null
): HardwareRecommendationResult {
  // 1. 提取各组件体积 (GB)
  const mainGB = parseSizeToGB(model.modelSize || model.size)
  const mmprojGB = model.mmproj ? parseSizeToGB(model.mmprojSize) : 0
  const dsparkGB = model.dspark ? parseSizeToGB(model.dsparkSize) : 0
  const draftGB = model.draftId ? parseSizeToGB(model.draftSize) : 0
  const accelGB = dsparkGB + draftGB // 算术合并加速组件

  const hasMmproj = Boolean(model.mmproj || model.isMultiModal)
  const hasDspark = Boolean(model.dspark)
  const hasDraft = Boolean(model.draftId)

  // 2. 计算有效显存预算 (解除 Apple Silicon Metal 误杀)
  const isMetal = hardware?.best_tier === 'metal' || hardware?.current_tier === 'metal'
  const rawVram = hardware?.total_vram_gb || 0
  const totalRam = hardware?.total_ram_gb || 16

  // Apple Silicon 统一内存架构：即使 is_integrated: true，也有大共享显存
  const effectiveVram = isMetal ? Math.max(rawVram, totalRam * 0.7) : rawVram
  const safeBudget = effectiveVram * 0.85

  // 3. 动态显存需求评估（双参数差异化系数）
  const fullNeeded = estimateRequiredVRAM(mainGB + accelGB, mmprojGB)
  const balancedNeeded = estimateRequiredVRAM(mainGB + accelGB, 0)
  const minimalNeeded = estimateRequiredVRAM(mainGB, 0)

  let tier: 'full' | 'balanced' | 'minimal' = 'full'
  let tipText = ''
  let selected = { main: true, mmproj: hasMmproj, dspark: hasDspark, draft: hasDraft }
  let recommendedTotalGB = mainGB + (hasMmproj ? mmprojGB : 0) + accelGB
  let estimatedVram = fullNeeded

  // 4. 水位比梯度决策与提示语
  if (hardware === null) {
    // 硬件尚未探明时的平滑首帧兜底，避免闪烁
    tier = 'full'
    tipText = t('正在检测硬件环境，默认展示完整推荐包')
  } else if (effectiveVram > 0 && fullNeeded <= safeBudget) {
    tier = 'full'
    selected = { main: true, mmproj: hasMmproj, dspark: hasDspark, draft: hasDraft }
    recommendedTotalGB = mainGB + (hasMmproj ? mmprojGB : 0) + accelGB
    estimatedVram = fullNeeded
    tipText = t('本机显存/内存充裕，已推荐全选以获得完整多模态与极速推理能力')
  } else if (effectiveVram > 0 && balancedNeeded <= safeBudget) {
    tier = 'balanced'
    selected = { main: true, mmproj: false, dspark: hasDspark, draft: hasDraft }
    recommendedTotalGB = mainGB + accelGB
    estimatedVram = balancedNeeded
    tipText = t('显存适中，推荐启用加速模型；识图模型已设为可选，如需处理图片可手动开启')
  } else {
    // 极低配 / 纯 CPU / 显存紧张保底分支
    const isCpuOrExceeded = effectiveVram <= 0 || minimalNeeded > safeBudget
    tier = 'minimal'
    selected = { main: true, mmproj: false, dspark: false, draft: false }
    recommendedTotalGB = mainGB
    estimatedVram = minimalNeeded
    tipText = isCpuOrExceeded
      ? t('当前使用系统内存/显存受限，已为您精简为仅主模型以防止运行卡死')
      : t('显存较为紧张，建议仅下载主模型以保证基础分类稳定')
  }

  // 5. 组装组件详情列表供 Popover 渲染
  const components: ComponentItemDetail[] = [
    {
      id: 'main',
      name: COMPONENT_EXPLANATIONS.main.name(),
      sizeStr: model.modelSize || model.size || formatSizeFromGB(mainGB),
      sizeGB: mainGB,
      roleLabel: COMPONENT_EXPLANATIONS.main.role(),
      description: COMPONENT_EXPLANATIONS.main.desc(),
      required: true,
      available: true,
      recommended: selected.main
    }
  ]

  if (hasMmproj) {
    components.push({
      id: 'mmproj',
      name: COMPONENT_EXPLANATIONS.mmproj.name(),
      sizeStr: model.mmprojSize || formatSizeFromGB(mmprojGB),
      sizeGB: mmprojGB,
      roleLabel: COMPONENT_EXPLANATIONS.mmproj.role(),
      description: COMPONENT_EXPLANATIONS.mmproj.desc(),
      required: false,
      available: true,
      recommended: selected.mmproj
    })
  }

  if (hasDspark) {
    components.push({
      id: 'dspark',
      name: COMPONENT_EXPLANATIONS.dspark.name(),
      sizeStr: model.dsparkSize || formatSizeFromGB(dsparkGB),
      sizeGB: dsparkGB,
      roleLabel: COMPONENT_EXPLANATIONS.dspark.role(),
      description: COMPONENT_EXPLANATIONS.dspark.desc(),
      required: false,
      available: true,
      recommended: selected.dspark
    })
  }

  if (hasDraft) {
    components.push({
      id: 'draft',
      name: COMPONENT_EXPLANATIONS.draft.name(),
      sizeStr: model.draftSize || formatSizeFromGB(draftGB),
      sizeGB: draftGB,
      roleLabel: COMPONENT_EXPLANATIONS.draft.role(),
      description: COMPONENT_EXPLANATIONS.draft.desc(),
      required: false,
      available: true,
      recommended: selected.draft
    })
  }

  return {
    tier,
    selectedComponents: selected,
    components,
    recommendedTotalSizeGB: recommendedTotalGB,
    recommendedTotalSizeStr: formatSizeFromGB(recommendedTotalGB),
    estimatedVramGB: estimatedVram,
    tipText,
    effectiveVramGB: effectiveVram,
    isAppleSilicon: isMetal
  }
}
