import posthog from 'posthog-js/dist/module.full.no-external'

/**
 * Engine（Tauri WebView 渲染层）PostHog 行为分析模块
 *
 * 对齐 desktop 端 apps/desktop/src/renderer/lib/posthog.ts 的行为：
 * autocapture、异常捕获、离线自动暂停捕获、身份识别与全局属性注入。
 * 差异点：
 * 1. Engine 无打包环境标志与 tier 遥测门控，改为「配置了 KEY 即初始化」；
 * 2. Engine 无机器 ID 后端命令，使用 localStorage 持久化的设备 UUID 作为 distinctId；
 * 3. 会话录屏默认关闭（引擎轻量工具，无硬件检测门控）；
 * 4. 全局属性注入 来源应用='ai-engine'，与 desktop 同项目数据区分来源。
 */

const POSTHOG_KEY = typeof VITE_POSTHOG_KEY !== 'undefined' ? VITE_POSTHOG_KEY : ''
const POSTHOG_HOST =
  typeof VITE_POSTHOG_HOST !== 'undefined' ? VITE_POSTHOG_HOST : 'https://app.posthog.com'

/** 运行环境标识，与 desktop 事件属性口径一致 */
const RUNTIME_ENV = import.meta.env?.PROD ? '生产环境' : '开发环境'

/** 设备唯一标识存储 key（localStorage 由 WebView2 数据目录持久化，卸载重装后重置） */
const DEVICE_ID_KEY = 'firefly_engine_device_id'

/**
 * 生成并持久化设备 UUID，作为 PostHog distinctId（跨会话稳定）
 */
const getDeviceId = (): string => {
  try {
    let id = window.localStorage.getItem(DEVICE_ID_KEY)
    if (!id) {
      id = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      window.localStorage.setItem(DEVICE_ID_KEY, id)
    }
    return id
  } catch {
    // localStorage 不可用时退化为会话内临时 ID
    return `dev-session-${Date.now()}`
  }
}

/**
 * 暂停状态持久化（与 desktop 同机制）
 *
 * opt_out_capturing() 的暂停状态仅存在于 posthog 内部持久化中，
 * 这里额外记录暂停是否由"离线探测"触发，服务器恢复后据此自动 opt-in。
 */
const PAUSE_STORAGE_KEY = 'posthog_capture_paused'

const loadPausedState = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(PAUSE_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

const savePausedState = (paused: boolean) => {
  if (typeof window === 'undefined') return
  try {
    if (paused) {
      window.localStorage.setItem(PAUSE_STORAGE_KEY, '1')
    } else {
      window.localStorage.removeItem(PAUSE_STORAGE_KEY)
    }
  } catch {
    // localStorage 不可用（如隐私模式）时忽略
  }
}

let isCapturingPaused = loadPausedState()
let checkInterval: ReturnType<typeof setInterval> | null = null

const checkServerReachability = async (): Promise<boolean> => {
  if (typeof window === 'undefined' || !window.navigator.onLine) {
    return false
  }
  try {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), 3000)

    // 探测接口是否可连通 (HEAD /)
    await fetch(POSTHOG_HOST, {
      method: 'HEAD',
      mode: 'no-cors',
      signal: controller.signal
    })
    clearTimeout(id)
    return true
  } catch {
    return false
  }
}

/**
 * 初始化 PostHog
 *
 * 未配置 KEY 时直接跳过（开源构建 / 未配置 .env 场景静默降级）。
 */
export const initPostHog = async () => {
  if (!POSTHOG_KEY) {
    console.warn('PostHog API Key 未配置（.env VITE_POSTHOG_KEY），行为分析已跳过')
    return
  }

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    // 开发环境下开启调试模式，可以在控制台看到事件发送情况
    debug: !import.meta.env?.PROD,
    // 捕获所有点击、表单提交等行为
    autocapture: true,
    // 引擎为轻量工具，默认关闭会话录屏
    disable_session_recording: true,
    // 禁用性能指标遥测（降低客户端开销）
    capture_performance: false,
    // 开启异常捕获
    capture_exceptions: true,
    // 自动捕获页面浏览
    capture_pageview: 'history_change',
    // 持久化标识
    persistence: 'localStorage+cookie'
  })

  // 注册全局属性，确保每个事件都带上环境与来源标识
  posthog.register({
    运行环境: RUNTIME_ENV,
    来源应用: 'ai-engine'
  })

  // 动态监控服务器连通性，离线时暂停捕获以免产生大量网络报错
  const checkConnection = async () => {
    const isReachable = await checkServerReachability()
    if (!isReachable) {
      if (!isCapturingPaused) {
        console.warn('PostHog: 检测到分析服务器离线，已暂停事件捕获以避免请求报错')
        posthog.opt_out_capturing()
        isCapturingPaused = true
        savePausedState(true)
      }
    } else if (isCapturingPaused) {
      console.log('PostHog: 检测到分析服务器已恢复，重新开启事件捕获')
      posthog.opt_in_capturing()
      isCapturingPaused = false
      savePausedState(false)
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', checkConnection)
    window.addEventListener('offline', checkConnection)
    if (checkInterval) clearInterval(checkInterval)
    checkInterval = setInterval(checkConnection, 30000)
    // 立即启动连通性判定
    checkConnection()
  }

  // 身份识别：设备 UUID 作为 distinctId，区分个人属性便于跨事件聚合
  try {
    const deviceId = getDeviceId()
    posthog.identify(deviceId)
    posthog.setPersonProperties({
      device_id: deviceId,
      app_version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown',
      platform: window.navigator.platform,
      app: 'firefly-ai-engine'
    })
  } catch (error) {
    console.error('无法获取设备 ID 进行 PostHog 身份识别:', error)
  }

  return posthog
}

/**
 * 捕获自定义事件
 * @param eventName 事件名称
 * @param properties 额外属性
 */
export const captureEvent = (eventName: string, properties?: Record<string, unknown>) => {
  // 确保注入环境信息
  const finalProps = {
    运行环境: RUNTIME_ENV,
    ...properties
  }

  try {
    if (posthog && typeof posthog.capture === 'function') {
      posthog.capture(eventName, finalProps)
    } else if (!import.meta.env?.PROD) {
      console.log(`[PostHog Skip] 事件: ${eventName}`, finalProps)
    }
  } catch (e) {
    if (!import.meta.env?.PROD) console.warn(`PostHog 事件捕获失败 [${eventName}]:`, e)
  }
}

/**
 * 捕获异常
 * @param error 错误对象
 * @param properties 额外属性
 */
export const captureException = (error: Error, properties?: Record<string, unknown>) => {
  const finalProps = {
    运行环境: RUNTIME_ENV,
    ...properties
  }

  try {
    if (posthog && typeof posthog.captureException === 'function') {
      posthog.captureException(error, finalProps)
    } else if (!import.meta.env?.PROD) {
      console.log(`[PostHog Skip] 异常:`, error, finalProps)
    }
  } catch (e) {
    if (!import.meta.env?.PROD) console.warn('PostHog 异常捕获失败:', e)
  }
}

export default posthog
