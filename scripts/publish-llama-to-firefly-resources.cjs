'use strict'

/**
 * 将 llama.cpp 兼容构建与官方镜像资产发布至统一资源中心 (firefly-resources)
 *
 * 职责：
 * 1. 扫描构建构件目录 (dist/all 或指定目录)
 * 2. 组装 llama-cpp 统一资源 manifest
 * 3. 调用 firefly-resources/publish-resources.js 双端发布 (GitHub Release + Cloudflare R2)
 * 4. 提交并推送 index.json
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const RESOURCE_ID = 'llama-cpp'

function log(msg) {
  console.log(`[llama-publish-unisource] ${msg}`)
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
    } else if (a === '--tag') {
      out.tag = argv[++i]
    } else if (a === '--dir') {
      out.dir = path.resolve(argv[++i])
    } else {
      rest.push(a)
    }
  }
  return out
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const tag = opts.tag || process.env.LLAMA_TAG
  if (!tag) {
    throw new Error('必须通过 --tag 或环境变量 LLAMA_TAG 指定 llama.cpp release tag (如 b11160)')
  }

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

  const artifactsDir = opts.dir || path.resolve(process.cwd(), 'dist/all')
  if (!fs.existsSync(artifactsDir)) {
    throw new Error(`构件目录不存在: ${artifactsDir}`)
  }

  log(`🚀 开始处理 llama.cpp (${tag}) 统一资源中心发布...`)

  // 扫描目录下所有 zip / tar.gz 文件
  const allFiles = fs.readdirSync(artifactsDir)
  const assets = {}

  for (const file of allFiles) {
    const fullPath = path.join(artifactsDir, file)
    const lower = file.toLowerCase()
    if (!lower.endsWith('.zip') && !lower.endsWith('.tar.gz')) continue

    // 映射平台键
    if (
      lower.includes('win-cpu-x64') ||
      lower.includes('win-avx2-x64') ||
      (lower.includes('win-x64') &&
        !lower.includes('cuda') &&
        !lower.includes('vulkan') &&
        !lower.includes('sycl') &&
        !lower.includes('rocm') &&
        !lower.includes('compat') &&
        !lower.includes('noavx'))
    ) {
      assets['win32-x64'] = fullPath
    } else if (lower.includes('macos-arm64')) {
      assets['darwin-arm64'] = { path: fullPath, ext: 'tar.gz' }
    } else if (lower.includes('macos-x64')) {
      assets['darwin-x64'] = { path: fullPath, ext: 'tar.gz' }
    } else if (
      lower.includes('ubuntu-x64') ||
      (lower.includes('linux') &&
        lower.includes('x64') &&
        !lower.includes('arm64') &&
        !lower.includes('vulkan'))
    ) {
      assets['linux-x64'] = { path: fullPath, ext: 'tar.gz' }
    }
  }

  log(`✅ 匹配到核心主平台包: ${Object.keys(assets).join(', ')}`)

  // 组装 manifest
  const manifest = {
    schema: 1,
    purpose: `llama.cpp ${tag} 跨平台推理运行时资产`,
    resources: {
      [RESOURCE_ID]: {
        version: tag,
        ext: 'zip',
        assets
      }
    }
  }

  const manifestsDir = path.join(frDir, 'manifests')
  fs.mkdirSync(manifestsDir, { recursive: true })
  const manifestPath = path.join(manifestsDir, `llama-cpp-${tag}.json`)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  log(`📄 清单已生成: ${manifestPath}`)

  // 调用 publish-resources.js 发布核心平台包至 GitHub Release + R2
  const pubArgs = [publishCli, '--manifest', manifestPath]
  if (opts.dryRun) pubArgs.push('--dry-run')
  if (opts.force) pubArgs.push('--force')

  log(`🚀 正在调用统一中心发布管线...`)
  const pub = spawnSync(process.execPath, pubArgs, {
    stdio: 'inherit',
    env: process.env
  })

  if (pub.status !== 0) {
    throw new Error(`发布 llama-cpp 至统一资源中心失败 (exit code: ${pub.status})`)
  }

  // 除了主平台资产外，将长尾兼容包与扩展包（如 cpu-avx, cpu-noavx, vulkan-compat, cuda 等）
  // 也无遗漏直传至 firefly-resources Release 与 R2
  const r2 = require(path.join(frDir, 'lib/r2'))
  const defaultGh = require(path.join(frDir, 'lib/gh'))
  const r2Configured = r2.isConfigured()

  log(`📦 检查并补齐长尾硬件兼容包与镜像扩展包至 firefly-resources 与 R2...`)
  for (const file of allFiles) {
    const fullPath = path.join(artifactsDir, file)
    const lower = file.toLowerCase()
    if (!lower.endsWith('.zip') && !lower.endsWith('.tar.gz')) continue

    // 上传到 GitHub Release
    if (!opts.dryRun) {
      try {
        defaultGh.uploadAsset({
          repo: 'Leonard-Li777/firefly-resources',
          tag: 'resources',
          localPath: fullPath,
          name: file
        })
        log(`  ↑ [GitHub Release] 扩展资产: ${file}`)
      } catch (err) {
        log(`  • [GitHub Release] 扩展资产可能已存在或跳过: ${file}`)
      }

      // 上传到 R2 firefly-resources/
      if (r2Configured) {
        try {
          const res = await r2.uploadAsset({
            localPath: fullPath,
            name: file,
            targetPrefix: 'firefly-resources',
            force: opts.force
          })
          if (res.uploaded) {
            log(`  ☁️↑ [R2 firefly-resources] ${file}`)
          } else {
            log(`  ☁️• [R2] 已存在: ${file}`)
          }
        } catch (r2Err) {
          log(`  ☁️✗ [R2] 上传失败 ${file}: ${r2Err.message}`)
        }
      }
    }
  }

  // 提交并推送 index.json
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

  spawnSync('git', ['-C', frDir, 'add', 'index.json', 'sources/llama-cpp.json', 'manifests'], {
    stdio: 'inherit'
  })
  const status = spawnSync('git', ['-C', frDir, 'status', '--porcelain', '--', 'index.json'], {
    encoding: 'utf8'
  }).stdout.trim()

  if (status) {
    log(`📝 提交并推送 firefly-resources index.json...`)
    spawnSync('git', ['-C', frDir, 'commit', '-m', `ci: 登记 llama-cpp ${tag} 跨平台推理资产`], {
      stdio: 'inherit'
    })
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
