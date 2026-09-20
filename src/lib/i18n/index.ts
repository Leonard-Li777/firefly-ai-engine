import { create } from 'zustand'
import { SupportedLanguage, SUPPORTED_LANGUAGES } from './types'
import { zhCN, TranslationKeys } from './locales/zh-CN'
import { enUS } from './locales/en-US'

// 翻译字典映射，默认提供 zh-CN 与 en-US，其余语言平滑回退到 en-US
const translations: Record<SupportedLanguage, TranslationKeys> = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'ja-JP': enUS,
  'ko-KR': enUS,
  'fr-FR': enUS,
  'de-DE': enUS,
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
      let val = resolveValue(dict, path)

      // 回退至 zh-CN
      if (!val) {
        val = resolveValue(translations['zh-CN'], path)
      }

      if (!val) {
        return path
      }

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
