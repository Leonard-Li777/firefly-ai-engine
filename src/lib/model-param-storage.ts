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
  repeat_penalty: 1.1
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
