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
  /**
   * 二次校验（可选）。正则命中后再跑一遍，返回 false 则视为误报、不脱敏。
   *
   * 存在理由：纯字符类正则无法表达「这串数字在上下文里是不是一个独立的卡号」。
   * `\b` 只判断词/非词边界，而 `.` 是非词字符——所以 `0.4428123456780257`
   * 里的尾数 16 位会被信用卡号规则命中（真实事故，见 isolatedNumber 注释）。
   */
  validate?: (value: string, index: number, text: string) => boolean;
}

/**
 * Luhn 校验（信用卡号的行业标准校验位算法）。
 * 真实卡号必然通过；随机 16 位数字通过的概率仅 1/10。
 */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const code = digits.charCodeAt(i) - 48;
    if (code < 0 || code > 9) return false;
    let d = code;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * 判断命中的数字串是否「独立」——两侧都不是数字、也不是小数点/科学计数法的一部分。
 *
 * 事故背景（2026-08-07 实测）：轨迹落盘全部经 maskSensitiveData 收口，而
 * `session.traj` 里的 `"total_cost_usd": 0.4428123456780257` 的尾数
 * `4428123456780257` 恰好长 16 位、前缀 4 —— 被信用卡号规则命中并改写成
 * `0.4428********0257`。`*` 是真实字节，落盘后**整个文件 JSON.parse 失败**，
 * 直接把 `/trace` 与 `bun scripts/trace-digest.ts` 打死（单文件损坏即 rc=1）。
 *
 * 所以卡号两侧必须排除 `.` 与数字：小数尾数、时间戳、token 计数都不是卡号。
 */
function isolatedNumber(value: string, index: number, text: string): boolean {
  const before = index > 0 ? text[index - 1]! : "";
  const after = index + value.length < text.length ? text[index + value.length]! : "";
  // 前后紧邻小数点或数字 → 是更长数字/小数的一部分，不是独立卡号
  if (before === "." || after === ".") return false;
  if (before >= "0" && before <= "9") return false;
  if (after >= "0" && after <= "9") return false;
  return true;
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
  {
    type: "JWT",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    keepHead: 10,
    keepTail: 4,
  },

  // 数据库连接串
  {
    type: "DB 连接串",
    pattern: /(?:mysql|postgres|postgresql|mongodb|redis):\/\/[^\s'"]{10,}/gi,
    keepHead: 10,
    keepTail: 4,
  },

  // 密码赋值（key=value 或 key: value 形式）
  {
    type: "密码赋值",
    pattern: /(?:password|passwd|pwd|secret)[\s]*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi,
    keepHead: 10,
    keepTail: 0,
  },

  // SSH 私钥
  {
    type: "SSH 私钥",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    keepHead: 10,
    keepTail: 0,
  },

  // Slack Token
  { type: "Slack Token", pattern: /xox[bpors]-[A-Za-z0-9-]{10,}/g, keepHead: 5, keepTail: 4 },

  // npm Token
  { type: "npm Token", pattern: /npm_[A-Za-z0-9]{36,}/g, keepHead: 4, keepTail: 4 },

  // 信用卡号（简化：16 位数字，可含空格/横线分隔）
  // 两道二次校验，缺一不可：
  //   - isolatedNumber：排除小数尾数/长数字的一部分（`\b` 挡不住 `0.4428…` 里的 `.`）
  //   - luhnValid：真实卡号必过校验位；随机 16 位数字仅 1/10 概率误过
  {
    type: "信用卡号",
    pattern:
      /\b(?:4[0-9]{3}|5[1-5][0-9]{2}|3[47][0-9]{2}|6(?:011|5[0-9]{2}))[- ]?[0-9]{4}[- ]?[0-9]{4}[- ]?[0-9]{4}\b/g,
    keepHead: 4,
    keepTail: 4,
    validate: (value, index, text) =>
      isolatedNumber(value, index, text) && luhnValid(value.replace(/[- ]/g, "")),
  },

  // AWS Secret Key（40 位 base64 字符，前面有关键词）
  {
    type: "AWS Secret Key",
    pattern:
      /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)[\s]*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi,
    keepHead: 25,
    keepTail: 4,
  },

  // 私有 Token（通用 private_token / access_token 赋值）
  {
    type: "Private Token",
    pattern:
      /(?:private_token|access_token|api_token|auth_token)[\s]*[=:]\s*['"]?[A-Za-z0-9_\-.]{16,}['"]?/gi,
    keepHead: 15,
    keepTail: 4,
  },
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
      if (sp.validate && !sp.validate(match[0], match.index, text)) continue;
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
      if (sp.validate && !sp.validate(value, match.index, text)) continue;
      const masked = maskValue(value, sp.keepHead, sp.keepTail);
      allMatches.push({ index: match.index, length: value.length, masked });
    }
  }

  // 按位置从后往前排序，避免替换偏移
  allMatches.sort((a, b) => b.index - a.index);

  // 去重（重叠区间只保留最长的）
  const deduped: typeof allMatches = [];
  for (const m of allMatches) {
    const overlaps = deduped.some((d) => m.index >= d.index && m.index < d.index + d.length);
    if (!overlaps) {
      deduped.push(m);
    }
  }

  for (const m of deduped) {
    result = result.slice(0, m.index) + m.masked + result.slice(m.index + m.length);
  }

  return result;
}

