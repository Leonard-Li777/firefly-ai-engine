import { create } from 'zustand'
import {
  EngineStatusResponse,
  EngineItem,
  ModelItem,
  RuntimeParams
} from '../api/types'
import { engineApiClient } from '../api/provider'
import { RegionDetectionResult, regionDetector } from '../lib/region-detector'
import { modelMetadataService } from '../lib/model-metadata-service'
import { i18nScope, t } from '../languages'
import type { SupportedLanguage } from '../lib/language'
import { resolveToAbsolutePath } from '../lib/path-utils'
import { mergeScannedWithRecommended } from '../lib/model-resolver'

/**
 * 判断列表中的模型是否就是后端当前运行的模型。
 * 后端 current_model 是 GGUF 文件完整路径（也可能为模型 ID/名称），
 * 匹配规则：
 * 1. 名称 / ID / 别名精确相等
 * 2. localPath 与 current_model 互为包含（忽略 Windows 大小写差异）
 * 3. 兜底：按文件名（不含扩展名、小写）在 current_model 路径中匹配
 */
function matchCurrentModel(model: ModelItem, currentModel: string): boolean {
  if (model.name === currentModel || model.id === currentModel) return true
  if (model.localPath) {
    const lp = model.localPath
    const a = lp.toLowerCase()
    const b = currentModel.toLowerCase()
    if (a === b || a.includes(b) || b.includes(a)) return true
    // 兜底：文件名匹配（如 current_model 为路径、localPath 未同步时的场景）
    const fileName = lp.replace(/\\/g, '/').split('/').pop()?.replace(/\.gguf$/i, '').toLowerCase()
    if (fileName && currentModel.toLowerCase().includes(fileName)) return true
  }
  return false
}

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
  logs: string[]
  logsLoading: boolean
  /** 自由添加成功信号：面板据此切换到新模型所属来源页签（seq 保证同来源连续添加也能触发） */
  lastAddedSource: { source: string; seq: number } | null

  // 动作
  fetchEngineStatus: (silent?: boolean) => Promise<void>
  fetchEngineList: () => Promise<void>
  fetchModels: (source?: string) => Promise<void>
  switchEngine: (backend: string) => Promise<boolean>
  switchModel: (modelId: string, source?: string, localPath?: string, modelName?: string) => Promise<boolean>
  updateStoragePath: (newPath: string) => Promise<boolean>
  rescanModels: () => Promise<void>
  updateRuntimeParams: (params: Partial<RuntimeParams>) => Promise<boolean>
  saveModelParams: (modelId: string, params: RuntimeParams) => Promise<boolean>
  getModelParams: (modelId: string) => Promise<RuntimeParams | undefined>
  addCustomModel: (url: string) => Promise<{ ok: boolean; error?: string }>
  deleteModel: (modelId: string, localPath?: string) => Promise<boolean>
  removeCustomModel: (modelId: string) => Promise<boolean>
  activateAndStart: (modelId: string, source?: string, localPath?: string, modelName?: string) => Promise<boolean>
  runRegionDetection: (force?: boolean) => Promise<void>
  resetDowngrade: () => Promise<boolean>
  startEngine: () => Promise<boolean>
  stopEngine: () => Promise<boolean>
  fetchLogs: () => Promise<void>
  clearLogs: () => Promise<boolean>
}

