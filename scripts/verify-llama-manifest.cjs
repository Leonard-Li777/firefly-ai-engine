/**
 * 发布后自检：核对线上 llama-cpp/manifest.json 与本地产物 / 镜像报告是否一致
 *
 * 背景：以往「发布成功」= 脚本没抛异常，但 manifest 是「dist 里有什么就登记什么」，
 * 缺包时依然会「成功」。本脚本把发布完成度定义成可验证的事实：
 *
 *   1. 线上 latestVersion 必须等于本次 tag；
 *   2. 契约里的必需档位键必须齐全；
 *   3. 镜像报告声明的每个键必须存在；
 *   4. 每个键登记的 file / size 必须与 dist 里的同名实际文件字节数逐一对齐。
 *
 * 用法：
 *   node scripts/verify-llama-manifest.cjs --tag b12345 --dir dist/all \
 *     [--report dist/all/_mirror-report.json] [--url https://download.iocn.cn/llama-cpp/manifest.json]
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const { createProxyAgent, detectProxy } = require('./utils/proxy-utils.cjs')
const {
  inferPackageFlavor,
  PACKAGE_FLAVOR_ALIASES,
  assertManifestComplete,
  expectedManifestKeys
} = require('./llama-package-contract.cjs')

const MANIFEST_URL =
  process.env.LLAMA_MANIFEST_URL || 'https://download.iocn.cn/llama-cpp/manifest.json'

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`)
}

function parseArgs() {
  const args = process.argv.slice(2)
  const out = {
    tag: '',
    // 不传 --dir 时只校验清单契约本身（供流水线的幂等闸复用），传了才核对本地产物字节数
    dir: '',
    report: '',
    url: MANIFEST_URL
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tag' && args[i + 1]) out.tag = args[++i]
    else if (args[i] === '--dir' && args[i + 1]) out.dir = path.resolve(process.cwd(), args[++i])
    else if (args[i] === '--report' && args[i + 1])
      out.report = path.resolve(process.cwd(), args[++i])
    else if (args[i] === '--url' && args[i + 1]) out.url = args[++i]
  }
  return out
}

function httpsGetJson(url, redirectLeft = 3) {
  return new Promise((resolve, reject) => {
    const agent = createProxyAgent(detectProxy())
    https
      .get(
        url,
        {
          agent,
          headers: { 'User-Agent': 'firefly-llama-verify/1.0', Accept: 'application/json' }
        },
        res => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location &&
            redirectLeft > 0
          ) {
            return httpsGetJson(res.headers.location, redirectLeft - 1).then(resolve, reject)
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
              reject(new Error(`响应不是合法 JSON: ${e.message}`))
            }
          })
        }
      )
      .on('error', reject)
  })
}

function collectLocalPackages(dir) {
  const packages = {}
  if (!fs.existsSync(dir)) return packages
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (!fs.statSync(full).isFile()) continue
    if (!entry.endsWith('.zip') && !entry.endsWith('.tar.gz')) continue
    const flavor = inferPackageFlavor(entry)
    const record = { file: entry, size: fs.statSync(full).size }
    packages[flavor] = record
    const alias = PACKAGE_FLAVOR_ALIASES[flavor]
    if (alias) packages[alias] = record
  }
  return packages
}

async function run() {
  const { tag, dir, report: reportPath, url } = parseArgs()
  if (!tag) throw new Error('必须通过 --tag 指定本次发布版本号')

  const cacheBuster = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
  log(`拉取线上清单: ${cacheBuster}`)
  const manifest = await httpsGetJson(cacheBuster)

  const errors = []
  if (manifest.latestVersion !== tag) {
    errors.push(
      `线上 latestVersion=${manifest.latestVersion} 与本次发布 ${tag} 不一致（清单未更新？）`
    )
  }

  const packages =
    (manifest.versions && manifest.versions[tag] && manifest.versions[tag].packages) || {}
  if (Object.keys(packages).length === 0) {
    throw new Error(`线上清单中不存在版本 ${tag} 的 packages 节点`)
  }

  let mirrorReport = null
  if (reportPath) {
    if (!fs.existsSync(reportPath)) throw new Error(`镜像报告不存在: ${reportPath}`)
    mirrorReport = JSON.parse(fs.readFileSync(reportPath, 'utf-8'))
  }

  errors.push(...assertManifestComplete(packages, { report: mirrorReport }))

  // 传 --dir 才做「清单体积 = 本地产物字节」核对；不传则只校验清单契约本身（供流水线幂等闸复用）
  const localPackages = dir ? collectLocalPackages(dir) : {}
  if (dir && !fs.existsSync(dir)) {
    errors.push(`产物目录不存在: ${dir}`)
  }
  for (const [key, expected] of Object.entries(localPackages)) {
    const entry = packages[key]
    if (!entry) {
      errors.push(`本地存在 ${expected.file}，但线上清单缺少键 ${key}`)
      continue
    }
    if (entry.file !== expected.file) {
      errors.push(`键 ${key} 登记文件 ${entry.file} 与本地实际 ${expected.file} 不一致`)
    }
    if (Number(entry.size) !== Number(expected.size)) {
      errors.push(
        `键 ${key} 登记体积 ${entry.size} 与本地实际 ${expected.size} 字节不一致（${entry.file}）`
      )
    }
  }

  if (mirrorReport) {
    for (const key of expectedManifestKeys(mirrorReport.expected)) {
      if (!packages[key]) errors.push(`镜像报告要求的键 ${key} 未出现在线上清单`)
    }
  }

  if (errors.length > 0) {
    for (const err of errors) console.error(`❌ ${err}`)
    throw new Error(`线上清单自检未通过（${errors.length} 项）`)
  }

  const cudaKeys = Object.keys(packages).filter(k => k.startsWith('cuda') || k.startsWith('cudart'))
  log(`✓ 线上清单自检通过：version=${tag}，档位键 ${Object.keys(packages).length} 个`)
  log(`  CUDA 相关键: ${cudaKeys.join(', ')}`)
  for (const key of cudaKeys) {
    log(`  - ${key}: ${packages[key].file} (${(packages[key].size / 1024 / 1024).toFixed(1)} MB)`)
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error('线上清单自检失败:', err.message)
    process.exit(1)
  })
}

module.exports = { collectLocalPackages }
