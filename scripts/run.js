import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../../../')

// 自动检测并设置匹配当前工程 esbuild JS 版本的二进制路径，防止 hoisted 布局下的版本串扰
const env = { ...process.env }
if (!env.ESBUILD_BINARY_PATH && process.platform === 'win32') {
  const pnpmDir = path.join(rootDir, 'node_modules/.pnpm')
  if (fs.existsSync(pnpmDir)) {
    const entries = fs.readdirSync(pnpmDir)
    const esbuildPkg = entries.find(e => e.startsWith('@esbuild+win32-x64@0.25.'))
    if (esbuildPkg) {
      const binPath = path.join(pnpmDir, esbuildPkg, 'node_modules/@esbuild/win32-x64/esbuild.exe')
      if (fs.existsSync(binPath)) {
        env.ESBUILD_BINARY_PATH = binPath
      }
    }
  }
}

const args = process.argv.slice(2)
const cmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const child = spawn(cmd, ['exec', ...args], {
  stdio: 'inherit',
  env,
  shell: true,
  cwd: path.resolve(__dirname, '..')
})

child.on('exit', code => process.exit(code || 0))
