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
    driverWarningTip: 'NVIDIA driver version is too low or lacks CUDA support. Automatically downgraded to Vulkan. Updating GPU drivers is recommended.',
    vramBar: 'Estimated VRAM Usage'
  },
  engine: {
    title: 'AI Inference Engines',
    desc: 'Supports Vulkan, CPU, CUDA 12.4, and Metal runtimes with seamless hot-switching.',
    name: 'Engine Name',
    type: 'Backend Architecture',
    status: 'Status',
    action: 'Action',
    statusReady: 'Ready',
    statusActive: 'Active',
    statusNotInstalled: 'Not Installed',
    statusDownloading: 'Downloading...',
    btnEnable: 'Enable',
    btnActive: 'Active',
    btnDownload: 'Download',
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
    quantization: 'Quant'
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
  }
}
