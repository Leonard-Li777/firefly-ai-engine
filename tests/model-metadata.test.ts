import { describe, it, expect } from 'vitest'
import {
  modelMetadataService,
  estimateRequiredVRAM,
  parseSizeToGB
} from '../src/lib/model-metadata-service'
import { useI18nStore, t } from '../src/lib/i18n'
import { SupportedLanguage } from '../src/lib/i18n/types'

describe('ModelMetadataService & 10 Languages Built-in Metadata', () => {
  const languages: SupportedLanguage[] = [
    'zh-CN',
    'en-US',
    'ja-JP',
    'ko-KR',
    'fr-FR',
    'de-DE',
    'es-ES',
    'ru-RU',
    'pt-PT',
    'ar-EG'
  ]

  it('should load model lists for all 10 supported languages without crash', () => {
    for (const lang of languages) {
      const models = modelMetadataService.getModelsForLanguage(lang)
      expect(models.length).toBeGreaterThan(0)
      expect(models[0].id).toBeDefined()
      expect(models[0].name).toBeDefined()
      expect(models[0].vramNeededGB).toBeGreaterThan(0)
    }
  })

  it('should get language-specific model descriptions and recommendations', () => {
    const zhModels = modelMetadataService.getModelsForLanguage('zh-CN')
    const enModels = modelMetadataService.getModelsForLanguage('en-US')

    expect(zhModels.some(m => m.name.includes('中文更佳'))).toBe(true)
    const qwenZh = zhModels.find(m => m.id.includes('Qwen3.5-0.8B'))
    expect(qwenZh?.description).toContain('中文')

    const qwenEn = enModels.find(m => m.id.includes('Qwen3.5-0.8B') || m.id.includes('LFM'))
    expect(qwenEn).toBeDefined()
  })

  it('should calculate required VRAM accurately using Max-Fill overhead formula', () => {
    // 558MB -> 0.545GB * 1.15 + 0.5 = 1.12GB -> ceil = 2GB
    expect(estimateRequiredVRAM('558MB')).toBe(2)
    // 4.37GB -> 4.37 * 1.15 + 0.5 = 5.52GB -> ceil = 6GB
    expect(estimateRequiredVRAM('4.37GB')).toBe(6)
    // 8.5GB -> 8.5 * 1.15 + 0.5 = 10.27GB -> ceil = 11GB
    expect(estimateRequiredVRAM('8.5GB')).toBe(11)
  })

  it('should parse size strings accurately', () => {
    expect(parseSizeToGB('1.5GB')).toBe(1.5)
    expect(parseSizeToGB('1024MB')).toBe(1)
    expect(parseSizeToGB('512MB')).toBe(0.5)
    expect(parseSizeToGB('')).toBe(0)
  })
})

describe('i18n Store & Localization', () => {
  it('should translate keys correctly in zh-CN', () => {
    useI18nStore.getState().setLanguage('zh-CN')
    expect(t('app.title')).toBe('Firefly AI Engine')
    expect(t('hardware.title')).toBe('硬件环境与驱动诊断')
    expect(t('storage.scanSuccess', { count: 3 })).toBe('扫描完成，发现 3 个模型')
  })

  it('should switch language to en-US and reflect in translations', () => {
    useI18nStore.getState().setLanguage('en-US')
    expect(t('hardware.gpuModel')).toBe('GPU Model')
    expect(t('engine.title')).toBe('Switch Local AI Engine')
    expect(t('storage.scanSuccess', { count: 5 })).toBe('Scan completed, found 5 models')
  })

  it('should fallback gracefully for unsupported keys', () => {
    expect(t('non_existing_path_abc')).toBe('non_existing_path_abc')
  })
})
