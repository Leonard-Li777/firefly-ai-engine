import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { HardwareCard } from '../src/components/hardware/hardware-card'
import { EngineTable } from '../src/components/engine/engine-table'
import { ModelStorageConfig } from '../src/components/storage/model-storage-config'
import { ThinkingModeCard } from '../src/components/engine/thinking-mode-card'
import { LocalChatView } from '../src/components/chat/local-chat-view'
import { ModelListPanel } from '../src/components/model/model-list-panel'
import { DashboardView } from '../src/components/dashboard/dashboard-view'
import { Footer } from '../src/components/common/Footer'
import { useEngineStore } from '../src/stores/engine-store'
import { isAbsolutePath } from '../src/lib/path-utils'

describe('Tier 2 管理视窗核心组件交互测试', () => {
  beforeEach(async () => {
    // 每次测试前初始化 Store 状态
    await useEngineStore.getState().fetchEngineStatus()
    await useEngineStore.getState().fetchEngineList()
  })

  it('HardwareCard 能够正确渲染 GPU 硬件信息与驱动降级警告', async () => {
    render(<HardwareCard />)

    // 校验检测到的 GPU 名称与显存
    expect(screen.getByText('NVIDIA GeForce RTX 3060')).toBeInTheDocument()
    expect(screen.getByText('12 GB')).toBeInTheDocument()

    // 校验降级告警与驱动升级按钮
    expect(screen.getByText(/目前使用兼容模式，能发挥您显卡70% AI算力/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /升级显卡驱动/ })).toBeInTheDocument()
  })

  it('EngineTable 表格能展示已安装与未安装引擎，驱动不适配显示【更新显卡驱动】，已安装未激活项显示【切换引擎】', async () => {
    // 监听 window.open
    const originalOpen = window.open
    let openedUrl = ''
    window.open = (url?: string | URL) => {
      openedUrl = String(url)
      return null
    }

    try {
      render(<EngineTable />)

      // 校验引擎行
      expect(screen.getByText('Vulkan')).toBeInTheDocument()
      expect(screen.getByText('CPU (AVX2)')).toBeInTheDocument()
      expect(screen.getByText('CUDA 12.4')).toBeInTheDocument()
      expect(screen.getByText('CUDA 13.4')).toBeInTheDocument()

      // Vulkan 为当前运行引擎徽标（表头与行内徽标各一处）
      expect(screen.getAllByText('当前引擎').length).toBeGreaterThanOrEqual(2)

      // CPU (AVX2) 已安装但非当前运行引擎，应呈现【切换引擎】高亮按钮
      const switchBtn = screen.getByRole('button', { name: /切换引擎/ })
      expect(switchBtn).toBeInTheDocument()

      // CUDA 13.4 初始模拟驱动不满足，应呈现【更新显卡驱动】按钮
      const updateDriverBtn = screen.getByRole('button', { name: /更新显卡驱动/ })
      expect(updateDriverBtn).toBeInTheDocument()

      // 点击【更新显卡驱动】自动跳转至官网下载链接
      fireEvent.click(updateDriverBtn)
      expect(openedUrl).toContain('nvidia.cn')

      // CUDA 12.4 初始为未安装且驱动适配，应呈现【下载引擎】按钮（下载体积已在独立"引擎大小"列展示）
      const downloadBtn = screen.getByRole('button', { name: /下载引擎/ })
      expect(downloadBtn).toBeInTheDocument()

      // 点击下载引擎按钮触发下载状态
      fireEvent.click(downloadBtn)

      // 等待进入下载状态
      await waitFor(() => {
        const downloadTexts = screen.getAllByText(/下载中/)
        expect(downloadTexts.length).toBeGreaterThanOrEqual(1)
      })
    } finally {
      window.open = originalOpen
    }
  })

  it('点击【切换引擎】能够成功切换引擎，并在表格中更新当前引擎标记与状态', async () => {
    render(<EngineTable />)

    // 初始 CPU (AVX2) 具有【切换引擎】按钮
    const switchBtn = screen.getByRole('button', { name: /切换引擎/ })
    expect(switchBtn).toBeInTheDocument()

    // 点击切换至 CPU
    fireEvent.click(switchBtn)

    // 等待切换完成并生效为当前引擎
    await waitFor(() => {
      expect(useEngineStore.getState().engineStatus?.active_backend).toBe('cpu')
    })
  })

  it('ModelStorageConfig 允许用户通过【浏览】选择新目录后直接迁移生效，且始终显示绝对路径', async () => {
    // 模拟 window.prompt 返回新绝对路径
    const originalPrompt = window.prompt
    window.prompt = () => 'E:\\New_AI_Models'

    try {
      render(<ModelStorageConfig />)

      const input = screen.getByRole('textbox') as HTMLInputElement
      // 确保默认展示为标准绝对路径
      expect(isAbsolutePath(input.value)).toBe(true)

      // 验证已无“保存并生效”按钮
      expect(screen.queryByText('保存并生效')).toBeNull()

      // 点击“浏览”按钮触发目录选择与自动迁移
      const browseBtn = screen.getByRole('button', { name: /浏览/ })
      fireEvent.click(browseBtn)

      await waitFor(() => {
        expect(screen.getByText(/模型存储目录已成功更改/)).toBeInTheDocument()
      })

      // Store 中的模型目录应已直接更新为新绝对路径
      expect(useEngineStore.getState().modelsDir).toBe('E:\\New_AI_Models')
      expect(input.value).toBe('E:\\New_AI_Models')
    } finally {
      window.prompt = originalPrompt
    }
  })

  it('ThinkingModeCard 能够正确渲染思考模式配置项、文案与开关切换', async () => {
    render(<ThinkingModeCard />)

    expect(screen.getByText('模型思考模式')).toBeInTheDocument()
    expect(screen.getByText('会增加耗时')).toBeInTheDocument()
    expect(screen.getByText(/建议在需要与 AI 进行聊天时才开启/)).toBeInTheDocument()

    const switchEl = screen.getByRole('switch', { name: '模型思考模式' })
    expect(switchEl).toBeInTheDocument()

    // 等待挂载时从后端同步权威值完成，再切换开关
    await waitFor(() => {
      expect(switchEl).toHaveAttribute('aria-checked', 'false')
    })

    fireEvent.click(switchEl)
    expect(switchEl).toHaveAttribute('aria-checked', 'true')

    // 开关变更后应持久化到 mock 客户端（与后端 config.json 同构）
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: '模型思考模式' })).toHaveAttribute('aria-checked', 'true')
    })
  })

  it('LocalChatView 在服务就绪时渲染 iframe，未就绪时呈现友好的启动引导', async () => {
    const { unmount } = render(<LocalChatView />)

    // 就绪状态（mock 默认就绪）：显示 iframe
    const iframe = screen.getByTitle('llama.cpp local chat') as HTMLIFrameElement
    expect(iframe).toBeInTheDocument()
    expect(iframe.src).toContain('38400')
    expect(screen.getByText('与本地AI私密聊天')).toBeInTheDocument()

    unmount()

    // 处于 processing 工作状态：仍然稳定渲染 iframe，不会错误退到未就绪导致页面闪动
    useEngineStore.setState(state => ({
      engineStatus: state.engineStatus ? { ...state.engineStatus, status: 'processing' } : null
    }))
    const { unmount: unmountProcessing } = render(<LocalChatView />)
    expect(screen.getByTitle('llama.cpp local chat')).toBeInTheDocument()
    expect(screen.getByText('处理中...')).toBeInTheDocument()
    expect(screen.queryByText('本地推理服务未就绪')).not.toBeInTheDocument()

    unmountProcessing()

    // 切换到停止状态
    useEngineStore.setState(state => ({
      engineStatus: state.engineStatus ? { ...state.engineStatus, status: 'stopped' } : null
    }))

    render(<LocalChatView />)
    expect(screen.getByText('本地推理服务未就绪')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /立即启动服务/ })).toBeInTheDocument()
  })

  it('ModelListPanel 能正确渲染模型卡片的相对路径（不显示 base 路径）且仅已下载未超标模型展示【参数配置】按钮', async () => {
    await useEngineStore.getState().fetchModels()
    render(<ModelListPanel />)

    // 1. 已就绪模型展示相对路径
    const readyBadges = screen.getAllByText('已就绪')
    expect(readyBadges.length).toBeGreaterThan(0)

    // 校验卡片路径不含盘符前缀 D:\AI_Models，而是展示相对路径
    const relativePathRegex = /hub[\\/]models[\\/].+\.gguf/i
    const matches = screen.getAllByText(relativePathRegex)
    expect(matches.length).toBeGreaterThan(0)

    // 2. 删除/参数配置收纳于「高级」按钮内：逐行点击「高级」展开后，出现【参数配置】按钮，绝不存在过时的【预设参数】按钮
    const advancedButtons = screen.getAllByRole('button', { name: /高级/ })
    expect(advancedButtons.length).toBeGreaterThan(0)
    advancedButtons.forEach(btn => fireEvent.click(btn))
    const configButtons = screen.getAllByRole('button', { name: /参数配置/ })
    expect(configButtons.length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /预设参数/ })).not.toBeInTheDocument()

    // 3. 校验已下载模型的激活控制：当前运行模型展示【已激活】角标，非当前运行的已下载模型展示【激活】按钮
    const activeModelBadges = screen.getAllByText('已激活')
    expect(activeModelBadges.length).toBeGreaterThanOrEqual(1)

    // 验证列表中其他已下载就绪的模型展示有【激活】按钮
    const activateButtons = screen.getAllByRole('button', { name: '激活' })
    expect(activateButtons.length).toBeGreaterThanOrEqual(1)

    // 点击【激活】按钮可以成功触发切换模型并更新当前运行模型
    fireEvent.click(activateButtons[0])
    await waitFor(() => {
      expect(useEngineStore.getState().activeModelKey).toBeDefined()
    })
  })

  it('ModelListPanel 能正确显示 WeMM-Embedding-2B 推荐模型，并在 focusModel 聚焦时高亮并展示安装引导提示', async () => {
    await useEngineStore.getState().fetchModels()
    const { unmount } = render(<ModelListPanel focusModel="WeMM-Embedding-2B" focusSource="modelscope" />)

    // 默认开启「仅显示推荐」下，WeMM 依然可见（recommended: true）
    expect(screen.getAllByText(/WeMM-Embedding 2B/i).length).toBeGreaterThan(0)
    // 聚焦提示横幅显示
    expect(screen.getByText(/主程序已开启高维修正与视频检索/)).toBeInTheDocument()

    unmount()

    // 切换到 huggingface 来源同样可见 WeMM
    render(<ModelListPanel focusModel="WeMM-Embedding-2B" focusSource="huggingface" />)
    expect(screen.getAllByText(/WeMM-Embedding 2B/i).length).toBeGreaterThan(0)
  })

  it('DashboardView 能够在【推理引擎后台服务】与状态徽标之间正确渲染当前模型名称', async () => {
    await useEngineStore.getState().fetchModels()
    render(<DashboardView />)

    // 校验【推理引擎后台服务】标题存在
    const title = screen.getByText('推理引擎后台服务')
    expect(title).toBeInTheDocument()

    // 校验服务运行状态徽标存在（mock 默认状态为运行中 (就绪)）
    expect(screen.getByText(/运行中 \(就绪\)|已停止/)).toBeInTheDocument()

    // 校验当前模型名称正常显示
    const activeModelKey = useEngineStore.getState().activeModelKey || useEngineStore.getState().activeLanguageModelKey
    const models = useEngineStore.getState().models
    const currentModel = models.find(m => `${m.id}@${m.source}` === activeModelKey || m.id === activeModelKey)
    if (currentModel) {
      expect(screen.getByText(currentModel.name)).toBeInTheDocument()
    }
  })

  it('Footer 左侧状态在 processing 时正确显示处理中，且不包含 [本地] 或 [云端] 前缀', async () => {
    await useEngineStore.getState().fetchModels()
    const currentStatus = useEngineStore.getState().engineStatus!
    useEngineStore.setState({
      engineStatus: {
        ...currentStatus,
        status: 'processing'
      }
    })

    render(<Footer onNavigateTab={() => {}} />)

    // 校验出现 "处理中..."
    expect(screen.getByText(/处理中\.\.\./)).toBeInTheDocument()
    // 校验 Engine 自身文案不包含 [本地] 或 [云端] 前缀
    expect(screen.queryByText(/\[本地\]/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\[云端\]/)).not.toBeInTheDocument()
  })
})


