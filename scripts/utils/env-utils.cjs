const fs = require('fs');
const path = require('path');

/**
 * 解析 .env 格式的配置文件内容
 * @param {string} filePath 文件绝对路径
 * @returns {Record<string, string>} 解析后的键值对对象
 */
function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const env = {};
    content.split(/\r?\n/).forEach(line => {
      // 过滤注释和空行
      if (line.trim().startsWith('#') || !line.trim()) return;
      const match = line.match(/^\s*([\w_]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        let value = match[2] || '';
        // 移除两端引号
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        } else if (value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        env[match[1]] = value;
      }
    });
    return env;
  } catch (e) {
    return {};
  }
}

/**
 * 批量获取环境变量值
 * 依次尝试加载：process.env -> 指定环境后缀的 .env.[envName] -> 通用 .env
 * @param {string[]} keys 需要获取的 Key 数组
 * @param {string} [envName] 环境名称（例如 'production'，对应加载 .env.production）
 * @returns {Record<string, string>} 返回 key-value 的结果对象
 */
function getEnvValues(keys, envName = '') {
  const result = {};

  const rootDir = process.cwd();
  const parsedConfigs = [];

  // 1. 默认加载通用的 .env 文件
  const defaultEnvPath = path.join(rootDir, '.env');
  if (fs.existsSync(defaultEnvPath)) {
    parsedConfigs.push(parseEnvFile(defaultEnvPath));
  }

  // 2. 如果指定了特定环境，则加载对应的 .env.[envName] 并 merge 覆盖
  if (envName && ['development', 'canary', 'test', 'production'].includes(envName)) {
    const specificEnvPath = path.join(rootDir, `.env.${envName}`);
    if (fs.existsSync(specificEnvPath)) {
      parsedConfigs.push(parseEnvFile(specificEnvPath));
    }
  }

  // 3. 按照从低到高（.env -> .env.环境）的顺序进行 merge 合并
  const mergedEnv = {};
  for (const config of parsedConfigs) {
    Object.assign(mergedEnv, config);
  }

  // 4. 批量获取结果，并让系统 process.env 拥有最高优先级进行覆盖
  keys.forEach(key => {
    if (process.env[key] !== undefined) {
      result[key] = process.env[key];
    } else if (mergedEnv[key] !== undefined) {
      result[key] = mergedEnv[key];
    }
  });

  return result;
}

module.exports = {
  parseEnvFile,
  getEnvValues
};
