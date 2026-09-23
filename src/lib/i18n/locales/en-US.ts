import { TranslationKeys } from './zh-CN'

export const enUS: TranslationKeys = {
  app: {
    title: 'Firefly AI Engine',
    subtitle: 'Standalone On-Device AI Inference Engine & Model Management Platform',
    language: 'Language'
  },
  network: {
    detecting: 'Probing network environment...',
    mirrorCn: 'CN Accelerated Mirror (ModelScope / Fast Proxy)',
    directGlobal: 'Global Direct Access (HuggingFace / Official)',
    probeSuccess: 'Network probe completed'
  },
  hardware: {
    title: 'Hardware Environment & Driver Diagnostics',
    gpuModel: 'GPU Model',
    vram: 'Available VRAM',
    totalMem: 'System RAM',
    activeBackend: 'Active Backend',
    recommendedBackend: 'Recommended Backend',
    driverWarningTitle: 'Driver Warning & Auto-Downgrade Diagnostic',
    driverWarningTip: 'Running in compatibility mode (70% AI performance). Please upgrade GPU drivers to unlock full performance.',
    btnUpdateDriver: 'Upgrade GPU Driver',
    btnRecheckDriver: 'Driver Upgraded, Recheck',
    vramBar: 'Estimated VRAM Usage'
  },
  engine: {
    title: 'Switch Local AI Engine',
    desc: 'Your {vendor} GPU supports switching to the following engines',
    name: 'AI Engine',
    type: 'Adaptation Type',
    perfRating: 'Performance',
    status: 'Status',
    action: 'Current Engine',
    statusReady: 'Ready',
    statusActive: 'Active',
    statusNotInstalled: 'Not Installed',
    statusDownloading: 'Downloading...',
    btnEnable: 'Switch Engine',
    btnSwitch: 'Switch Engine',
    btnActive: 'Current Engine',
    btnDownload: 'Download Engine',
    btnUpdateDriver: 'Update Driver',
    switchSuccess: 'Engine switched successfully',
    downloadFailed: 'Failed to download engine'
  },
  storage: {
    title: 'Custom Model Storage Directory',
    desc: 'Customize storage path on large disks. Changing it will immediately re-scan GGUF models in that directory.',
    currentPath: 'Current Storage Path',
    btnBrowse: 'Browse',
    btnRescan: 'Rescan',
    scanning: 'Scanning models...',
    scanSuccess: 'Scan completed, found {count} models'
  },
  models: {
    title: 'On-Device Models & Orchestration',
    tabInstalled: 'Installed ({count})',
    tabRecommended: 'Recommended ({count})',
    searchPlaceholder: 'Search model name, organization, or spec...',
    sourceFilter: 'Source Channel',
    sourceAll: 'All Sources',
    sourceModelScope: 'ModelScope (CN)',
    sourceHuggingFace: 'HuggingFace (Global)',
    sourceLocal: 'Local Import',
    emptyInstalled: 'No models installed yet. Click download from recommended list.',
    emptyRecommended: 'No matching recommended models found',
    btnDownload: 'Download',
    btnDownloading: 'Downloading...',
    btnRun: 'Start Engine',
    btnRunning: 'Running',
    btnStop: 'Stop Engine',
    tagMultimodal: 'Multimodal Vision',
    tagDspark: 'DSpark Speculative',
    tagCpuFriendly: 'CPU Friendly',
    tagRecommended: 'Recommended',
    paramSize: 'Params',
    fileSize: 'File Size',
    vramNeeded: 'VRAM Needed',
    quantization: 'Quant',
    groupDownloaded: 'Downloaded',
    groupNotDownloaded: 'Available to Download',
    groupVramInsufficient: 'Insufficient VRAM · Unavailable',
    colModel: 'Model',
    colRecommended: 'Recommended',
    colIntelligence: 'Intelligence',
    colCapabilities: 'Capabilities',
    colVram: 'VRAM',
    intelLevel1: 'Elementary',
    intelLevel2: 'Middle School',
    intelLevel3: 'High School',
    intelLevel4: 'University'
  },
  runtime: {
    title: 'Runtime Monitoring & Safe Scheduling',
    desc: 'Real-time tuning strictly enforcing ubatch <= batch and Max-Fill VRAM offloading.',
    gpuLayers: 'GPU Layers (-ngl)',
    batchSize: 'Batch Size (--batch-size)',
    ubatchSize: 'Micro-Batch Size (--ubatch-size)',
    threads: 'CPU Threads (-t)',
    ctxSize: 'Context Size (--ctx-size)',
    vramAllocation: 'Dynamic VRAM Estimation',
    flashAttention: 'Flash Attention',
    faEnabled: 'Enabled (Hardware Supported)',
    faDisabled: 'Disabled (Vulkan / CPU / Legacy Fallback)'
  },
  common: {
    success: 'Operation succeeded',
    failed: 'Operation failed',
    loading: 'Loading...',
    confirm: 'Confirm',
    cancel: 'Cancel'
  },
  chat: {
    tabTitle: 'Chat privately with local AI',
    notReadyTitle: 'Local Inference Service Not Ready',
    notReadyDesc: 'Please start the local AI engine service in Dashboard first, or wait for the model to finish loading.',
    btnStart: 'Start Service Now',
    openExternal: 'Open in Browser',
    reload: 'Reload Page'
  },
  thinking: {
    title: 'Model thinking mode',
    badgeTime: 'Will increase time consumption',
    desc: 'After turning it on, local and cloud models are allowed to start thinking mode, which may improve AI analysis quality, but will greatly increase response time. Recommended to enable only when chatting with AI.',
    unsupportedTip: 'Models tagged Instruct are not supported.'
  }
}
