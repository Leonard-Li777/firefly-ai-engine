/**
 * 多语言支持类型定义（纯常量，不含翻译逻辑）
 * 翻译能力统一由标准多语言流水线模块 src/languages（VoerkaI18n）提供，
 * 本文件仅承载语言代码、展示名与文字方向等元数据。
 * 涵盖系统支持的 10 种国际化语言
 */

export type SupportedLanguage =
  | 'zh-CN'
  | 'en-US'
  | 'ja-JP'
  | 'ko-KR'
  | 'fr-FR'
  | 'de-DE'
  | 'es-ES'
  | 'ru-RU'
  | 'pt-PT'
  | 'ar-EG'

export interface LanguageInfo {
  code: SupportedLanguage
  label: string
  nativeName: string
  dir?: 'ltr' | 'rtl'
}

export const SUPPORTED_LANGUAGES: LanguageInfo[] = [
  { code: 'zh-CN', label: '简体中文', nativeName: '简体中文', dir: 'ltr' },
  { code: 'en-US', label: 'English', nativeName: 'English', dir: 'ltr' },
  { code: 'ja-JP', label: '日本語', nativeName: '日本語', dir: 'ltr' },
  { code: 'ko-KR', label: '한국어', nativeName: '한국어', dir: 'ltr' },
  { code: 'fr-FR', label: 'Français', nativeName: 'Français', dir: 'ltr' },
  { code: 'de-DE', label: 'Deutsch', nativeName: 'Deutsch', dir: 'ltr' },
  { code: 'es-ES', label: 'Español', nativeName: 'Español', dir: 'ltr' },
  { code: 'ru-RU', label: 'Русский', nativeName: 'Русский', dir: 'ltr' },
  { code: 'pt-PT', label: 'Português', nativeName: 'Português', dir: 'ltr' },
  { code: 'ar-EG', label: 'العربية', nativeName: 'العربية', dir: 'rtl' }
]
