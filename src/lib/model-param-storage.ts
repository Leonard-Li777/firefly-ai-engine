import { RuntimeParams } from '../api/types'

const STORAGE_KEY_PREFIX = 'firefly_model_params_'

/**
 * 默认基础运行时参数（覆盖全部 11 项可调超参）
 */
export const DEFAULT_MODEL_PARAMS: RuntimeParams = {
  n_gpu_layers: 24,
  threads: 8,
  ctx_size: 4096,
  batch_size: 512,
  ubatch_size: 256,
  cache_type_k: 'f16',
  cache_type_v: 'f16',
  parallel: 1,
  temp: 0.7,
  top_p: 0.95,
  top_k: 40,
  repeat_penalty: 1.1,
  enableVision: true,
  enableDraft: true,
  draftMaxTokens: 5
}

/**
 * 获取指定模型的专属自定义参数（如果无，则返回 undefined）
 */
export function getModelCustomParams(modelId: string): Partial<RuntimeParams> | undefined {
  if (typeof window === 'undefined' || !window.localStorage) return undefined
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${modelId}`)
    if (!raw) return undefined
    return JSON.parse(raw)
  } catch (e) {
    console.warn(`读取模型 [${modelId}] 自定义参数失败:`, e)
    return undefined
  }
}

/**
 * 保存指定模型的专属自定义参数
 */
export function saveModelCustomParams(modelId: string, params: Partial<RuntimeParams>): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    // 强制微批约束：ubatch <= batch，防止底层崩溃
    const validParams = { ...params }
    if (validParams.batch_size && validParams.ubatch_size && validParams.ubatch_size > validParams.batch_size) {
      validParams.ubatch_size = validParams.batch_size
    }
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${modelId}`, JSON.stringify(validParams))
  } catch (e) {
    console.error(`保存模型 [${modelId}] 自定义参数失败:`, e)
  }
}

/**
 * 重置指定模型的专属参数（恢复全局默认）
 */
export function clearModelCustomParams(modelId: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    localStorage.removeItem(`${STORAGE_KEY_PREFIX}${modelId}`)
  } catch (e) {
    console.error(`清除模型 [${modelId}] 自定义参数失败:`, e)
  }
}

/**
 * 根据模型特征与当前硬件环境，自适应计算推荐的运行时超参
 *
 * 注意：_model 为预留的模型特征入参（当前推荐策略以硬件规格为主，
 * 模型侧的互锁由 command-builder 的双重互锁兜底，故暂不参与计算，
 * 保留此形参以维持调用方 (model, hardware) 的位置兼容签名）。
 */
export function calculateRecommendedParams(_model?: import('../api/types').ModelItem | null, hardware?: import('../api/types').HardwareSpec | null): RuntimeParams {
  const vramGB = hardware?.total_vram_gb || 0
  const isIntegrated = !!hardware?.is_integrated
  const cpuThreads = hardware?.cpu_threads || hardware?.cpu_cores || 8
  const safeThreads = Math.max(2, Math.min(8, Math.floor(cpuThreads * 0.75)))

  let n_gpu_layers = 24
  let batch_size = 512
  let ubatch_size = 256
  let ctx_size = 4096
  let cache_type_k = 'f16'
  let cache_type_v = 'f16'

  if (vramGB <= 0 || hardware?.current_tier === 'cpu') {
    // 纯 CPU 模式
    n_gpu_layers = 0
    batch_size = 128
    ubatch_size = 128
    ctx_size = 2048
  } else if (isIntegrated) {
    // 核显
    n_gpu_layers = 12
    batch_size = 512
    ubatch_size = 256
    ctx_size = 4096
    cache_type_k = 'q8_0'
    cache_type_v = 'q8_0'
  } else {
    // 独显
    if (vramGB >= 12) {
      n_gpu_layers = -1 // 全量卸载
      batch_size = 2048
      ubatch_size = 512
      ctx_size = 8192
    } else if (vramGB >= 8) {
      n_gpu_layers = -1
      batch_size = 1024
      ubatch_size = 512
      ctx_size = 4096
      cache_type_k = 'q8_0'
      cache_type_v = 'q8_0'
    } else if (vramGB >= 6) {
      n_gpu_layers = 28
      batch_size = 512
      ubatch_size = 256
      ctx_size = 4096
      cache_type_k = 'q8_0'
      cache_type_v = 'q8_0'
    } else {
      n_gpu_layers = 16
      batch_size = 512
      ubatch_size = 256
      ctx_size = 2048
      cache_type_k = 'q8_0'
      cache_type_v = 'q8_0'
    }
  }

  return {
    ...DEFAULT_MODEL_PARAMS,
    n_gpu_layers,
    threads: safeThreads,
    ctx_size,
    batch_size,
    ubatch_size,
    cache_type_k,
    cache_type_v,
    parallel: 1,
    temp: 0.7,
    top_p: 0.95,
    top_k: 40,
    repeat_penalty: 1.1,
    enableVision: true,
    enableDraft: true,
    draftMaxTokens: 5
  }
}
