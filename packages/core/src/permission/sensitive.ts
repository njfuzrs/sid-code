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
  /**
   * 自定义遮盖（可选）。缺省用 keepHead / keepTail 的头尾保留式遮盖。
   *
   * 两类规则需要它：PEM 整块要换成「类型 + 长度量级」占位（头尾保留对多行密钥无意义）；
   * `KEY=value` 赋值写法要**保留键名、只遮值**（键名是排查时最有用的线索，且不敏感）。
   */
  mask?: (match: RegExpExecArray) => string;
}

/**
 * 已知凭证前缀：值以这些开头时，赋值类规则不再要求「字母 + 数字混合」的多样性。
 * 只用于放宽二次校验，不单独构成命中条件。
 */
const KNOWN_SECRET_PREFIXES = [
  "sk-",
  "ghp_",
  "gho_",
  "ghs_",
  "github_pat_",
  "glpat-",
  "xox",
  "AKIA",
  "npm_",
  "eyJ",
];

/**
 * 赋值类规则（`*_API_KEY=` / `x-api-key:`）的值二次校验：只遮「像字面量凭证」的值。
 *
 * 朴素规则的误伤是实测出来的（PR-B 方案 §8.3）：`API_KEY = process.env.<某个变量>`（形如读环境变量的表达式）
 * 会被命中，而这类表达式恰恰出现在被测代码 / diff 里，遮掉会改写 tool_input，
 * 让评测的分歧分析失真。所以：
 *   - 含 `.` `(` `)` `$` `{` `}` 的是表达式 / 模板，不遮；含 `/` `\` 的是路径，不遮；
 *   - 长度 < 16 的不遮（真凭证几乎都更长，短值多是开关、枚举）；
 *   - 明显占位（xxxx、your-…、<…>、__…__、changeme、placeholder）不遮；
 *   - 不带已知前缀时要求同时含字母和数字——长常量名、驼峰变量名通常不含数字。
 */
