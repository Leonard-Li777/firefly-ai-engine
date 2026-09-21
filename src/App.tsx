import React, { useEffect, useState } from 'react'
import {
  Cpu,
  Zap,
  Globe2,
  RefreshCw,
  Server,
  Activity,
  Moon,
  Sun,
  Boxes,
  Sliders,
  LayoutDashboard
} from 'lucide-react'
import { Badge } from './components/ui/badge'
import { Switch } from './components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs'
import { DashboardView } from './components/dashboard/dashboard-view'
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

  // 顶层三大分层 Tab：
  // 1: 'dashboard' (概览仪表板)
  // 2: 'models' (模型库与存储管理)
  // 3: 'engine' (计算引擎与硬件环境)
  const [activeMainTab, setActiveMainTab] = useState<string>('dashboard')

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
      {/* 顶部常驻导航与状态条 */}
      <header className="sticky top-0 z-50 border-b border-border/80 bg-background/95 backdrop-blur-md px-5 py-3 flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 shadow-xs">
        <div className="flex items-center gap-3 shrink-0 min-w-0">
          <div className="flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs border border-primary/40">
            <Zap className="h-4.5 w-4.5 fill-current" />
          </div>
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2 flex-nowrap">
              <span className="text-sm font-bold tracking-tight text-foreground whitespace-nowrap">Firefly AI Engine</span>
              <Badge variant="outline" className="text-[10px] h-5 px-1.5 py-0 font-bold whitespace-nowrap shrink-0 rounded-md border-primary/40 text-primary bg-primary/10">
                {t('Tier 2 独立引擎')}
              </Badge>
              {isMock && (
                <Badge variant="secondary" className="text-[10px] h-5 px-1.5 py-0 font-bold whitespace-nowrap shrink-0 rounded-md border border-border/60">
                  {t('沙盒 Mock')}
                </Badge>
              )}
            </div>
            <span className="text-[11px] text-muted-foreground font-medium truncate max-w-[340px] sm:max-w-none">
              {t('独立高可用端侧 AI 推理引擎与模型管理平台')}
            </span>
          </div>
        </div>

        {/* 顶部右侧快捷状态与设置 */}
        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap justify-end shrink-0">
          {/* 网络探针状态 */}
          <div
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-muted/40 border border-border/70 text-xs font-semibold cursor-pointer hover:bg-muted/70 hover:border-border transition-colors shrink-0"
            title={t('点击重新探测网络环境与镜像加速源')}
            onClick={() => runRegionDetection(true)}
          >
            <Globe2 className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="truncate max-w-[130px] sm:max-w-[200px]">
              {regionInfo?.region === 'cn' ? t('国内高速源 (CN)') : t('海外官方 (Global)')}
            </span>
            <RefreshCw className="h-3 w-3 text-muted-foreground ml-0.5 shrink-0" />
          </div>

          {/* 服务状态指示 */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 text-xs font-bold shrink-0">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span>{engineStatus?.status === 'ready' ? `${t('就绪')} (${engineStatus.port || 38400})` : t('启动中...')}</span>
          </div>

          {/* 语言切换下拉 */}
          <LanguageSelector />

          {/* 明暗模式 Switch 开关 */}
          <div
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-muted/40 border border-border/70 text-xs font-semibold cursor-pointer select-none hover:bg-muted/70 hover:border-border transition-colors shrink-0"
            onClick={() => handleThemeChange(!isDarkMode)}
            title={isDarkMode ? t('切换至明亮模式') : t('切换至暗色模式')}
          >
            {isDarkMode ? (
              <Moon className="h-3.5 w-3.5 text-primary shrink-0" />
            ) : (
              <Sun className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            )}
            <span className="text-[11px] text-muted-foreground font-semibold min-w-[24px]">
              {isDarkMode ? t('暗色') : t('明亮')}
            </span>
            <Switch
              checked={isDarkMode}
              onCheckedChange={handleThemeChange}
              aria-label={t('切换明暗主题')}
              className="scale-85 pointer-events-none"
            />
          </div>
        </div>
      </header>

      {/* 吸顶 Tab 栏：分层次管理 (Dashboard -> 模型管理 -> 引擎与硬件) */}
      <div className="sticky top-[57px] z-40 bg-background/95 backdrop-blur-md border-b border-border/70 px-6 shadow-2xs">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Tabs
            value={activeMainTab}
            onValueChange={setActiveMainTab}
            className="w-full"
          >
            <TabsList className="flex justify-start h-12 bg-transparent p-0 rounded-none gap-1 shadow-none border-b-0">
              {/* Tab 1: 仪表板 Dashboard */}
              <TabsTrigger
                value="dashboard"
                className="px-4 h-full rounded-none font-semibold text-sm data-[state=active]:border-b-[3px] data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=inactive]:text-foreground/55 transition-all border-b-[3px] border-transparent hover:text-foreground hover:bg-muted/30 relative flex items-center gap-2 shadow-none"
              >
                <LayoutDashboard className="h-4 w-4" />
                <span>{t('仪表盘')}</span>
              </TabsTrigger>

              {/* Tab 2: 模型管理与存储 */}
              <TabsTrigger
                value="models"
                className="px-4 h-full rounded-none font-semibold text-sm data-[state=active]:border-b-[3px] data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=inactive]:text-foreground/55 transition-all border-b-[3px] border-transparent hover:text-foreground hover:bg-muted/30 relative flex items-center gap-2 shadow-none"
              >
                <Boxes className="h-4 w-4" />
                <span>{t('模型管理')}</span>
              </TabsTrigger>

              {/* Tab 3: 引擎与硬件 */}
              <TabsTrigger
                value="engine"
                className="px-4 h-full rounded-none font-semibold text-sm data-[state=active]:border-b-[3px] data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=inactive]:text-foreground/55 transition-all border-b-[3px] border-transparent hover:text-foreground hover:bg-muted/30 relative flex items-center gap-2 shadow-none"
              >
                <Sliders className="h-4 w-4" />
                <span>{t('引擎与硬件')}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* 主工作区 */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-6">
        {/* Tab 1: 仪表盘 Dashboard */}
        {activeMainTab === 'dashboard' && (
          <div className="space-y-6 animate-in fade-in duration-200">
            <DashboardView />
          </div>
        )}

        {/* Tab 2: 模型管理与存储 */}
        {activeMainTab === 'models' && (
          <div className="space-y-6 animate-in fade-in duration-200">
            {/* 1. 模型存储路径自定义配置与扫描 */}
            <section>
              <ModelStorageConfig />
            </section>

            {/* 2. 双轨模型生态与高速下载、独立启动参数配置 */}
            <section>
              <ModelListPanel />
            </section>
          </div>
        )}

        {/* Tab 3: 引擎与硬件环境 */}
        {activeMainTab === 'engine' && (
          <div className="space-y-6 animate-in fade-in duration-200">
            {/* 1. 硬件检测与驱动降级诊断卡片 */}
            <section>
              <HardwareCard />
            </section>

            {/* 2. AI 计算引擎管理表格 (1:1 移植) */}
            <section>
              <EngineTable />
            </section>

            {/* 3. 显存负载与动态推理参数调优 */}
            <section>
              <HardwareMonitorPanel />
            </section>
          </div>
        )}
      </main>

      {/* 底部信息栏 */}
      <footer className="border-t border-border/70 py-4 px-6 text-center text-xs text-muted-foreground/70 font-medium bg-muted/20">
        <div className="flex flex-wrap items-center justify-center gap-4">
          <span className="flex items-center gap-1">
            <Server className="h-3.5 w-3.5" />
            {t('基准服务监听')}: 127.0.0.1:{engineStatus?.port || 38400}
          </span>
          <span>•</span>
          <span className="flex items-center gap-1">
            <Activity className="h-3.5 w-3.5" />
            {t('协议契约')}: 标准 OpenAI 兼容 (/v1/chat/completions)
          </span>
          <span>•</span>
          <span className="flex items-center gap-1">
            <Cpu className="h-3.5 w-3.5" />
            {t('架构规范')}: ADR-0033 物理隔离与数据目录独立自治
          </span>
        </div>
      </footer>
    </div>
  )
}
