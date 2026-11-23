/**
 * llama.cpp 发布包契约（单一事实源）
 *
 * 背景：以往「镜像 → 发布」两侧各自维护一份包名白名单，且发布脚本只登记 dist 里
 * 实际落到的文件。于是上游一换 CUDA 小版本（13.3 → 13.4 → 13.5），包就被过滤掉，
 * 清单被「如实但不完整」地重写，客户端读不到键 → 只能回落到硬编码常量。
 *
 * 契约解决三件事：
 * 1. 选择规则按「家族 / 平台」判定，不再枚举具体小版本号；
 * 2. 明确「必须存在的档位」（MANDATORY_FLAVORS），缺一个就不许发布；
 * 3. 提供上游资产清单与本地落地清单的差集（buildMirrorReport），
 *    让「缺包」在流水线里成为红灯，而不是变成一份少了键的清单。
 */

const CUDA_ASSET_RE = /cuda-(\d+)\.(\d+)/i
/** 引擎读侧支持的 CUDA 大版本（新增大版本必须先扩引擎读侧，故此处硬闸拦截） */
const SUPPORTED_CUDA_MAJORS = [12, 13]

/** 清单里必须存在的档位键（引擎下载/体积展示依赖） */
const MANDATORY_FLAVORS = [
  'cuda13',
  'cudart-cuda13',
  'cuda12',
  'cudart-cuda12',
  'cpu',
  'vulkan',
  'metal-arm64',
  'metal-x64'
]

/** 兼容增补包（由 build-llama-compat.yml 的矩阵构建，缺一即为矩阵与发布脱节） */
const MANDATORY_COMPAT_FLAVORS = ['cpu-avx', 'cpu-noavx', 'vulkan-compat']

/** 可选档位：上游是否产出由上游决定，缺失不算发布失败 */
const OPTIONAL_FLAVORS = ['sycl', 'rocm']

/**
 * 根据包名推断 Flavor 标识
 *
 * CUDA 小版本会随官方 Toolkit 升级前进（13.3 → 13.4 → 13.5…），因此这里按「家族」归一，
 * 不允许再枚举具体小版本：13.x 统一落到 `cuda134` / `cudart-cuda134`（对老客户端保持键名兼容），
 * 12.x 统一落到 `cuda124` / `cudart-cuda124`。
 */
function inferPackageFlavor(filename) {
  const lower = filename.toLowerCase()
  if (lower.includes('vulkan-compat')) return 'vulkan-compat'
  if (lower.includes('cpu-avx-x64')) return 'cpu-avx'
  if (lower.includes('cpu-noavx-x64')) return 'cpu-noavx'
  if (CUDA_ASSET_RE.test(lower)) {
    const major = Number(lower.match(CUDA_ASSET_RE)[1])
    const family = `cuda${major}`
    return lower.includes('cudart') ? `cudart-${family}` : family
  }
  if (lower.includes('vulkan')) return 'vulkan'
  if (lower.includes('sycl')) return 'sycl'
  if (lower.includes('rocm')) return 'rocm'
  if (lower.includes('cpu') || lower.includes('avx2') || lower.endsWith('-bin-win-x64.zip'))
    return 'cpu'
  if (lower.includes('macos-arm64')) return 'metal-arm64'
  if (lower.includes('macos-x64')) return 'metal-x64'
  return filename.replace(/\.(zip|tar\.gz)$/i, '')
}

/**
 * Flavor 家族别名：读侧（引擎体积解析）按 `cuda13` / `cudart-cuda13` 家族前缀消费，
 * 写侧同时登记具体键与家族键，两边都不再依赖某一具体 CUDA 小版本。
 *
 * 说明：inferPackageFlavor 已按大版本归一到 cuda12/cuda13，这里保留别名表是为了
 * 兼容早期以 `cuda124`/`cuda134` 为具体小版本的读侧实现与历史清单。
 */
const PACKAGE_FLAVOR_ALIASES = {
  cuda12: 'cuda124',
  cuda13: 'cuda134',
  'cudart-cuda12': 'cudart-cuda124',
  'cudart-cuda13': 'cudart-cuda134'
}

/** 判断该官方资产是否属于我们要镜像的档位（只看平台/架构/类型，不枚举版本号） */
function isTargetOfficialAsset(name) {
  const lower = String(name).toLowerCase()
  if (lower.includes('win') && lower.includes('x64')) {
    if (CUDA_ASSET_RE.test(lower)) return true
    if (lower.includes('vulkan')) return true
    if (lower.includes('sycl')) return true
    if (lower.includes('rocm')) return true
    if (lower.includes('cpu') || lower.includes('avx2') || lower.endsWith('-bin-win-x64.zip'))
      return true
  }
  if (lower.includes('macos') && (lower.includes('arm64') || lower.includes('x64'))) return true
  return false
}

/** 上游出现引擎尚未支持的 CUDA 大版本时返回包名列表（硬闸，不允许静默忽略） */
function detectUnsupportedCudaMajors(assetNames) {
  const hits = []
  for (const name of assetNames) {
    const m = String(name).match(CUDA_ASSET_RE)
    if (!m) continue
    if (!SUPPORTED_CUDA_MAJORS.includes(Number(m[1]))) hits.push(name)
  }
  return hits
}

