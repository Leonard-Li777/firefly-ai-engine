import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { HardwareCard } from '../src/components/hardware/hardware-card'
import { EngineTable } from '../src/components/engine/engine-table'
import { ModelStorageConfig } from '../src/components/storage/model-storage-config'
import { useEngineStore } from '../src/stores/engine-store'

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
    expect(screen.getByText(/驱动升级建议与降级诊断告警/)).toBeInTheDocument()
    expect(screen.getByText(/NVIDIA 显卡驱动版本过低/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /前往官网更新驱动/ })).toBeInTheDocument()
  })

  it('EngineTable 表格能展示已安装与未安装引擎，未安装项显示【下载】', async () => {
    render(<EngineTable />)

    // 校验引擎行
    expect(screen.getByText('Vulkan (GPU通用)')).toBeInTheDocument()
    expect(screen.getByText('CPU (AVX2)')).toBeInTheDocument()
    expect(screen.getByText('CUDA 12.4')).toBeInTheDocument()

    // Vulkan 为当前运行引擎
    expect(screen.getByText('当前运行中')).toBeInTheDocument()

    // CUDA 12.4 初始为未安装，应呈现下载按钮
    const downloadBtn = screen.getByText(/下载 \(450MB\)/)
    expect(downloadBtn).toBeInTheDocument()

    // 点击下载按钮触发下载状态
    fireEvent.click(downloadBtn)

    // 等待进入下载状态
    await waitFor(() => {
      expect(screen.getByText(/下载中/)).toBeInTheDocument()
    })
  })

  it('ModelStorageConfig 允许用户自定义更改模型目录并生效', async () => {
    render(<ModelStorageConfig />)

    const input = screen.getByPlaceholderText(/例如: D:\\AI_Models/) as HTMLInputElement
    expect(input.value).toBe('D:\\AI_Models')

    // 模拟用户修改路径
    fireEvent.change(input, { target: { value: 'E:\\New_AI_Models' } })
    expect(input.value).toBe('E:\\New_AI_Models')

    // 点击保存并生效按钮
    const saveBtn = screen.getByText('保存并生效')
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(screen.getByText(/模型存储目录已成功更改/)).toBeInTheDocument()
    })

    // Store 中的模型目录应已更新
    expect(useEngineStore.getState().modelsDir).toBe('E:\\New_AI_Models')
  })
})
