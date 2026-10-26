import { create } from 'zustand'
import {
  EngineStatusResponse,
  EngineItem,
  ModelItem,
  RuntimeParams,
  ModelParamsResponse
} from '../api/types'
import { engineApiClient } from '../api/provider'
import { RegionDetectionResult, regionDetector } from '../lib/region-detector'
import { modelMetadataService } from '../lib/model-metadata-service'
import { i18nScope, t } from '../languages'
import type { SupportedLanguage } from '../lib/language'
import { resolveToAbsolutePath } from '../lib/path-utils'
import { matchEngineModel, mergeScannedWithRecommended } from '../lib/model-resolver'
import { captureEvent } from '../lib/posthog'
import { toast } from '../components/common/Toast'

/**
 * 判断列表中的模型是否就是后端当前运行的模型。
 * 后端 current_model 是 GGUF 文件完整路径（也可能为模型 ID/名称）。
 *
 * 匹配规则统一收敛到 `matchEngineModel`（与首页 / Footer 的展示判定同源），
 * 避免「首页能识别运行中模型、模型列表却反查失败仍显示『激活并启动』」的口径分裂。
 * 该函数历史上只看 name/id/localPath，遇到「current_model 为物理路径 + 列表条目 localPath 缺失」
 * 时必然失配，导致 activeModelKey 恒为 null。
 */
function matchCurrentModel(model: ModelItem, currentModel: string): boolean {
  return matchEngineModel(model, currentModel)
}

interface EngineStoreState {
  // 状态数据
  engineStatus: EngineStatusResponse | null
  engineList: EngineItem[]
  models: ModelItem[]
  modelsDir: string
  activeModelKey: string | null
  activeLanguageModelKey: string | null
  activeEmbeddingModelKey: string | null
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
  deleteEngine: (backend: string) => Promise<boolean>
  switchModel: (modelId: string, source?: string, localPath?: string, modelName?: string, isEmbedding?: boolean) => Promise<boolean>
  updateStoragePath: (newPath: string) => Promise<boolean>
  rescanModels: () => Promise<void>
  updateRuntimeParams: (params: Partial<RuntimeParams>) => Promise<boolean>
  saveModelParams: (modelId: string, params: RuntimeParams) => Promise<boolean>
  getModelParams: (modelId: string) => Promise<ModelParamsResponse | undefined>
  addCustomModel: (url: string) => Promise<{ ok: boolean; error?: string }>
  deleteModel: (modelId: string, localPath?: string) => Promise<boolean>
  removeCustomModel: (modelId: string) => Promise<boolean>
  activateAndStart: (modelId: string, source?: string, localPath?: string, modelName?: string, isEmbedding?: boolean) => Promise<boolean>
  runRegionDetection: (force?: boolean) => Promise<void>
  resetDowngrade: () => Promise<boolean>
  startEngine: (options?: { mode?: 'language' | 'embedding'; modelId?: string }) => Promise<boolean>
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
  activeLanguageModelKey: null,
  activeEmbeddingModelKey: null,
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

      // 依据后端 current_model 反查 activeModelKey（当前进程实际运行 / 正在加载的模型）。
      // 反查失败或后端未上报时必须显式清空：运行态键只能由引擎上报派生，
      // 绝不允许残留上一次的值（否则重启期间会把旧模型继续标成「已启动/启动中」）。
      {
        const currentModels = get().models
        const reported = status.current_model
        if (!reported) {
          // 后端明确没有运行 / 加载中的模型 → 必须清空，杜绝残留值被当作运行态
          if (get().activeModelKey !== null) {
            set({ activeModelKey: null })
          }
        } else if (currentModels.length > 0) {
          // 列表未就绪时无法反查，保持原值，等 fetchModels 再对齐
          const matched = currentModels.find(m => matchCurrentModel(m, reported))
          const realKey = matched ? `${matched.id}@${matched.source}` : null
          if (get().activeModelKey !== realKey) {
            set({ activeModelKey: realKey })
          }
        }
      }

