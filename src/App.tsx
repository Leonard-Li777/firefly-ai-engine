import React, { useEffect, useState } from 'react'
import {
  Cpu,
  Zap,
  Globe2,
  RefreshCw,
  Server,
  Activity,
  Moon,
  Sun
} from 'lucide-react'
import { Badge } from './components/ui/badge'
import { Switch } from './components/ui/switch'
import { HardwareCard } from './components/hardware/hardware-card'
import { EngineTable } from './components/engine/engine-table'
import { ModelStorageConfig } from './components/storage/model-storage-config'
import { ModelListPanel } from './components/model/model-list-panel'
import { HardwareMonitorPanel } from './components/monitor/hardware-monitor-panel'
import { LanguageSelector } from './components/common/language-selector'
import { useEngineStore } from './stores/engine-store'
import { useI18nStore } from './lib/i18n'
import { engineApiClient } from './api/client'

export const App: React.FC = () => {
  const { t, dir } = useI18nStore()
  const {
    engineStatus,
    fetchEngineStatus,
    fetchEngineList,
    fetchModels,
    regionInfo,
    runRegionDetection
  } = useEngineStore()

  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme')
      if (saved === 'dark') return true
      if (saved === 'light') return false
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })

  useEffect(() => {
    // 同步明暗模式样式到 DOM
    if (isDarkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }

    // 初始化加载
    const initApp = async () => {
      if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const actualPort = await invoke<number>('get_server_port')
          if (actualPort) {
            engineApiClient.setBaseUrl(`http://127.0.0.1:${actualPort}`)
          }
        } catch (e) {
          console.warn('获取 Tauri 后端动态端口失败，使用默认配置:', e)
        }
      }

      await Promise.allSettled([
        fetchEngineStatus(),
        fetchEngineList(),
        fetchModels(),
        runRegionDetection()
      ])
    }

    initApp()
  }, [fetchEngineStatus, fetchEngineList, fetchModels, runRegionDetection])

  const handleThemeChange = (checked: boolean) => {
    setIsDarkMode(checked)
    if (checked) {
      document.documentElement.classList.add('dark')
      localStorage.setItem('theme', 'dark')
    } else {
      document.documentElement.classList.remove('dark')
      localStorage.setItem('theme', 'light')
    }
  }

  const isMock = engineApiClient.isMockMode()

  return (
    <div dir={dir} className="min-h-screen bg-background text-foreground flex flex-col font-sans transition-colors duration-200">
      {/* 顶部导航与状态条 */}
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md px-6 py-3.5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-xs">
            <Zap className="h-5 w-5 fill-current" />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="text-base font-black tracking-tight">{t('app.title')}</span>
              <Badge variant="outline" className="text-[10px] h-4.5 px-1.5 py-0 font-bold">
                Tier 2 独立引擎
              </Badge>
              {isMock && (
                <Badge variant="secondary" className="text-[10px] h-4.5 px-1.5 py-0 font-bold">
                  沙盒 Mock 模式
                </Badge>
              )}
            </div>
            <span className="text-[11px] text-muted-foreground font-medium">
              {t('app.subtitle')}
            </span>
          </div>
        </div>

        {/* 顶部右侧快捷状态 */}
        <div className="flex items-center gap-2.5">
          {/* 网络探针状态 */}
          <div
            className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-muted/50 border border-border/50 text-xs font-bold cursor-pointer hover:bg-muted transition-colors"
            title="点击重新探测网络环境与镜像加速源"
            onClick={() => runRegionDetection(true)}
          >
            <Globe2 className="h-3.5 w-3.5 text-primary" />
            <span>网络镜像: {regionInfo?.region === 'cn' ? '国内高速加速 (CN)' : '海外官方 (Global)'}</span>
            <RefreshCw className="h-3 w-3 text-muted-foreground ml-0.5" />
          </div>

          {/* 服务状态指示 */}
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 text-xs font-black">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span>{engineStatus?.status === 'ready' ? '就绪 (38400)' : '启动中...'}</span>
          </div>

          {/* 语言切换下拉 */}
          <LanguageSelector />

          {/* 明暗模式 Switch 开关 */}
          <div
            className="flex items-center gap-2 px-3 py-1 rounded-xl bg-muted/50 border border-border/50 text-xs font-semibold cursor-pointer select-none hover:bg-muted/80 transition-colors"
            onClick={() => handleThemeChange(!isDarkMode)}
            title={isDarkMode ? '切换至明亮模式' : '切换至暗色模式'}
          >
            {isDarkMode ? (
              <Moon className="h-3.5 w-3.5 text-primary" />
            ) : (
              <Sun className="h-3.5 w-3.5 text-amber-500" />
            )}
            <span className="text-[11px] text-muted-foreground font-bold min-w-[24px]">
              {isDarkMode ? '暗色' : '明亮'}
            </span>
            <Switch
              checked={isDarkMode}
              onCheckedChange={handleThemeChange}
              aria-label="切换明暗主题"
              className="scale-90 pointer-events-none"
            />
          </div>
        </div>
      </header>

      {/* 主工作区 */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-6 space-y-6">
        {/* 1. 硬件检测与驱动降级诊断卡片 */}
        <section>
          <HardwareCard />
        </section>

        {/* 2. AI 计算引擎管理表格 (1:1 移植) */}
        <section>
          <EngineTable />
        </section>

        {/* 3. 模型存储路径自定义配置与扫描 */}
        <section>
          <ModelStorageConfig />
        </section>

        {/* 4. 双轨模型生态与高速下载 */}
        <section>
          <ModelListPanel />
        </section>

        {/* 5. 显存负载与动态推理参数调优 */}
        <section>
          <HardwareMonitorPanel />
        </section>
      </main>

      {/* 底部信息栏 */}
      <footer className="border-t border-border/40 py-4 px-6 text-center text-xs text-muted-foreground/70 font-medium">
        <div className="flex flex-wrap items-center justify-center gap-4">
          <span className="flex items-center gap-1">
            <Server className="h-3.5 w-3.5" />
            基准服务监听: 127.0.0.1:{engineStatus?.port || 38400}
          </span>
          <span>•</span>
          <span className="flex items-center gap-1">
            <Activity className="h-3.5 w-3.5" />
            协议契约: 标准 OpenAI 兼容 (/v1/chat/completions)
          </span>
          <span>•</span>
          <span className="flex items-center gap-1">
            <Cpu className="h-3.5 w-3.5" />
            架构规范: ADR-0033 物理隔离与数据目录独立自治
          </span>
        </div>
      </footer>
    </div>
  )
}
