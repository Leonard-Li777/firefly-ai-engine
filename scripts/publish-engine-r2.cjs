/**
 * Cloudflare R2 AI 引擎发布与双版本轮转淘汰脚本 (基于 S3 兼容 API)
 *
 * 核心职责：
 * 1. 将自编译增补包与镜像的官方包批量上传至 R2 `llama-cpp/{tag}/` 路径
 * 2. 动态生成并上传 `llama-cpp/manifest.json`，声明当前最新与次新版本
 * 3. 严格执行「后清理原则」：扫描 `llama-cpp/` 目录，仅保留最新 2 个版本，物理删除其余更早历史版本
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const crypto = require('crypto')
const { getEnvValues } = require('./utils/env-utils.cjs')
const { createProxyAgent, delay, isNetworkError, detectProxy } = require('./utils/proxy-utils.cjs')

const MAX_RETRIES = 3
const RETRY_DELAY = 3000
const REGION = 'auto'

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`)
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function hmac(key, string) {
  return crypto.createHmac('sha256', key).update(string).digest()
}

function hash(string) {
  return crypto.createHash('sha256').update(string, 'utf8').digest('hex')
}

function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = hmac('AWS4' + key, dateStamp)
  const kRegion = hmac(kDate, regionName)
  const kService = hmac(kRegion, serviceName)
  return hmac(kService, 'aws4_request')
}

/**
 * 版本排序比较函数（由新到旧倒序）
 * 支持 bXXXX (如 b11095 > b11063) 及语义版本
 */
function sortVersionsDesc(versions) {
  const unique = Array.from(new Set(versions.filter(Boolean)))
  return unique.sort((a, b) => {
    const matchA = a.match(/^b(\d+)$/i)
    const matchB = b.match(/^b(\d+)$/i)
    if (matchA && matchB) {
      return parseInt(matchB[1], 10) - parseInt(matchA[1], 10)
    }
    return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' })
  })
}

/**
 * 识别待淘汰的历史版本列表（只保留最新的保留数量，默认 2）
 */
function identifyPrunableVersions(allVersions, keepCount = 2) {
  const sorted = sortVersionsDesc(allVersions)
  if (sorted.length <= keepCount) {
    return {
      activeVersions: sorted,
      prunableVersions: []
    }
  }
  return {
    activeVersions: sorted.slice(0, keepCount),
    prunableVersions: sorted.slice(keepCount)
  }
}

/**
 * 根据包名推断 Flavor 标识
 */
function inferPackageFlavor(filename) {
  const lower = filename.toLowerCase()
  if (lower.includes('vulkan-compat')) return 'vulkan-compat'
  if (lower.includes('cpu-avx-x64')) return 'cpu-avx'
  if (lower.includes('cpu-noavx-x64')) return 'cpu-noavx'
  if (lower.includes('cuda-13.4') || lower.includes('cuda-13.3')) {
    return lower.includes('cudart') ? 'cudart-cuda134' : 'cuda134'
  }
  if (lower.includes('cuda-12.4')) {
    return lower.includes('cudart') ? 'cudart-cuda124' : 'cuda124'
  }
  if (lower.includes('vulkan')) return 'vulkan'
  if (lower.includes('sycl')) return 'sycl'
  if (lower.includes('rocm')) return 'rocm'
  if (lower.includes('cpu') || lower.includes('avx2') || lower.endsWith('-bin-win-x64.zip'))
    return 'cpu'
  if (lower.includes('macos-arm64')) return 'metal-arm64'
  if (lower.includes('macos-x64')) return 'metal-x64'
  return path.basename(filename, path.extname(filename))
}

/**
 * 生成 Manifest 清单结构
 */
function buildManifest(latestVersion, previousVersion, versionsMap) {
  return {
    updatedAt: new Date().toISOString(),
    latestVersion,
    previousVersion: previousVersion || null,
    versions: versionsMap
  }
}

/**
 * 封装 R2 S3 兼容 API 请求
 */
