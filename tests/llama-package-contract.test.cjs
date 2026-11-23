const test = require('node:test')
const assert = require('node:assert/strict')
const {
  isTargetOfficialAsset,
  detectUnsupportedCudaMajors,
  buildMirrorReport,
  expectedManifestKeys,
  assertManifestComplete,
  PACKAGE_FLAVOR_ALIASES
} = require('../scripts/llama-package-contract.cjs')

const B12345_ASSETS = [
  'cudart-llama-bin-win-cuda-12.4-x64.zip',
  'cudart-llama-bin-win-cuda-13.5-x64.zip',
  'llama-b12345-bin-win-cpu-avx-x64.zip',
  'llama-b12345-bin-win-cpu-x64.zip',
  'llama-b12345-bin-win-cuda-12.4-x64.zip',
  'llama-b12345-bin-win-cuda-13.5-x64.zip',
  'llama-b12345-bin-win-hip-x64.zip',
  'llama-b12345-bin-win-rocm-10.0-x64.zip',
  'llama-b12345-bin-win-sycl-x64.zip',
  'llama-b12345-bin-win-vulkan-x64.zip',
  'llama-b12345-bin-macos-arm64.tar.gz',
  'llama-b12345-bin-macos-x64.tar.gz'
]

const FULL_PACKAGES = {
  cuda13: { file: 'llama-13.5.zip' },
  cuda134: { file: 'llama-13.5.zip' },
  'cudart-cuda13': { file: 'cudart-13.5.zip' },
  'cudart-cuda134': { file: 'cudart-13.5.zip' },
  cuda12: { file: 'llama-12.4.zip' },
  cuda124: { file: 'llama-12.4.zip' },
  'cudart-cuda12': { file: 'cudart-12.4.zip' },
  'cudart-cuda124': { file: 'cudart-12.4.zip' },
  cpu: { file: 'llama-cpu.zip' },
  vulkan: { file: 'llama-vulkan.zip' },
  'metal-arm64': { file: 'llama-macos-arm64.tar.gz' },
  'metal-x64': { file: 'llama-macos-x64.tar.gz' },
  'cpu-avx': { file: 'llama-cpu-avx.zip' },
  'cpu-noavx': { file: 'llama-cpu-noavx.zip' },
  'vulkan-compat': { file: 'llama-vulkan-compat.zip' },
  sycl: { file: 'llama-sycl.zip' },
  rocm: { file: 'llama-rocm.zip' }
}

test('isTargetOfficialAsset: 按家族/平台匹配，不依赖具体 CUDA 小版本', () => {
  assert.equal(isTargetOfficialAsset('llama-b12345-bin-win-cuda-13.5-x64.zip'), true)
  assert.equal(isTargetOfficialAsset('cudart-llama-bin-win-cuda-13.5-x64.zip'), true)
  assert.equal(isTargetOfficialAsset('llama-b12345-bin-win-cuda-12.4-x64.zip'), true)
  assert.equal(isTargetOfficialAsset('llama-b12345-bin-win-vulkan-x64.zip'), true)
  assert.equal(isTargetOfficialAsset('llama-b12345-bin-macos-arm64.tar.gz'), true)
  assert.equal(isTargetOfficialAsset('llama-b12345-bin-macos-x64.tar.gz'), true)
  // Linux 不在镜像范围
  assert.equal(isTargetOfficialAsset('llama-b12345-bin-ubuntu-x64.zip'), false)
})

test('detectUnsupportedCudaMajors: 上游出现未支持的大版本必须被识别（硬闸）', () => {
  assert.deepEqual(detectUnsupportedCudaMajors(B12345_ASSETS), [])
  assert.deepEqual(detectUnsupportedCudaMajors(['llama-b12345-bin-win-cuda-11.8-x64.zip']), [
    'llama-b12345-bin-win-cuda-11.8-x64.zip'
  ])
})

test('buildMirrorReport: 上游应有但未落地必须进入 missing', () => {
  const report = buildMirrorReport({
    tag: 'b12345',
    upstreamAssets: B12345_ASSETS,
    mirrored: B12345_ASSETS.filter(n => !n.includes('cuda-13.5'))
  })
  assert.deepEqual(report.missing, [
    'cudart-llama-bin-win-cuda-13.5-x64.zip',
    'llama-b12345-bin-win-cuda-13.5-x64.zip'
  ])
  assert.deepEqual(report.orphanCudaAssets, [])
  assert.deepEqual(report.unsupportedCudaMajors, [])
})

test('buildMirrorReport: CUDA 主包缺 cudart 必须被识别为不成对', () => {
  const withoutCudart135 = B12345_ASSETS.filter(n => !n.includes('cudart') || !n.includes('13.5'))
  const report = buildMirrorReport({
    tag: 'b12345',
    upstreamAssets: withoutCudart135,
    mirrored: withoutCudart135
  })
  assert.equal(report.missing.length, 0)
  assert.deepEqual(report.orphanCudaAssets, ['cuda-13.5 主包存在但缺少对应 cudart 运行库'])
})

test('expectedManifestKeys: 每个 CUDA 家族同时要求家族键与老键', () => {
  const keys = expectedManifestKeys([
    'llama-b12345-bin-win-cuda-13.5-x64.zip',
    'cudart-llama-bin-win-cuda-13.5-x64.zip',
    'llama-b12345-bin-win-cpu-x64.zip'
  ])
  // 家族键 + 老客户端兼容键都要登记
  assert.deepEqual(
    keys.sort(),
    ['cpu', 'cuda13', 'cuda134', 'cudart-cuda13', 'cudart-cuda134'].sort()
  )
  assert.equal(PACKAGE_FLAVOR_ALIASES.cuda13, 'cuda134')
})

test('assertManifestComplete: 齐全时零错误，缺 CUDA 13 家族键时必须报错', () => {
  assert.deepEqual(assertManifestComplete(FULL_PACKAGES), [])

  const missingCuda13 = { ...FULL_PACKAGES }
  delete missingCuda13.cuda13
  delete missingCuda13.cuda134
  const errors = assertManifestComplete(missingCuda13)
  assert.ok(
    errors.some(e => e.includes('cuda13')),
    errors.join(' | ')
  )

  const missingCompat = { ...FULL_PACKAGES }
  delete missingCompat['vulkan-compat']
  assert.ok(
    assertManifestComplete(missingCompat).some(e => e.includes('vulkan-compat')),
    '缺兼容增补包应报错'
  )
})

test('assertManifestComplete: 镜像报告 missing/未支持大版本必须阻断发布', () => {
  const report = buildMirrorReport({
    tag: 'b12345',
    upstreamAssets: B12345_ASSETS,
    mirrored: B12345_ASSETS.filter(n => !n.includes('cuda-13.5'))
  })
  const errors = assertManifestComplete(FULL_PACKAGES, { report })
  assert.ok(
    errors.some(e => e.includes('未镜像')),
    errors.join(' | ')
  )

  const badReport = {
    tag: 'b12345',
    expected: [],
    missing: [],
    orphanCudaAssets: [],
    unsupportedCudaMajors: ['llama-b12345-bin-win-cuda-14.0-x64.zip']
  }
  assert.ok(
    assertManifestComplete(FULL_PACKAGES, { report: badReport }).some(e => e.includes('14.0'))
  )
})
