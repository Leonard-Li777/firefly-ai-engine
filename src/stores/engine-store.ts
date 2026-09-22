import { create } from 'zustand'
import {
  EngineStatusResponse,
  EngineItem,
  ModelItem,
  RuntimeParams
} from '../api/types'
import { engineApiClient } from '../api/client'
import { RegionDetectionResult, regionDetector } from '../lib/region-detector'
import { modelMetadataService } from '../lib/model-metadata-service'
import { useI18nStore, t } from '../lib/i18n'
import { resolveToAbsolutePath } from '../lib/path-utils'
import { ModelResolver } from '../lib/model-resolver'

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

  // 动作
  fetchEngineStatus: () => Promise<void>
  fetchEngineList: () => Promise<void>
  fetchModels: (source?: string) => Promise<void>
  switchEngine: (backend: string) => Promise<boolean>
  switchModel: (modelId: string, source?: string, localPath?: string, modelName?: string) => Promise<boolean>
  updateStoragePath: (newPath: string) => Promise<boolean>
  rescanModels: () => Promise<void>
  updateRuntimeParams: (params: Partial<RuntimeParams>) => Promise<boolean>
  saveModelParams: (modelId: string, params: RuntimeParams) => Promise<boolean>
  getModelParams: (modelId: string) => Promise<RuntimeParams | undefined>
  runRegionDetection: (force?: boolean) => Promise<void>
  resetDowngrade: () => Promise<boolean>
  startEngine: () => Promise<boolean>
  stopEngine: () => Promise<boolean>
  fetchLogs: () => Promise<void>
  clearLogs: () => Promise<boolean>
}

/**
 * 将扫描到的物理模型（或已下载标记）合并至当前语言的推荐模型底表，确保列表永不丢失
 */
function mergeScannedWithRecommended(scanned: ModelItem[]): ModelItem[] {
  const currentLang = useI18nStore.getState().currentLanguage || 'zh-CN'
  const recommendedList = modelMetadataService.getModelsForLanguage(currentLang)
  const map = new Map<string, ModelItem>()

  // 1. 填入所有官方推荐模型，并通过多级特征精准匹配扫描到的下载状态
  for (const rec of recommendedList) {
    const recIdClean = rec.id.split(':')[0].toLowerCase()
    const recTail = recIdClean.split('/').pop()?.replace(/-gguf$/i, '') || recIdClean
    // 推荐模型的量化 tag（标准化去除 UD- 前缀小写）
    const recTag = (rec.id.includes(':')
      ? rec.id.split(':')[1]
      : rec.quant || ''
    ).replace(/^ud-/, '').toLowerCase()

    const existing = scanned.find(m => {
      // 必须是已经确认下载就绪的扫描模型条目
      if (!m.isDownloaded && !m.localPath) return false

      // 提取被扫描模型的量化 tag：优先从本地文件名提取，次之从 m.id/m.quant 提取
      const localFileName = m.localPath ? (m.localPath.split(/[\\/]/).pop() || '') : ''
      const fileQuant = localFileName ? ModelResolver.extractQuantTag(localFileName) : null
      const mTag = fileQuant || (m.id.includes(':') ? m.id.split(':')[1] : m.quant || '').replace(/^ud-/, '').toLowerCase()

      // 若双方均指定了量化 tag，则量化 tag 必须严格一致，禁止跨量化串绑！
      if (recTag && mTag && recTag !== mTag) {
        return false
      }

      // 策略 A: ID 完全相同
      if (m.id === rec.id) return true

      // 策略 B: 清除量化后缀后 repo ID 相同且量化 tag 吻合
      const mIdClean = m.id.split(':')[0].toLowerCase()
      if (mIdClean === recIdClean) {
        return recTag ? recTag === mTag : true
      }

      // 策略 C: 物理文件路径包含模型核心仓库名且量化 tag 吻合
      if (localFileName) {
        const localLower = localFileName.toLowerCase()
        if (localLower.includes(recTail) || localLower.replace(/\.gguf$/, '').includes(recTail.replace(/-gguf$/, ''))) {
          return recTag ? recTag === mTag : true
        }
      }

      return false
    })

    const isDownloaded = existing ? Boolean(existing.isDownloaded) : false
    map.set(rec.id, {
      ...rec,
      isDownloaded,
      localPath: existing?.localPath,
      sha256: existing?.sha256 || rec.sha256
    })
  }

  // 2. 填入扫描到的本地自定义/独有模型（保证本地模型不被丢弃）
  for (const item of scanned) {
    const isAlreadyMapped = Array.from(map.values()).some(m => {
      if (m.id === item.id) return true
      if (item.localPath && m.localPath === item.localPath) return true
      return false
    })
    if (!isAlreadyMapped) {
      map.set(item.id, item)
    }
  }

  return Array.from(map.values())
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

  fetchEngineStatus: async () => {
    try {
      set({ loading: true, error: null })
      const status = await engineApiClient.getEngineStatus()
      const resolvedDir = status.models_dir
        ? resolveToAbsolutePath(status.models_dir)
        : get().modelsDir
      set({
        engineStatus: status,
        modelsDir: resolvedDir,
        runtimeParams: status.runtime_params || get().runtimeParams,
        loading: false
      })

      // 如果当前 activeModelKey 尚未确定且已有当前运行模型，尝试反查 activeModelKey
      if (!get().activeModelKey && status.current_model) {
        const currentModels = get().models
        const matched = currentModels.find(
          m => m.name === status.current_model || m.id === status.current_model || (m.localPath && status.current_model.includes(m.localPath))
        )
        if (matched) {
          set({ activeModelKey: `${matched.id}@${matched.source}` })
        }
      }
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
      const rawModels = await engineApiClient.listModels(source)
      const models = mergeScannedWithRecommended(rawModels)
      set({ models })

      // 确定激活模型 Key：
      // 1. 若当前运行模型已在状态中，优先对齐当前运行模型
      // 2. 否则选择第一个已下载就绪的模型
      // 3. 否则选择官方推荐模型
      const currentActiveKey = get().activeModelKey
      const currentModelName = get().engineStatus?.current_model

      if (currentModelName) {
        const activeItem = models.find(
          m => m.name === currentModelName || m.id === currentModelName || (m.localPath && currentModelName.includes(m.localPath))
        )
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
      const merged = mergeScannedWithRecommended(scanned)
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
