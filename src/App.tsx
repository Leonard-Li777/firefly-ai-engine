import React, { useEffect, useState } from 'react'
import {
  Zap,
  Moon,
  Sun,
  Boxes,
  Sliders,
  LayoutDashboard,
  Terminal,
  Bot,
  ExternalLink
} from 'lucide-react'
import { Badge } from './components/ui/badge'
import { Switch } from './components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs'
import { DashboardView } from './components/dashboard/dashboard-view'
import { HardwareCard } from './components/hardware/hardware-card'
import { EngineTable } from './components/engine/engine-table'
import { ThinkingModeCard } from './components/engine/thinking-mode-card'
import { ModelStorageConfig } from './components/storage/model-storage-config'
import { ModelListPanel } from './components/model/model-list-panel'
import { ThirdPartyApiView } from './components/api/third-party-api-view'
import { EngineLogsView } from './components/logs/engine-logs-view'
import { LocalChatView } from './components/chat/local-chat-view'
import { LanguageSelector } from './components/common/language-selector'
import { Footer } from './components/common/Footer'
import { ToastContainer } from './components/common/Toast'
import { useEngineStore } from './stores/engine-store'
import { useI18nStore } from './lib/i18n'
import { engineApiClient } from './api/client'
import pkg from '../package.json'

