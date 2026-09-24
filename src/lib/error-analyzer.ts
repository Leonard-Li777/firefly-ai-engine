/**
 * 引擎侧 llama.cpp / 运行时错误分析器
 * 从 desktop ErrorNormalizer 的 llama.cpp 关键词识别与解决建议移植而来，
 * 职责：把原始引擎错误转成普通用户可读的分析结论与修复建议。
 */

import { t } from '../languages'

export type EngineErrorSeverity = 'low' | 'medium' | 'high' | 'critical'

export type EngineErrorCode =
  | 'INSUFFICIENT_VRAM'
  | 'GPU_DRIVER_OUTDATED'
  | 'LOCAL_AI_UNSUPPORTED'
  | 'ENGINE_NOT_FOUND'
  | 'MODEL_LOAD_FAILED'
  | 'SERVER_START_FAILED'
  | 'SERVER_CRASHED'
  | 'REQUEST_TIMEOUT'
  | 'DISK_FULL'
  | 'UNKNOWN_ERROR'

export interface EngineErrorAnalysis {
  code: EngineErrorCode
  severity: EngineErrorSeverity
  title: string
  userMessage: string
  solutions: string[]
  /** 清洗后的原始错误（可折叠展示） */
  rawMessage: string
  canRetry: boolean
}

/** 清洗调用栈与 Electron/运行时前缀，保留可读原因 */
function cleanErrorText(input: string): string {
  const stackTraceRegex = /^.*?\s*at\s+.+(:\d+:\d+|native|\[as\s.+\]).*$/gm
  const cleaned = input
    .replace(stackTraceRegex, '')
    .replace(/\n\s*\n/g, '\n')
    .replace(/^Error:\s*/i, '')
    .replace(/^Error invoking remote method.*?: Error:\s*/i, '')
    .trim()
  // 清洗过度导致空文案时回退原文，避免侧边栏丢失上下文
  return cleaned || input.trim()
}

/** 按 llama.cpp / 引擎运行时关键词推断错误码（移植 desktop ErrorNormalizer 规则） */
export function classifyEngineErrorCode(rawText: string): EngineErrorCode {
  const searchText = rawText.toLowerCase()

  // 显存/内存分配优先，避免同时命中 cuda 被误判为驱动问题
  if (
    searchText.includes('out of memory') ||
    searchText.includes('vram') ||
    searchText.includes('显存') ||
    searchText.includes('allocation failed')
  ) {
    return 'INSUFFICIENT_VRAM'
  }

  // 致命环境崩溃（访问违例）
  if (searchText.includes('3221225477') || searchText.includes('0xc0000005')) {
    return 'LOCAL_AI_UNSUPPORTED'
  }

  // 磁盘空间
  if (
    searchText.includes('no space left on device') ||
    searchText.includes('磁盘空间不足') ||
    searchText.includes('not enough space') ||
    searchText.includes('enospc')
  ) {
    return 'DISK_FULL'
  }

  // GPU / 驱动兼容
  if (
    searchText.includes('driver') ||
    searchText.includes('驱动') ||
    searchText.includes('cuda runtime version') ||
    searchText.includes('unsupported') ||
    searchText.includes('ptx') ||
    (searchText.includes('cuda') && !searchText.includes('busy or unavailable')) ||
    (searchText.includes('gpu') && !searchText.includes('busy or unavailable')) ||
    searchText.includes('ggml_assert')
  ) {
    return 'GPU_DRIVER_OUTDATED'
  }

  // 引擎二进制缺失
  if (
    searchText.includes('未找到 llama 引擎') ||
    searchText.includes('engine not found') ||
    searchText.includes('failed to spawn') ||
    searchText.includes('找不到指定的文件')
  ) {
    return 'ENGINE_NOT_FOUND'
  }

  // 模型加载
  if (
    searchText.includes('exiting due to model loading error') ||
    searchText.includes('model loading error') ||
    searchText.includes('projector type') ||
    searchText.includes('failed to load clip model') ||
    searchText.includes('failed to load model') ||
    searchText.includes('invalid gguf')
  ) {
    return 'MODEL_LOAD_FAILED'
  }

  // 服务启动 / 进程退出
  if (
    searchText.includes('llama-server进程已退出') ||
    searchText.includes('llama-server进程意外退出') ||
    searchText.includes('进程已退出') ||
    searchText.includes('进程意外退出') ||
    searchText.includes('退出，代码') ||
    searchText.includes('服务器启动超时') ||
    searchText.includes('服务启动超时') ||
    searchText.includes('启动超时') ||
    searchText.includes('startup timeout') ||
    searchText.includes('server startup timed out') ||
    searchText.includes('bind') ||
    searchText.includes('address already in use') ||
    searchText.includes('port')
  ) {
    return 'SERVER_START_FAILED'
  }

  // 崩溃
  if (
    searchText.includes('crash') ||
    searchText.includes('panic') ||
    searchText.includes('abort') ||
    searchText.includes('segfault') ||
    searchText.includes('access violation')
  ) {
    return 'SERVER_CRASHED'
  }

  // 超时
  if (
    searchText.includes('timeout') ||
    searchText.includes('timed out') ||
    searchText.includes('超时')
  ) {
    return 'REQUEST_TIMEOUT'
  }

  return 'UNKNOWN_ERROR'
}

