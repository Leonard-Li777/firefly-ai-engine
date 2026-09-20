import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 格式化文件尺寸大小 (如 1.5 GB)
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

/**
 * 格式化传输速率 (如 12.5 MB/s)
 */
export function formatSpeed(bps: number): string {
  return `${formatFileSize(bps)}/s`
}

/**
 * 估算下载剩余时间
 */
export function calculateRemainingTime(
  received: number,
  total: number,
  speed: number
): {
  kind: 'calculating' | 'waiting' | 'seconds' | 'minutes' | 'hours'
  value?: number
  seconds?: number
  minutes?: number
} {
  if (speed <= 0 || total <= 0 || received >= total) {
    return { kind: received >= total ? 'waiting' : 'calculating' }
  }

  const remainingBytes = total - received
  const remainingSec = Math.round(remainingBytes / speed)

  if (remainingSec < 5) {
    return { kind: 'waiting' }
  }
  if (remainingSec < 60) {
    return { kind: 'seconds', value: remainingSec }
  }
  if (remainingSec < 3600) {
    const mins = Math.floor(remainingSec / 60)
    const secs = remainingSec % 60
    return { kind: 'minutes', value: mins, seconds: secs }
  }

  const hours = Math.floor(remainingSec / 3600)
  const mins = Math.floor((remainingSec % 3600) / 60)
  return { kind: 'hours', value: hours, minutes: mins }
}