function createR2Client(credentials) {
  const { accessKeyId, secretAccessKey, bucketName, accountId } = credentials
  const host = `${bucketName}.${accountId}.r2.cloudflarestorage.com`

  function r2Request(method, pathStr, options = {}, retryCount = 0) {
    return new Promise((resolve, reject) => {
      const proxyUrl = detectProxy()
      const agent = createProxyAgent(proxyUrl)

      const amzDate = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '')
      const dateStamp = amzDate.substr(0, 8)
      const service = 's3'

      const contentHash =
        options.contentHash || 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      const canonicalUri = encodeURI(pathStr)
      const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${contentHash}\nx-amz-date:${amzDate}\n`
      const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
      const canonicalRequest = `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${contentHash}`

      const credentialScope = `${dateStamp}/${REGION}/${service}/aws4_request`
      const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${hash(canonicalRequest)}`
      const signingKey = getSignatureKey(secretAccessKey, dateStamp, REGION, service)
      const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex')

      const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

      const requestOptions = {
        hostname: host,
        path: pathStr,
        method: method,
        agent: agent,
        headers: {
          Authorization: authorizationHeader,
          'x-amz-content-sha256': contentHash,
          'x-amz-date': amzDate,
          ...options.headers
        }
      }

      const req = https.request(requestOptions, res => {
        if (method === 'HEAD') {
          res.on('data', () => {})
          res.on('end', () => resolve(res))
          return
        }
        let data = ''
        res.on('data', chunk => (data += chunk))
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data)
          } else {
            reject(new Error(`R2 请求失败: ${res.statusCode} - ${data}`))
          }
        })
      })

      req.on('error', async err => {
        if (retryCount < MAX_RETRIES && isNetworkError(err)) {
          log(`[R2 重试 ${retryCount + 1}/${MAX_RETRIES}] ${err.message}，等待重试...`)
          await delay(RETRY_DELAY)
          return r2Request(method, pathStr, options, retryCount + 1)
            .then(resolve)
            .catch(reject)
        }
        reject(err)
      })

      if (options.bodyStream) {
        options.bodyStream.pipe(req)
      } else if (options.body) {
        req.write(options.body)
        req.end()
      } else {
        req.end()
      }
    })
  }

  async function uploadFile(filePath, targetKey, contentType = 'application/octet-stream') {
    const stat = fs.statSync(filePath)
    const fileBuffer = fs.readFileSync(filePath)
    const contentHash = hash(fileBuffer)
    const fileStream = fs.createReadStream(filePath)

    await r2Request('PUT', `/${targetKey}`, {
      contentHash,
      headers: {
        'Content-Length': stat.size,
        'Content-Type': contentType
      },
      bodyStream: fileStream
    })
  }

  async function uploadString(content, targetKey, contentType = 'application/json') {
    const buffer = Buffer.from(content, 'utf-8')
    const contentHash = hash(buffer)
    await r2Request('PUT', `/${targetKey}`, {
      contentHash,
      headers: {
        'Content-Length': buffer.length,
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
      body: buffer
    })
  }

  async function listObjects(prefix = '') {
    const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''
    const xml = await r2Request('GET', `/${query}`)
    const keys = []
    const keyMatches = xml.matchAll(/<Key>(.*?)<\/Key>/g)
    for (const m of keyMatches) {
      keys.push(m[1])
    }
    return keys
  }

  async function deleteObject(key) {
    await r2Request('DELETE', `/${encodeURI(key)}`)
  }

  return { uploadFile, uploadString, listObjects, deleteObject }
}