/**
 * 结构化脱敏：对 JSON 文本**只脱敏字符串字面量内部**，绝不触碰 number / bool / null。
 *
 * 为什么需要独立一层（而不是只靠 validate 兜）：
 *   `maskSensitiveData` 是纯文本替换，对「这个位置是 JSON 数字还是字符串」一无所知。
 *   信用卡号那条已用 Luhn + isolatedNumber 修掉，但任何**未来新增**的数字类规则
 *   （手机号、身份证、订单号…）都会重新踩同一个坑，而症状是「轨迹文件静默损坏」
 *   —— 这类故障极难归因。所以落盘路径改走本函数：从类型上消灭这一整类 bug，
 *   而不是逐条规则打补丁。
 *
 * 实现方式是**词法扫描而非 parse→stringify**：逐字符走一遍，只在字符串字面量的
 * 区间内做替换，其余字节原样保留。这样做的原因有两个，都很实际：
 *   1. **保持原格式**。parse→stringify 会重排缩进/键序，让「写入的文本」与
 *      「调用方序列化出来的文本」不再逐字节相等——测试和 diff 都会莫名其妙地变。
 *   2. **不改变数值表示**。JSON.parse 走 IEEE754，`1e999`→`Infinity`、超长整数
 *      丢精度；数字压根不碰才是最稳的。
 *
 * 非 JSON 输入（或扫描中发现结构不合法）自动回退到纯文本 maskSensitiveData。
 *
 * @param text 待脱敏文本（通常是 JSON.stringify 的产物）
 * @param _indent 兼容保留：词法扫描天然保持原缩进，本参数已无作用
 */
export function maskSensitiveJson(text: string, _indent = 0): string {
  // 先确认是合法 JSON——非 JSON（日志行、纯文本）必须走纯文本脱敏，否则
  // 「没有引号包裹的凭证」会被整条漏掉。
  try {
    JSON.parse(text);
  } catch {
    return maskSensitiveData(text);
  }

  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i]!;
    if (ch !== '"') {
      // 字符串字面量之外的一切（数字、字面量、空白、标点）原样保留
      out += ch;
      i++;
      continue;
    }

    // 找到字符串字面量的结束引号（正确处理 \\ 与 \" 转义）
    let j = i + 1;
    let closed = false;
    while (j < n) {
      const c = text[j]!;
      if (c === "\\") {
        j += 2; // 跳过被转义的那个字符
        continue;
      }
      if (c === '"') {
        closed = true;
        break;
      }
      j++;
    }
    if (!closed) {
      // 结构异常（理论上 JSON.parse 已经拦住）→ 保守起见整体退回纯文本脱敏
      return maskSensitiveData(text);
    }

    const rawLiteral = text.slice(i, j + 1); // 含两侧引号
    let decoded: string;
    try {
      decoded = JSON.parse(rawLiteral) as string;
    } catch {
      out += rawLiteral;
      i = j + 1;
      continue;
    }
    const masked = maskSensitiveData(decoded);
    // 未命中任何规则时原样回填，避免转义形态被规范化（如 中 → 中）
    out += masked === decoded ? rawLiteral : JSON.stringify(masked);
    i = j + 1;
  }

  return out;
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
