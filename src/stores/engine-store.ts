import { create } from 'zustand'
import {
  EngineStatusResponse,
  EngineItem,
  ModelItem,
  RuntimeParams
} from '../api/types'
import { engineApiClient } from '../api/client'
import { RegionDetectionResult, regionDetector } from '../lib/region-detector'

interface EngineStoreState {
  // 状态数据
  engineStatus: EngineStatusResponse | null
  engineList: EngineItem[]
  models: ModelItem[]
  modelsDir: string
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
  updateStoragePath: (newPath: string) => Promise<boolean>
  rescanModels: () => Promise<void>
  updateRuntimeParams: (params: Partial<RuntimeParams>) => Promise<boolean>
  runRegionDetection: (force?: boolean) => Promise<void>
}

export const useEngineStore = create<EngineStoreState>((set, get) => ({
  engineStatus: null,
  engineList: [],
  models: [],
  modelsDir: 'D:\\AI_Models',
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
      set({ error: e.message || '获取引擎状态失败', loading: false })
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
    } catch (e: any) {
      console.error('获取模型列表失败:', e)
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
  }
}))