/** 按错误码返回用户可读分析与建议（移植 desktop getCompleteErrorInfo 关键条目） */
export function getEngineErrorInfo(code: EngineErrorCode): Omit<
  EngineErrorAnalysis,
  'code' | 'rawMessage'
> {
  switch (code) {
    case 'INSUFFICIENT_VRAM':
      return {
        severity: 'high',
        title: t('显存不足'),
        userMessage: t('显存或内存不足，无法加载当前模型'),
        solutions: [
          t('关闭其他占用显存的应用程序'),
          t('尝试切换到更小的模型（如 0.8B 或更小）'),
          t('在「引擎与硬件」中切换到 CPU 或兼容模式'),
          t('查看运行日志获取更多技术细节')
        ],
        canRetry: true
      }
    case 'GPU_DRIVER_OUTDATED':
      return {
        severity: 'critical',
        title: t('显卡驱动或加速层异常'),
        userMessage: t('当前 GPU 驱动/加速后端与模型运行不兼容，引擎可能已降级'),
        solutions: [
          t('升级显卡驱动至最新版本'),
          t('在「引擎与硬件」中切换计算引擎（如 CUDA → Vulkan → CPU）'),
          t('启用兼容模式后重试启动'),
          t('查看运行日志获取更多技术细节')
        ],
        canRetry: true
      }
    case 'LOCAL_AI_UNSUPPORTED':
      return {
        severity: 'critical',
        title: t('当前环境无法运行本地 AI'),
        userMessage: t('系统环境发生致命错误，本地引擎无法继续运行'),
        solutions: [
          t('重启应用后重试'),
          t('在「引擎与硬件」中强制使用 CPU 模式'),
          t('检查系统内存与磁盘空间是否充足'),
          t('查看运行日志获取更多技术细节')
        ],
        canRetry: true
      }
    case 'ENGINE_NOT_FOUND':
      return {
        severity: 'critical',
        title: t('引擎程序缺失'),
        userMessage: t('未找到 llama.cpp 引擎可执行文件，部署可能不完整'),
        solutions: [
          t('重新安装应用或恢复引擎组件'),
          t('检查模型与引擎安装目录是否被安全软件隔离'),
          t('查看运行日志获取更多技术细节')
        ],
        canRetry: true
      }
    case 'MODEL_LOAD_FAILED':
      return {
        severity: 'high',
        title: t('模型加载失败'),
        userMessage: t('模型文件存在但加载失败，通常是文件损坏、不兼容或资源不足'),
        solutions: [
          t('重新下载模型文件或切换其他模型'),
          t('检查磁盘空间和系统显存是否充足'),
          t('尝试使用更小尺寸的模型'),
          t('在「引擎与硬件」中切换到 CPU 模式'),
          t('查看运行日志获取更多技术细节')
        ],
        canRetry: true
      }
    case 'SERVER_START_FAILED':
      return {
        severity: 'critical',
        title: t('引擎服务启动失败'),
        userMessage: t('llama.cpp 服务未能成功启动或端口异常'),
        solutions: [
          t('检查端口是否被占用，稍后重试启动'),
          t('确认模型文件完整且已正确选择'),
          t('切换计算引擎或强制 CPU 模式后重试'),
          t('查看运行日志获取更多技术细节')
        ],
        canRetry: true
      }
    case 'SERVER_CRASHED':
      return {
        severity: 'critical',
        title: t('引擎异常崩溃'),
        userMessage: t('推理进程意外退出，可能与驱动、显存或模型有关'),
        solutions: [
          t('切换到占用显存更小的模型'),
          t('停止其他占用显存的程序后重试'),
          t('尝试手动配置引擎为 CPU 模式'),
          t('查看运行日志获取更多技术细节')
        ],
        canRetry: true
      }
    case 'REQUEST_TIMEOUT':
      return {
        severity: 'medium',
        title: t('请求超时'),
        userMessage: t('引擎响应超时，可能是负载过高或服务未就绪'),
        solutions: [
          t('等待服务就绪后重试'),
          t('切换到更轻量的模型'),
          t('减少正在运行的后台任务'),
          t('查看运行日志获取更多技术细节')
        ],
        canRetry: true
      }
    case 'DISK_FULL':
      return {
        severity: 'high',
        title: t('磁盘空间不足'),
        userMessage: t('磁盘空间不足，无法完成模型或日志写入'),
        solutions: [
          t('清理磁盘空间后重试'),
          t('将模型存储路径迁移到更大磁盘'),
          t('查看运行日志获取更多技术细节')
        ],
        canRetry: true
      }
    default:
      return {
        severity: 'medium',
        title: t('引擎运行异常'),
        userMessage: t('引擎运行出现异常，建议查看日志并重试'),
        solutions: [
          t('重试启动服务'),
          t('切换模型或计算引擎'),
          t('查看运行日志获取更多技术细节')
        ],
        canRetry: true
      }
  }
}

/**
 * 分析原始引擎错误文本，输出侧边栏展示结构
 */
export function analyzeEngineError(rawError: string | null | undefined): EngineErrorAnalysis | null {
  if (!rawError || !String(rawError).trim()) return null
  const rawMessage = cleanErrorText(String(rawError))
  if (!rawMessage) return null

  const code = classifyEngineErrorCode(rawMessage)
  const info = getEngineErrorInfo(code)

  return {
    code,
    severity: info.severity,
    title: info.title,
    userMessage: info.userMessage,
    solutions: info.solutions,
    rawMessage,
    canRetry: info.canRetry
  }
}