      // 双槽位解耦映射：持久化的语言模型与嵌入模型槽位
      const currentModels = get().models
      if (status.active_language_model) {
        const langPref = status.active_language_model
        const matchedLang = currentModels.find(m => !m.isEmbedding && (m.id === langPref || `${m.id}@${m.source}` === langPref || matchCurrentModel(m, langPref)))
        const langKey = matchedLang ? `${matchedLang.id}@${matchedLang.source}` : langPref
        if (get().activeLanguageModelKey !== langKey) {
          set({ activeLanguageModelKey: langKey })
        }
      }
      if (status.active_embedding_model) {
        const embPref = status.active_embedding_model
        const matchedEmb = currentModels.find(m => m.isEmbedding && (m.id === embPref || `${m.id}@${m.source}` === embPref || matchCurrentModel(m, embPref)))
        const embKey = matchedEmb ? `${matchedEmb.id}@${matchedEmb.source}` : embPref
        if (get().activeEmbeddingModelKey !== embKey) {
          set({ activeEmbeddingModelKey: embKey })
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
      // 1. 语言模型槽位：优先对齐后端已持久化的 active_language_model；否则选第一个已下载的语言模型，再兜底推荐模型
      // 2. 嵌入模型槽位：优先对齐后端已持久化的 active_embedding_model；否则选 WeMM 或首个已下载 embedding 模型
      const engineStatus = get().engineStatus
      const langModels = models.filter(m => !m.isEmbedding)
      const embModels = models.filter(m => m.isEmbedding)

      let targetLangKey = get().activeLanguageModelKey
      if (engineStatus?.active_language_model) {
        const matched = langModels.find(m => m.id === engineStatus.active_language_model || `${m.id}@${m.source}` === engineStatus.active_language_model || matchCurrentModel(m, engineStatus.active_language_model!))
        if (matched && matched.isDownloaded) {
          targetLangKey = `${matched.id}@${matched.source}`
        } else {
          targetLangKey = null
        }
      }
      if (!targetLangKey && langModels.length > 0) {
        // 严格约束：只有已下载的模型才允许作为默认激活语言模型，未下载模型绝不可为已激活
        const initialLang = langModels.find(m => m.isDownloaded)
        if (initialLang) targetLangKey = `${initialLang.id}@${initialLang.source}`
      }

      let targetEmbKey = get().activeEmbeddingModelKey
      if (engineStatus?.active_embedding_model) {
        const matched = embModels.find(m => m.id === engineStatus.active_embedding_model || `${m.id}@${m.source}` === engineStatus.active_embedding_model || matchCurrentModel(m, engineStatus.active_embedding_model!))
        if (matched && matched.isDownloaded) {
          targetEmbKey = `${matched.id}@${matched.source}`
        } else {
          targetEmbKey = null
        }
      }
      if (!targetEmbKey && embModels.length > 0) {
        // 严格约束：只有已下载的模型才允许作为默认激活嵌入模型
        const initialEmb = embModels.find(m => m.isDownloaded)
        if (initialEmb) targetEmbKey = `${initialEmb.id}@${initialEmb.source}`
      }

      // 运行态 activeModelKey 严格由引擎上报的 current_model 派生：
      // 引擎未运行 / 尚未解析出模型时保持 null，绝不用「槽位激活态」或「首个已下载模型」兜底。
      // 历史上这里用 targetLangKey 兜底，导致重启期间（current_model 尚未上报）把列表第一行
      // 的已下载模型误标成「启动中」，而真正被加载的激活模型反而不显示。
      let targetActiveKey: string | null = null
      if (engineStatus?.current_model) {
        const activeItem = models.find(m => matchCurrentModel(m, engineStatus.current_model!))
        targetActiveKey = activeItem && activeItem.isDownloaded
          ? `${activeItem.id}@${activeItem.source}`
          : null
      } else if (get().activeModelKey && models.some(m => `${m.id}@${m.source}` === get().activeModelKey)) {
        // 状态快照暂时缺失（如刚启动尚未拿到 status）时保留已确认的运行态，但不新造
        targetActiveKey = get().activeModelKey
      }

      set({
        activeLanguageModelKey: targetLangKey,
        activeEmbeddingModelKey: targetEmbKey,
        activeModelKey: targetActiveKey
      })
    } catch (e: any) {
      console.error('获取模型列表失败:', e)
    }
  },

