/**
 * 环境变量安全清理模块
 * 在 bash 工具执行命令时，清理环境变量中的敏感信息
 */

export interface SanitizeOptions {
  /** 额外允许的变量名 */
  extraAllowed?: string[];
  /** 额外禁止的变量名 */
  extraDenied?: string[];
}

/** 白名单：始终保留的系统变量 */
const ALWAYS_ALLOWED = new Set([
  // 系统基础变量
  "PATH",
  "HOME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "LOGNAME",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "TMPDIR",
  "TMP",
  "TEMP",
  // XDG 规范
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  // 开发环境
  "NODE_ENV",
  "BUN_ENV",
  "DEBUG",
  // 代理设置
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // 终端相关
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLUMNS",
  "LINES",
  // sid-code 自身需要的变量
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "SID_CODE_LLM_API_KEY",
  "SID_CODE_LLM_PROVIDER",
  "SID_CODE_LLM_MODEL",
  "SID_CODE_LLM_BASE_URL",
]);

/** 黑名单：始终移除的已知敏感变量 */
const ALWAYS_DENIED = new Set([
  // 数据库
  "DATABASE_URL",
  "DB_PASSWORD",
  "DB_PASS",
  "MYSQL_PASSWORD",
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
  "MONGODB_PASSWORD",
  // AWS
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  // 云服务
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
  "DIGITALOCEAN_TOKEN",
  "HEROKU_API_KEY",
  // CI/CD
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "CIRCLE_TOKEN",
  "TRAVIS_TOKEN",
  // 其他常见敏感变量
  "SLACK_TOKEN",
  "SLACK_WEBHOOK",
  "DISCORD_TOKEN",
  "TELEGRAM_TOKEN",
  "TWILIO_AUTH_TOKEN",
  "STRIPE_SECRET_KEY",
  "PAYPAL_SECRET",
  "JWT_SECRET",
  "SESSION_SECRET",
  "ENCRYPTION_KEY",
  "PRIVATE_KEY",
  "SSH_PRIVATE_KEY",
]);

/** 敏感名称模式（正则） */
const SENSITIVE_NAME_PATTERNS = [
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /CREDENTIAL/i,
  /PRIVATE[_-]?KEY/i,
  /API[_-]?KEY/i,
  /AUTH[_-]?KEY/i,
  /ACCESS[_-]?KEY/i,
];

/** 敏感值模式（正则） */
const SENSITIVE_VALUE_PATTERNS = [
  /^sk-[a-zA-Z0-9]{20,}$/,           // OpenAI API Key
  /^ghp_[a-zA-Z0-9]{36,}$/,          // GitHub Personal Access Token
  /^gho_[a-zA-Z0-9]{36,}$/,          // GitHub OAuth Token
  /^github_pat_[a-zA-Z0-9_]{82}$/,   // GitHub Fine-grained PAT
  /^glpat-[a-zA-Z0-9_-]{20,}$/,      // GitLab Personal Access Token
  /^xoxb-[a-zA-Z0-9-]+$/,            // Slack Bot Token
  /^xoxp-[a-zA-Z0-9-]+$/,            // Slack User Token
  /^-----BEGIN (RSA |DSA |EC )?PRIVATE KEY-----/, // 私钥
  /^[A-Za-z0-9+/]{40,}={0,2}$/,      // Base64 编码的长字符串（可能是密钥）
];

/**
 * 清理环境变量，移除敏感信息。
 *
 * 三层过滤：
 * 1. 白名单：始终保留的系统变量
 * 2. 黑名单：始终移除的已知敏感变量
 * 3. 模式匹配：移除名称或值匹配敏感模式的变量
 *
 * 返回清理后的环境变量副本（不修改 process.env）。
 */
export function sanitizeEnv(
  env: Record<string, string>,
  options?: SanitizeOptions
): Record<string, string> {
  const result: Record<string, string> = {};
  const allowed = new Set([...ALWAYS_ALLOWED, ...(options?.extraAllowed || [])]);
  const denied = new Set([...ALWAYS_DENIED, ...(options?.extraDenied || [])]);

  for (const [name, value] of Object.entries(env)) {
    // 1. 黑名单：最高优先级，直接拒绝（包括 extraDenied）
    if (denied.has(name)) {
      continue;
    }

    // 2. 白名单：直接通过
    if (allowed.has(name)) {
      result[name] = value;
      continue;
    }

    // 3. 模式匹配：检查名称和值
    const { safe } = isEnvVarSafe(name, value);
    if (safe) {
      result[name] = value;
    }
  }

  return result;
}

/**
 * 检查单个环境变量是否安全。
 * 用于调试和审计。
 */
export function isEnvVarSafe(name: string, value: string): { safe: boolean; reason?: string } {
  // 检查名称模式
  for (const pattern of SENSITIVE_NAME_PATTERNS) {
    if (pattern.test(name)) {
      return { safe: false, reason: `名称匹配敏感模式: ${pattern}` };
    }
  }

  // 检查值模式
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      return { safe: false, reason: `值匹配敏感模式: ${pattern}` };
    }
  }

  return { safe: true };
}
