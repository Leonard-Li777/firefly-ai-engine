import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig(({ mode }) => {
  // 从 .env（不入库）加载 PostHog 配置，经 define 编译期注入前端代码
  const env = loadEnv(mode, __dirname, '')
  return {
    plugins: [react(), tailwindcss()],
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '0.1.0'),
      VITE_POSTHOG_KEY: JSON.stringify(env.VITE_POSTHOG_KEY || ''),
      VITE_POSTHOG_HOST: JSON.stringify(env.VITE_POSTHOG_HOST || 'https://app.posthog.com')
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src')
      }
    },
    server: {
      port: 38410,
      strictPort: false
    }
  }
})