/** 主包与 cudart 运行库必须成对：13.x 引擎配 12.4 运行库是历史事故，这里做结构性拦截 */
function findOrphanCudaAssets(expectedNames) {
  const byCuda = new Map()
  for (const name of expectedNames) {
    const m = String(name).match(CUDA_ASSET_RE)
    if (!m) continue
    const key = `${m[1]}.${m[2]}`
    const slot = byCuda.get(key) || { main: false, cudart: false }
    if (String(name).toLowerCase().includes('cudart')) slot.cudart = true
    else slot.main = true
    byCuda.set(key, slot)
  }
  const orphans = []
  for (const [cuda, slot] of byCuda.entries()) {
    if (slot.main && !slot.cudart) orphans.push(`cuda-${cuda} 主包存在但缺少对应 cudart 运行库`)
    if (slot.cudart && !slot.main) orphans.push(`cuda-${cuda} cudart 运行库存在但缺少主包`)
  }
  return orphans
}

/** 从上游资产名列表算出本次「应当落地」的包名列表 */
function listExpectedAssets(assetNames) {
  return assetNames.filter(isTargetOfficialAsset)
}

/**
 * 生成镜像报告：上游应有 vs 本地实际落地的差集。
 * 该报告由 sync 阶段写出、publish 阶段读取，是「缺包必须红灯」的唯一事实来源。
 */
function buildMirrorReport({ tag, upstreamAssets, mirrored }) {
  const expected = listExpectedAssets(upstreamAssets)
  const mirroredList = Array.from(mirrored || [])
  const mirroredSet = new Set(mirroredList)
  const missing = expected.filter(name => !mirroredSet.has(name))
  const unsupportedCudaMajors = detectUnsupportedCudaMajors(upstreamAssets)
  const orphanCudaAssets = findOrphanCudaAssets(expected)

  return {
    tag,
    generatedAt: new Date().toISOString(),
    upstreamAssets,
    expected,
    mirrored: mirroredList,
    /** 上游应有但本地未落地的包（含 cudart 缺失） */
    missing,
    /** 上游出现的、引擎尚未支持的 CUDA 大版本资产 */
    unsupportedCudaMajors,
    /** CUDA 主包 / cudart 运行库缺对 */
    orphanCudaAssets
  }
}

/** 报告里的 expected 资产，应在清单里登记成哪些键（含家族别名） */
function expectedManifestKeys(expectedAssets) {
  const keys = new Set()
  for (const name of expectedAssets || []) {
    const flavor = inferPackageFlavor(name)
    keys.add(flavor)
    const alias = PACKAGE_FLAVOR_ALIASES[flavor]
    if (alias) keys.add(alias)
  }
  return Array.from(keys)
}

/**
 * 发布前的硬闸：返回错误列表（空数组表示通过）。
 * 只要非空就绝不允许写 manifest.json —— 宁可这版不发，也不发一份「少了键」的清单。
 */
function assertManifestComplete(packages, { report, requireCompat = true } = {}) {
  const errors = []
  const keys = new Set(Object.keys(packages || {}))

  for (const flavor of MANDATORY_FLAVORS) {
    if (!keys.has(flavor)) errors.push(`清单缺少必需档位键: ${flavor}`)
  }
  if (requireCompat) {
    for (const flavor of MANDATORY_COMPAT_FLAVORS) {
      if (!keys.has(flavor)) errors.push(`清单缺少兼容增补包键: ${flavor}`)
    }
  }

  if (report) {
    if (report.unsupportedCudaMajors && report.unsupportedCudaMajors.length > 0) {
      errors.push(
        `上游出现引擎尚未支持的 CUDA 大版本: ${report.unsupportedCudaMajors.join(', ')}（需先扩展引擎读侧契约）`
      )
    }
    if (report.missing && report.missing.length > 0) {
      errors.push(`上游应有但未镜像的资产: ${report.missing.join(', ')}`)
    }
    if (report.orphanCudaAssets && report.orphanCudaAssets.length > 0) {
      errors.push(`CUDA 主包与 cudart 未成对: ${report.orphanCudaAssets.join('; ')}`)
    }
    if (report.tag) {
      for (const key of expectedManifestKeys(report.expected)) {
        if (!keys.has(key)) errors.push(`镜像报告声明的键 ${key} 未出现在清单中`)
      }
    }
  }

  return errors
}

module.exports = {
  CUDA_ASSET_RE,
  SUPPORTED_CUDA_MAJORS,
  MANDATORY_FLAVORS,
  MANDATORY_COMPAT_FLAVORS,
  OPTIONAL_FLAVORS,
  PACKAGE_FLAVOR_ALIASES,
  inferPackageFlavor,
  isTargetOfficialAsset,
  listExpectedAssets,
  detectUnsupportedCudaMajors,
  findOrphanCudaAssets,
  buildMirrorReport,
  expectedManifestKeys,
  assertManifestComplete
}
