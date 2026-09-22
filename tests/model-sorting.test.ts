import { describe, it, expect } from 'vitest'
import {
  isModelExceedsHardware,
  calculateModelScore,
  sortModels
} from '../src/lib/model-sorting'
import { ModelItem } from '../src/api/types'

describe('model-sorting: 显存超标判定与性价比加权排序', () => {
  describe('isModelExceedsHardware', () => {
    it('显存需求 <= 2GB 的模型作为 CPU 兼容模式，永远不判定为超标', () => {
      const cpuModel: Partial<ModelItem> = {
        id: 'qwen-0.8b',
        vramNeededGB: 2.0,
        size: '558MB'
      }
      // 即使显存为 0GB 或 1GB，也绝不超标
      expect(isModelExceedsHardware(cpuModel, 0)).toBe(false)
      expect(isModelExceedsHardware(cpuModel, 1)).toBe(false)
      expect(isModelExceedsHardware(cpuModel, 8)).toBe(false)
    })

    it('显存需求 > 2GB 时，若用户显存 <= 1GB，判定为超标', () => {
      const largerModel: Partial<ModelItem> = {
        id: 'minicpm-2b',
        vramNeededGB: 3.0,
        size: '1.45GB'
      }
      expect(isModelExceedsHardware(largerModel, 0)).toBe(true)
      expect(isModelExceedsHardware(largerModel, 1)).toBe(true)
    })

    it('显存需求 > 2GB 时，若需求超过用户显存的 1.2 倍，判定为超标；1.2 倍以内放行', () => {
      const model6GB: Partial<ModelItem> = {
        id: 'model-6gb',
        vramNeededGB: 6.0,
        size: '4.5GB'
      }
      // 用户显存 4GB: 4 * 1.2 = 4.8GB < 6GB -> 超标
      expect(isModelExceedsHardware(model6GB, 4)).toBe(true)
      // 用户显存 5GB: 5 * 1.2 = 6.0GB >= 6GB -> 临界不超标
      expect(isModelExceedsHardware(model6GB, 5)).toBe(false)
      // 用户显存 8GB: 8 * 1.2 = 9.6GB > 6GB -> 不超标
      expect(isModelExceedsHardware(model6GB, 8)).toBe(false)
    })
  })

  describe('calculateModelScore & sortModels 加权排序', () => {
    const model08B: ModelItem = {
      id: 'qwen-0.8b',
      name: 'Qwen 0.8B',
      source: 'modelscope',
      quant: 'Q4_K_M',
      fileSize: 558 * 1024 * 1024,
      size: '558MB',
      params: '0.8B',
      description: '极小模型',
      isDownloaded: false,
      recommended: true,
      intelligenceLevel: 1, // 小学生
      vramNeededGB: 2.0
    }

    const model2BHigh: ModelItem = {
      id: 'minicpm-2b',
      name: 'MiniCPM5 2B',
      source: 'modelscope',
      quant: 'Q4_K_M',
      fileSize: Math.round(1.45 * 1024 * 1024 * 1024),
      size: '1.45GB',
      params: '2B',
      description: '高质量高效模型',
      isDownloaded: false,
      recommended: true,
      intelligenceLevel: 3, // 高中生
      vramNeededGB: 3.0
    }

    const model8B: ModelItem = {
      id: 'qwen-8b',
      name: 'Qwen 8B',
      source: 'modelscope',
      quant: 'Q4_K_M',
      fileSize: 5 * 1024 * 1024 * 1024,
      size: '5.0GB',
      params: '8B',
      description: '高智能大模型',
      isDownloaded: false,
      recommended: true,
      intelligenceLevel: 4, // 大学生
      vramNeededGB: 7.0
    }

    it('体积较小且智能程度高的模型（如 MiniCPM 2B）综合性价比分数应高于纯体积极小但智能低的模型（0.8B）', () => {
      const minSize = 0.5
      const maxSize = 6.0
      const score08B = calculateModelScore(model08B, minSize, maxSize)
      const score2B = calculateModelScore(model2BHigh, minSize, maxSize)
      const score8B = calculateModelScore(model8B, minSize, maxSize)

      // 0.8B: 体积很小但智能为 1（最低分）
      // 2B: 体积只大一点点，但智能为 3（高中生，明显更高）
      expect(score2B).toBeGreaterThan(score08B)
      // 8B: 智能为 4，但体积大（5GB），体积得分被压低
      expect(score2B).toBeGreaterThan(score8B)
    })

    it('sortModels 应将超显存模型置底，未超标模型按性价比排在前面', () => {
      // 假设用户显存为 4GB
      // model8B 需求 7GB > 4 * 1.2 (4.8GB) -> isEx = true
      // model08B 需求 2GB -> isEx = false
      // model2BHigh 需求 3GB <= 4.8GB -> isEx = false
      const sorted = sortModels([model8B, model08B, model2BHigh], 4)

      expect(sorted.length).toBe(3)
      // 8B 超出显存，应排在末尾并标记 isEx = true
      expect(sorted[2].id).toBe('qwen-8b')
      expect(sorted[2].isEx).toBe(true)

      // 前两位未超标，MiniCPM 2B 性价比最高排第一，0.8B 排第二
      expect(sorted[0].id).toBe('minicpm-2b')
      expect(sorted[0].isEx).toBe(false)
      expect(sorted[1].id).toBe('qwen-0.8b')
      expect(sorted[1].isEx).toBe(false)
    })

    it('显存充足（16GB）时，所有模型均未超标，MiniCPM 2B 性价比最高依然排在最前', () => {
      const sorted = sortModels([model8B, model08B, model2BHigh], 16)
      expect(sorted.every(m => !m.isEx)).toBe(true)
      expect(sorted[0].id).toBe('minicpm-2b')
    })
  })
})
