'use strict'

/**
 * firefly-ai-engine 依赖资源装配入口（已收归 ProductResourceAssembler）
 * apps/firefly-ai-engine/scripts/setup-extra-resources.cjs
 */

const fs = require('fs')
const path = require('path')

const ENGINE_ROOT = path.resolve(__dirname, '..')
const BASE_EXTRA_DIR = path.join(ENGINE_ROOT, 'build', 'extraResources')
const PRESET_DIR = path.join(ENGINE_ROOT, 'build', 'presetResources')
const LOCK_FILE = path.join(BASE_EXTRA_DIR, 'configs', 'preset-resources.lock.json')

function parseArgs(argv) {
  const args = { platform: process.platform, arch: process.arch, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--platform=')) args.platform = a.split('=')[1]
    else if (a === '--platform' && argv[i + 1]) args.platform = argv[++i]
    else if (a.startsWith('--arch=')) args.arch = a.split('=')[1]
    else if (a === '--arch' && argv[i + 1]) args.arch = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const assemblerPath = path.resolve(ENGINE_ROOT, '../firefly-resources/lib/product-assembler.js')
  if (!fs.existsSync(assemblerPath)) {
    throw new Error(`[engine-setup] 未找到统一产品装配器: ${assemblerPath}`)
  }
  const { assembleProduct } = require(assemblerPath)
  const platform = args.platform === 'darwin' ? 'darwin' : args.platform === 'win32' ? 'win32' : 'linux'
  const arch = args.arch === 'arm64' ? 'arm64' : 'x64'

  console.log(`🚀 [engine-setup] 通过 ProductResourceAssembler 装配 firefly-ai-engine [${platform}-${arch}]`)
  const result = await assembleProduct({
    product: 'engine',
    mode: 'release-locked',
    targetRoot: BASE_EXTRA_DIR,
    presetDir: PRESET_DIR,
    lockfilePath: fs.existsSync(LOCK_FILE) ? LOCK_FILE : undefined,
    platform,
    arch,
    dryRun: args.dryRun
  })
  console.log(
    `✅ [engine-setup] 装配完成 (skipped=${result.skipped.length}, cleaned=${Object.keys(result.cleanedExtraFiles).length})`
  )
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ [engine-setup] 装配失败:', err)
    process.exit(1)
  })
}

module.exports = { main }