export const useEngineStore = create<EngineStoreState>((set, get) => ({
  engineStatus: null,
  engineList: [],
  models: [],
  modelsDir: resolveToAbsolutePath('build/extraResources/models'),
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
  logs: [],
  logsLoading: false,
  lastAddedSource: null,

  fetchEngineStatus: async (silent?: boolean) => {
    try {
      // silent 模式（后台轮询）不翻转 loading，避免按钮等 UI 因轮询而闪动
      if (!silent) set({ loading: true, error: null })
      const status = await engineApiClient.getEngineStatus()
      const resolvedDir = status.models_dir
        ? resolveToAbsolutePath(status.models_dir)
        : get().modelsDir
      set({
        engineStatus: status,
        modelsDir: resolvedDir,
        runtimeParams: status.runtime_params || get().runtimeParams,
        ...(silent ? {} : { loading: false })
      })

      // 依据后端 current_model 反查 activeModelKey：
      // 未确定时直接反查；已确定但与真实运行模型不一致时（如初始化竞态下兜底到了错误条目）进行校正
      if (status.current_model) {
        const currentModels = get().models
        const matched = currentModels.find(m => matchCurrentModel(m, status.current_model!))
        if (matched) {
          const realKey = `${matched.id}@${matched.source}`
          if (get().activeModelKey !== realKey) {
            set({ activeModelKey: realKey })
          }
        }
      }
    } catch (e: any) {
      set({ error: e.message || t('获取引擎状态失败'), ...(silent ? {} : { loading: false }) })
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
      const rawModels = await engineApiClient.listModels(source)
      const recommendedList = modelMetadataService.getModelsForLanguage(
        (i18nScope.activeLanguage as SupportedLanguage) || 'zh-CN'
      )
      const models = mergeScannedWithRecommended(recommendedList, rawModels)
      set({ models })

      // 确定激活模型 Key：
      // 1. 若当前运行模型已在状态中，优先对齐当前运行模型
      // 2. 否则选择第一个已下载就绪的模型
      // 3. 否则选择官方推荐模型
      const currentActiveKey = get().activeModelKey
      const currentModelName = get().engineStatus?.current_model

      if (currentModelName) {
        const activeItem = models.find(m => matchCurrentModel(m, currentModelName))
        if (activeItem) {
          set({ activeModelKey: `${activeItem.id}@${activeItem.source}` })
          return
        }
      }

      if (!currentActiveKey && models.length > 0) {
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

  switchModel: async (modelId: string, source?: string, localPath?: string, modelName?: string) => {
    try {
      set({ loading: true })
      const models = get().models
      const matched = models.find(
        m => m.id === modelId && (!source || m.source === source)
      )
      const effectiveLocalPath = localPath || matched?.localPath
      const effectiveModelName = modelName || matched?.name
      const res = await engineApiClient.switchModel(modelId, source, effectiveLocalPath, effectiveModelName)
      if (res.success) {
        const key = matched ? `${matched.id}@${matched.source}` : `${modelId}@${source || 'modelscope'}`
        const displayName = effectiveModelName || matched?.name || res.currentModel || modelId
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
      const resolvedPath = resolveToAbsolutePath(newPath)
      const res = await engineApiClient.updateModelStoragePath(resolvedPath)
      if (res.success) {
        set({ modelsDir: resolvedPath })
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
      const scanned = await engineApiClient.rescanModels()
      // 与 fetchModels 一致：以当前语言推荐底表合并扫描结果，列签名 (recommendedList, scanned)
      const recommendedList = modelMetadataService.getModelsForLanguage(
        (i18nScope.activeLanguage as SupportedLanguage) || 'zh-CN'
      )
      const merged = mergeScannedWithRecommended(recommendedList, scanned)
      set({ models: merged })
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

  saveModelParams: async (modelId: string, params: RuntimeParams) => {
    try {
      const res = await engineApiClient.saveModelParams(modelId, params)
      if (res.success) {
        // 如果当前保存的模型就是当前运行的模型，同步应用到运行时
        const activeKey = get().activeModelKey
        if (activeKey && activeKey.startsWith(`${modelId}@`)) {
          set({ runtimeParams: params })
        }
        return true
      }
      return false
    } catch (e: any) {
      console.error('保存模型专属参数失败:', e)
      return false
    }
  },

  getModelParams: async (modelId: string) => {
    try {
      return await engineApiClient.getModelParams(modelId)
    } catch (e: any) {
      console.error('获取模型专属参数失败:', e)
      return undefined
    }
  },

  addCustomModel: async (url: string) => {
    try {
      const model = await engineApiClient.addCustomModel(url)
      // 同 ID 覆盖（后端持久化同为覆盖语义），否则追加进列表
      set(state => {
        const idx = state.models.findIndex(m => m.id === model.id)
        if (idx >= 0) {
          const next = [...state.models]
          next[idx] = { ...next[idx], ...model }
          return { models: next }
        }
        return { models: [...state.models, model] }
      })
      // 通知面板切换到新模型所属来源页签，保证添加后可见
      set(state => ({
        lastAddedSource: {
          source: model.source,
          seq: (state.lastAddedSource?.seq ?? 0) + 1
        }
      }))
      return { ok: true }
    } catch (e: any) {
      console.error('自由添加模型失败:', e)
      return { ok: false, error: e?.message || t('添加模型失败') }
    }
  },

  deleteModel: async (modelId: string, localPath?: string) => {
    try {
      const res = await engineApiClient.deleteModel(modelId, localPath)
      if (res.success) {
        // 若删除的是当前激活模型，同步清空前端激活状态
        const removed = get().models.find(m => m.id === modelId)
        if (removed && get().activeModelKey === `${removed.id}@${removed.source}`) {
          set({ activeModelKey: null })
        }
        // 删除后刷新模型列表，保持 UI 与磁盘一致
        await get().fetchModels()
        return true
      }
      return false
    } catch (e: any) {
      console.error('删除模型失败:', e)
      set({ error: e?.message || t('删除模型失败') })
      return false
    }
  },

  removeCustomModel: async (modelId: string) => {
    try {
      const res = await engineApiClient.removeCustomModel(modelId)
      if (res.success) {
        // 若移除的是当前激活条目，同步清空前端激活状态并刷新列表
        const removed = get().models.find(m => m.id === modelId)
        if (removed && get().activeModelKey === `${removed.id}@${removed.source}`) {
          set({ activeModelKey: null })
        }
        await get().fetchModels()
        return true
      }
      return false
    } catch (e: any) {
      console.error('移除自定义模型失败:', e)
      set({ error: e?.message || t('移除模型失败') })
      return false
    }
  },

  activateAndStart: async (modelId: string, source?: string, localPath?: string, modelName?: string) => {
    // 先切换/激活模型，再启动引擎服务
    const switched = await get().switchModel(modelId, source, localPath, modelName)
    if (!switched) return false
    return get().startEngine()
  },

  runRegionDetection: async (force?: boolean) => {
    try {
      const info = await regionDetector.detect(300, force)
      set({ regionInfo: info })
    } catch (e: any) {
      console.error('地区网络环境检测失败:', e)
    }
  },

    resetDowngrade: async () => {
    try {
      set({ loading: true })
      await engineApiClient.resetDowngrade()
      await get().fetchEngineStatus()
      return true
    } catch (e: any) {
      console.error('重置降级状态失败:', e)
      return false
    } finally {
      set({ loading: false })
    }
  },

  startEngine: async () => {
    try {
      set({ loading: true, error: null })

      // 若前端已选定激活模型且模型列表中存在，先调用 switchModel 确保后端 active_model 同步
      const activeKey = get().activeModelKey
      const models = get().models
      if (activeKey && models.length > 0) {
        const [activeId, activeSource] = activeKey.split('@')
        const activeModel = models.find(
          m => m.id === activeId && (!activeSource || m.source === activeSource)
        )
        if (activeModel?.isDownloaded) {
          await engineApiClient.switchModel(activeModel.id, activeModel.source, activeModel.localPath, activeModel.name)
        }
      }

      const res = await engineApiClient.startEngine()
      if (res.success) {
        await get().fetchEngineStatus()
        await get().fetchLogs()
        return true
      }
      set({ error: res.error || '启动服务失败' })
      return false
    } catch (e: any) {
      console.error('启动服务异常:', e)
      set({ error: e.message || '启动服务异常' })
      return false
    } finally {
      set({ loading: false })
    }
  },

  stopEngine: async () => {
    try {
      set({ loading: true, error: null })
      const res = await engineApiClient.stopEngine()
      if (res.success) {
        await get().fetchEngineStatus()
        await get().fetchLogs()
        return true
      }
      set({ error: res.error || '停止服务失败' })
      return false
    } catch (e: any) {
      console.error('停止服务异常:', e)
      set({ error: e.message || '停止服务异常' })
      return false
    } finally {
      set({ loading: false })
    }
  },

  fetchLogs: async () => {
    try {
      set({ logsLoading: true })
      const res = await engineApiClient.getEngineLogs()
      set({ logs: res.logs || [] })
    } catch (e: any) {
      console.error('获取日志失败:', e)
    } finally {
      set({ logsLoading: false })
    }
  },

  clearLogs: async () => {
    try {
      await engineApiClient.clearEngineLogs()
      set({ logs: [] })
      return true
    } catch (e: any) {
      console.error('清空日志失败:', e)
      return false
    }
  }
}))
