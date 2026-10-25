import { spawn } from 'child_process'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../../../')
const projectDir = path.resolve(__dirname, '..')

/**
 * 解析当前工程实际生效的 esbuild 平台二进制路径。
 *
 * 背景：hoisted 布局下 node_modules 内会同时存在多个 esbuild 版本
 * （0.25.0 / 0.25.11 / 0.27.7 …），且 esbuild 自身向上查找 `@esbuild/*`
 * 时会逃逸到 `.pnpm/node_modules` 里的其它版本，因此必须显式指定
 * `ESBUILD_BINARY_PATH`，否则报
 * `Cannot start service: Host version "x" does not match binary version "y"`。
 *
 * 关键点：二进制版本必须与「本次执行的工具真正 require 到的 esbuild JS 包」
 * 严格一致。同一工程内 vite 与 vitest 可能各绑不同 esbuild（实测本 worktree：
 * vite → 0.25.11、vitest → 0.25.0），故须按工具名分别锚定；
 * 不能只按 `0.25.` 前缀取第一个命中项（多版本共存时会选错，导致 Host/binary 错配）。
 */
function resolveEsbuildBinaryPath(tool) {
  const pnpmDir = path.join(rootDir, 'node_modules/.pnpm')
  if (!fs.existsSync(pnpmDir)) return null

  // 1) 以「本次执行的工具」为锚点，解析其真正加载的 esbuild JS 包版本
  let version = null
  for (const anchor of [tool, 'vite']) {
    if (!anchor) continue
    try {
      const projectRequire = createRequire(path.join(projectDir, 'package.json'))
      const anchorPkgJson = projectRequire.resolve(`${anchor}/package.json`)
      const esbuildPkgJson = createRequire(anchorPkgJson).resolve('esbuild/package.json')
      version = JSON.parse(fs.readFileSync(esbuildPkgJson, 'utf8')).version
      break
    } catch {
      // 该锚点不可解析时尝试下一个；全部失败则退回前缀匹配（保持历史兜底行为）
    }
  }

  // 2) 精确版本优先；3) 兜底为任意 0.25.x（vite 6 / vitest 3 的依赖范围）
  const candidates = []
  if (version) candidates.push(`@esbuild+win32-x64@${version}`)
  candidates.push(...fs.readdirSync(pnpmDir).filter(e => e.startsWith('@esbuild+win32-x64@0.25.')))

  for (const name of candidates) {
    const binPath = path.join(pnpmDir, name, 'node_modules/@esbuild/win32-x64/esbuild.exe')
    if (fs.existsSync(binPath)) return binPath
  }
  return null
}

const args = process.argv.slice(2)

// 自动检测并设置匹配当前工程 esbuild JS 版本的二进制路径，防止 hoisted 布局下的版本串扰
const env = { ...process.env }
if (!env.ESBUILD_BINARY_PATH && process.platform === 'win32') {
  const binPath = resolveEsbuildBinaryPath(args[0])
  if (binPath) {
    env.ESBUILD_BINARY_PATH = binPath
  }
}

// 注入 Node.js 内存上限兜底（4GB），防止大型前端构建/Vite 插件在多任务并发或内存压力下 OOM
if (!env.NODE_OPTIONS || !env.NODE_OPTIONS.includes('--max-old-space-size')) {
  env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --max-old-space-size=4096`.trim()
}

const cmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const isWin = process.platform === 'win32'
// Windows 下避免传 args 数组 + shell: true 触发 DEP0190 告警
const child = isWin
  ? spawn(`${cmd} exec ${args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`, {
      stdio: 'inherit',
      env,
      shell: true,
      cwd: path.resolve(__dirname, '..')
    })
  : spawn(cmd, ['exec', ...args], {
      stdio: 'inherit',
      env,
      cwd: path.resolve(__dirname, '..')
    })

child.on('exit', code => process.exit(code || 0))