export const App: React.FC = () => {
  const { t, dir } = useI18nStore()
  const {
    engineStatus,
    fetchEngineStatus,
    fetchEngineList,
    fetchModels,
    runRegionDetection
  } = useEngineStore()

  // 顶层分层 Tab：
  // 1: 'dashboard' (概览仪表板)
  // 2: 'models' (模型库与存储管理)
  // 3: 'engine' (计算引擎与硬件环境)
  // 4: 'chat' (与本地AI私密聊天)
  // 5: 'logs' (运行日志)
  // 6: 'api' (第三方应用对接与 API 地址，置于最后)
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
      await engineApiClient.ensureReady()

      await Promise.allSettled([
        fetchEngineStatus(),
        fetchEngineList(),
        fetchModels(),
        runRegionDetection()
      ])
    }

    initApp()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    <div dir={dir} className="h-screen max-h-screen w-screen overflow-hidden bg-background text-foreground flex flex-col font-sans transition-colors duration-200">
      {/* 顶部常驻导航与状态条：纯固定 Flex 项，绝不随任何内容滚动 */}
      <header className="shrink-0 z-50 border-b border-border/80 bg-background/95 backdrop-blur-md px-5 py-3 flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 shadow-xs">
        <div className="flex items-center gap-3 shrink-0 min-w-0">
          <div className="flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs border border-primary/40">
            <Zap className="h-4.5 w-4.5 fill-current" />
          </div>
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2 flex-nowrap">
              <span className="text-sm font-bold tracking-tight text-foreground whitespace-nowrap">{t('萤核AI引擎')}</span>
              <Badge variant="outline" className="text-[10px] h-5 px-1.5 py-0 font-bold font-mono whitespace-nowrap shrink-0 rounded-md border-primary/40 text-primary bg-primary/10">
                v{pkg.version}
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
          {/* 服务状态指示：根据真实状态区分展示（就绪/启动中/启动失败/未启动） */}
          {(() => {
            const st = engineStatus?.status
            const isReady = st === 'ready'
            const isError = st === 'error'
            const isStopped = st === 'stopped' || !st
            const chipCls = isReady
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
              : isError
                ? 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30'
                : isStopped
                  ? 'bg-muted/40 text-muted-foreground border-border/70'
                  : 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30'
            const dotCls = isReady
              ? 'bg-emerald-400 opacity-75'
              : isError
                ? 'bg-red-400 opacity-75'
                : isStopped
                  ? 'bg-muted-foreground/50'
                  : 'bg-amber-400 opacity-75'
            const statusText = isReady
              ? `${t('就绪')} (${engineStatus?.port || 38400})`
              : isError
                ? t('启动失败')
                : isStopped
                  ? t('未启动')
                  : t('启动中...')
            return (
              <div
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-bold shrink-0 ${chipCls}`}
                title={engineStatus?.last_error || undefined}
              >
                <span className={`relative flex h-2 w-2 shrink-0 ${isReady || isError || !isStopped ? '' : 'opacity-100'}`}>
                  {isReady || isError || !isStopped ? (
                    <>
                      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${dotCls}`}></span>
                      <span className={`relative inline-flex rounded-full h-2 w-2 ${dotCls.replace(' opacity-75', '')}`}></span>
                    </>
                  ) : (
                    <span className={`relative inline-flex rounded-full h-2 w-2 ${dotCls}`}></span>
                  )}
                </span>
                <span>{statusText}</span>
              </div>
            )
          })()}

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

      {/* 吸顶 Tab 栏：自然作为第 2 行固定 Flex 项，纹丝不动绝无滚动位移 */}
      <div className="shrink-0 z-40 bg-background/95 backdrop-blur-md border-b border-border/70 px-6 shadow-2xs">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Tabs
            value={activeMainTab}
            onValueChange={setActiveMainTab}
            className="w-full"
          >
            <TabsList className="flex justify-start h-12 bg-transparent p-0 rounded-none gap-2 shadow-none border-b-0 overflow-x-auto">
              {/* Tab 1: 仪表板 Dashboard */}
              <TabsTrigger
                value="dashboard"
                className="px-4 h-full rounded-none font-bold text-sm data-[state=active]:border-b-[3px] data-[state=active]:border-primary data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=inactive]:text-muted-foreground transition-all border-b-[3px] border-transparent hover:text-foreground hover:bg-muted/30 relative flex items-center gap-2 shadow-none shrink-0"
              >
                <LayoutDashboard className="h-4 w-4 text-inherit" />
                <span>{t('仪表盘')}</span>
              </TabsTrigger>

              {/* Tab 2: 模型管理与存储 */}
              <TabsTrigger
                value="models"
                className="px-4 h-full rounded-none font-bold text-sm data-[state=active]:border-b-[3px] data-[state=active]:border-primary data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=inactive]:text-muted-foreground transition-all border-b-[3px] border-transparent hover:text-foreground hover:bg-muted/30 relative flex items-center gap-2 shadow-none shrink-0"
              >
                <Boxes className="h-4 w-4 text-inherit" />
                <span>{t('模型管理')}</span>
              </TabsTrigger>

              {/* Tab 3: 引擎与硬件 */}
              <TabsTrigger
                value="engine"
                className="px-4 h-full rounded-none font-bold text-sm data-[state=active]:border-b-[3px] data-[state=active]:border-primary data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=inactive]:text-muted-foreground transition-all border-b-[3px] border-transparent hover:text-foreground hover:bg-muted/30 relative flex items-center gap-2 shadow-none shrink-0"
              >
                <Sliders className="h-4 w-4 text-inherit" />
                <span>{t('引擎与硬件')}</span>
              </TabsTrigger>

              {/* Tab 4: 与本地AI私密聊天 */}
              <TabsTrigger
                value="chat"
                className="px-4 h-full rounded-none font-bold text-sm data-[state=active]:border-b-[3px] data-[state=active]:border-purple-500 data-[state=active]:bg-purple-500/10 data-[state=active]:text-purple-600 dark:data-[state=active]:text-purple-400 data-[state=inactive]:text-muted-foreground transition-all border-b-[3px] border-transparent hover:text-foreground hover:bg-muted/30 relative flex items-center gap-2 shadow-none shrink-0"
              >
                <Bot className="h-4 w-4 text-inherit" />
                <span>{t('与本地AI私密聊天')}</span>
              </TabsTrigger>

              {/* Tab 5: 运行日志 */}
              <TabsTrigger
                value="logs"
                className="px-4 h-full rounded-none font-bold text-sm data-[state=active]:border-b-[3px] data-[state=active]:border-primary data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=inactive]:text-muted-foreground transition-all border-b-[3px] border-transparent hover:text-foreground hover:bg-muted/30 relative flex items-center gap-2 shadow-none shrink-0"
              >
                <Terminal className="h-4 w-4 text-inherit" />
                <span>{t('运行日志')}</span>
              </TabsTrigger>

              {/* Tab 6: 第三方应用对接与 API 地址（最后） */}
              <TabsTrigger
                value="api"
                className="px-4 h-full rounded-none font-bold text-sm data-[state=active]:border-b-[3px] data-[state=active]:border-primary data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=inactive]:text-muted-foreground transition-all border-b-[3px] border-transparent hover:text-foreground hover:bg-muted/30 relative flex items-center gap-2 shadow-none shrink-0"
              >
                <ExternalLink className="h-4 w-4 text-inherit" />
                <span>{t('第三方对接')}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* 主工作区：自适应占据剩余所有高度，无外溢 */}
      <main
        className={`flex-1 min-h-0 w-full transition-all duration-200 ${
          activeMainTab === 'chat'
            ? 'p-2 sm:p-3 overflow-hidden flex flex-col'
            : activeMainTab === 'logs'
              ? 'p-4 sm:p-6 overflow-hidden flex flex-col'
              : 'overflow-y-auto p-6'
        }`}
      >
        {/* Tab 1: 仪表盘 Dashboard */}
        {activeMainTab === 'dashboard' && (
          <div className="max-w-6xl mx-auto space-y-6 animate-in fade-in duration-200">
            <DashboardView />
          </div>
        )}

        {/* Tab 2: 模型管理与存储 */}
        {activeMainTab === 'models' && (
          <div className="max-w-6xl mx-auto space-y-6 animate-in fade-in duration-200">
            {/* 1. 双轨模型生态与高速下载、独立启动参数配置 */}
            <section>
              <ModelListPanel />
            </section>

            {/* 2. 模型存储路径自定义配置与扫描（置于最后） */}
            <section>
              <ModelStorageConfig />
            </section>
          </div>
        )}

        {/* Tab 3: 引擎与硬件环境 */}
        {activeMainTab === 'engine' && (
          <div className="max-w-6xl mx-auto space-y-6 animate-in fade-in duration-200">
            {/* 1. 硬件检测与驱动降级诊断卡片 */}
            <section>
              <HardwareCard />
            </section>

            {/* 2. AI 计算引擎管理表格 (1:1 移植) */}
            <section>
              <EngineTable />
            </section>

            {/* 3. 模型思考模式配置卡片 */}
            <section>
              <ThinkingModeCard />
            </section>
          </div>
        )}

        {/* Tab 4: 与本地AI私密聊天：撑满 flex-1 min-h-0，最大化用户聊天空间 */}
        {activeMainTab === 'chat' && (
          <div className="flex-1 min-h-0 w-full h-full flex flex-col animate-in fade-in duration-200 overflow-hidden">
            <LocalChatView />
          </div>
        )}

        {/* Tab 5: 运行日志：撑满 flex-1 min-h-0，仅日志窗口内部滚动 */}
        {activeMainTab === 'logs' && (
          <div className="flex-1 min-h-0 w-full h-full flex flex-col animate-in fade-in duration-200 overflow-hidden">
            <EngineLogsView />
          </div>
        )}

        {/* Tab 6: 第三方应用对接与 API 地址（置于最后） */}
        {activeMainTab === 'api' && (
          <div className="max-w-6xl mx-auto space-y-6 animate-in fade-in duration-200">
            <ThirdPartyApiView />
          </div>
        )}
      </main>

      {/* 底部信息栏：全局常驻展示模型状态、引擎警告与思考模式开关 */}
      <Footer onNavigateTab={setActiveMainTab} />
      {/* 全局 Toast 通知容器 */}
      <ToastContainer />
    </div>
  )
}
