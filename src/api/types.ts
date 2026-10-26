/**
 * Tier 2 AI 引擎类型定义契约
 * 严格遵循 ADR-0033 与 PRD-0033 规范
 */

export type EngineBackend =
  | 'vulkan'
  | 'cuda'
  | 'cuda12'
  | 'cuda13'
  | 'cuda134'
  | 'metal'
  | 'cpu'
  | 'cpu-avx'
  | 'cpu-noavx'
  | 'cpu-avx2'
  | 'rocm'
  | 'hip'
  | 'sycl'
  | string

export type EngineRunStatus = 'starting' | 'ready' | 'model_loading' | 'downloading' | 'processing' | 'error' | 'stopped'
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
  has_avx2?: boolean
  has_avx?: boolean
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
 * 引擎运行时微调参数及模型专属参数
 */
export interface RuntimeParams {
  n_gpu_layers: number
  threads: number
  ctx_size: number
  batch_size: number
  ubatch_size: number
  cache_type_k?: 'f16' | 'q8_0' | 'q4_0' | string
  cache_type_v?: 'f16' | 'q8_0' | 'q4_0' | string
  parallel?: number
  temp?: number
  top_p?: number
  top_k?: number
  repeat_penalty?: number

  // 伴随模型控制与微调（新增）
  enableVision?: boolean       // 是否加载识图多模态投影（默认 true）
  enableMmproj?: boolean       // 别名兼容
  enableDraft?: boolean        // 是否加载投机加速草稿模型（默认 true）
  draftMaxTokens?: number      // 投机预测最大步数（默认 6——DSpark 甜点值；2026-10-20 取消 15 下限，命中率低时 15 个候选大部分作废）
}

export interface ModelBudgetInfo {
  budget_ctx: number
  max_train_ctx: number
  usable_memory_gb: number
  fixed_overhead_gb: number
  tier: string
}

export interface ModelParamsResponse {
  params?: RuntimeParams | null
  recommended: RuntimeParams
  budget?: ModelBudgetInfo | null
}

export interface StartModelDownloadOptions {
  source?: string
  forceRestart?: boolean
  quantization?: string
  isMultiModal?: boolean       // 多模态门控
  mmproj?: string              // 投影短标签/目标
  dspark?: string              // 草稿短标签/目标
}

export type ModelCustomParams = RuntimeParams

/**
 * 后端 /api/engine/status 响应结构
 */
export interface EngineStatusResponse {
  status: EngineRunStatus
  active_backend: EngineBackend
  current_model: string | null
  current_model_name?: string | null
  active_language_model?: string | null
  active_embedding_model?: string | null
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
  isRecommended?: boolean
  performance: string
  isCurrent: boolean
  isInstalled: boolean
  hasUpdate?: boolean
  latestVersion?: string
  installedVersion?: string
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
  /** 嵌入向量模型标记（如 WeMM-Embedding），与语言模型分组展示，不参与激活/启动流程 */
  isEmbedding?: boolean
  mmproj?: string
  mmprojFileName?: string
  isDownloaded: boolean
  localPath?: string
  mmprojLocalPath?: string
  draftLocalPath?: string
  sha256?: string
  dspark?: string
  draftId?: string
  downloadId?: string
  recommended?: boolean
  vramNeededGB?: number
  capabilities?: string[]
  intelligenceLevel?: 1 | 2 | 3 | 4 | number
  customParams?: Partial<RuntimeParams>
  /** 用户自由添加的模型（URL 嗅探来源），非探测值不显示 */
  custom?: boolean
  /** 自由添加模型的直接下载地址（resolve URL） */
  resolveUrl?: string
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
  draftPath?: string           // 新增：伴随草稿模型物理路径
  dirPath: string
  dirType: 'modern' | 'modelscope' | 'legacy' | 'root'
}

/**
 * open-ui 深链意图记录（引擎侧「待消费」存储）
 *
 * Desktop 的引导条会并行发起「静默拉起引擎」与 `openUI({panel})`，此时引擎可能刚启动、
 * WebView 前端尚未挂载，Tauri 事件必然丢失。引擎把意图暂存于此，前端挂载后一次性取回补偿。
 */
export interface UiIntentRecord {
  /** 目标面板：error / logs / models / default */
  panel: string
  /** 目标模型关键词（模型面板滚动聚焦 + 呼吸高亮，Issue 0046 §3；未指定时字段省略） */
  focus_model?: string
  /** 推荐模型源（modelscope / huggingface；未指定时字段省略） */
  source?: string
  /** 单调递增序号 */
  seq: number
}

/**
 * POST /api/engine/ui-intent/consume 响应：取回并清空待消费意图
 */
export interface UiIntentConsumeResponse {
  intent: UiIntentRecord | null
}
