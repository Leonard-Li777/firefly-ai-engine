/**
 * 同步与镜像官方 llama.cpp Release 资产包
 *
 * 功能：
 * 1. 查询目标 Tag (默认最新) 的 GitHub Release 资产列表
 * 2. 匹配 Windows (CUDA 12/13, Vulkan, SYCL, ROCm, CPU) 与 macOS (Metal arm64/x64) 官方包
 * 3. 并行下载至 staging 目录并计算 SHA-256
 * 4. 产出 staged-assets.json 供下一阶段批量推送到 Cloudflare R2
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const crypto = require('crypto')
const { createProxyAgent, delay, isNetworkError, detectProxy } = require('./utils/proxy-utils.cjs')
const {
  isTargetOfficialAsset,
  buildMirrorReport,
  detectUnsupportedCudaMajors
} = require('./llama-package-contract.cjs')

const MAX_RETRIES = 3
const RETRY_DELAY = 3000

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`)
}

function parseArgs() {
  const args = process.argv.slice(2)
  let tag = process.env.LLAMA_TAG || ''
  let outDir = path.resolve(__dirname, '../dist/official')

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tag' && args[i + 1]) {
      tag = args[i + 1]
      i++
    } else if (args[i] === '--out' && args[i + 1]) {
      outDir = path.resolve(process.cwd(), args[i + 1])
      i++
    }
  }

  return { tag, outDir }
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const proxyUrl = detectProxy()
    const agent = createProxyAgent(proxyUrl)
    const options = {
      headers: {
        'User-Agent': 'firefly-llama-sync/1.0',
        Accept: 'application/vnd.github.v3+json',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
      },
      agent
    }

    https
      .get(url, options, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return httpsGetJson(res.headers.location).then(resolve).catch(reject)
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`请求 ${url} 失败: HTTP ${res.statusCode}`))
        }
        let raw = ''
        res.on('data', chunk => (raw += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

function downloadFile(url, destPath, retryCount = 0) {
  return new Promise((resolve, reject) => {
    const proxyUrl = detectProxy()
    const agent = createProxyAgent(proxyUrl)
    const options = {
      headers: {
        'User-Agent': 'firefly-llama-sync/1.0',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
      },
      agent
    }

    const tempPath = `${destPath}.tmp`
    const file = fs.createWriteStream(tempPath)
    const hash = crypto.createHash('sha256')

    const req = https.get(url, options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close()
        try {
          fs.unlinkSync(tempPath)
        } catch (_) {}
        return downloadFile(res.headers.location, destPath, retryCount).then(resolve).catch(reject)
      }

      if (res.statusCode !== 200) {
        file.close()
        try {
          fs.unlinkSync(tempPath)
        } catch (_) {}
        return reject(new Error(`下载失败: HTTP ${res.statusCode} from ${url}`))
      }

      res.on('data', chunk => {
        file.write(chunk)
        hash.update(chunk)
      })

      res.on('end', () => {
        file.end()
        fs.renameSync(tempPath, destPath)
        const sha256 = hash.digest('hex')
        resolve(sha256)
      })
    })

    req.on('error', async err => {
      file.close()
      try {
        fs.unlinkSync(tempPath)
      } catch (_) {}
      if (retryCount < MAX_RETRIES && isNetworkError(err)) {
        log(
          `[重试 ${retryCount + 1}/${MAX_RETRIES}] 下载 ${path.basename(destPath)} 失败: ${err.message}, 等待重试...`
        )
        await delay(RETRY_DELAY)
        return downloadFile(url, destPath, retryCount + 1)
          .then(resolve)
          .catch(reject)
      }
      reject(err)
    })
  })
}

// 目标包匹配器：统一走发布包契约（按家族/平台判定，不枚举 CUDA 小版本）

async function run() {
  const { tag: inputTag, outDir } = parseArgs()
  fs.mkdirSync(outDir, { recursive: true })

  let targetTag = inputTag
  if (!targetTag) {
    log('未指定 Tag，正在获取官方 llama.cpp 最新发布版本 (优先匹配 bXXXX)...')
    try {
      const releases = await httpsGetJson(
        'https://api.github.com/repos/ggml-org/llama.cpp/releases'
      )
      if (Array.isArray(releases)) {
        const buildRel = releases.find(r => /^b\d+$/i.test(r.tag_name))
        if (buildRel) {
          targetTag = buildRel.tag_name
        }
      }
    } catch (e) {
      log(`获取 releases 列表失败: ${e.message}，尝试 releases/latest 回退`)
    }
    if (!targetTag) {
      const latestRelease = await httpsGetJson(
        'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest'
      )
      targetTag = latestRelease.tag_name
    }
    log(`检测到官方最新版本: ${targetTag}`)
  }

  log(`正在获取 ${targetTag} 的资产清单...`)
  const releaseData = await httpsGetJson(
    `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${targetTag}`
  )
  const allAssets = releaseData.assets || []
  log(`官方 Release 共包含 ${allAssets.length} 个资产`)

  const matchedAssets = allAssets.filter(a => isTargetOfficialAsset(a.name))
  log(`匹配到 ${matchedAssets.length} 个核心架构资产:`)
  matchedAssets.forEach(a => console.log(`  - ${a.name} (${(a.size / 1024 / 1024).toFixed(1)} MB)`))

  if (matchedAssets.length === 0) {
    throw new Error(`在版本 ${targetTag} 中未找到任何符合条件的官方二进制资产！`)
  }

  // 上游出现契约尚未支持的 CUDA 大版本时，必须在下载前失败（否则会静默少一整个档位）
  const unsupportedCudaMajors = detectUnsupportedCudaMajors(allAssets.map(a => a.name))
  if (unsupportedCudaMajors.length > 0) {
    throw new Error(
      `上游版本 ${targetTag} 出现引擎尚未支持的 CUDA 大版本资产: ${unsupportedCudaMajors.join(', ')}。` +
        '请先扩展 scripts/llama-package-contract.cjs 与引擎读侧契约后再镜像。'
    )
  }

  const manifestEntries = []

  for (const asset of matchedAssets) {
    const destPath = path.join(outDir, asset.name)
    log(`正在下载: ${asset.name} ...`)
    const sha256 = await downloadFile(asset.browser_download_url, destPath)
    log(`✓ 完成: ${asset.name} (SHA256: ${sha256})`)

    manifestEntries.push({
      name: asset.name,
      size: fs.statSync(destPath).size,
      sha256,
      localPath: destPath
    })
  }

  const manifestPath = path.join(outDir, 'staged-assets.json')
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        tag: targetTag,
        updatedAt: new Date().toISOString(),
        assets: manifestEntries
      },
      null,
      2
    ),
    'utf-8'
  )

  // 镜像报告：上游应有 vs 本地落地 的差集，是发布阶段「缺包必须红灯」的唯一事实来源
  const mirrorReport = buildMirrorReport({
    tag: targetTag,
    upstreamAssets: allAssets.map(a => a.name),
    mirrored: manifestEntries.map(e => e.name)
  })
  const reportPath = path.join(outDir, '_mirror-report.json')
  fs.writeFileSync(reportPath, JSON.stringify(mirrorReport, null, 2), 'utf-8')

  log(`----------------------------------------`)
  log(`全量官方资产镜像完成！清单已输出至: ${manifestPath}`)
  log(`镜像报告已输出至: ${reportPath}`)

  if (mirrorReport.missing.length > 0 || mirrorReport.orphanCudaAssets.length > 0) {
    for (const name of mirrorReport.missing) console.error(`❌ 上游应有但未镜像: ${name}`)
    for (const msg of mirrorReport.orphanCudaAssets) console.error(`❌ ${msg}`)
    throw new Error('镜像完整性校验未通过：存在未落地的上游资产，拒绝进入发布阶段')
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error('执行同步出错:', err)
    process.exit(1)
  })
}

module.exports = { isTargetOfficialAsset }
