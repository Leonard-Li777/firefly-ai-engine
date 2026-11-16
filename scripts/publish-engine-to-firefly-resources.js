'use strict'

/**
 * Firefly AI Engine 发布至统一资源中心 (firefly-resources) 聚合脚本
 *
 * 职责：
 * 1. 扫描 build-ai-engine.yml 下载的多平台构建构件 (Windows, macOS, Linux)
 * 2. 规范化打包并按 naming.js 规则命名为标准资产：
 *    - firefly-ai-engine-v{version}-win32-x64.zip
 *    - firefly-ai-engine-v{version}-darwin-arm64.tar.gz
 *    - firefly-ai-engine-v{version}-darwin-x64.tar.gz
 *    - firefly-ai-engine-v{version}-linux-x64.tar.gz
 * 3. 组装 manifest 并调用 publish-resources.js 双端发布 (GitHub Release + Cloudflare R2)
 * 4. 提交并推送 index.json
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const RESOURCE_ID = 'firefly-ai-engine'

function log(msg) {
  console.log(`[engine-publish] ${msg}`)
}

function parseArgs(argv) {
  const out = { dryRun: false, force: false }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') {
      out.dryRun = true
    } else if (a === '--force' || a === '--overwrite') {
      out.force = true
    } else if (a === '--fr') {
      out.frDir = path.resolve(argv[++i])
    } else if (a === '--version') {
      out.version = argv[++i]
    } else {
      rest.push(a)
    }
  }
  out.distDir = rest[0] && path.resolve(rest[0])
  return out
}

function compressToArchive(srcDirOrFile, destArchive) {
  const isDir = fs.statSync(srcDirOrFile).isDirectory()
  const workDir = isDir ? srcDirOrFile : path.dirname(srcDirOrFile)
  const baseName = path.basename(srcDirOrFile)

  if (destArchive.endsWith('.zip')) {
    if (process.platform === 'win32') {
      const res = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Compress-Archive -Path '${srcDirOrFile}${isDir ? '/*' : ''}' -DestinationPath '${destArchive}' -Force`
        ],
        { stdio: 'pipe' }
      )
      if (res.status !== 0) {
        throw new Error(`Compress-Archive 失败: ${(res.stderr || '').toString().trim()}`)
      }
      return
    }
    const res = spawnSync('zip', ['-qr', destArchive, '.'], { cwd: workDir, stdio: 'pipe' })
    if (res.status !== 0) throw new Error(`zip 压缩失败: ${(res.stderr || '').toString().trim()}`)
    return
  }

  if (destArchive.endsWith('.tar.gz')) {
    const res = spawnSync('tar', ['-czf', destArchive, isDir ? '.' : baseName], {
      cwd: workDir,
      stdio: 'pipe'
    })
    if (res.status !== 0) throw new Error(`tar 压缩失败: ${(res.stderr || '').toString().trim()}`)
  }
}

function readEngineVersion() {
  const pkgPath = path.resolve(__dirname, '../package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      if (pkg.version) return pkg.version
    } catch (_) {}
  }
  return '1.0.0'
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const version = opts.version ? String(opts.version).replace(/^v/, 'v') : `v${readEngineVersion()}`
  const frDir =
    opts.frDir ||
    process.env.UNISOURCE_REPO_DIR ||
    path.resolve(__dirname, '../../firefly-resources')

  if (!fs.existsSync(frDir)) {
    throw new Error(`未找到 firefly-resources 目录: ${frDir}`)
  }

  const publishCli = path.join(frDir, 'publish-resources.js')
  if (!fs.existsSync(publishCli)) {
    throw new Error(`未找到发布工具: ${publishCli}`)
  }

  log(`🚀 开始处理 Firefly AI Engine (${version}) 聚合发布...`)

  const artifactsDir = opts.distDir || path.resolve(process.cwd(), 'dist/artifacts')
  const stagedDir = path.resolve(process.cwd(), 'dist/staged-packages')
  fs.mkdirSync(stagedDir, { recursive: true })

  const assets = {}

  // 1. 扫描与标准化归档
  // 查找 macOS aarch64
  const macArmDir = path.join(artifactsDir, 'firefly-ai-engine-aarch64-apple-darwin')
  if (fs.existsSync(macArmDir)) {
    const tarName = `firefly-ai-engine-${version}-darwin-arm64.tar.gz`
    const tarPath = path.join(stagedDir, tarName)
    log(`📦 正在打包 macOS arm64 -> ${tarName}`)
    compressToArchive(macArmDir, tarPath)
    assets['darwin-arm64'] = { path: tarPath, ext: 'tar.gz' }
  }

  // 查找 macOS x64
  const macX64Dir = path.join(artifactsDir, 'firefly-ai-engine-x86_64-apple-darwin')
  if (fs.existsSync(macX64Dir)) {
    const tarName = `firefly-ai-engine-${version}-darwin-x64.tar.gz`
    const tarPath = path.join(stagedDir, tarName)
    log(`📦 正在打包 macOS x64 -> ${tarName}`)
    compressToArchive(macX64Dir, tarPath)
    assets['darwin-x64'] = { path: tarPath, ext: 'tar.gz' }
  }

  // 查找 Windows x64
  const winDir = path.join(artifactsDir, 'firefly-ai-engine-windows-x64')
  if (fs.existsSync(winDir)) {
    const zipName = `firefly-ai-engine-${version}-win32-x64.zip`
    const zipPath = path.join(stagedDir, zipName)
    log(`📦 正在打包 Windows x64 -> ${zipName}`)
    compressToArchive(winDir, zipPath)
    assets['win32-x64'] = zipPath
  }

  // 查找 Linux x64
  const linuxDebDir = path.join(artifactsDir, 'firefly-ai-engine-linux-deb')
  if (fs.existsSync(linuxDebDir)) {
    const tarName = `firefly-ai-engine-${version}-linux-x64.tar.gz`
    const tarPath = path.join(stagedDir, tarName)
    log(`📦 正在打包 Linux x64 -> ${tarName}`)
    compressToArchive(linuxDebDir, tarPath)
    assets['linux-x64'] = { path: tarPath, ext: 'tar.gz' }
  }

  if (Object.keys(assets).length === 0) {
    log(`⚠️ 提示: 在 ${artifactsDir} 未扫描到构建构件，检查是否有单独文件传入...`)
    // 允许通过直接传入现成压缩包发布
    if (fs.existsSync(artifactsDir)) {
      const files = fs.readdirSync(artifactsDir)
      for (const f of files) {
        const full = path.join(artifactsDir, f)
        if (f.includes('win32-x64') || f.includes('windows-x64')) assets['win32-x64'] = full
        if (f.includes('darwin-arm64')) assets['darwin-arm64'] = { path: full, ext: 'tar.gz' }
        if (f.includes('darwin-x64')) assets['darwin-x64'] = { path: full, ext: 'tar.gz' }
        if (f.includes('linux-x64')) assets['linux-x64'] = { path: full, ext: 'tar.gz' }
      }
    }
  }

  if (Object.keys(assets).length === 0) {
    throw new Error(`未收集到任何平台的 ${RESOURCE_ID} 构件，发布中止`)
  }

  log(`✅ 收集到以下平台构件: ${Object.keys(assets).join(', ')}`)

  // 2. 组装 manifest
  const manifest = {
    schema: 1,
    purpose: `Firefly AI Engine ${version} 多平台矩阵发布`,
    resources: {
      [RESOURCE_ID]: {
        version,
        ext: 'zip',
        assets
      }
    }
  }

  const manifestsDir = path.join(frDir, 'manifests')
  fs.mkdirSync(manifestsDir, { recursive: true })
  const manifestPath = path.join(manifestsDir, `engine-${version}.json`)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  log(`📄 清单已生成: ${manifestPath}`)

  // 3. 执行发布 (publish-resources.js 双端发布)
  const pubArgs = [publishCli, '--manifest', manifestPath]
  if (opts.dryRun) pubArgs.push('--dry-run')
  if (opts.force) pubArgs.push('--force')

  log(`🚀 正在调用统一中心发布管线...`)
  const pub = spawnSync(process.execPath, pubArgs, {
    stdio: 'inherit',
    env: process.env
  })

  if (pub.status !== 0) {
    throw new Error(`发布至统一资源中心失败 (exit code: ${pub.status})`)
  }

  // 4. Git 提交并推送 index.json
  if (opts.dryRun) {
    log('🔍 [dry-run] 模式，跳过提交 index.json')
    return
  }

  const gitEmail = spawnSync('git', ['-C', frDir, 'config', 'user.email'], {
    encoding: 'utf8'
  }).stdout.trim()
  if (!gitEmail) {
    spawnSync('git', [
      '-C',
      frDir,
      'config',
      'user.email',
      'github-actions[bot]@users.noreply.github.com'
    ])
    spawnSync('git', ['-C', frDir, 'config', 'user.name', 'github-actions[bot]'])
  }

  spawnSync(
    'git',
    ['-C', frDir, 'add', 'index.json', 'sources/firefly-ai-engine.json', 'manifests'],
    {
      stdio: 'inherit'
    }
  )
  const status = spawnSync('git', ['-C', frDir, 'status', '--porcelain', '--', 'index.json'], {
    encoding: 'utf8'
  }).stdout.trim()

  if (status) {
    log(`📝 提交并推送 firefly-resources index.json...`)
    spawnSync(
      'git',
      ['-C', frDir, 'commit', '-m', `ci: 发布 ${RESOURCE_ID} ${version} 多平台构件`],
      { stdio: 'inherit' }
    )
    spawnSync('git', ['-C', frDir, 'push', 'origin', 'HEAD'], { stdio: 'inherit' })
    log(`🎉 统一资源中心索引更新推送完成！`)
  } else {
    log(`ℹ️ index.json 无变化，跳过提交`)
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(`❌ 执行失败: ${err.message}`)
    process.exit(1)
  })
}

module.exports = { main }
