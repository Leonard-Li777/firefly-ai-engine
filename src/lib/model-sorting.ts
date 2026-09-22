import { ModelItem } from '../api/types'
import { parseSizeToGB, estimateRequiredVRAM } from './model-metadata-service'

/**
 * 判断模型是否超出当前用户的硬件显存限制
 * 逻辑 1:1 对标 desktop (model-utils.ts 中的 isModelExceedsHardware)
 *
 * @param model 模型对象
 * @param userVramGB 用户机器可用显存 (GB)
 * @returns 是否超出显存限制 (true 为超标，应置灰)
 */
export function isModelExceedsHardware(
  model: Partial<ModelItem>,
  userVramGB?: number
): boolean {
  // 如果尚未检测到显存，或显存信息未就绪，安全起见默认不判定超标（或按0GB处理）
  const vram = userVramGB ?? 0
  const vramReq =
    model.vramNeededGB ??
    (model.size ? estimateRequiredVRAM(model.size) : 0)

  // 1. 如果模型显存需求 <= 2GB，视为 CPU 兼容轻量模型，永远不判定为“显存不足”
  if (vramReq <= 2.0) {
    return false
  }

  // 2. 如果显存需求 > 2GB：
  //    - 如果用户显存 <= 1GB (无独立显卡或纯 CPU 模式)，则视为显存不足
  //    - 如果用户显存 > 1GB，允许需求在可用显存 1.2 倍以内（动态缓冲安全裕度），超过则判定显存不足
  if (vram <= 1) {
    return true
  }

  return vramReq > vram * 1.2
}

/**
 * 计算模型的综合性价比评分
 *
 * 排序需求：“按用户模型体积最小，智能程度最高加权排序；
 * 比如体积小得高分+但智能程度低需要得低分；这样综合性价比最高的模型可以排前面”
 *
 * @param model 模型对象
 * @param minSizeGB 当前列表最小体积（用于归一化）
 * @param maxSizeGB 当前列表最大体积（用于归一化）
 * @returns 综合性价比得分 (区间通常在 0 ~ 1 之间，越高代表性价比越优秀)
 */
export function calculateModelScore(
  model: ModelItem,
  minSizeGB: number = 0.5,
  maxSizeGB: number = 10.0
): number {
  // 1. 智能程度得分 (intelligenceLevel: 1: 小学生, 2: 初中生, 3: 高中生, 4: 大学生)
  // 归一化至 0.0 ~ 1.0
  const level = model.intelligenceLevel ? Math.max(1, Math.min(4, model.intelligenceLevel)) : 1
  const intelScore = (level - 1) / 3 // 1 -> 0, 2 -> 0.333, 3 -> 0.667, 4 -> 1.0

  // 2. 模型体积得分 (体积越小得分越高)
  const sizeGB = model.fileSize
    ? model.fileSize / (1024 * 1024 * 1024)
    : parseSizeToGB(model.size) || 2.0

  let sizeScore = 0.5
  if (maxSizeGB > minSizeGB) {
    // 线性反比例归一化：体积越接近 minSizeGB 得分越接近 1.0；越接近 maxSizeGB 得分越接近 0.0
    const clampedSize = Math.max(minSizeGB, Math.min(maxSizeGB, sizeGB))
    sizeScore = (maxSizeGB - clampedSize) / (maxSizeGB - minSizeGB)
  } else {
    // 若所有模型体积一致，体积分为中间值 0.5
    sizeScore = 0.5
  }

  // 3. 综合加权评分：体积权重 50%，智能程度权重 50%
  // 体积小得高分，但智能程度低会被拉低分数；高智能且控制好体积的模型（如 2B 高质量小模型）得分最高
  const weightSize = 0.5
  const weightIntel = 0.5

  return weightSize * sizeScore + weightIntel * intelScore
}

export interface EnrichedModelItem extends ModelItem {
  isEx: boolean
  cpScore: number
}

/**
 * 对模型列表进行显存超标标记与性价比综合加权排序
 *
 * 排序层级优先级：
 * 1. 显存超标判断：未超标模型排在前面，超标模型统一沉底置灰；
 * 2. 官方推荐优先：在未超标的模型中，官方推荐（recommended）优先展示；
 * 3. 综合性价比排序：按计算所得的综合性价比得分 (cpScore) 降序排列；
 * 4. 保底规则：按所需显存升序。
 *
 * @param models 原始模型列表
 * @param userVramGB 用户当前检测到的可用显存 (GB)
 */
export function sortModels(
  models: ModelItem[],
  userVramGB?: number
): EnrichedModelItem[] {
  if (!models || models.length === 0) return []

  // 预先计算当前模型集合的体积极值，以便进行自适应归一化打分
  const sizes = models.map(m =>
    m.fileSize ? m.fileSize / (1024 * 1024 * 1024) : parseSizeToGB(m.size) || 2.0
  )
  const minSizeGB = Math.min(...sizes, 0.5)
  const maxSizeGB = Math.max(...sizes, 10.0)

  // 补充超标状态与性价比分数
  const enriched: EnrichedModelItem[] = models.map(m => {
    const isEx = isModelExceedsHardware(m, userVramGB)
    const cpScore = calculateModelScore(m, minSizeGB, maxSizeGB)
    return {
      ...m,
      isEx,
      cpScore
    }
  })

  return enriched.sort((a, b) => {
    // 1. 超标模型沉底
    if (a.isEx !== b.isEx) {
      return a.isEx ? 1 : -1
    }

    // 2. 已下载到本地的就绪模型优先置顶展示
    const aDownloaded = Boolean(a.isDownloaded)
    const bDownloaded = Boolean(b.isDownloaded)
    if (aDownloaded !== bDownloaded) {
      return aDownloaded ? -1 : 1
    }

    // 3. 官方推荐优先
    const aRec = Boolean(a.recommended)
    const bRec = Boolean(b.recommended)
    if (aRec !== bRec) {
      return aRec ? -1 : 1
    }

    // 4. 综合性价比最高者排前面 (分数高者排前)
    const scoreDiff = b.cpScore - a.cpScore
    if (Math.abs(scoreDiff) > 0.001) {
      return scoreDiff
    }

    // 5. 保底：显存需求越小越靠前
    const aVram = a.vramNeededGB || 0
    const bVram = b.vramNeededGB || 0
    return aVram - bVram
  })
}
