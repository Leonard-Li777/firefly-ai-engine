'use strict'

/**
 * firefly-ai-engine 依赖资源自动装配脚本
 * apps/firefly-ai-engine/scripts/setup-extra-resources.js
 *
 * 职责：
 *  1. 依据 build/extraResources/configs/preset-resources.lock.json 读取版本配置；
 *  2. 检查 build/extraResources/bin/ 对应目录中是否存在目标可执行文件，若已存在直接跳过；
 *  3. 若不存在，优先从 build/presetResources/ 检查压缩包并校验 SHA256；
 *  4. 若仍不存在，从 GitHub Releases (https://github.com/Leonard-Li777/firefly-resources/releases/tag/resources) 下载；
 *  5. 解压部署到 build/extraResources/bin/{tool}-{version}-{os}-{arch}/
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const https = require('https')
const http = require('http')
const { spawnSync, execSync } = require('child_process')

const ENGINE_ROOT = path.resolve(__dirname, '..')
const BASE_EXTRA_DIR = path.join(ENGINE_ROOT, 'build', 'extraResources')
const PRESET_DIR = path.join(ENGINE_ROOT, 'build', 'presetResources')
const BIN_DEST_DIR = path.join(BASE_EXTRA_DIR, 'bin')
const LOCK_FILE = path.join(BASE_EXTRA_DIR, 'configs', 'preset-resources.lock.json')

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()))
    stream.on('error', reject)
  })
}

function parseArgs(argv) {
  const args = { platform: process.platform, arch: process.arch }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--platform=')) {
      args.platform = a.split('=')[1]
    } else if (a === '--platform' && argv[i + 1]) {
      args.platform = argv[++i]
    } else if (a.startsWith('--arch=')) {
      args.arch = a.split('=')[1]
    } else if (a === '--arch' && argv[i + 1]) {
      args.arch = argv[++i]
    } else if (a.startsWith('--proxy=')) {
      args.proxy = a.split('=')[1]
    }
  }
  return args
}

function resolveDownloadUrl(url, explicitProxy) {
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
  if (explicitProxy) {
    return `${explicitProxy.replace(/\/+$/, '')}/${url}`
  }
  if (!isCI && process.env.GH_PROXY_DISABLE !== 'true') {
    const ghProxy = process.env.GH_PROXY || 'https://gh-proxy.com'
    return `${ghProxy.replace(/\/+$/, '')}/${url}`
  }
  return url
}

async function downloadFile(url, destPath, explicitProxy) {
  ensureDir(path.dirname(destPath))
  const finalUrl = resolveDownloadUrl(url, explicitProxy)
  console.log(`📥 正在下载: ${path.basename(destPath)}`)
  console.log(`   源地址: ${finalUrl}`)

  return new Promise((resolve, reject) => {
    const tempPath = `${destPath}.tmp.${Date.now()}`
    const fetchWithRedirect = (currentUrl, redirects = 0) => {
      if (redirects > 10) return reject(new Error('Too many redirects'))

      const client = currentUrl.startsWith('http:') ? http : https
      const req = client.get(currentUrl, { headers: { 'User-Agent': 'firefly-ai-engine-setup' } }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const loc = res.headers.location
          if (!loc) return reject(new Error(`Redirect without location: HTTP ${res.statusCode}`))
          return fetchWithRedirect(loc, redirects + 1)
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} on downloading ${currentUrl}`))
        }
        const fileStream = fs.createWriteStream(tempPath)
        res.pipe(fileStream)
        fileStream.on('finish', () => {
          fileStream.close(() => {
            fs.renameSync(tempPath, destPath)
            resolve()
          })
        })
        fileStream.on('error', err => {
          try { fs.unlinkSync(tempPath) } catch (_) {}
          reject(err)
        })
      })
      req.on('error', err => {
        try { fs.unlinkSync(tempPath) } catch (_) {}
        reject(err)
      })
    }
    fetchWithRedirect(finalUrl)
  })
}

async function extractArchive(archivePath, destDir) {
  ensureDir(destDir)
  const absArchive = path.resolve(archivePath)
  const absDest = path.resolve(destDir)
  const isTarGz = archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')

  if (process.platform === 'win32') {
    const relArchive = path.relative(absDest, absArchive)
    try {
      const res = spawnSync('tar', ['-xf', relArchive], { cwd: absDest, windowsHide: true })
      if (res.status === 0) {
        console.log(`   ✅ [系统 tar] 成功解压: ${path.basename(archivePath)}`)
        return
      }
    } catch (_) {}

    try {
      execSync(`7z x "${absArchive}" -o"${absDest}" -y`, { windowsHide: true, shell: 'cmd.exe' })
      console.log(`   ✅ [7z] 成功解压: ${path.basename(archivePath)}`)
      return
    } catch (_) {}

    if (!isTarGz) {
      try {
        execSync(
          `powershell -NoProfile -Command "Expand-Archive -Path '${absArchive}' -DestinationPath '${absDest}' -Force"`,
          { windowsHide: true }
        )
        console.log(`   ✅ [PowerShell] 成功解压: ${path.basename(archivePath)}`)
        return
      } catch (_) {}
    }
  } else {
    const cmd = isTarGz ? 'tar' : 'unzip'
    const args = isTarGz ? ['-xzf', archivePath, '-C', destDir] : ['-q', '-o', archivePath, '-d', destDir]
    const res = spawnSync(cmd, args)
    if (res.status === 0) {
      console.log(`   ✅ [系统 ${cmd}] 成功解压: ${path.basename(archivePath)}`)
      return
    }
  }

  throw new Error(`解压文件失败: ${archivePath}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const platform = args.platform === 'darwin' ? 'darwin' : args.platform === 'win32' ? 'win32' : 'linux'
  const arch = args.arch === 'arm64' ? 'arm64' : 'x64'
  const platformKey = `${platform}-${arch}`

  console.log(`🚀 开始装配 firefly-ai-engine 依赖资源: [${platformKey}]`)

  if (!fs.existsSync(LOCK_FILE)) {
    throw new Error(`找不到锁定清单文件: ${LOCK_FILE}`)
  }
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
  const repo = lock.resourcePackage?.repo || 'Leonard-Li777/firefly-resources'
  const containerTag = lock.resourcePackage?.containerTag || 'resources'

  // 读取远程/本地资源包清单元数据 (以 firefly-resources 为标准)
  const remoteIndexUrl = `https://raw.githubusercontent.com/${repo}/${lock.resourcePackage?.branch || 'main'}/index.json`
  let indexData = null
  try {
    // 优先读取 monorepo 本地 apps/firefly-resources/index.json (免网络请求)
    const localIndex = path.resolve(ENGINE_ROOT, '../firefly-resources/index.json')
    if (fs.existsSync(localIndex)) {
      indexData = JSON.parse(fs.readFileSync(localIndex, 'utf8'))
      console.log(`📖 从本地读取资源索引: ${localIndex}`)
    }
  } catch (_) {}

  if (!indexData) {
    console.log(`🌐 正在从 GitHub 获取最新资源索引: ${remoteIndexUrl}`)
    const tmpIndex = path.join(PRESET_DIR, 'index.json')
    await downloadFile(remoteIndexUrl, tmpIndex, args.proxy)
    indexData = JSON.parse(fs.readFileSync(tmpIndex, 'utf8'))
  }

  ensureDir(BIN_DEST_DIR)
  ensureDir(PRESET_DIR)

  // 处理 fastfetch 与 llama-model-download
  const tools = ['fastfetch', 'llama-model-download']

  for (const tool of tools) {
    const ver = lock.resources?.[tool]?.version
    if (!ver) {
      console.warn(`⚠️ 锁定清单中未声明 ${tool} 的版本，跳过`)
      continue
    }

    const toolDirName = `${tool}-${ver}-${platform}-${arch}`
    const targetBinDir = path.join(BIN_DEST_DIR, toolDirName)
    const exeName = platform === 'win32' ? `${tool}.exe` : tool
    const expectedExe = path.join(targetBinDir, exeName)

    // 1. 检查已解压的最终目标
    if (fs.existsSync(expectedExe)) {
      console.log(`✨ 本地已存在最新合规二进制: ${toolDirName}/${exeName}，跳过下载与解压。`)
      continue
    }

    // 2. 解析资产信息
    const toolMeta = indexData.resources?.[tool]
    const assetMeta = toolMeta?.versions?.[ver]?.[platformKey]
    if (!assetMeta) {
      console.warn(`⚠️ 资源索引中未找到 ${tool}@${ver} 在 [${platformKey}] 的发布资产`)
      continue
    }

    const archiveName = assetMeta.name
    const expectedSha256 = assetMeta.sha256
    const archivePath = path.join(PRESET_DIR, tool, archiveName)

    // 3. 检查预设缓存包
    let needDownload = true
    if (fs.existsSync(archivePath)) {
      const actualSha256 = await sha256File(archivePath)
      if (actualSha256 === expectedSha256.toLowerCase()) {
        console.log(`✨ 预设包缓存校验通过 (${archiveName})，跳过网络下载。`)
        needDownload = false
      } else {
        console.warn(`⚠️ 预设包 SHA256 校验不匹配，准备重新拉取: ${archiveName}`)
      }
    }

    // 4. 从 GitHub Releases 下载
    if (needDownload) {
      const downloadUrl = `https://github.com/${repo}/releases/download/${containerTag}/${archiveName}`
      await downloadFile(downloadUrl, archivePath, args.proxy)
      const downloadedSha = await sha256File(archivePath)
      if (downloadedSha !== expectedSha256.toLowerCase()) {
        throw new Error(`下载的文件 SHA256 校验失败: ${archiveName} (期望: ${expectedSha256}, 实际: ${downloadedSha})`)
      }
      console.log(`🔒 文件完整性校验通过 (SHA256: ${expectedSha256})`)
    }

    // 5. 解压部署到目标目录
    console.log(`📦 解压部署: ${archiveName} -> ${targetBinDir}`)
    ensureDir(targetBinDir)
    await extractArchive(archivePath, targetBinDir)

    // 6. Linux/macOS 赋予可执行权限
    if (platform !== 'win32' && fs.existsSync(expectedExe)) {
      try {
        fs.chmodSync(expectedExe, 0o755)
      } catch (_) {}
    }
  }

  console.log(`🎉 firefly-ai-engine 依赖资源装配完成！`)
}

main().catch(err => {
  console.error(`❌ 装配失败:`, err)
  process.exit(1)
})