function literalSecretValue(value: string): boolean {
  if (value.length < 16) return false;
  if (/[.(){}$/\\<>`]/.test(value)) return false;
  const lower = value.toLowerCase();
  if (
    lower.includes("xxxx") ||
    lower.startsWith("your-") ||
    lower.startsWith("your_") ||
    /^__.*__$/.test(value) ||
    lower.includes("changeme") ||
    lower.includes("placeholder") ||
    lower.includes("replace_me") ||
    lower.includes("replace-me")
  ) {
    return false;
  }
  if (KNOWN_SECRET_PREFIXES.some((p) => value.startsWith(p))) return true;
  return /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

/** 赋值类规则的统一遮盖：键名与分隔符原样保留，只遮值。约定第 1 组是「键 + 分隔符」，第 2 组是值。 */
function maskAssignment(m: RegExpExecArray): string {
  const prefix = m[1] ?? "";
  const value = m[2] ?? "";
  const rest = m[0].slice(prefix.length + value.length);
  return prefix + maskValue(value, 3, 4) + rest;
}

/** PEM 占位：保留密钥类型与字节量级（分歧分析仍能看出「这一步写了一个密钥」），正文全部抹掉。 */
function maskPem(m: RegExpExecArray): string {
  const kind = (m[1] ?? "").trim();
  const label = kind ? `${kind} PRIVATE KEY` : "PRIVATE KEY";
  return `<PEM ${label}:${m[0].length}B>`;
}

/**
 * 赋值类规则的二次校验：从命中串里取出值部分再判断。
 * 正则只负责「键名 + 分隔符 + 一段非空白」的形态，是否是字面量凭证交给 literalSecretValue。
 */
function assignmentValueOk(pattern: RegExp): (value: string) => boolean {
  // 用一个不带 g 标志的副本解析分组，避免与外层 exec 循环共享 lastIndex
  const single = new RegExp(pattern.source, pattern.flags.replace("g", ""));
  return (value: string) => {
    const m = single.exec(value);
    return m !== null && literalSecretValue(m[2] ?? "");
  };
}

/**
 * `*_API_KEY=` / `*_TOKEN=` / `*_SECRET=` 赋值写法（含 JSON 的 `"KEY": "value"` 形态）。
 * 键名前缀任意（`OPENAI_`、`MY_APP_`…），也接受裸 `API_KEY=`。
 * 第 1 组 = 键 + 引号 + 分隔符 + 可选开引号，第 2 组 = 值。
 */
const ENV_ASSIGNMENT_PATTERN =
  /\b((?:[A-Za-z0-9]+_)*(?:API_?KEY|TOKEN|SECRET(?:_KEY)?|ACCESS_KEY)["']?\s*[=:]\s*["']?)([^\s'",;]+)/gi;

/** 文本形态的鉴权请求头：`x-api-key: <value>`、`api-key=<value>`、`x-auth-token: <value>`。分组约定同上。 */
const HEADER_ASSIGNMENT_PATTERN =
  /(?<![A-Za-z0-9_-])((?:x-api-key|api-key|x-auth-token)["']?\s*[:=]\s*["']?)([^\s'",;]+)/gi;

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
  // ⚠️ `sk-` 系列**不放宽通用规则的字符类**（加 `-_`）。实测放宽后会命中
  // `cd tasks/task-qemu-alpine-ssh-key-setup` 里的 `sk-qemu-alpine-ssh-key-setup`、
  // `disk-usage-monitor-service_v2`、`fix/task-panel-dismiss-manual-exit`——`task-` / `disk-` /
  // `mask-` 前缀在路径与命令里极常见，改写的正是评测分歧分析依赖的 command / file_path。
  // 所以：带连字符的新格式一律走**显式前缀**，通用规则只补左边界。新增前缀类密钥照此办理。
  {
    type: "OpenAI Project Key",
    pattern: /(?<![A-Za-z0-9_-])sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,
    keepHead: 8,
    keepTail: 4,
  },
  {
    type: "OpenAI API Key",
    pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{20,}/g,
    keepHead: 3,
    keepTail: 4,
  },

  // 代码托管 Token
  { type: "GitHub Token", pattern: /gh[ps]_[A-Za-z0-9]{36,}/g, keepHead: 4, keepTail: 4 },
  {
    type: "GitHub Fine-grained Token",
    pattern: /github_pat_[A-Za-z0-9_]{22,}/g,
    keepHead: 11,
    keepTail: 4,
  },
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

  // 环境变量 / 配置赋值写法：`OPENAI_API_KEY=…`、`GITHUB_TOKEN: …`、`MY_SECRET=…`
  // 只遮值、保留键名；值必须像字面量凭证（见 literalSecretValue 的误伤约束）。
  {
    type: "凭证赋值",
    pattern: ENV_ASSIGNMENT_PATTERN,
    keepHead: 0,
    keepTail: 0,
    validate: assignmentValueOk(ENV_ASSIGNMENT_PATTERN),
    mask: maskAssignment,
  },
  // 文本形态的鉴权请求头（curl -H 'x-api-key: …'、日志里的头部打印）
  {
    type: "鉴权请求头",
    pattern: HEADER_ASSIGNMENT_PATTERN,
    keepHead: 0,
    keepTail: 0,
    validate: assignmentValueOk(HEADER_ASSIGNMENT_PATTERN),
    mask: maskAssignment,
  },

  // 私钥（PEM 整块）。旧规则只认 BEGIN 行：遮掉头一行，base64 正文与 END 行原样落盘，
  // 等于没遮；`ENCRYPTED PRIVATE KEY` 头也不认。现在：
  //   - 类型前缀任意（RSA / EC / DSA / OPENSSH / ENCRYPTED / 无），第 1 组捕获类型供占位用；
  //   - 有 END 行时遮到 END 行；**没有 END 行**（工具输出被截断时很常见）时遮到正文结束；
  //   - 正文字符类含 `\`，兼容 `JSON.stringify` 文本里的字面 `\n`（warn.log 就是这种）；
  //   - 有限量词 {0,16384}：真实私钥 < 4KB，上限防大文件上的回溯。
  {
    // type 名沿用旧值「SSH 私钥」：检测结果按 type 聚合告警（tool-executor），改名会断口径
    type: "SSH 私钥",
    pattern:
      /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----(?:[\s\S]{0,16384}?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|[A-Za-z0-9+/=\s\\:,-]{0,16384})/g,
    keepHead: 0,
    keepTail: 0,
    mask: maskPem,
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
      if (value.length === 0) {
        sp.pattern.lastIndex++; // 防零宽匹配死循环
        continue;
      }
      if (sp.validate && !sp.validate(value, match.index, text)) continue;
      const masked = sp.mask ? sp.mask(match) : maskValue(value, sp.keepHead, sp.keepTail);
      allMatches.push({ index: match.index, length: value.length, masked });
    }
  }

  // 去重：重叠区间只保留一个——起点更早者优先，同起点取更长者。
  //
  // 旧实现按起点倒序、只判断「新区间的起点是否落在已选区间内」，漏了「新区间从前面
  // 跨进已选区间」这一种重叠：两段都会被替换，而后一次替换用的是原文下标，结果是乱码。
  // PEM 整块（几 KB）里的 base64 正文随机撞上 `AKIA…` 之类的短规则，正好就是这种形态。
  allMatches.sort((a, b) => a.index - b.index || b.length - a.length);
  const deduped: typeof allMatches = [];
  let coveredUntil = -1;
  for (const m of allMatches) {
    if (m.index < coveredUntil) continue;
    deduped.push(m);
    coveredUntil = m.index + m.length;
  }

  // 从后往前替换，避免偏移
  deduped.reverse();
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
export function maskSensitiveJson(
  text: string,
  _indent = 0,
  onFieldError?: (err: unknown) => void,
  /** 字段级脱敏函数，缺省 maskSensitiveData；仅测试注入用于触发 fail-closed 路径 */
  masker: (s: string) => string = maskSensitiveData,
): string {
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
    let masked: string;
    try {
      masked = masker(decoded);
    } catch (err) {
      // fail-closed，粒度是**单个字符串字段**：只把出错的这一个值换成占位，
      // 其余字段（usage / 步骤 / 工具序列）照常落盘。整文件回落原文会泄露凭证，
      // 整文件占位又会让这条会话对评测整条作废——两头都不能接受。
      if (!onFieldError) throw err;
      onFieldError(err);
      out += JSON.stringify(REDACTION_FAILED_PLACEHOLDER);
      i = j + 1;
      continue;
    }
    // 未命中任何规则时原样回填，避免转义形态被规范化（如 中 → 中）
    out += masked === decoded ? rawLiteral : JSON.stringify(masked);
    i = j + 1;
  }

  return out;
}

/** 脱敏出错时替换该字符串字段的占位。固定文本，便于在轨迹里 grep 统计。 */
export const REDACTION_FAILED_PLACEHOLDER = "[REDACTION_FAILED]";

/**
 * 结构化逐字段脱敏（maskSensitiveJson 失效时的兜底）：parse → 逐个字符串值脱敏 → stringify。
 *
 * 代价是格式会按 indent 重排、超大整数可能丢精度，所以只在词法路径失败时才走这里；
 * 换来的是「无论脱敏函数出什么错，产物都是合法 JSON 且不含未脱敏原文」。
 * 输入本身不是 JSON 时抛出，由调用方决定整条占位。
 */
export function maskJsonByWalk(
  text: string,
  indent: number,
  onFieldError: (err: unknown) => void,
  masker: (s: string) => string = maskSensitiveData,
): string {
  const maskOne = (s: string): string => {
    try {
      return masker(s);
    } catch (err) {
      onFieldError(err);
      return REDACTION_FAILED_PLACEHOLDER;
    }
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return maskOne(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[maskOne(k)] = walk(val);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(JSON.parse(text)), null, indent || undefined);
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
