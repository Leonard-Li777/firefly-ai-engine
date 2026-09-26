import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Moon,
  Sun,
  Boxes,
  Sliders,
  LayoutDashboard,
  Download,
  X,
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
import { CustomModelAddCard } from './components/model/custom-model-add-card'
import { hasCompletedModelGuideDownload } from './components/model/model-bubble-guide'
import { ThirdPartyApiView } from './components/api/third-party-api-view'
import { EngineLogsView } from './components/logs/engine-logs-view'
import { LocalChatView } from './components/chat/local-chat-view'
import { LanguageSelector } from './components/common/language-selector'
import { Footer } from './components/common/Footer'
import { ToastContainer } from './components/common/Toast'
import { ErrorAnalysisSidebar } from './components/errors/error-analysis-sidebar'
import {
  bindEngineUiIntentBridge,
  ENGINE_UI_INTENT_EVENT,
  EngineUiIntent,
  EngineUiSource,
  parseUiPanel
} from './lib/engine-ui-intent'
import { useEngineStore } from './stores/engine-store'
import { i18nScope, t } from './languages'
import { getEngineApiClient, isMockMode } from './api/provider'

export const App: React.FC = () => {
  // 阿拉伯语为 RTL 书写方向，其余语言均为 LTR
  const dir: 'ltr' | 'rtl' = i18nScope.activeLanguage === 'ar-EG' ? 'rtl' : 'ltr'
  const {
    engineStatus,
    error: storeError,
    fetchEngineStatus,
    fetchEngineList,
    fetchModels,
    runRegionDetection,
    startEngine
  } = useEngineStore()

  // 侧边栏展示用原始错误（引擎 last_error 优先，其次 store 错误）
  const rawError = useMemo(
    () => engineStatus?.last_error || storeError || null,
    [engineStatus?.last_error, storeError]
  )

  // 引擎侧记录的新错误（不含前端操作产生的 storeError）——用于自动展开错误面板
  const engineLastError = engineStatus?.last_error || null

  // 顶层分层 Tab：
  // 1: 'dashboard' (概览仪表板)
  // 2: 'models' (模型库与存储管理)
  // 3: 'engine' (计算引擎与硬件环境)
  // 4: 'chat' (与本地AI私密聊天)
  // 5: 'logs' (运行日志)
  // 6: 'api' (第三方应用对接与 API 地址，置于最后)
  const [activeMainTab, setActiveMainTab] = useState<string>('dashboard')
  // 错误分析侧边栏（Footer 点击错误 / Desktop open-ui panel=error 打开）
  const [errorPanelOpen, setErrorPanelOpen] = useState(false)
  // Issue 0046 §3：Desktop 深链携带的目标模型与推荐源。
  // 模型面板据此滚动聚焦 + 呼吸高亮，并预选可顺畅下载的源页签。
  const [modelFocusRequest, setModelFocusRequest] = useState<{
    focusModel: string
    source?: EngineUiSource
  } | null>(null)

  // 出现「新的」引擎错误时自动展开错误分析面板。
  // 典型场景：Desktop（engine-bridge）拉起 AI 服务失败（如未下载任何 GGUF 模型），
  // 用户并未在引擎内点击任何按钮，仅在 Footer 显示一行提示容易被忽略。
  // 对同一个错误值只自动展开一次：Footer 每 2.5s 轮询状态，用户手动关闭后不应反复弹出；
  // 错误被清除（启动成功）后复位，下次失败仍会自动展开。
  const autoOpenedErrorRef = useRef<string | null>(null)
  useEffect(() => {
    if (!engineLastError) {
      autoOpenedErrorRef.current = null
      return
    }
    if (autoOpenedErrorRef.current === engineLastError) return
    autoOpenedErrorRef.current = engineLastError
    setErrorPanelOpen(true)
  }, [engineLastError])

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
      // Tauri 环境下先绑定真实动态端口（浏览器/mock 模式无端口概念，getEngineStatus 内部会自动跳过）
      await getEngineApiClient().ensureReady?.()

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

  // 首次使用引导（PRD-0043 全局层）：模型列表加载完成后，若本机无任何已下载模型
  // 且未完成过首次下载引导 → 自动切换到「模型管理」tab。仅此一次自动切换：
  // 用户随后手动切到其它 tab 时不拽回，由下方常驻引导横幅承接继续引导。
  const models = useEngineStore(s => s.models)
  const isFirstUseModelsEmpty = Array.isArray(models) && models.length > 0 && models.every(m => !m.isDownloaded)
  const hasAutoSwitchedRef = useRef(false)
  useEffect(() => {
    if (hasAutoSwitchedRef.current) return
    if (!Array.isArray(models) || models.length === 0) return // 列表未加载完成，等待
    hasAutoSwitchedRef.current = true
    if (isFirstUseModelsEmpty && !hasCompletedModelGuideDownload()) {
      setActiveMainTab('models')
    }
  }, [models, isFirstUseModelsEmpty])

  // 全局引导横幅：首次使用（无任何已下载模型）且未完成首次下载提交时显示；
  // 点击直达模型管理，会话内可关闭（不持久化，下次启动若仍未下载会再出现）
  const [guideBannerDismissed, setGuideBannerDismissed] = useState(false)
  const showFirstUseBanner =
    Array.isArray(models) && models.length > 0 && isFirstUseModelsEmpty && !guideBannerDismissed && !hasCompletedModelGuideDownload()

  // Desktop 经 /api/engine/open-ui 触发的导航意图：error=错误分析侧边栏，logs=运行日志，models=模型管理
  useEffect(() => {
    const handleUiIntent = (event: Event) => {
      const detail = (event as CustomEvent<EngineUiIntent>).detail
      const panel = parseUiPanel(detail?.panel)
      if (panel === 'error') {
        setErrorPanelOpen(true)
      } else if (panel === 'logs') {
        setActiveMainTab('logs')
      } else if (panel === 'models') {
        // Desktop 下载引导流深链：直达模型列表页（气泡引导由模型列表页自行判断激活）
        setActiveMainTab('models')
        // Issue 0046 §3：携带目标模型与推荐源时，交由模型列表页滚动聚焦 + 呼吸高亮
        setModelFocusRequest(
          detail?.focusModel
            ? { focusModel: detail.focusModel, source: detail.source }
            : null
        )
      }
    }
    // 必须先注册 DOM 监听，再绑定桥接：桥接层会同步派发补偿意图的 DOM 事件，
    // 顺序颠倒会漏掉首个意图
    window.addEventListener(ENGINE_UI_INTENT_EVENT, handleUiIntent as EventListener)
    const disposeBridge = bindEngineUiIntentBridge()
    return () => {
      window.removeEventListener(ENGINE_UI_INTENT_EVENT, handleUiIntent as EventListener)
      disposeBridge()
    }
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

  const isMock = isMockMode()

  return (
    <div dir={dir} className="h-screen max-h-screen w-screen overflow-hidden bg-background text-foreground flex flex-col font-sans transition-colors duration-200">
      {/* 顶部常驻导航与状态条：纯固定 Flex 项，绝不随任何内容滚动 */}
      <header className="shrink-0 z-50 border-b border-border/80 bg-background/95 backdrop-blur-md px-5 py-3 flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 shadow-xs">
        <div className="flex items-center gap-3 shrink-0 min-w-0">
          <img src="/icon.ico" alt={t('萤核AI引擎')} className="h-8.5 w-8.5 shrink-0 rounded-xl object-cover shadow-xs" draggable={false} />
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2 flex-nowrap">
              <span className="text-2xl font-bold tracking-tight text-foreground whitespace-nowrap">{t('萤核AI引擎')}</span>
              <Badge variant="outline" className="text-[10px] h-5 px-1.5 mt-2 ml-2 font-bold font-mono whitespace-nowrap shrink-0 rounded-md border-0 text-primary bg-primary/10">
                {t('独立高可用端侧 AI 推理引擎与模型管理平台')}
              </Badge>
              {isMock && (
                <Badge variant="secondary" className="text-[10px] h-5 px-1.5 py-0 font-bold whitespace-nowrap shrink-0 rounded-md border border-border/60">
                  {t('沙盒 Mock')}
                </Badge>
              )}
            </div>
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
            <TabsList className="flex justify-start h-12 bg-transparent p-0 rounded-none gap-2 shadow-none border-b-0 overflow-x-auto no-scrollbar">
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

      {/* 首次使用全局引导横幅：本机无任何已下载模型时显示，点击直达模型管理 */}
      {showFirstUseBanner && (
        <div className="shrink-0 z-30 bg-primary/5 border-b border-primary/20 px-6 py-2.5 shadow-2xs">
          <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Download className="h-4 w-4 text-primary shrink-0" />
              <span className="text-xs font-semibold text-foreground truncate">
                {t('欢迎使用萤核AI引擎！首次使用请先下载一个模型，才能启动本地AI推理服务。')}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* 已在模型管理页时无需跳转按钮，仅保留关闭 */}
              {activeMainTab !== 'models' && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shadow-xs"
                  onClick={() => setActiveMainTab('models')}
                >
                  {t('前往下载模型')}
                </button>
              )}
              <button
                type="button"
                className="h-7 w-7 inline-flex items-center justify-center rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-muted/60 transition-colors"
                title={t('暂不引导')}
                onClick={() => setGuideBannerDismissed(true)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

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
              <ModelListPanel
                focusModel={modelFocusRequest?.focusModel}
                focusSource={modelFocusRequest?.source}
              />
            </section>

            {/* 2. 自由添加任意托管模型（URL 嗅探后进入上方模型列表） */}
            <section>
              <CustomModelAddCard />
            </section>

            {/* 3. 模型存储路径自定义配置与扫描（置于最后） */}
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
      <Footer
        onNavigateTab={setActiveMainTab}
        onOpenErrorPanel={() => setErrorPanelOpen(true)}
      />

      {/* 错误分析侧边栏：llama.cpp/引擎错误解读与解决建议（移植 desktop 分析能力） */}
      <ErrorAnalysisSidebar
        isOpen={errorPanelOpen}
        rawError={rawError}
        onClose={() => setErrorPanelOpen(false)}
        onViewLogs={() => {
          setErrorPanelOpen(false)
          setActiveMainTab('logs')
        }}
        onRetry={() => {
          void startEngine()
        }}
      />

      {/* 全局 Toast 通知容器 */}
      <ToastContainer />
    </div>
  )
}
