/**
 * 敏感数据检测与遮盖
 * 20 种敏感数据模式：云服务密钥、AI 密钥、代码托管 Token、通用模式等
 */

/** 敏感数据匹配结果 */
export interface SensitiveMatch {
  type: string;
  value: string;
  index: number;
}

/** 敏感数据模式定义 */
interface SensitivePattern {
  type: string;
  pattern: RegExp;
  /** 遮盖时保留头部字符数 */
  keepHead: number;
  /** 遮盖时保留尾部字符数 */
  keepTail: number;
}

const SENSITIVE_PATTERNS: SensitivePattern[] = [
  // 云服务密钥
  { type: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/g, keepHead: 4, keepTail: 4 },
  { type: "阿里云 AccessKey", pattern: /LTAI[A-Za-z0-9]{12,20}/g, keepHead: 4, keepTail: 4 },
  { type: "腾讯云 SecretId", pattern: /AKID[A-Za-z0-9]{13,40}/g, keepHead: 4, keepTail: 4 },

  // AI 服务密钥
  { type: "Anthropic API Key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, keepHead: 7, keepTail: 4 },
  { type: "OpenAI API Key", pattern: /sk-[A-Za-z0-9]{20,}/g, keepHead: 3, keepTail: 4 },

  // 代码托管 Token
  { type: "GitHub Token", pattern: /gh[ps]_[A-Za-z0-9]{36,}/g, keepHead: 4, keepTail: 4 },
  { type: "GitHub OAuth Token", pattern: /gho_[A-Za-z0-9]{36,}/g, keepHead: 4, keepTail: 4 },
  { type: "GitLab Token", pattern: /glpat-[A-Za-z0-9_-]{20,}/g, keepHead: 6, keepTail: 4 },

  // 通用 Token
  { type: "Bearer Token", pattern: /Bearer\s+[A-Za-z0-9_\-.]{20,}/g, keepHead: 10, keepTail: 4 },
  { type: "Basic Auth", pattern: /Basic\s+[A-Za-z0-9+/=]{20,}/g, keepHead: 9, keepTail: 4 },
  { type: "JWT", pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, keepHead: 10, keepTail: 4 },

  // 数据库连接串
  { type: "DB 连接串", pattern: /(?:mysql|postgres|postgresql|mongodb|redis):\/\/[^\s'"]{10,}/gi, keepHead: 10, keepTail: 4 },

  // 密码赋值（key=value 或 key: value 形式）
  { type: "密码赋值", pattern: /(?:password|passwd|pwd|secret)[\s]*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi, keepHead: 10, keepTail: 0 },

  // SSH 私钥
  { type: "SSH 私钥", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, keepHead: 10, keepTail: 0 },

  // Slack Token
  { type: "Slack Token", pattern: /xox[bpors]-[A-Za-z0-9-]{10,}/g, keepHead: 5, keepTail: 4 },

  // npm Token
  { type: "npm Token", pattern: /npm_[A-Za-z0-9]{36,}/g, keepHead: 4, keepTail: 4 },

  // 信用卡号（简化：16 位数字，可含空格/横线分隔）
  { type: "信用卡号", pattern: /\b(?:4[0-9]{3}|5[1-5][0-9]{2}|3[47][0-9]{2}|6(?:011|5[0-9]{2}))[- ]?[0-9]{4}[- ]?[0-9]{4}[- ]?[0-9]{4}\b/g, keepHead: 4, keepTail: 4 },

  // AWS Secret Key（40 位 base64 字符，前面有关键词）
  { type: "AWS Secret Key", pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)[\s]*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi, keepHead: 25, keepTail: 4 },

  // 私有 Token（通用 private_token / access_token 赋值）
  { type: "Private Token", pattern: /(?:private_token|access_token|api_token|auth_token)[\s]*[=:]\s*['"]?[A-Za-z0-9_\-.]{16,}['"]?/gi, keepHead: 15, keepTail: 4 },
];

/**
 * 检测文本中的敏感数据
 */
export function detectSensitiveData(text: string): SensitiveMatch[] {
  const matches: SensitiveMatch[] = [];

  for (const sp of SENSITIVE_PATTERNS) {
    // 重置 lastIndex（全局正则需要）
    sp.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = sp.pattern.exec(text)) !== null) {
      matches.push({
        type: sp.type,
        value: match[0],
        index: match.index,
      });
    }
  }

  return matches;
}

/**
 * 遮盖文本中的敏感数据
 * 保留头尾各 N 个字符，中间用 * 填充
 */
export function maskSensitiveData(text: string): string {
  let result = text;

  // 按匹配位置从后往前替换，避免偏移问题
  const allMatches: { index: number; length: number; masked: string }[] = [];

  for (const sp of SENSITIVE_PATTERNS) {
    sp.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = sp.pattern.exec(text)) !== null) {
      const value = match[0];
      const masked = maskValue(value, sp.keepHead, sp.keepTail);
      allMatches.push({ index: match.index, length: value.length, masked });
    }
  }

  // 按位置从后往前排序，避免替换偏移
  allMatches.sort((a, b) => b.index - a.index);

  // 去重（重叠区间只保留最长的）
  const deduped: typeof allMatches = [];
  for (const m of allMatches) {
    const overlaps = deduped.some(
      (d) => m.index >= d.index && m.index < d.index + d.length,
    );
    if (!overlaps) {
      deduped.push(m);
    }
  }

  for (const m of deduped) {
    result = result.slice(0, m.index) + m.masked + result.slice(m.index + m.length);
  }

  return result;
}

/** 遮盖单个值 */
function maskValue(value: string, keepHead: number, keepTail: number): string {
  if (value.length <= keepHead + keepTail + 2) {
    // 太短，全部遮盖
    return value.slice(0, Math.min(2, value.length)) + "****";
  }

  const head = value.slice(0, keepHead);
  const tail = keepTail > 0 ? value.slice(-keepTail) : "";
  const maskLen = Math.min(value.length - keepHead - keepTail, 8);
  return head + "*".repeat(maskLen) + tail;
}
