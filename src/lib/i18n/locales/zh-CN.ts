export const zhCN = {
  app: {
    title: 'Firefly AI Engine',
    subtitle: '独立高可用端侧 AI 推理引擎与模型管理平台',
    language: '界面语言'
  },
  network: {
    detecting: '正在探测网络环境...',
    mirrorCn: '国内加速镜像 (ModelScope / 镜像代理)',
    directGlobal: '海外官方直连 (HuggingFace / 官方源)',
    probeSuccess: '网络检测完成'
  },
  hardware: {
    title: '硬件环境与驱动诊断',
    gpuModel: '显卡型号',
    vram: '可用显存',
    totalMem: '系统物理内存',
    activeBackend: '当前活动后端',
    recommendedBackend: '硬件最佳推荐',
    driverWarningTitle: '驱动升级告警与自动降级诊断',
    driverWarningTip: 'NVIDIA 驱动版本过低或缺少 CUDA 支持，已自动降级至 Vulkan 运行。建议更新显卡驱动以获得最佳算力。',
    vramBar: '显存预估占用'
  },
  engine: {
    title: 'AI 计算引擎管理',
    desc: '系统支持 Vulkan、CPU、CUDA 12.4 及 Metal 运行时，已安装引擎可一键平滑热切换。',
    name: '引擎名称',
    type: '后端架构',
    status: '当前状态',
    action: '操作',
    statusReady: '就绪',
    statusActive: '运行中',
    statusNotInstalled: '未安装',
    statusDownloading: '下载中...',
    btnEnable: '启用',
    btnActive: '已启用',
    btnDownload: '下载安装',
    switchSuccess: '引擎切换成功',
    downloadFailed: '引擎下载失败'
  },
  storage: {
    title: '模型存储目录自定义配置',
    desc: '自定义大容量磁盘存放目录，避免占用系统盘空间。更改后将即时扫描该目录下的 GGUF 模型。',
    currentPath: '当前存储路径',
    btnBrowse: '更改目录',
    btnRescan: '重新扫描',
    scanning: '正在扫描模型...',
    scanSuccess: '扫描完成，发现 {count} 个模型'
  },
  models: {
    title: '端侧模型库与调度',
    tabInstalled: '本地已就绪 ({count})',
    tabRecommended: '官方推荐模型 ({count})',
    searchPlaceholder: '搜索模型名称、组织或规格...',
    sourceFilter: '来源渠道',
    sourceAll: '全部来源',
    sourceModelScope: 'ModelScope (国内)',
    sourceHuggingFace: 'HuggingFace (国际)',
    sourceLocal: '本地物理导入',
    emptyInstalled: '暂无已就绪模型，可从推荐模型列表中一键下载',
    emptyRecommended: '未找到匹配的推荐模型',
    btnDownload: '下载模型',
    btnDownloading: '正在下载...',
    btnRun: '启动引擎',
    btnRunning: '正在服务',
    btnStop: '停止服务',
    tagMultimodal: '多模态视觉',
    tagDspark: 'DSpark 投机加速',
    tagCpuFriendly: 'CPU 友好',
    tagRecommended: '官方推荐',
    paramSize: '参数量',
    fileSize: '模型大小',
    vramNeeded: '显存需求',
    quantization: '量化精度'
  },
  runtime: {
    title: '运行时监控与安全调度配置',
    desc: '实时调控推理参数。严格遵循 ubatch <= batch 防崩溃安全准则与 Max-Fill 显存卸载。',
    gpuLayers: 'GPU 卸载层数 (-ngl)',
    batchSize: '逻辑批大小 (--batch-size)',
    ubatchSize: '物理微批大小 (--ubatch-size)',
    threads: 'CPU 计算线程 (-t)',
    ctxSize: '上下文长度 (--ctx-size)',
    vramAllocation: '动态显存预测分配',
    flashAttention: 'Flash Attention',
    faEnabled: '已启用 (显卡硬件支持)',
    faDisabled: '已禁用 (Vulkan / CPU / 旧架构回退)'
  },
  common: {
    success: '操作成功',
    failed: '操作失败',
    loading: '加载中...',
    confirm: '确认',
    cancel: '取消'
  }
}

export type TranslationKeys = typeof zhCN
