import React from 'react'
import { Languages } from 'lucide-react'
import { useI18nStore, SUPPORTED_LANGUAGES, SupportedLanguage } from '../../lib/i18n'
import { useEngineStore } from '../../stores/engine-store'

export const LanguageSelector: React.FC = () => {
  const { currentLanguage, setLanguage } = useI18nStore()
  const { fetchModels } = useEngineStore()

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const lang = e.target.value as SupportedLanguage
    setLanguage(lang)
    fetchModels()
  }

  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-muted/50 border border-border/50 text-xs font-bold hover:bg-muted transition-colors">
      <Languages className="h-3.5 w-3.5 text-primary shrink-0" />
      <select
        value={currentLanguage}
        onChange={handleLanguageChange}
        className="bg-transparent border-none outline-hidden text-xs font-semibold cursor-pointer text-foreground"
        title="选择界面语言 (Switch Language)"
      >
        {SUPPORTED_LANGUAGES.map(lang => (
          <option key={lang.code} value={lang.code} className="bg-background text-foreground">
            {lang.nativeName} ({lang.code})
          </option>
        ))}
      </select>
    </div>
  )
}
