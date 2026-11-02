import { describe, it, expect } from 'vitest'
import {
  recommendComponentsForModel,
  formatSizeFromGB
} from '../src/lib/model-component-recommender'
import { isModelExceedsHardware } from '../src/lib/model-sorting'
import { HardwareSpec, ModelItem } from '../src/api/types'

describe('model-component-recommender: 基于动态显存水位比的硬件自适应推荐', () => {
  const miniCpm1B = {
    id: 'OpenBMB/MiniCPM-V-4.7-1B',
    name: 'MiniCPM-V 4.7 1B',
    source: 'modelscope' as const,
    quant: 'Q4_K_M',
    fileSize: 1720000000,
    params: '1B',
    description: '多模态 1B',
    modelSize: '727MB',
    mmproj: 'f16',
    mmprojSize: '858MB',
    dspark: 'DSpark-BF16',
    dsparkSize: '180MB',
    size: '1.72GB',
    recommended: true,
    isDownloaded: false
  } as ModelItem

  const largeModel9B = {
    id: 'large-multimodal-9b',
    name: 'Large Multimodal 9B',
    source: 'huggingface' as const,
    quant: 'Q4_K_M',
    fileSize: 7700000000,
    params: '9B',
    description: '大模型 9B',
    modelSize: '5.5GB',
    mmproj: 'f16',
    mmprojSize: '1.8GB',
    dspark: 'DSpark-BF16',
    dsparkSize: '0.4GB',
    size: '7.7GB',
    recommended: true,
    isDownloaded: false
  } as ModelItem

  const mtpGemmaModel = {
    id: 'unsloth/gemma-4-E2B-it-qat-MTP',
    name: 'Gemma 4 E2B MTP',
    source: 'huggingface' as const,
    quant: 'Q4_K_M',
    fileSize: 3400000000,
    params: '2B',
    description: 'MTP 2B',
    modelSize: '2.5GB',
    draftId: 'NicklausCairns/gemma-4-E2B-it-qat-assistant-MTP-Q8_0',
    draftSize: '0.9GB',
    size: '3.4GB',
    recommended: true,
    isDownloaded: false
  } as ModelItem

  it('场景 1: Apple Silicon (Metal) 统一内存设备解耦，不被核显标记误杀', () => {
    const appleSiliconHardware = {
      gpu_name: 'Apple M3 Pro',
      best_tier: 'metal',
      current_tier: 'metal',
      total_vram_gb: 0, // Metal 报告 0 或共享
      total_ram_gb: 32, // 32GB 统一内存
      is_integrated: true
    } as HardwareSpec

    const res = recommendComponentsForModel(miniCpm1B, appleSiliconHardware)
    expect(res.isAppleSilicon).toBe(true)
    expect(res.effectiveVramGB).toBeCloseTo(32 * 0.7, 1) // 22.4GB
    expect(res.tier).toBe('full')
    expect(res.selectedComponents.main).toBe(true)
    expect(res.selectedComponents.mmproj).toBe(true)
    expect(res.selectedComponents.dspark).toBe(true)
  })

  it('场景 2: 6GB 显卡运行 1B 超小模型，显存充裕推荐全选 (full)', () => {
    const pc6GbHardware = {
      gpu_name: 'NVIDIA RTX 4060',
      best_tier: 'cuda',
      current_tier: 'cuda',
      total_vram_gb: 6,
      total_ram_gb: 16,
      is_integrated: false
    } as HardwareSpec

    const res = recommendComponentsForModel(miniCpm1B, pc6GbHardware)
    expect(res.tier).toBe('full')
    expect(res.selectedComponents.main).toBe(true)
    expect(res.selectedComponents.mmproj).toBe(true)
    expect(res.selectedComponents.dspark).toBe(true)
  })

  it('场景 3: 8GB 显存运行 9B 多模态大模型，因水位比不足降级推荐为 balanced 或 minimal，防爆显存', () => {
    const pc8GbHardware = {
      gpu_name: 'NVIDIA RTX 4070',
      best_tier: 'cuda',
      current_tier: 'cuda',
      total_vram_gb: 8,
      total_ram_gb: 16,
      is_integrated: false
    } as HardwareSpec

    const res = recommendComponentsForModel(largeModel9B, pc8GbHardware)
    // 9B 模型: 主5.5G + 加速0.4G = 5.9G, mmproj 1.8G.
    // fullNeeded: 5.9 * 1.15 + 0.5 + 1.8 * 1.02 ≈ 7.285 + 1.836 = 9.12GB > 8 * 0.85 (6.8GB)
    // 故绝不可能推荐 full
    expect(res.tier).not.toBe('full')
    expect(res.selectedComponents.mmproj).toBe(false)
  })

  it('场景 4: 极低配 / 纯 CPU (0 VRAM)，保底推荐仅主模型 (minimal)', () => {
    const cpuHardware = {
      gpu_name: 'Intel CPU',
      best_tier: 'cpu',
      current_tier: 'cpu',
      total_vram_gb: 0,
      total_ram_gb: 8,
      is_integrated: true
    } as HardwareSpec

    const res = recommendComponentsForModel(miniCpm1B, cpuHardware)
    expect(res.tier).toBe('minimal')
    expect(res.selectedComponents.main).toBe(true)
    expect(res.selectedComponents.mmproj).toBe(false)
    expect(res.selectedComponents.dspark).toBe(false)
    expect(res.selectedComponents.draft).toBe(false)
  })

  it('场景 5: 首帧 hardware === null 时平滑回退，防白屏与提示闪烁', () => {
    const res = recommendComponentsForModel(miniCpm1B, null)
    expect(res.selectedComponents.main).toBe(true)
    expect(typeof res.tipText).toBe('string')
  })

  it('场景 6: MTP 草稿模型伴随推荐 (draft)', () => {
    const pc8GbHardware = {
      gpu_name: 'NVIDIA RTX 4080',
      best_tier: 'cuda',
      current_tier: 'cuda',
      total_vram_gb: 8,
      total_ram_gb: 16,
      is_integrated: false
    } as HardwareSpec

    const res = recommendComponentsForModel(mtpGemmaModel, pc8GbHardware)
    expect(res.selectedComponents.main).toBe(true)
    expect(res.selectedComponents.draft).toBe(true)
  })

  it('formatSizeFromGB 格式化正确', () => {
    expect(formatSizeFromGB(0.71)).toBe('727MB')
    expect(formatSizeFromGB(1.72)).toBe('1.72GB')
    expect(formatSizeFromGB(0)).toBe('0MB')
  })

  describe('isModelExceedsHardware 门禁解耦测试', () => {
    it('以主模型体积作为可运行门禁，伴随模型超标不影响主模型准入', () => {
      // 假设用户显存 4GB (上限 4 * 1.2 = 4.8GB)
      // miniCpm1B 主模型 727MB (需求 ~1.3GB <= 2GB CPU安全阈值)
      // 即使总包 1.72GB，主模型门禁也绝不超标
      expect(isModelExceedsHardware(miniCpm1B, 4)).toBe(false)
    })

    it('Apple Silicon 统一内存设备在 isModelExceedsHardware 中放行', () => {
      const appleSiliconHardware = {
        gpu_name: 'Apple M3 Max',
        best_tier: 'metal',
        current_tier: 'metal',
        total_vram_gb: 0,
        total_ram_gb: 32,
        is_integrated: true
      } as HardwareSpec
      expect(isModelExceedsHardware(largeModel9B, 0, appleSiliconHardware)).toBe(false)
    })
  })
})
