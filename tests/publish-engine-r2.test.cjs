const test = require('node:test')
const assert = require('node:assert/strict')
const {
  sortVersionsDesc,
  identifyPrunableVersions,
  inferPackageFlavor,
  buildManifest
} = require('../scripts/publish-engine-r2.cjs')

test('sortVersionsDesc: 准确按 bXXXX 构建编号及自然版本倒序排列并去重', () => {
  const versions = ['b11011', 'b11095', 'b11063', 'b11011', 'b999']
  const sorted = sortVersionsDesc(versions)
  assert.deepEqual(sorted, ['b11095', 'b11063', 'b11011', 'b999'])
})

test('identifyPrunableVersions: 超过保留数时准确挑出淘汰版本', () => {
  const allVersions = ['b11011', 'b11095', 'b11063']
  const result = identifyPrunableVersions(allVersions, 2)
  assert.deepEqual(result.activeVersions, ['b11095', 'b11063'])
  assert.deepEqual(result.prunableVersions, ['b11011'])
})

test('identifyPrunableVersions: 恰好2个或少于2个版本时不触发淘汰', () => {
  const twoVer = ['b11095', 'b11063']
  const resultTwo = identifyPrunableVersions(twoVer, 2)
  assert.deepEqual(resultTwo.activeVersions, ['b11095', 'b11063'])
  assert.deepEqual(resultTwo.prunableVersions, [])

  const oneVer = ['b11095']
  const resultOne = identifyPrunableVersions(oneVer, 2)
  assert.deepEqual(resultOne.activeVersions, ['b11095'])
  assert.deepEqual(resultOne.prunableVersions, [])
})

test('inferPackageFlavor: 准确推断所有增补包与官方包 Flavor', () => {
  assert.equal(inferPackageFlavor('llama-b11095-bin-win-vulkan-compat-x64.zip'), 'vulkan-compat')
  assert.equal(inferPackageFlavor('llama-b11095-bin-win-cpu-avx-x64.zip'), 'cpu-avx')
  assert.equal(inferPackageFlavor('llama-b11095-bin-win-cpu-noavx-x64.zip'), 'cpu-noavx')
  assert.equal(inferPackageFlavor('llama-b11095-bin-win-cuda-12.4-x64.zip'), 'cuda124')
  assert.equal(inferPackageFlavor('cudart-llama-bin-win-cuda-12.4-x64.zip'), 'cudart-cuda124')
  assert.equal(inferPackageFlavor('llama-b11095-bin-win-cuda-13.4-x64.zip'), 'cuda134')
  assert.equal(inferPackageFlavor('llama-b11095-bin-win-vulkan-x64.zip'), 'vulkan')
  assert.equal(inferPackageFlavor('llama-b11095-bin-win-sycl-x64.zip'), 'sycl')
  assert.equal(inferPackageFlavor('llama-b11095-bin-win-rocm-10.0-x64.zip'), 'rocm')
  assert.equal(inferPackageFlavor('llama-b11095-bin-win-cpu-x64.zip'), 'cpu')
  assert.equal(inferPackageFlavor('llama-b11095-bin-macos-arm64.tar.gz'), 'metal-arm64')
  assert.equal(inferPackageFlavor('llama-b11095-bin-macos-x64.tar.gz'), 'metal-x64')
})

test('buildManifest: 生成合规的 Manifest 清单结构', () => {
  const manifest = buildManifest('b11095', 'b11063', {
    b11095: { packages: { cpu: { file: 'foo.zip', sha256: 'abc' } } }
  })
  assert.equal(manifest.latestVersion, 'b11095')
  assert.equal(manifest.previousVersion, 'b11063')
  assert.ok(manifest.updatedAt)
  assert.equal(manifest.versions.b11095.packages.cpu.file, 'foo.zip')
})
