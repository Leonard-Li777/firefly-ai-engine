
/**
 * 检测可用的代理配置
 */
function detectProxy() {
  return process.env.HTTPS_PROXY || process.env.HTTPS_proxy ||
         process.env.HTTP_PROXY  || process.env.HTTP_proxy  ||
         process.env.ALL_PROXY   || process.env.all_proxy;
}

/**
 * 创建 HttpsProxyAgent
 */
function createProxyAgent(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(proxyUrl);
  } catch (e) {
    console.warn('⚠️ 无法加载 https-proxy-agent 模块，跳过代理代理创建:', e.message);
    return null;
  }
}

/**
 * 延迟
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 判断错误是否为网络连接类错误
 */
function isNetworkError(error) {
  if (!error || !error.message) return false;
  const msg = error.message;
  return msg.includes('ENOTFOUND') ||
         msg.includes('EAI_AGAIN') ||
         msg.includes('ECONNREFUSED') ||
         msg.includes('ECONNRESET') ||
         msg.includes('socket hang up') ||
         msg.includes('ETIMEDOUT') ||
         msg.includes('ECONNABORTED') ||
         msg.includes('Protocol') ||
         msg.includes('EPIPE') ||
         error.code === 'ENOTFOUND' ||
         error.code === 'EAI_AGAIN' ||
         error.code === 'ECONNREFUSED' ||
         error.code === 'ECONNRESET' ||
         error.code === 'ETIMEDOUT' ||
         error.code === 'ECONNABORTED' ||
         error.code === 'EPIPE';
}

/**
 * 打印代理设置提示
 */
function printProxyHint() {
  if (!detectProxy()) {
    console.log('💡 提示: 如你所在网络无法直连 (例如中国大陆)，可设置代理环境变量再试:');
    console.log('   export HTTPS_PROXY=http://127.0.0.1:7890');
  }
}

/**
 * 创建 axios 级别的代理配置
 * 始终禁用 axios 自动代理检测（axios 1.x 自动读取 env 存在 bug）
 */
function createAxiosProxyConfig(proxyUrl, extraHeaders = {}) {
  const config = { headers: { 'Accept': 'application/vnd.github.v3+json', ...extraHeaders }, proxy: false };
  const agent = createProxyAgent(proxyUrl);
  if (agent) {
    config.httpsAgent = agent;
  }
  return config;
}

/**
 * 带自动重试的 fetch（Node.js 原生 fetch 不自动使用代理，重试失败后提示用户设置 HTTPS_PROXY）
 */
async function fetchWithRetry(url, options = {}, retryCount = 0, maxRetries = 2) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (retryCount < maxRetries) {
      console.log(`\x1b[33m[重试]\x1b[0m 网络请求失败 (${error.message}), 3 秒后重试 (${retryCount + 1}/${maxRetries})...`);
      await delay(3000);
      return fetchWithRetry(url, options, retryCount + 1, maxRetries);
    }
    const proxyUrl = detectProxy();
    if (proxyUrl) {
      console.log(`\x1b[33m[提示]\x1b[0m 已检测到代理 ${proxyUrl}，但 Node.js 原生 fetch 不自动使用。`);
      console.log(`\x1b[33m[提示]\x1b[0m 请尝试: HTTPS_PROXY=${proxyUrl} node ${process.argv[1]}`);
    } else {
      printProxyHint();
    }
    throw error;
  }
}

module.exports = {
  detectProxy,
  createProxyAgent,
  delay,
  isNetworkError,
  printProxyHint,
  createAxiosProxyConfig,
  fetchWithRetry
};
