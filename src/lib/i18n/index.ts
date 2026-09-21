import { create } from 'zustand'
import { SupportedLanguage, SUPPORTED_LANGUAGES } from './types'
import { zhCN, TranslationKeys } from './locales/zh-CN'
import { enUS } from './locales/en-US'
import { deDE } from './locales/de-DE'

// 翻译字典映射，默认提供 zh-CN、en-US 与 de-DE，其余语言平滑回退
const translations: Record<SupportedLanguage, TranslationKeys> = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'ja-JP': enUS,
  'ko-KR': enUS,
  'fr-FR': enUS,
  'de-DE': deDE,
  'es-ES': enUS,
  'ru-RU': enUS,
  'pt-PT': enUS,
  'ar-EG': enUS
}

interface I18nState {
  currentLanguage: SupportedLanguage
  dir: 'ltr' | 'rtl'
  setLanguage: (lang: SupportedLanguage) => void
  t: (path: string, params?: Record<string, string | number>) => string
}

function getInitialLanguage(): SupportedLanguage {
  if (typeof window !== 'undefined' && window.localStorage) {
    const saved = window.localStorage.getItem('ai_engine_language') as SupportedLanguage
    if (saved && SUPPORTED_LANGUAGES.some(l => l.code === saved)) {
      return saved
    }
    const navLang = navigator.language
    if (navLang.startsWith('zh')) return 'zh-CN'
    if (navLang.startsWith('ja')) return 'ja-JP'
    if (navLang.startsWith('ko')) return 'ko-KR'
    if (navLang.startsWith('fr')) return 'fr-FR'
    if (navLang.startsWith('de')) return 'de-DE'
    if (navLang.startsWith('es')) return 'es-ES'
    if (navLang.startsWith('ru')) return 'ru-RU'
    if (navLang.startsWith('pt')) return 'pt-PT'
    if (navLang.startsWith('ar')) return 'ar-EG'
  }
  return 'zh-CN'
}

function resolveValue(obj: any, path: string): string | undefined {
  const parts = path.split('.')
  let curr = obj
  for (const p of parts) {
    if (curr === undefined || curr === null) return undefined
    curr = curr[p]
  }
  return typeof curr === 'string' ? curr : undefined
}

export const useI18nStore = create<I18nState>((set, get) => {
  const initialLang = getInitialLanguage()
  const initialInfo = SUPPORTED_LANGUAGES.find(l => l.code === initialLang)

  return {
    currentLanguage: initialLang,
    dir: initialInfo?.dir || 'ltr',
    setLanguage: (lang: SupportedLanguage) => {
      const info = SUPPORTED_LANGUAGES.find(l => l.code === lang)
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem('ai_engine_language', lang)
      }
      set({
        currentLanguage: lang,
        dir: info?.dir || 'ltr'
      })
    },
    t: (path: string, params?: Record<string, string | number>) => {
      const { currentLanguage } = get()
      const dict = translations[currentLanguage] || translations['zh-CN']
      
      // 1. 如果当前字典本身包含该直接 key (例如原生中文 key)
      let val: string | undefined = (dict as any)?.[path]
      
      // 2. 如果不存在，尝试 dot 路径递归查找 (兼容 storage.title 等旧路径)
      if (!val && path.includes('.')) {
        val = resolveValue(dict, path)
      }

      // 3. 如果非中文语言没有找到，回退至 zh-CN 字典
      if (!val) {
        val = (translations['zh-CN'] as any)?.[path]
        if (!val && path.includes('.')) {
          val = resolveValue(translations['zh-CN'], path)
        }
      }

      // 4. 如果仍未找到，直接返回原生传入的字符串 (如自然中文)
      if (!val) {
        val = path
      }

      // 5. 变量插值替换: {name}
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          val = val.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
        }
      }
      return val
    }
  }
})

/**
 * 方便直接调用的 t 函数（取当前语言）
 */
export function t(path: string, params?: Record<string, string | number>): string {
  return useI18nStore.getState().t(path, params)
}

export * from './types'
