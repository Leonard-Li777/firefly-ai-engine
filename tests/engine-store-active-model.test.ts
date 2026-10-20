import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IEngineApiClient } from '../src/api/client'
import type { EngineStatusResponse, ModelItem } from '../src/api/types'
import { setEngineApiClient } from '../src/api/provider'

// 元数据底表置空：本用例只关心「运行态键的来源」，不掺入推荐模型合并逻辑
// （用 importOriginal 保留 estimateRequiredVRAM 等合并期依赖的导出）
vi.mock('../src/lib/model-metadata-service', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/lib/model-metadata-service')>()
  return {
    ...actual,
    modelMetadataService: {
      ...actual.modelMetadataService,
      getModelsForLanguage: () => []
    }
  }
})

import { useEngineStore } from '../src/stores/engine-store'

// ---------------------------------------------------------------------------
// 场景还原（2026-10-20 实机回归）：
// 桌面端 Footer 报引擎错误 → 点「重新启动」→ 引擎进入 starting（此时后端尚未上报
// current_model，旧后端只在 Running 态上报）→ 模型列表把**列表第一行**的已下载模型
// 标成「启动中」，而真正被加载的激活模型反而显示「激活并启动」。
// 根因：fetchModels 在 current_model 缺失时用 targetLangKey（槽位 / 首个已下载模型）兜底，
// 把「已激活」偷换成「运行态」。
// ---------------------------------------------------------------------------

const MINICPM5: ModelItem = {
  id: 'OpenBMB/MiniCPM5-2B-GGUF:Q4_K_M',
  name: 'MiniCPM5 2B',
  source: 'modelscope',
  quant: 'Q4_K_M',
  fileSize: 1_500_000_000,
  params: '2B',
  description: '',
  isDownloaded: true,
  custom: true,
  localPath: 'D:\\llm\\hub\\models\\OpenBMB\\MiniCPM5-2B-GGUF\\MiniCPM5-2B-Q4_K_M.gguf'
}

const MINICPMV: ModelItem = {
  id: 'dealignai/MiniCPM-V-4.7-1B-CRACK-GGUF:Q4_K_M',
  name: 'MiniCPM-V 4.7 1B',
  source: 'modelscope',
  quant: 'Q4_K_M',
  fileSize: 900_000_000,
  params: '1B',
  description: '',
  isDownloaded: true,
  custom: true,
  localPath: 'D:\\llm\\hub\\models\\dealignai\\MiniCPM-V-4.7-1B-CRACK-GGUF\\MiniCPM-V-4.7-1B-CRACK-Q4_K_M.gguf'
}

/** 列表顺序：MiniCPM5 排在第一位（与实机一致） */
const DOWNLOADED_MODELS: ModelItem[] = [MINICPM5, MINICPMV]

const KEY_MINICPM5 = `${MINICPM5.id}@${MINICPM5.source}`
const KEY_MINICPMV = `${MINICPMV.id}@${MINICPMV.source}`

function makeStatus(overrides: Partial<EngineStatusResponse>): EngineStatusResponse {
  return {
    status: 'starting',
    active_backend: 'cuda134',
    current_model: null,
    active_language_model: null,
    active_embedding_model: null,
    models_dir: 'D:\\llm',
    vram_usage_mb: 0,
    port: 38400,
    hardware: {} as EngineStatusResponse['hardware'],
    ...overrides
  }
}

function installClient(status: EngineStatusResponse, models: ModelItem[] = DOWNLOADED_MODELS) {
  setEngineApiClient({
    getEngineStatus: vi.fn(async () => status),
    listModels: vi.fn(async () => models),
    getEngineList: vi.fn(async () => [])
  } as unknown as IEngineApiClient)
}

beforeEach(() => {
  useEngineStore.setState({
    engineStatus: null,
    engineList: [],
    models: [],
    activeModelKey: null,
    activeLanguageModelKey: null,
    activeEmbeddingModelKey: null,
    error: null,
    loading: false
  })
  setEngineApiClient(null)
})

describe('运行态 activeModelKey 只能由引擎 current_model 派生', () => {
  it('starting 且 current_model 未上报时不得用「列表首项」兜底（旧实现会把第一行标成启动中）', async () => {
    installClient(makeStatus({ status: 'starting', current_model: null, active_language_model: null }))

    await useEngineStore.getState().fetchEngineStatus()
    await useEngineStore.getState().fetchModels()

    const state = useEngineStore.getState()
    // 槽位仍按「首个已下载模型」初始化（这是激活语义，允许）
    expect(state.activeLanguageModelKey).toBe(KEY_MINICPM5)
    // 但运行态必须为空：没有 current_model 就没有任何模型在启动/运行
    expect(state.activeModelKey).toBeNull()
  })

  it('starting 且 current_model 未上报时不得把「已激活槽位」当成运行态', async () => {
    installClient(makeStatus({ status: 'starting', current_model: null, active_language_model: KEY_MINICPMV }))

    await useEngineStore.getState().fetchEngineStatus()
    await useEngineStore.getState().fetchModels()

    const state = useEngineStore.getState()
    expect(state.activeLanguageModelKey).toBe(KEY_MINICPMV)
    expect(state.activeModelKey).toBeNull()
  })

  it('starting 且 current_model 指向激活模型时，运行态归属该模型（而不是列表第一行）', async () => {
    installClient(
      makeStatus({
        status: 'starting',
        current_model: MINICPMV.localPath!,
        current_model_name: MINICPMV.name,
        active_language_model: KEY_MINICPMV
      })
    )

    await useEngineStore.getState().fetchEngineStatus()
    await useEngineStore.getState().fetchModels()

    expect(useEngineStore.getState().activeModelKey).toBe(KEY_MINICPMV)
  })

  it('fetchEngineStatus 在 current_model 缺失时清空残留运行态键（重启期间不得沿用旧模型）', async () => {
    installClient(makeStatus({ status: 'starting', current_model: null }))
    useEngineStore.setState({ models: DOWNLOADED_MODELS, activeModelKey: KEY_MINICPM5 })

    await useEngineStore.getState().fetchEngineStatus()

    expect(useEngineStore.getState().activeModelKey).toBeNull()
  })

  it('fetchEngineStatus 在 current_model 指向激活模型时把运行态对齐到该模型', async () => {
    installClient(makeStatus({ status: 'starting', current_model: MINICPMV.localPath! }))
    useEngineStore.setState({ models: DOWNLOADED_MODELS, activeModelKey: null })

    await useEngineStore.getState().fetchEngineStatus()

    expect(useEngineStore.getState().activeModelKey).toBe(KEY_MINICPMV)
  })
})
