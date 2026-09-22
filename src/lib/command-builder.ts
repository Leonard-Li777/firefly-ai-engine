import os from 'node:os'
import { toShortPathOnWindows, resolveModelArgForCmd } from './path-utils'
import { unifiedModelManager } from './unified-model-manager'
import { parseSizeToGB } from './model-metadata-service'

export interface HardwareInfo {
  gpuModel?: string
  gpuVendor?: 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown'
  vramGB?: number
  totalMemGB?: number
  isIntegrated?: boolean
  osPlatform?: string
  cpuCores?: number
}

export interface BuildCommandOptions {
  modelId: string
  modelPath?: string
  source?: string
  binaryPath?: string
  port?: number
  contextWindow?: number
  batchSize?: number
  ubatchSize?: number
  gpuLayers?: number
  threads?: number
  forceCpuMode?: boolean
  backend?: 'cuda' | 'vulkan' | 'cpu' | 'metal'
  hardware?: HardwareInfo
  /** 是否启用思考模式，默认 false (关闭时注入 --reasoning off --reasoning-format none --reasoning-budget 0 等) */
  enableThinking?: boolean
  /** 外部额外参数，自动支持去重与覆盖保护 */
  extraArgs?: string[]
  /** 是否为生产环境 (生产环境自动注入 --verbose) */
  isProduction?: boolean
  /** Linux 环境是否启用 NUMA 隔离优化 */
  enableNUMA?: boolean
}

export interface BuiltCommandContext {
  command: string
  args: string[]
  env: Record<string, string>
  calculatedGpuLayers: number
  calculatedBatchSize: number
  calculatedUbatchSize: number
  calculatedThreads: number
  isCpuMode: boolean
  isFlashAttentionEnabled: boolean
  fullCommandLine: string
}

/**
 * 生产级 llama-server 动态命令行构建器 (LlamaCommandBuilder)
 * 1:1 对等移植桌面端生产环境验证的参数计算矩阵、Max-Fill 显存卸载、DSpark 投机加速与短路径安全保护
 */
