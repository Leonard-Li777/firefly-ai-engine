import React from 'react'
import { Languages } from 'lucide-react'
import { i18nScope, t } from '../../languages'
import { SUPPORTED_LANGUAGES, SupportedLanguage } from '../../lib/language'
import { useEngineStore } from '../../stores/engine-store'

export const LanguageSelector: React.FC = () => {
  const { fetchModels } = useEngineStore()

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const lang = e.target.value as SupportedLanguage
    // 切换标准多语言作用域语言，完成后再按新语言重新拉取模型元数据
    // （借 fetchModels 的 store 更新触发全局重渲染，使界面文案同步为新语言）
    i18nScope.change(lang).finally(() => {
      fetchModels()
    })
  }

  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-muted/50 border border-border/50 text-xs font-bold hover:bg-muted transition-colors">
      <Languages className="h-3.5 w-3.5 text-primary shrink-0" />
      <select
        value={i18nScope.activeLanguage}
        onChange={handleLanguageChange}
        className="bg-transparent border-none outline-hidden text-xs font-semibold cursor-pointer text-foreground"
        title={t('选择界面语言 (Switch Language)')}
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
