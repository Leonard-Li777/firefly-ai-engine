/// <reference types="vite/client" />

/** 应用版本（vite.config.ts define 编译期注入） */
declare const __APP_VERSION__: string
/** PostHog API Key（vite.config.ts define 编译期注入，来自 .env） */
declare const VITE_POSTHOG_KEY: string
/** PostHog 上报域名（EdgeOne 代理，来自 .env） */
declare const VITE_POSTHOG_HOST: string
