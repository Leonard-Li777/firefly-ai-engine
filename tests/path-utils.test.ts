import { describe, it, expect } from 'vitest'
import {
  isWindowsPlatform,
  hasNonAsciiOrSpaces,
  toShortPathOnWindows,
  resolveModelArgForCmd,
  getDisplayRelativeModelPath
} from '../src/lib/path-utils'

describe('PathUtils & Windows 8.3 Short Path Conversion', () => {
  it('should detect Windows platform correctly', () => {
    const isWin = process.platform === 'win32'
    expect(isWindowsPlatform()).toBe(isWin)
  })

  it('should correctly identify paths with non-ASCII chars or spaces', () => {
    expect(hasNonAsciiOrSpaces('C:\\Program Files\\Firefly')).toBe(true)
    expect(hasNonAsciiOrSpaces('D:\\模型库\\Qwen.gguf')).toBe(true)
    expect(hasNonAsciiOrSpaces('D:\\models\\日本語\\model.gguf')).toBe(true)
    expect(hasNonAsciiOrSpaces('D:\\models\\qwen_1.5b.gguf')).toBe(false)
    expect(hasNonAsciiOrSpaces('/usr/local/bin/llama')).toBe(false)
  })

  it('should return ASCII paths without spaces untouched (zero overhead)', () => {
    const simplePath = 'D:\\AI_Models\\models--Qwen--Qwen2.5\\qwen.gguf'
    expect(toShortPathOnWindows(simplePath)).toBe(simplePath)
  })

  it('should convert Windows paths with spaces or non-ASCII characters if on Windows', () => {
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || 'C:\\Users\\Default\\AppData\\Roaming'
      // APPDATA 必然是存在且有效的 Windows 路径
      const short = toShortPathOnWindows(appData)
      expect(short).toBeDefined()
      expect(typeof short).toBe('string')
      expect(short.length).toBeGreaterThan(0)
    }
  })

  it('should resolve model args for ModelScope with absolute path', () => {
    const baseDir = 'D:\\AI_Models'
    const msPath = 'D:\\AI_Models\\hub\\models\\Qwen\\Qwen2.5-1.5B\\model.gguf'
    const result = resolveModelArgForCmd(msPath, baseDir, 'modelscope')
    expect(result).toBe(msPath)
  })

  it('should resolve model args for HuggingFace with relative path if ASCII and no spaces', () => {
    const baseDir = 'D:\\AI_Models'
    const hfPath = 'D:\\AI_Models\\models--Qwen--Qwen2.5-1.5B\\model.gguf'
    const result = resolveModelArgForCmd(hfPath, baseDir, 'huggingface')
    expect(result).toBe('models--Qwen--Qwen2.5-1.5B\\model.gguf')
  })

  it('should convert HuggingFace path to short path if it contains spaces or Chinese', () => {
    const baseDir = 'D:\\AI_Models'
    const hfPathWithSpace = 'D:\\AI_Models\\My Models Folder\\model.gguf'
    const result = resolveModelArgForCmd(hfPathWithSpace, baseDir, 'huggingface')
    expect(result).toBeDefined()
  })

  describe('getDisplayRelativeModelPath', () => {
    it('应成功剥离 base 路径并输出标准相对路径', () => {
      const baseDir = 'C:\\Users\\lilun\\AppData\\Roaming\\com.firefly.ai-engine\\models'
      const localPath = 'C:\\Users\\lilun\\AppData\\Roaming\\com.firefly.ai-engine\\models\\hub\\models\\OpenBMB\\MiniCPM5-2B-gguf\\MiniCPM5-2B-Q4_K_M.gguf'
      const res = getDisplayRelativeModelPath(localPath, baseDir)
      if (isWindowsPlatform()) {
        expect(res).toBe('hub\\models\\OpenBMB\\MiniCPM5-2B-gguf\\MiniCPM5-2B-Q4_K_M.gguf')
      } else {
        expect(res).toBe('hub/models/OpenBMB/MiniCPM5-2B-gguf/MiniCPM5-2B-Q4_K_M.gguf')
      }
    })

    it('当未传入 baseDir 时能够根据 hub/models 特征自动剥离并返回相对路径', () => {
      const localPath = 'E:/some_path/models/hub/models/unsloth/Qwen3.5-0.8B-GGUF/Qwen3.5-0.8B-UD-Q4_K_XL.gguf'
      const res = getDisplayRelativeModelPath(localPath)
      if (isWindowsPlatform()) {
        expect(res).toBe('hub\\models\\unsloth\\Qwen3.5-0.8B-GGUF\\Qwen3.5-0.8B-UD-Q4_K_XL.gguf')
      } else {
        expect(res).toBe('hub/models/unsloth/Qwen3.5-0.8B-GGUF/Qwen3.5-0.8B-UD-Q4_K_XL.gguf')
      }
    })

    it('当未传入 baseDir 时能够根据 models-- 特征自动剥离并返回相对路径', () => {
      const localPath = 'C:\\custom\\dir\\models--unsloth--Qwen3.5-0.8B-GGUF\\snapshots\\hash\\model.gguf'
      const res = getDisplayRelativeModelPath(localPath)
      if (isWindowsPlatform()) {
        expect(res).toBe('models--unsloth--Qwen3.5-0.8B-GGUF\\snapshots\\hash\\model.gguf')
      } else {
        expect(res).toBe('models--unsloth--Qwen3.5-0.8B-GGUF/snapshots/hash/model.gguf')
      }
    })

    it('普通无特征平铺文件回退为单纯文件名', () => {
      const localPath = 'C:\\temp\\isolated_model.gguf'
      const res = getDisplayRelativeModelPath(localPath)
      expect(res).toBe('isolated_model.gguf')
    })
  })
})
