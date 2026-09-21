import { create } from 'zustand'
import {
  EngineStatusResponse,
  EngineItem,
  ModelItem,
  RuntimeParams
} from '../api/types'
import { engineApiClient } from '../api/client'
import { RegionDetectionResult, regionDetector } from '../lib/region-detector'
import { t } from '../lib/i18n'

interface EngineStoreState {
  // 状态数据
  engineStatus: EngineStatusResponse | null
  engineList: EngineItem[]
  models: ModelItem[]
  modelsDir: string
  activeModelKey: string | null
  runtimeParams: RuntimeParams
  regionInfo: RegionDetectionResult | null
  loading: boolean
  switchingBackend: string | null
  error: string | null

  // 动作
  fetchEngineStatus: () => Promise<void>
  fetchEngineList: () => Promise<void>
  fetchModels: (source?: string) => Promise<void>
  switchEngine: (backend: string) => Promise<boolean>
  switchModel: (modelId: string, source?: string) => Promise<boolean>
  updateStoragePath: (newPath: string) => Promise<boolean>
  rescanModels: () => Promise<void>
  updateRuntimeParams: (params: Partial<RuntimeParams>) => Promise<boolean>
  runRegionDetection: (force?: boolean) => Promise<void>
  resetDowngrade: () => Promise<boolean>
}

export const useEngineStore = create<EngineStoreState>((set, get) => ({
  engineStatus: null,
  engineList: [],
  models: [],
  modelsDir: 'D:\\AI_Models',
  activeModelKey: null,
  runtimeParams: {
    n_gpu_layers: 24,
    threads: 8,
    ctx_size: 4096,
    batch_size: 512,
    ubatch_size: 256
  },
  regionInfo: null,
  loading: false,
  switchingBackend: null,
  error: null,

  fetchEngineStatus: async () => {
    try {
      set({ loading: true, error: null })
      const status = await engineApiClient.getEngineStatus()
      set({
        engineStatus: status,
        modelsDir: status.models_dir || get().modelsDir,
        runtimeParams: status.runtime_params || get().runtimeParams,
        loading: false
      })
    } catch (e: any) {
      set({ error: e.message || t('获取引擎状态失败'), loading: false })
    }
  },

  fetchEngineList: async () => {
    try {
      const list = await engineApiClient.getEngineList()
      set({ engineList: list })
    } catch (e: any) {
      console.error('获取引擎列表失败:', e)
    }
  },

  fetchModels: async (source?: string) => {
    try {
      const models = await engineApiClient.listModels(source)
      set({ models })

      // 如果当前 activeModelKey 尚未确定，根据已下载模型或默认模型精准初始化
      if (!get().activeModelKey && models.length > 0) {
        const downloaded = models.find(m => m.isDownloaded)
        const initial = downloaded || models.find(m => m.recommended) || models[0]
        if (initial) {
          const key = `${initial.id}@${initial.source}`
          set(state => ({
            activeModelKey: key,
            engineStatus: state.engineStatus
              ? { ...state.engineStatus, current_model: initial.name }
              : state.engineStatus
          }))
        }
      }
    } catch (e: any) {
      console.error('获取模型列表失败:', e)
    }
  },

  switchModel: async (modelId: string, source?: string) => {
    try {
      set({ loading: true })
      const res = await engineApiClient.switchModel(modelId, source)
      if (res.success) {
        const models = get().models
        const matched = models.find(
          m => m.id === modelId && (!source || m.source === source)
        )
        const key = matched ? `${matched.id}@${matched.source}` : `${modelId}@${source || 'modelscope'}`
        const displayName = matched?.name || res.currentModel || modelId
        set(state => ({
          activeModelKey: key,
          engineStatus: state.engineStatus
            ? { ...state.engineStatus, current_model: displayName }
            : state.engineStatus
        }))
        return true
      }
      return false
    } catch (e: any) {
      console.error('切换模型失败:', e)
      return false
    } finally {
      set({ loading: false })
    }
  },

  switchEngine: async (backend: string) => {
    try {
      set({ switchingBackend: backend })
      const res = await engineApiClient.switchEngine(backend)
      if (res.success) {
        await Promise.all([get().fetchEngineStatus(), get().fetchEngineList()])
        return true
      }
      return false
    } catch (e: any) {
      console.error('切换引擎失败:', e)
      return false
    } finally {
      set({ switchingBackend: null })
    }
  },

  updateStoragePath: async (newPath: string) => {
    try {
      const res = await engineApiClient.updateModelStoragePath(newPath)
      if (res.success) {
        set({ modelsDir: newPath })
        await get().fetchModels()
        return true
      }
      return false
    } catch (e: any) {
      console.error('更新存储路径失败:', e)
      return false
    }
  },

  rescanModels: async () => {
    try {
      const models = await engineApiClient.rescanModels()
      set({ models })
    } catch (e: any) {
      console.error('重新扫描模型失败:', e)
    }
  },

  updateRuntimeParams: async (params: Partial<RuntimeParams>) => {
    try {
      const current = get().runtimeParams
      const merged = { ...current, ...params }
      // 强制微批约束：ubatch <= batch，防止底层内存访问断言崩溃
      if (merged.ubatch_size > merged.batch_size) {
        merged.ubatch_size = merged.batch_size
      }
      const res = await engineApiClient.updateRuntimeParams(merged)
      if (res.success) {
        set({ runtimeParams: merged })
        return true
      }
      return false
    } catch (e: any) {
      console.error('更新运行时参数失败:', e)
      return false
    }
  },

  runRegionDetection: async (force = false) => {
    try {
      const result = await regionDetector.detect(300, force)
      set({ regionInfo: result })
    } catch (e) {
      console.error('网络探测失败:', e)
      set({ regionInfo: regionDetector.getLastResult() })
    }
  },

  resetDowngrade: async () => {
    try {
      set({ loading: true })
      await engineApiClient.resetDowngrade()
      await Promise.all([get().fetchEngineStatus(), get().fetchEngineList()])
      return true
    } catch (e) {
      console.error('重置降级诊断失败:', e)
      return false
    } finally {
      set({ loading: false })
    }
  }
}))