export class LlamaCommandBuilder {
  /**
   * 构建生产级完整启动上下文
   */
  static buildCommandContext(options: BuildCommandOptions): BuiltCommandContext {
    const modelManager = unifiedModelManager
    const modelConfig = modelManager.getModelById(options.modelId, options.source)
    const finalSource = options.source || modelConfig?.source || 'huggingface'
    const modelBaseDir = modelManager.getModelBaseDir()

    const rawBinary = options.binaryPath || (process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')
    const binaryPath = toShortPathOnWindows(rawBinary)

    // 1. 模型路径解析与短路径安全转换
    let modelArg: string[] = []
    let projectorArg: string[] = []
    let draftArg: string[] = []

    const paths = modelManager.resolveModelPaths(options.modelId, options.source)
    const effectiveModelPath = options.modelPath || paths.modelFile

    if (effectiveModelPath) {
      const modelCmdPath = resolveModelArgForCmd(effectiveModelPath, modelBaseDir, finalSource)
      modelArg = ['--model', modelCmdPath]

      // 多模态投影器 --mmproj 参数
      if (modelConfig?.isMultiModal && paths.mmprojFile) {
        const projCmdPath = resolveModelArgForCmd(paths.mmprojFile, modelBaseDir, finalSource)
        projectorArg = ['--mmproj', projCmdPath]
      }
    } else if (finalSource === 'huggingface') {
      // 采用 -hf 模式
      modelArg = ['-hf', options.modelId]
    } else {
      modelArg = ['-hf', options.modelId]
    }

    // 2. 估算模型参数量与体积
    let modelParamSize = 7
    if (modelConfig?.parameterSize) {
      const match = modelConfig.parameterSize.match(/^([\d.]+)\s*B$/i)
      if (match) {
        modelParamSize = parseFloat(match[1]) || 7
      } else {
        const num = parseFloat(modelConfig.parameterSize)
        if (!isNaN(num)) modelParamSize = num
      }
    }

    let modelSizeGB = parseSizeToGB(modelConfig?.size)
    if (modelSizeGB <= 0) {
      const quant = (modelConfig?.quantization || '').toUpperCase()
      let bytesPerParam = 0.6 // 默认 Q4_K_M
      if (quant.includes('Q8') || quant.includes('FP8')) bytesPerParam = 1.05
      else if (quant.includes('Q2') || quant.includes('IQ2')) bytesPerParam = 0.38
      else if (quant.includes('Q3') || quant.includes('IQ3')) bytesPerParam = 0.48
      else if (quant.includes('Q5') || quant.includes('Q6')) bytesPerParam = 0.75
      else if (quant.includes('FP16') || quant.includes('F16')) bytesPerParam = 2.0
      modelSizeGB = modelParamSize * bytesPerParam
    }

    // 3. 确定是否处于纯 CPU 模式
    const backend = options.backend || 'vulkan'
    let isCpuMode = false
    if (options.forceCpuMode || backend === 'cpu') {
      isCpuMode = true
    }

    // 4. Max-Fill 显存卸载与分级参数自适应计算
    const hardware = options.hardware || {}
    const vramGB = hardware.vramGB || 0
    const isIntegrated = !!hardware.isIntegrated

    let estimatedLayers = 32
    if (modelParamSize <= 2) estimatedLayers = 24
    else if (modelParamSize <= 4) estimatedLayers = 28
    else if (modelParamSize <= 9) estimatedLayers = 32
    else if (modelParamSize <= 16) estimatedLayers = 48
    else estimatedLayers = 64

    let calculatedGpuLayers = -1
    let calculatedBatchSize = 512
    let calculatedUbatchSize = 256
    let calculatedCtxSize = options.contextWindow || 4096

    const isAppleSilicon =
      hardware.gpuVendor === 'apple' ||
      hardware.osPlatform === 'darwin' ||
      process.platform === 'darwin'

    if (isCpuMode) {
      calculatedGpuLayers = 0
      calculatedBatchSize = Math.min(options.batchSize ?? 128, 128)
      calculatedUbatchSize = 128
      calculatedCtxSize = options.contextWindow || 4096
    } else if (isAppleSilicon) {
      // Apple Silicon Metal UMA (统一内存)
      const totalMem = hardware.totalMemGB || 16
      const usableMem = Math.max(2.0, totalMem - 3.0) // 预留 3GB 给系统
      if (modelSizeGB <= usableMem) {
        calculatedGpuLayers = -1
      } else {
        const offloadRatio = usableMem / modelSizeGB
        calculatedGpuLayers = Math.max(8, Math.floor(estimatedLayers * offloadRatio))
      }
      calculatedBatchSize = 1024
      calculatedUbatchSize = 512
    } else if (isIntegrated) {
      // 集成显卡/核显 (iGPU)
      const usableVramForIgpu = Math.min(3.5, Math.max(1.8, vramGB > 0 ? vramGB * 0.7 : 2.0))
      const offloadRatio = modelSizeGB > 0 ? usableVramForIgpu / modelSizeGB : 1.0
      if (offloadRatio >= 0.85 || modelSizeGB <= 2.0) {
        calculatedGpuLayers = -1
      } else {
        const targetLayers = Math.floor(estimatedLayers * offloadRatio)
        calculatedGpuLayers = Math.min(16, Math.max(8, targetLayers))
      }
      calculatedBatchSize = 512
      calculatedUbatchSize = 256
    } else {
      // 独立显卡 (dGPU)
      const usableVRAM = Math.max(0, vramGB - 0.8) // 预留 0.8GB 给系统与驱动
      const offloadRatio = modelSizeGB > 0 ? usableVRAM / modelSizeGB : 1.0
      if (offloadRatio >= 0.88) {
        calculatedGpuLayers = -1 // 全量 GPU 卸载
      } else {
        const targetLayers = Math.floor(estimatedLayers * offloadRatio)
        calculatedGpuLayers = targetLayers >= 6 ? targetLayers : 0
      }

      if (vramGB < 4) {
        calculatedBatchSize = 512
        calculatedUbatchSize = 256
        calculatedCtxSize = options.contextWindow || 4096
      } else if (vramGB < 8) {
        calculatedBatchSize = 1024
        calculatedUbatchSize = 512
        calculatedCtxSize = options.contextWindow || 4096
      } else {
        calculatedBatchSize = 2048
        calculatedUbatchSize = 512
        calculatedCtxSize = options.contextWindow || 8192
      }
    }

    // 显式选项覆盖优先级最高
    const finalGpuLayers = isCpuMode
      ? 0
      : options.gpuLayers !== undefined
        ? options.gpuLayers
        : calculatedGpuLayers

    const finalBatchSize = isCpuMode
      ? Math.min(options.batchSize ?? 128, 128)
      : options.batchSize !== undefined
        ? options.batchSize
        : calculatedBatchSize

    // 核心安全断言约束：ubatch-size 严禁大于 batch-size！
    const finalUbatchSize = Math.min(
      options.ubatchSize !== undefined ? options.ubatchSize : calculatedUbatchSize,
      finalBatchSize
    )

    const finalContextSize =
      options.contextWindow !== undefined ? options.contextWindow : calculatedCtxSize

    // 5. Flash Attention 判定 (非 CPU + 非 Vulkan + 硬件支持)
    const isFlashAttentionSupported =
      backend === 'cuda' && (hardware.gpuVendor === 'nvidia' || isAppleSilicon)
    const isFlashAttentionEnabled = !isCpuMode && backend !== 'vulkan' && isFlashAttentionSupported

    // 6. DSpark 投机采样配对与草稿模型
    if (modelConfig?.dspark && paths.draftFile) {
      const draftCmdPath = resolveModelArgForCmd(paths.draftFile, modelBaseDir, finalSource)
      draftArg = [
        '--model-draft',
        draftCmdPath,
        '--spec-type',
        'draft-dspark',
        '--spec-draft-n-max',
        '5',
        '--spec-draft-n-min',
        '0'
      ]
      if (!isCpuMode && finalGpuLayers > 0) {
        draftArg.push('--gpu-layers-draft', String(finalGpuLayers))
      }
    } else if (modelConfig?.draftId && paths.draftFile) {
      const draftCmdPath = resolveModelArgForCmd(paths.draftFile, modelBaseDir, finalSource)
      draftArg = [
        '--model-draft',
        draftCmdPath,
        '--spec-type',
        'draft-mtp',
        '--spec-draft-n-max',
        '3'
      ]
    }

    // 7. CPU 留核调度保护 (保留至少 2 核给操作系统与前台 UI)
    let safeThreads = 4
    try {
      const physicalCores = hardware.cpuCores || Math.max(1, Math.floor(os.cpus().length / 2))
      safeThreads = Math.max(2, Math.min(8, physicalCores - 2))
    } catch {
      safeThreads = 4
    }
    const finalThreads = options.threads !== undefined ? options.threads : safeThreads

    // 8. 思考模式 (enableThinking) 与推理抑制参数
    const enableThinking = !!options.enableThinking
    const isLlamafile = (options.binaryPath || '').toLowerCase().includes('llamafile')
    const lowerModelId = options.modelId.toLowerCase()
    const lowerModelPath = (options.modelPath || '').toLowerCase()
    const isMiniCPM5 = lowerModelId.includes('minicpm5') || lowerModelPath.includes('minicpm5')
    const isNanbeige4 = lowerModelId.includes('nanbeige4') || lowerModelPath.includes('nanbeige4')

    const reasoningArgs: string[] = []
    let templateArg: string[] = []

    if (!enableThinking) {
      // 思考模式关闭：强制添加推理抑制参数
      reasoningArgs.push(
        '--reasoning', 'off',
        '--reasoning-format', 'none',
        '--reasoning-budget', '0'
      )

      if (isLlamafile) {
        reasoningArgs.push('--nothink')
      }

      // --chat-template 模板选择与参数设置
      if (isMiniCPM5) {
        // MiniCPM5-1B 在关闭思考模式时采用 chatml 且降低 temp
        reasoningArgs.push('--temp', '0.7', '--top-p', '0.95')
        templateArg = ['--chat-template', 'chatml']
      } else if (isNanbeige4) {
        // Nanbeige4 专用 Chat Template: 末尾不硬编码 assistant 前缀，由 llama-server 动态生成
        // 彻底解决 GBNF Sampler 与 json_schema 严格输出约束时的 Unexpected empty grammar stack 冲突
        templateArg = [
          '--chat-template',
          "{% for message in messages %}{{'<|im_start|>' + message['role'] + '\\n' + message['content'] + '<|im_end|>\\n'}}{% endfor %}"
        ]
      } else {
        // 默认通用 Jinja 模板（关闭思考时）
        templateArg = [
          '--chat-template',
          "{% for message in messages %}{{'<|im_start|>' + message['role'] + '\\n' + message['content'] + '<|im_end|>\\n'}}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant\\n' }}{% endif %}"
        ]
      }
    } else {
      // 思考模式启用：注入推荐的高发散思考参数
      reasoningArgs.push(
        '--reasoning-budget', '1024',
        '--temp', '0.9',
        '--top-p', '0.95'
      )
    }

    // 9. 组装标准基础参数序列
    const baseArgs: string[] = [
      '--host',
      '127.0.0.1',
      ...modelArg,
      ...projectorArg,
      ...draftArg,
      '--port',
      String(options.port || 38400),
      '--ctx-size',
      String(finalContextSize),
      '--alias',
      options.modelId,
      '--jinja',
      '--no-context-shift',
      '--load-mode',
      'auto',
      '--repeat-penalty',
      '1.1',
      '--parallel',
      '1',
      ...reasoningArgs,
      ...templateArg
    ]

    // Flash Attention 参数注入
    if (isFlashAttentionEnabled) {
      baseArgs.push('-fa', 'auto')
    } else {
      baseArgs.push('-fa', 'off')
    }

    // 生产环境开启详细日志，便于排查用户侧的崩溃问题
    const isProduction =
      options.isProduction ??
      (typeof process !== 'undefined' &&
        (process.env?.NODE_ENV === 'production' || !!(process as any).env?.APP_PACKAGED))
    if (isProduction) {
      baseArgs.push('--verbose')
    }

    // Linux 平台特定 NUMA 优化
    if (process.platform === 'linux' && options.enableNUMA) {
      baseArgs.push('--numa', 'isolate')
    }

    // GPU 卸载参数注入
    if (isCpuMode || finalGpuLayers === 0) {
      baseArgs.push('--device', 'none')
      baseArgs.push('--n-gpu-layers', '0')
    } else {
      baseArgs.push('--n-gpu-layers', String(finalGpuLayers))
    }

    // 批大小与线程数
    baseArgs.push('--batch-size', String(finalBatchSize))
    baseArgs.push('--ubatch-size', String(finalUbatchSize))
    baseArgs.push('-t', String(finalThreads))

    // 10. 额外参数 (extraArgs) 去重与合并逻辑 (支持 --flag 及 --flag value 形式)
    const extraArgs = options.extraArgs || []
    const finalArgs: string[] = []

    // 辅助检查 extraArgs 中是否含有某 flag
    const hasInExtra = (flag: string) =>
      extraArgs.some(arg => arg === flag || arg.startsWith(`${flag}=`))

    // 遍历 baseArgs，如果 extraArgs 中显式覆盖了该 flag，则跳过 baseArgs 中的这一项
    for (let i = 0; i < baseArgs.length; i++) {
      const current = baseArgs[i]
      if (current.startsWith('-')) {
        const flagName = current.split('=')[0]
        if (hasInExtra(flagName)) {
          // 如果下一个参数不是以 '-' 开头，说明是当前 flag 的值，一并跳过
          if (i + 1 < baseArgs.length && !baseArgs[i + 1].startsWith('-')) {
            i++
          }
          continue
        }
      }
      finalArgs.push(current)
    }
    // 将 extraArgs 追加到最后
    finalArgs.push(...extraArgs)

    // 11. 跨平台标准化环境变量构建
    const engineDir = options.binaryPath ? toShortPathOnWindows(options.binaryPath.replace(/[^\\/]+$/, '')) : ''
    const env: Record<string, string> = {
      LLAMA_CACHE: toShortPathOnWindows(modelBaseDir),
      CUDA_VISIBLE_DEVICES: '0',
      OMP_NUM_THREADS: String(finalThreads),
      PYTHONIOENCODING: 'utf-8',
      LANG: 'en_US.UTF-8',
      PYTHONUNBUFFERED: '1'
    }

    if (process.platform === 'win32') {
      env.WER_DONT_SHOW_UI = '1' // 抑制 Windows 错误报告挂起与弹窗
      if (engineDir) {
        env.Path = `${engineDir};${process.env?.Path || process.env?.PATH || ''}`
      }
    } else if (process.platform === 'linux') {
      if (engineDir) {
        env.LD_LIBRARY_PATH = `${engineDir}:${process.env?.LD_LIBRARY_PATH || ''}`
      }
      env.MKL_NUM_THREADS = String(finalThreads)
    } else if (process.platform === 'darwin') {
      env.VECLIB_MAXIMUM_THREADS = String(finalThreads)
    }

    const filteredArgs = finalArgs.filter(Boolean)
    const fullCommandLine = `"${binaryPath}" ${filteredArgs.join(' ')}`

    return {
      command: binaryPath,
      args: filteredArgs,
      env,
      calculatedGpuLayers: finalGpuLayers,
      calculatedBatchSize: finalBatchSize,
      calculatedUbatchSize: finalUbatchSize,
      calculatedThreads: finalThreads,
      isCpuMode,
      isFlashAttentionEnabled,
      fullCommandLine
    }
  }
}