async function run() {
  const args = process.argv.slice(2)
  let targetTag = process.env.LLAMA_TAG || ''
  let artifactsDir = path.resolve(__dirname, '../dist')

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tag' && args[i + 1]) {
      targetTag = args[i + 1]
      i++
    } else if (args[i] === '--dir' && args[i + 1]) {
      artifactsDir = path.resolve(process.cwd(), args[i + 1])
      i++
    }
  }

  if (!targetTag) {
    throw new Error('必须通过 --tag 或环境变量 LLAMA_TAG 指定发布版本号！')
  }

  const envs = getEnvValues(
    ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_ACCOUNT_ID'],
    'production'
  )

  if (
    !envs.R2_ACCESS_KEY_ID ||
    !envs.R2_SECRET_ACCESS_KEY ||
    !envs.R2_BUCKET_NAME ||
    !envs.R2_ACCOUNT_ID
  ) {
    throw new Error(
      '未设置完整的 Cloudflare R2 环境变量 (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ACCOUNT_ID)'
    )
  }

  const r2 = createR2Client({
    accessKeyId: envs.R2_ACCESS_KEY_ID,
    secretAccessKey: envs.R2_SECRET_ACCESS_KEY,
    bucketName: envs.R2_BUCKET_NAME,
    accountId: envs.R2_ACCOUNT_ID
  })

  // 1. 扫描待上传文件
  const filesToUpload = []
  function scan(dir) {
    if (!fs.existsSync(dir)) return
    const list = fs.readdirSync(dir)
    for (const file of list) {
      const full = path.join(dir, file)
      if (fs.statSync(full).isDirectory()) {
        scan(full)
      } else {
        const ext = path.extname(file).toLowerCase()
        if (ext === '.zip' || ext === '.gz' || ext === '.sha256') {
          filesToUpload.push(full)
        }
      }
    }
  }
  scan(artifactsDir)

  log(`检测到 ${filesToUpload.length} 个待上传至 R2 的资产文件`)
  if (filesToUpload.length === 0) {
    throw new Error(`在目录 ${artifactsDir} 中未找到任何待上传资产！`)
  }

  const currentVersionPackages = {}

  // 2. 执行批量上传
  for (const file of filesToUpload) {
    const filename = path.basename(file)
    const targetKey = `llama-cpp/${targetTag}/${filename}`
    log(`正在上传 R2: ${targetKey} (${formatBytes(fs.statSync(file).size)})...`)
    await r2.uploadFile(file, targetKey)

    if (filename.endsWith('.zip') || filename.endsWith('.tar.gz')) {
      const flavor = inferPackageFlavor(filename)
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      currentVersionPackages[flavor] = {
        file: filename,
        size: fs.statSync(file).size,
        sha256
      }
    }
  }
  log(`✓ 版本 ${targetTag} 全量资产上传 R2 完成！`)

  // 3. 扫描已存在的所有版本目录以构建 Manifest 和执行轮替
  log('正在查询 R2 桶中所有 llama-cpp 历史版本...')
  const allKeys = await r2.listObjects('llama-cpp/')
  const detectedVersions = new Set([targetTag])

  for (const k of allKeys) {
    const m = k.match(/^llama-cpp\/([^/]+)\//)
    if (m && m[1] && m[1] !== 'manifest.json') {
      detectedVersions.add(m[1])
    }
  }

  const { activeVersions, prunableVersions } = identifyPrunableVersions(
    Array.from(detectedVersions),
    2
  )
  log(`当前活跃保留版本: ${activeVersions.join(', ')} (最新: ${activeVersions[0]})`)
  log(`待淘汰历史版本: ${prunableVersions.length > 0 ? prunableVersions.join(', ') : '无'}`)

  // 4. 生成并更新 manifest.json
  const manifestData = buildManifest(activeVersions[0], activeVersions[1] || null, {
    [targetTag]: {
      packages: currentVersionPackages
    }
  })
  log('正在上传更新 llama-cpp/manifest.json ...')
  await r2.uploadString(JSON.stringify(manifestData, null, 2), 'llama-cpp/manifest.json')
  log('✓ manifest.json 更新成功！')

  // 5. 后清理原则：删除旧版本
  if (prunableVersions.length > 0) {
    log(`正在清理旧版本目录以控制 R2 空间: ${prunableVersions.join(', ')} ...`)
    for (const oldVer of prunableVersions) {
      const keysToDelete = allKeys.filter(k => k.startsWith(`llama-cpp/${oldVer}/`))
      log(`- 淘汰版本 ${oldVer} 包含 ${keysToDelete.length} 个文件，执行删除...`)
      for (const k of keysToDelete) {
        await r2.deleteObject(k)
      }
      log(`✓ 已删除版本 ${oldVer}`)
    }
  }

  log('----------------------------------------')
  log('Cloudflare R2 AI 引擎发布与轮替清理全部完成！')
}

if (require.main === module) {
  run().catch(err => {
    console.error('发布 R2 失败:', err)
    process.exit(1)
  })
}

module.exports = {
  sortVersionsDesc,
  identifyPrunableVersions,
  inferPackageFlavor,
  buildManifest
}