  switchModel: async (modelId: string, source?: string, localPath?: string, modelName?: string, isEmbedding?: boolean) => {
    try {
      set({ loading: true })
      const models = get().models
      const matched = models.find(
        m => m.id === modelId && (!source || m.source === source)
      )
      const effectiveLocalPath = localPath || matched?.localPath
      const effectiveModelName = modelName || matched?.name
      const effectiveIsEmbedding = isEmbedding !== undefined ? isEmbedding : (matched?.isEmbedding || modelId.toLowerCase().includes('wemm'))
      const res = await engineApiClient.switchModel(modelId, source, effectiveLocalPath, effectiveModelName, effectiveIsEmbedding)
      if (res.success) {
        captureEvent('切换模型', { modelId, source: source || 'modelscope', isEmbedding: effectiveIsEmbedding })
        const key = matched ? `${matched.id}@${matched.source}` : `${modelId}@${source || 'modelscope'}`
        // 切换只更新「配置槽位」（用户偏好），绝不宣称模型已进入运行态：
        // - 语言模型与嵌入模型各自独立持有激活槽位，二者可同时处于「已激活」；
        // - 但引擎进程同一时刻只运行一个模型，「已启动」由 /api/engine/status 的
        //   current_model（后端 running_model）独占表达，且切换并不触发进程重启。
        // 因此这里不改写 activeModelKey / engineStatus.current_model，避免把
        // 「刚切换的模型」误标为「已启动」（曾导致语言模型在跑时嵌入模型也显示已启动、无法手动切换）。
        set(state => ({
          activeLanguageModelKey: effectiveIsEmbedding ? state.activeLanguageModelKey : key,
          activeEmbeddingModelKey: effectiveIsEmbedding ? key : state.activeEmbeddingModelKey
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
        captureEvent('切换生效引擎', { backend })
        set(state => ({
          engineStatus: state.engineStatus
            ? { ...state.engineStatus, active_backend: backend }
            : state.engineStatus,
          engineList: state.engineList.map(e => ({
            ...e,
            isCurrent: e.backend === backend || (backend === 'cpu' && e.backend.startsWith('cpu'))
          }))
        }))
        await Promise.all([get().fetchEngineStatus(), get().fetchEngineList()])
        toast.success(res.message || t('已成功切换引擎'))
        return true
      }
      toast.error(res.error || res.message || t('切换引擎失败'))
      return false
    } catch (e: any) {
      console.error('切换引擎失败:', e)
      toast.error(e.message || t('切换引擎异常'))
      return false
    } finally {
      set({ switchingBackend: null })
    }
  },

  deleteEngine: async (backend: string) => {
    try {
      const res = await engineApiClient.deleteEngine(backend)
      if (res.success) {
        // 乐观更新：立即从列表中移除，避免后端异步删除导致的 UI 延迟（需二次点击才能看到删除态）
        set({ engineList: get().engineList.filter(e => e.backend !== backend) })
        await Promise.all([get().fetchEngineStatus(), get().fetchEngineList()])
        return true
      }
      return false
    } catch (e: any) {
      console.error('删除引擎失败:', e)
      return false
    }
  },

  updateStoragePath: async (newPath: string) => {
    try {
      const resolvedPath = resolveToAbsolutePath(newPath)
      const res = await engineApiClient.updateModelStoragePath(resolvedPath)
      if (res.success) {
        captureEvent('更新模型存储路径')
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
      // 仅记录来源，不上报 URL（可能含第三方私有地址）
      captureEvent('自由添加模型', { source: model.source })
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
        // 若删除的是当前激活模型，同步清空前端所有激活槽位
        const removed = get().models.find(m => m.id === modelId)
        const removedKey = removed ? `${removed.id}@${removed.source}` : modelId
        if (get().activeModelKey === removedKey || get().activeModelKey?.startsWith(modelId)) {
          set({ activeModelKey: null })
        }
        if (get().activeLanguageModelKey === removedKey || get().activeLanguageModelKey?.startsWith(modelId)) {
          set({ activeLanguageModelKey: null })
        }
        if (get().activeEmbeddingModelKey === removedKey || get().activeEmbeddingModelKey?.startsWith(modelId)) {
          set({ activeEmbeddingModelKey: null })
        }
        // 删除后先刷新引擎状态（可能因正在运行被停止），再刷新模型列表保持 UI 与磁盘一致
        await get().fetchEngineStatus(true)
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
        const removedKey = removed ? `${removed.id}@${removed.source}` : modelId
        if (get().activeModelKey === removedKey || get().activeModelKey?.startsWith(modelId)) {
          set({ activeModelKey: null })
        }
        if (get().activeLanguageModelKey === removedKey || get().activeLanguageModelKey?.startsWith(modelId)) {
          set({ activeLanguageModelKey: null })
        }
        if (get().activeEmbeddingModelKey === removedKey || get().activeEmbeddingModelKey?.startsWith(modelId)) {
          set({ activeEmbeddingModelKey: null })
        }
        await get().fetchEngineStatus(true)
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

  activateAndStart: async (modelId: string, source?: string, localPath?: string, modelName?: string, isEmbedding?: boolean) => {
    // 先切换/激活模型，再启动引擎服务
    const switched = await get().switchModel(modelId, source, localPath, modelName, isEmbedding)
    if (!switched) return false
    const models = get().models
    const matched = models.find(m => m.id === modelId && (!source || m.source === source))
    const effectivePath = localPath || matched?.localPath
    const effectiveIsEmbedding = isEmbedding !== undefined ? isEmbedding : (matched?.isEmbedding || modelId.toLowerCase().includes('wemm'))
    return get().startEngine({ mode: effectiveIsEmbedding ? 'embedding' : 'language', modelId: effectivePath || modelId })
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

  startEngine: async (options?: { mode?: 'language' | 'embedding'; modelId?: string }) => {
    try {
      set({ loading: true, error: null })

      // 若前端已选定激活语言模型且未显式指定 options，先确保主语言模型同步
      if (!options) {
        const langKey = get().activeLanguageModelKey || get().activeModelKey
        const models = get().models
        if (langKey && models.length > 0) {
          const [activeId, activeSource] = langKey.split('@')
          const activeModel = models.find(
            m => m.id === activeId && (!activeSource || m.source === activeSource)
          )
          if (activeModel?.isDownloaded) {
            await engineApiClient.switchModel(activeModel.id, activeModel.source, activeModel.localPath, activeModel.name, activeModel.isEmbedding)
          }
        }
      }

      const res = await engineApiClient.startEngine(options)
      if (res.success) {
        captureEvent('启动AI服务', {
          mode: options?.mode || 'language',
          modelId: options?.modelId ?? get().activeModelKey ?? undefined
        })
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
        captureEvent('停止AI服务')
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
