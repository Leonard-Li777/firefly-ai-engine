/**
 * Tier 2 AI 引擎类型定义契约
 * 严格遵循 ADR-0033 与 PRD-0033 规范
 */

export type EngineBackend = 'vulkan' | 'cuda' | 'metal' | 'cpu' | 'rocm' | 'sycl'
export type EngineRunStatus = 'starting' | 'ready' | 'model_loading' | 'downloading' | 'error' | 'stopped'
export type ModelSource = 'huggingface' | 'modelscope'

/**
 * 硬件检测信息
 */
export interface HardwareSpec {
  gpu_name: string
  total_vram_gb: number
  used_vram_gb?: number
  best_tier: EngineBackend
  current_tier: EngineBackend
  is_integrated: boolean
  cpu_cores?: number
  cpu_threads?: number
  os_platform?: 'win32' | 'darwin' | 'linux'
  total_ram_gb?: number
  used_ram_gb?: number
}

/**
 * 降级与驱动诊断信息
 */
export interface DowngradeInfo {
  downgraded: boolean
  reason?: string
  message?: string
  driver_update_url?: string
}

/**
 * 引擎运行时微调参数
 */
export interface RuntimeParams {
  n_gpu_layers: number
  threads: number
  ctx_size: number
  batch_size: number
  ubatch_size: number
}

/**
 * 后端 /api/engine/status 响应结构
 */
export interface EngineStatusResponse {
  status: EngineRunStatus
  active_backend: EngineBackend
  current_model: string
  models_dir: string
  vram_usage_mb: number
  port: number
  hardware: HardwareSpec
  downgrade_info?: DowngradeInfo
  runtime_params?: RuntimeParams
  last_error?: string
}

/**
 * 引擎管理表格行数据
 */
export interface EngineItem {
  id: string
  name: string
  backend: EngineBackend
  matchType: 'best' | 'compatible' | 'fallback'
  matchText: string
  performance: string
  isCurrent: boolean
  isInstalled: boolean
  downloadSizeMb?: number
  driverCompliant?: boolean
  driverUpdateUrl?: string
  downloadState?: {
    status: 'idle' | 'downloading' | 'extracting' | 'completed' | 'error'
    progress: number
    receivedBytes: number
    totalBytes: number
    speedBps: number
    error?: string
  }
}

export interface ModelItem {
  id: string
  name: string
  author?: string
  source: ModelSource
  quant: string
  quantization?: string
  fileSize: number
  size?: string
  params: string
  parameterSize?: string
  description: string
  isMultiModal?: boolean
  mmprojFileName?: string
  isDownloaded: boolean
  localPath?: string
  mmprojLocalPath?: string
  sha256?: string
  dspark?: string
  draftId?: string
  downloadId?: string
  recommended?: boolean
  vramNeededGB?: number
  capabilities?: string[]
  intelligenceLevel?: 1 | 2 | 3 | 4 | number
  customParams?: Partial<RuntimeParams>
}

/**
 * 下载进度事件
 */
export interface DownloadProgressEvent {
  taskId: string
  modelId: string
  source?: ModelSource
  sourceName?: string
  percent: number
  receivedBytes: number
  totalBytes: number
  speedBps: number
  status: 'pending' | 'downloading' | 'retrying' | 'completed' | 'error' | 'canceled'
  error?: string
  currentFileName?: string
  fileIndex?: number
  totalFiles?: number
}

/**
 * 下载任务摘要
 */
export interface DownloadTaskSummary {
  taskId: string
  totalBytes: number
  isDownloaded: boolean
}

/**
 * 模型物理路径探测结果
 */
export interface ModelResolution {
  modelId: string
  modelPath: string
  mmprojPath?: string
  dirPath: string
  dirType: 'modern' | 'modelscope' | 'legacy' | 'root'
}
