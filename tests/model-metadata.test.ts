import { describe, it, expect } from 'vitest'
import {
  modelMetadataService,
  estimateRequiredVRAM,
  parseSizeToGB
} from '../src/lib/model-metadata-service'
import { i18nScope, t } from '../src/languages'
import { SupportedLanguage } from '../src/lib/language'

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

describe('标准多语言作用域（VoerkaI18n）行为', () => {
  it('未翻译文案应原样返回中文源文', () => {
    expect(t('硬件环境与驱动诊断')).toBe('硬件环境与驱动诊断')
  })

  it('应支持 {name} 插值', () => {
    expect(t('扫描完成，发现 {count} 个模型', { count: 3 })).toBe('扫描完成，发现 3 个模型')
  })

  it('activeLanguage 应始终有值且未翻译 key 原样回退', () => {
    expect(i18nScope.activeLanguage).toBeTruthy()
    expect(t('non_existing_path_abc')).toBe('non_existing_path_abc')
  })
})
