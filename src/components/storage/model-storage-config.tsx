import React, { useState, useEffect } from 'react'
import { FolderOpen, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react'
import { Card } from '../ui/card'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { useEngineStore } from '../../stores/engine-store'
import { useI18nStore } from '../../lib/i18n'
import { invoke } from '@tauri-apps/api/core'

import { validateModelPath } from '../../lib/path-utils'

export const ModelStorageConfig: React.FC = () => {
  const { t } = useI18nStore()
  const { modelsDir, updateStoragePath, rescanModels, loading } = useEngineStore()
  const [inputPath, setInputPath] = useState(modelsDir)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setInputPath(modelsDir)
  }, [modelsDir])

  const handleSave = async (pathOverride?: string) => {
    const targetPath = (pathOverride || inputPath).trim()
    const validation = validateModelPath(targetPath)
    if (!validation.isValid) {
      setFeedback({ type: 'error', message: validation.error || t('路径格式不合法') })
      return
    }

    setIsSaving(true)
    setFeedback(null)
    const success = await updateStoragePath(targetPath)
    setIsSaving(false)

    if (success) {
      setFeedback({ type: 'success', message: t('模型存储目录已成功更改并已刷新扫描模型！') })
      setTimeout(() => setFeedback(null), 4000)
    } else {
      setFeedback({ type: 'error', message: t('更改存储目录失败，请检查目录权限。') })
    }
  }

  // 调用 Tauri 原生目录选择对话框（通过自定义 select_directory 命令实现）
  const handleBrowse = async () => {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        // 调用 Rust 侧 rfd 弹出系统原生目录选择器
        const selected = await invoke<string | null>('select_directory', {
          defaultPath: modelsDir
        })
        if (selected) {
          setInputPath(selected)
          await handleSave(selected)
        }
        return
      } catch (e) {
        console.warn('Tauri 目录选择器不可用:', e)
      }
    }

    // Web / 沙盒开发模式下提供预设快速路径选择
    const promptPath = window.prompt(t('请输入自定义模型存储目录的绝对路径:'), inputPath)
    if (promptPath && promptPath !== inputPath) {
      setInputPath(promptPath)
      await handleSave(promptPath)
    }
  }

  return (
    <Card className="p-5 border border-border/80 rounded-2xl bg-card shadow-xs space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1.5">
        <div>
          <Label className="text-base font-bold tracking-tight text-foreground flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-primary" />
            <span>{t('模型存储目录自定义配置')}</span>
          </Label>
          <p className="text-xs text-muted-foreground font-normal mt-1 leading-relaxed">
            {t('自定义大容量磁盘存放目录，避免占用系统盘空间。更改后将即时扫描该目录下的 GGUF 模型。')}
          </p>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-2.5">
        <div className="relative flex-1">
          <Input
            value={inputPath}
            readOnly
            placeholder={t('点击右侧“浏览”选择模型存储目录')}
            className="h-9.5 font-mono text-xs pr-10 rounded-lg bg-muted/30 border-border/80 cursor-default focus:border-primary"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={isSaving}
            onClick={handleBrowse}
            className="h-9.5 px-3.5 font-bold text-xs rounded-lg border-border/80 hover:bg-muted/50"
          >
            <FolderOpen className={`h-3.5 w-3.5 mr-1.5 ${isSaving ? 'animate-pulse' : ''}`} />
            {isSaving ? t('迁移中...') : t('浏览')}
          </Button>

          <Button
            variant="secondary"
            disabled={loading || isSaving}
            onClick={() => rescanModels()}
            className="h-9.5 px-3.5 font-bold text-xs rounded-lg bg-muted/60 hover:bg-muted text-foreground border border-border/30"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            {t('重新扫描')}
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

