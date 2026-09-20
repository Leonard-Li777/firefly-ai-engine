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

    // 8. 组装标准参数序列
    const args: string[] = [
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
      '1'
    ]

    // Flash Attention 参数注入
    if (isFlashAttentionEnabled) {
      args.push('-fa', 'auto')
    } else {
      args.push('-fa', 'off')
    }

    // GPU 卸载参数注入
    if (isCpuMode || finalGpuLayers === 0) {
      args.push('--device', 'none')
      args.push('--n-gpu-layers', '0')
    } else {
      args.push('--n-gpu-layers', String(finalGpuLayers))
    }

    // 批大小与线程数
    args.push('--batch-size', String(finalBatchSize))
    args.push('--ubatch-size', String(finalUbatchSize))
    args.push('-t', String(finalThreads))

    // 9. 环境变量准备 (注入短路径 LLAMA_CACHE)
    const env: Record<string, string> = {
      LLAMA_CACHE: toShortPathOnWindows(modelBaseDir)
    }

    return {
      command: binaryPath,
      args: args.filter(Boolean),
      env,
      calculatedGpuLayers: finalGpuLayers,
      calculatedBatchSize: finalBatchSize,
      calculatedUbatchSize: finalUbatchSize,
      calculatedThreads: finalThreads,
      isCpuMode,
      isFlashAttentionEnabled
    }
  }
}
