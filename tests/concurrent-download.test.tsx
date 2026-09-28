import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ModelListPanel } from '../src/components/model/model-list-panel'
import { useEngineStore } from '../src/stores/engine-store'

describe('同时下载两个模型测试', () => {
  beforeEach(async () => {
    await useEngineStore.getState().fetchEngineStatus()
    await useEngineStore.getState().fetchEngineList()
    await useEngineStore.getState().fetchModels()
  })

  it('可以同时下载两个模型', async () => {
    render(<ModelListPanel />)

    // 找到所有【下载模型】按钮
    const downloadButtons = screen.getAllByRole('button', { name: /下载模型/ })
    console.log('找到下载模型按钮数量:', downloadButtons.length)
    expect(downloadButtons.length).toBeGreaterThanOrEqual(2)

    // 点击第一个模型下载
    fireEvent.click(downloadButtons[0])

    // 点击第二个模型下载
    fireEvent.click(downloadButtons[1])

    // 检查两个模型是否都进入了下载中状态
    await waitFor(() => {
      const downloadingTexts = screen.getAllByText(/正在下载/)
      console.log('正在下载的模型数量:', downloadingTexts.length)
      expect(downloadingTexts.length).toBe(2)
    })
  })
})
