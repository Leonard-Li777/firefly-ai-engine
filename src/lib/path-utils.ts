/**
 * Windows 8.3 短路径安全转换与路径过滤工具
 * 解决 C/C++ 核心程序 (llama.cpp, llama-server, llama-model-download) 在 Windows 下
 * 遇到非 ASCII 字符 (如中文、日韩文、特殊符号) 或空格时的崩溃、乱码与参数截断问题。
 */

/**
 * 判断当前是否处于 Windows 操作系统
 */
export function isWindowsPlatform(): boolean {
  if (typeof process !== 'undefined' && process.platform) {
    return process.platform === 'win32'
  }
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    return /win/i.test(navigator.userAgent)
  }
  return false
}

/**
 * 检查路径是否包含非 ASCII 字符或空格
 * 只有包含非 ASCII 或空格的路径才必须转为 8.3 短路径
 */
export function hasNonAsciiOrSpaces(filePath: string): boolean {
  if (!filePath) return false
  return /[^\x00-\x7F]/.test(filePath) || filePath.includes(' ')
}

/**
 * 平台环境下的安全短路径转换 (Windows 8.3 短名称)
 *
 * 转换原理：
 * 1. 若非 Windows 或为纯 ASCII 且无空格路径，直接原样返回（零开销）；
 * 2. 在 Node.js / Electron / Tauri 主进程环境中，通过 cmd.exe %~sA 扩展获取 8.3 短名称；
 * 3. 采用 chcp 65001 (UTF-8) 与系统活动代码页 (如 cp936) 双重解码和回退；
 * 4. 实施双重物理校验：若原长路径存在，验证解码短路径是否物理存在；若短路径不存在，安全回退至原长路径。
 */
export function toShortPathOnWindows(longPath: string): string {
  if (!longPath || typeof longPath !== 'string') return ''
  if (!isWindowsPlatform()) return longPath

  // 纯 ASCII 且不含空格，直接跳过转换
  if (!hasNonAsciiOrSpaces(longPath)) {
    return longPath
  }

  // 仅在 Node/本地运行时环境下可执行 child_process
  if (typeof process !== 'undefined' && typeof require === 'function') {
    try {
      const { execSync } = require('child_process')
      const fs = require('fs')

      // 获取系统活动代码页
      let systemCodePage = 'utf-8'
      try {
        const cpResult = execSync('chcp', { timeout: 3000 })
        const match = cpResult.toString().match(/(\d+)/)
        if (match) {
          const cp = parseInt(match[1], 10)
          systemCodePage = cp === 65001 ? 'utf-8' : `cp${cp}`
        }
      } catch {
        systemCodePage = 'cp936'
      }

      let resultBuffer: any = null
      let usedUtf8 = false

      // 优先尝试 chcp 65001 强制输出 UTF-8
      try {
        resultBuffer = execSync(`chcp 65001 > nul && for %A in ("${longPath}") do @echo %~sA`, {
          timeout: 5000,
          shell: 'cmd.exe'
        })
        usedUtf8 = true
      } catch {
        // 回退到不带 chcp 的原始模式
        try {
          resultBuffer = execSync(`for %A in ("${longPath}") do @echo %~sA`, {
            timeout: 5000,
            shell: 'cmd.exe'
          })
          usedUtf8 = false
        } catch {
          // cmd 执行失败，降级返回原路径
          return longPath
        }
      }

      if (resultBuffer && resultBuffer.length > 0) {
        let shortPath = ''
        if (usedUtf8) {
          shortPath = resultBuffer.toString('utf8').trim()
        } else {
          try {
            const iconv = require('iconv-lite')
            shortPath = iconv.decode(resultBuffer, systemCodePage).trim()
          } catch {
            shortPath = resultBuffer.toString('utf8').trim()
          }
        }

        // 双重物理校验：原路径若存在，则校验短路径是否有效
        try {
          if (fs.existsSync(longPath)) {
            if (fs.existsSync(shortPath)) {
              return shortPath
            }
            // 短路径验证不通过，返回原长路径
            return longPath
          }
        } catch {
          // 文件系统检查失败时返回转换结果
        }

        if (shortPath && !hasNonAsciiOrSpaces(shortPath)) {
          return shortPath
        }
      }
    } catch {
      // 降级回退
      return longPath
    }
  }

  // 前端沙盒或无 child_process 环境下，直接返回原始路径
  return longPath
}

/**
 * 构造传给 llama-server 或 llama-model-download 的模型路径参数
 * - ModelScope 源：llama-server 的 LLAMA_CACHE 相对路径解析不支持 hub/models 层次，
 *   必须传绝对路径；且若含空格或非 ASCII，转为 8.3 短路径
 * - HuggingFace 源：保持相对路径（LLAMA_CACHE 可正确定位）；若含空格或中文则转为短路径
 */
export function resolveModelArgForCmd(
  absolutePath: string,
  modelBaseDir: string,
  source: string = 'huggingface'
): string {
  if (!absolutePath) return ''

  // ModelScope 规范物理目录结构必须传绝对路径并做短路径转换
  if (source === 'modelscope') {
    return toShortPathOnWindows(absolutePath)
  }

  // HuggingFace 等其他源：
  // 若包含非 ASCII 或空格，直接转为绝对短路径确保安全性
  if (hasNonAsciiOrSpaces(absolutePath)) {
    return toShortPathOnWindows(absolutePath)
  }

  // 纯 ASCII 相对路径
  if (modelBaseDir && absolutePath.startsWith(modelBaseDir)) {
    const rel = absolutePath.slice(modelBaseDir.length).replace(/^[/\\]+/, '')
    return rel
  }

  return absolutePath
}
