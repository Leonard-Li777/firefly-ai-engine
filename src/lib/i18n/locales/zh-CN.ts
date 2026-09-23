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
    driverWarningTip: '目前使用兼容模式，能发挥您显卡70% AI算力，显卡驱动需要升级，才能发挥满血性能',
    btnUpdateDriver: '升级显卡驱动',
    btnRecheckDriver: '我已升级驱动，重新检测',
    vramBar: '显存预估占用'
  },
  engine: {
    title: '切换本地AI引擎',
    desc: '您的 {vendor} 显卡可切换以下引擎',
    name: 'AI 引擎',
    type: '适配类型',
    perfRating: '性能说明',
    status: '当前状态',
    action: '当前引擎',
    statusReady: '就绪',
    statusActive: '运行中',
    statusNotInstalled: '未安装',
    statusDownloading: '下载中...',
    btnEnable: '切换引擎',
    btnSwitch: '切换引擎',
    btnActive: '当前引擎',
    btnDownload: '下载引擎',
    btnUpdateDriver: '更新显卡驱动',
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
    quantization: '量化精度',
    groupDownloaded: '已下载模型',
    groupNotDownloaded: '待下载模型',
    groupVramInsufficient: '显存不足 · 不可下载',
    colModel: '模型名称',
    colRecommended: '推荐',
    colIntelligence: '智能程度',
    colCapabilities: '能力',
    colVram: '显存',
    intelLevel1: '小学生',
    intelLevel2: '初中生',
    intelLevel3: '高中生',
    intelLevel4: '大学生'
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
  },
  chat: {
    tabTitle: '与本地AI私密聊天',
    notReadyTitle: '本地推理服务未就绪',
    notReadyDesc: '请先在仪表盘启动本地 AI 引擎服务，或等待模型加载完成。',
    btnStart: '立即启动服务',
    openExternal: '外部浏览器打开',
    reload: '刷新页面'
  },
  thinking: {
    title: '模型思考模式',
    badgeTime: '会增加耗时',
    desc: '开启后允许本地和云端模型开启思考模式，可能提升AI分析质量，但会大大增加响应时间。建议仅在需要与 AI 进行聊天时开启。',
    unsupportedTip: '不支持标记 Instruct 的模型。'
  }
}

export type TranslationKeys = typeof zhCN
