import React, { useState, useEffect } from 'react'
import { FolderOpen, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react'
import { Card } from '../ui/card'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { useEngineStore } from '../../stores/engine-store'
import { useI18nStore } from '../../lib/i18n'

export const ModelStorageConfig: React.FC = () => {
  const { t } = useI18nStore()
  const { modelsDir, updateStoragePath, rescanModels, loading } = useEngineStore()
  const [inputPath, setInputPath] = useState(modelsDir)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setInputPath(modelsDir)
  }, [modelsDir])

  const validatePath = (pathStr: string): boolean => {
    if (!pathStr || pathStr.trim().length === 0) return false
    // 简单的 Windows / POSIX 路径格式校验
    const isWindows = /^[a-zA-Z]:[\\/]/.test(pathStr)
    const isPosix = pathStr.startsWith('/')
    return isWindows || isPosix
  }

  const handleSave = async (pathOverride?: string) => {
    const targetPath = (pathOverride || inputPath).trim()
    if (!validatePath(targetPath)) {
      setFeedback({ type: 'error', message: '路径格式不合法，请输入绝对路径（如 D:\\AI_Models 或 /data/models）' })
      return
    }

    setIsSaving(true)
    setFeedback(null)
    const success = await updateStoragePath(targetPath)
    setIsSaving(false)

    if (success) {
      setFeedback({ type: 'success', message: '模型存储目录已成功更改并已刷新扫描模型！' })
      setTimeout(() => setFeedback(null), 4000)
    } else {
      setFeedback({ type: 'error', message: '更改存储目录失败，请检查目录权限。' })
    }
  }

  // 模拟调用系统目录选择器（在 Tauri 2 环境下调用 dialog.open）
  const handleBrowse = async () => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        const dialogModule = await (new Function('return import("@tauri-apps/plugin-dialog")'))()
        const selected = await dialogModule.open({ directory: true, multiple: false })
        if (selected && typeof selected === 'string') {
          setInputPath(selected)
          await handleSave(selected)
        }
        return
      } catch (e) {
        console.warn('Tauri 目录选择器不可用，进入沙盒选择模式:', e)
      }
    }

    // Web / 沙盒开发模式下提供预设快速路径选择
    const promptPath = window.prompt('请输入自定义模型存储目录的绝对路径:', inputPath)
    if (promptPath && promptPath !== inputPath) {
      setInputPath(promptPath)
      await handleSave(promptPath)
    }
  }

  return (
    <Card className="p-5 border-border/30 rounded-xl bg-card shadow-xs space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1.5">
        <div>
          <Label className="text-base font-bold tracking-tight text-foreground flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-primary" />
            <span>{t('storage.title')}</span>
          </Label>
          <p className="text-xs text-muted-foreground/80 font-normal mt-1 leading-relaxed">
            {t('storage.desc')}
          </p>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-2.5">
        <div className="relative flex-1">
          <Input
            value={inputPath}
            onChange={e => setInputPath(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleSave()
            }}
            placeholder="例如: D:\AI_Models 或 /Volumes/Data/AI_Models"
            className="h-9.5 font-mono text-xs pr-10 rounded-lg bg-background/60 border-border/40 focus:border-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={handleBrowse}
            className="h-9.5 px-3.5 font-bold text-xs rounded-lg border-border/40 hover:bg-muted/50"
          >
            <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
            {t('storage.btnBrowse')}
          </Button>

          <Button
            variant="default"
            disabled={isSaving || inputPath === modelsDir}
            onClick={() => handleSave()}
            className="h-9.5 px-4 font-bold text-xs rounded-lg shadow-xs"
          >
            保存并生效
          </Button>

          <Button
            variant="secondary"
            disabled={loading}
            onClick={() => rescanModels()}
            className="h-9.5 px-3.5 font-bold text-xs rounded-lg bg-muted/60 hover:bg-muted text-foreground border border-border/30"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            {t('storage.btnRescan')}
          </Button>
        </div>
      </div>

      {feedback && (
        <div
          className={`flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-lg border ${
            feedback.type === 'success'
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20'
              : 'bg-destructive/10 text-destructive border-destructive/20'
          }`}
        >
          {feedback.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" />
          )}
          <span>{feedback.message}</span>
        </div>
      )}
    </Card>
  )
}

