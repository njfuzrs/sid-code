/**
 * 密钥识别规则表（B15）
 *
 * ── 为什么要有这个文件 ──
 *
 * 此前内容扫描规则分散在多处各自维护：`permission/sensitive.ts` 的
 * `SENSITIVE_PATTERNS`（23 条）、`llm/hooks/secret-redact.ts` 的 `BUILTIN_PATTERNS`
 * （7 类）、`memory/team/secret-scanner.ts` 的 gitleaks 子集（35 条）。
 * 同一形态在多处各写一条正则，长度还各不相同，漂移是必然的 —— 2026-11-10 实测：
 * `github_pat_` 在 R1 是 `{22,}`、在 R2 完全缺失、在 R3 是精确 `{82}`，
 * 结果是「私有记忆可以写进 fine-grained PAT」这个真实漏点。
 *
 * 所以规则本体只在这里写一次，消费方按「档位」取。
 *
 * ── 档位是规则的属性，不是消费方的选择 ──
 *
 * `strict`：有独特前缀、形态无可歧义，用于「命中即拒」场景（记忆闸门、团队同步）。
 *           误报代价高 —— 正常写入被拒且没有逃生舱，所以只收近零误报的规则。
 * `wide`：  需要上下文推断（赋值写法、DB URL、Bearer、宽松长度），用于「遮了不伤功能」
 *           的落盘场景（轨迹、审计）。误报代价只是多遮几个字符，漏遮的代价是凭证落盘。
 *
 * 一条规则可以同时属于两档（形态既可判又值得遮）。消费方只声明自己要哪一档，
 * 不在消费侧再挑一遍规则 —— 那等于把「哪些规则严格」这个判断复制一份，又会漂。
 *
 * ── 呈现形态留在消费方 ──
 *
 * R1 保形遮盖（`AKIA****1234`）、R2 占位（`<REDACTED:github_token>`）、
 * R3 只报 label —— 同一命中三种输出，都是对的，因为读者不同。
 *
 * ── fixture 守护不在这里 ──
 *
 * `secret-redact.ts` 的 `fixtureGuard`（命中附近出现 EXAMPLE / FAKE / 占位就跳过）
 * 留在 R2 的消费侧：它是「命中之后要不要当成真凭证」的判断，依赖上下文（前后 80 字符），
 * 而规则层只看命中本身。下沉进规则表会让 R1 也开始放过 `AKIA…EXAMPLE`，
 * 与「落盘宁可多遮」的准则相反（R1 现在照遮它，是对的）。
 *
 * ── 已知不覆盖：值含 `/` 的赋值 ──
 *
 * `MY_API_KEY=/path/abcdef…` 三套全漏，因为 `literalSecretValue` 把含 `/` 的值判为路径。
 * 这条**不能简单放宽** —— 放宽会让 `KEY=/usr/local/bin/xxx` 这类路径被遮。
 * 属于已知不覆盖，不要试图「顺手修」（详见 B15 方案 §3.3）。
 */

/** 规则档位。strict = 命中即拒场景；wide = 脱敏场景 */
export type SecretTier = "strict" | "wide";

/** 单条密钥识别规则 */
export interface SecretRule {
  /**
   * 稳定 id，一致性测试按它索引。
   * 与 R3 的 gitleaks rule id 对齐（kebab-case），这样两边去重时不必维护第二套映射表。
   */
  id: string;
  /** 可读标签。R1 的 `detectSensitiveData().type` 用它（tool-executor 按它聚合告警，改名会断口径） */
  label: string;
  /** 正则。不带 `g` 由消费方复制时补；运行时拼接的前缀（见文件末尾）用函数形式 */
  pattern: RegExp | (() => RegExp);
  /** 这条规则参与的档位 */
  tiers: SecretTier[];
  /**
   * 二次校验（可选）。正则命中后再跑一遍，返回 false 视为误报。
   * 语义是「返回 true = 这条命中有效」，与 R2 的 falsePositiveGuard（true = 跳过）相反，
   * 后者留在消费侧，不要混用。
   */
  validate?: (value: string, index: number, text: string) => boolean;
  /** 保形遮盖时保留头部字符数（wide 档消费方用） */
  keepHead?: number;
  /** 保形遮盖时保留尾部字符数（wide 档消费方用） */
  keepTail?: number;
  /** 自定义遮盖（PEM 整块、赋值写法保留键名） */
  mask?: (m: RegExpExecArray) => string;
  /** R2 占位名（`<REDACTED:xxx>`）；缺省由 id 派生。只在 strict 档有意义 */
  category?: string;
  /**
   * 匹配串的第 1 组是「键名 + 分隔符」、第 2 组是值。
   * 呈现时保留键名、只动值（R1 的 maskAssignment 与 R2 的 replacer 共用这个约定）。
   */
  keepKeyName?: boolean;
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

/** 遮盖单个值 */
export function maskValue(value: string, keepHead: number, keepTail: number): string {
  if (value.length <= keepHead + keepTail + 2) {
    // 太短，全部遮盖
    return value.slice(0, Math.min(2, value.length)) + "****";
  }

  const head = value.slice(0, keepHead);
  const tail = keepTail > 0 ? value.slice(-keepTail) : "";
  const maskLen = Math.min(value.length - keepHead - keepTail, 8);
  return head + "*".repeat(maskLen) + tail;
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

// ============================================================================
// 规则表
// ============================================================================
//
// 顺序有意义：R2 的 redact 是链式替换，PEM 整块必须排在不改结构的位置
// （正文被替换成占位不影响 BEGIN/END 配对）；R1 是 exec 循环 + 区间去重，顺序不影响结果。
//
// 新增规则时先回答两个问题：
//   1. 它的误报代价是「多遮几个字符」还是「正常写入被拒」？前者 wide，后者才 strict。
//   2. 同一形态是否已有规则？有就改那一条的 tiers，不要新增一条更宽的。

export const SECRET_RULES: SecretRule[] = [
  // ── 云厂商 ──
  {
    id: "aws-access-token",
    label: "AWS Access Key",
    // 前缀集合取 gitleaks 与 R1 的并集（ASIA/ABIA/ACCA/A3T 都是真实 AWS key 前缀），
    // 字符类用 R1 的 [0-9A-Z]（比 base32 的 [A-Z2-7] 宽）—— wide 档多遮无害，strict 档不漏更重要。
    pattern: /(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}/g,
    tiers: ["strict", "wide"],
    keepHead: 4,
    keepTail: 4,
    category: "aws_access_key",
  },
  {
    id: "aliyun-access-key",
    label: "阿里云 AccessKey",
    pattern: /LTAI[A-Za-z0-9]{12,20}/g,
    tiers: ["wide"],
    keepHead: 4,
    keepTail: 4,
    category: "aliyun_access_key",
  },
  {
    id: "tencent-secret-id",
    label: "腾讯云 SecretId",
    pattern: /AKID[A-Za-z0-9]{13,40}/g,
    tiers: ["wide"],
    keepHead: 4,
    keepTail: 4,
    category: "tencent_secret_id",
  },

  // ── AI 服务密钥 ──
  {
    id: "anthropic-api-key",
    label: "Anthropic API Key",
    // R3 用的是精确形态（`{93}AA`），见文件末尾 extension 的说明：
    // 团队记忆误拒代价高，只收 gitleaks 精确形态；这两条不合并。
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    tiers: ["strict", "wide"],
    keepHead: 7,
    keepTail: 4,
    category: "llm_api_key",
  },
  // ⚠️ `sk-` 系列**不放宽通用规则的字符类**（加 `-_`）。实测放宽后会命中
  // `cd tasks/task-qemu-alpine-ssh-key-setup` 里的 `sk-qemu-alpine-ssh-key-setup`、
  // `disk-usage-monitor-service_v2`、`fix/task-panel-dismiss-manual-exit`——`task-` / `disk-` /
  // `mask-` 前缀在路径与命令里极常见，改写的正是评测分歧分析依赖的 command / file_path。
  // 所以：带连字符的新格式一律走**显式前缀**，通用规则只补左边界。新增前缀类密钥照此办理。
  {
    id: "openai-project-key",
    label: "OpenAI Project Key",
    pattern: /(?<![A-Za-z0-9_-])sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,
    tiers: ["strict", "wide"],
    keepHead: 8,
    keepTail: 4,
    category: "llm_api_key",
  },
  {
    id: "openai-api-key",
    label: "OpenAI API Key",
    pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{20,}/g,
    tiers: ["strict", "wide"],
    keepHead: 3,
    keepTail: 4,
    category: "llm_api_key",
  },

  // ── 代码托管 Token ──
  {
    id: "github-pat",
    label: "GitHub Token",
    // 5 种前缀（ghp/gho/ghu/ghs/ghr）取 R2 与 R3 的并集；{36,} 取 R1 的宽松长度。
    // R3 的 ghp_{36} 精确形态被这条覆盖，不再单列（prefix 独特，放宽到 36+ 误报仍近零）。
    pattern: /gh[poushr]_[A-Za-z0-9]{36,}/g,
    tiers: ["strict", "wide"],
    keepHead: 4,
    keepTail: 4,
    category: "github_token",
  },
  {
    id: "github-fine-grained-pat",
    label: "GitHub Fine-grained Token",
    // B15 的漏点之一：R2 此前完全不认这个形态，私有记忆能写进 fine-grained PAT。
    // 与 R3 的 `{82}` 精确形态的关系：R3 保留精确版（团队记忆误拒代价高），
    // 这条 `{22,}` 给 R1/R2 —— 前缀独特，放宽到 22+ 误报仍近零，属 strict 该收的。
    pattern: /github_pat_[A-Za-z0-9_]{22,}/g,
    tiers: ["strict", "wide"],
    keepHead: 11,
    keepTail: 4,
    category: "github_token",
  },
  {
    id: "gitlab-pat",
    label: "GitLab Token",
    pattern: /glpat-[A-Za-z0-9_-]{20,}/g,
    tiers: ["strict", "wide"],
    keepHead: 6,
    keepTail: 4,
    category: "gitlab_token",
  },

  // ── 通用 Token ──
  {
    id: "bearer-token",
    label: "Bearer Token",
    // 字符类取 R1 ∪ R2 的并集（R2 认 base64 的 `=`）
    pattern: /Bearer\s+[A-Za-z0-9_\-\.=]{20,}/g,
    tiers: ["strict", "wide"],
    keepHead: 10,
    keepTail: 4,
    category: "bearer_token",
  },
  {
    id: "basic-auth",
    label: "Basic Auth",
    pattern: /Basic\s+[A-Za-z0-9+/=]{20,}/g,
    tiers: ["wide"],
    keepHead: 9,
    keepTail: 4,
    category: "basic_auth",
  },
  {
    id: "jwt",
    label: "JWT",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    tiers: ["wide"],
    keepHead: 10,
    keepTail: 4,
    category: "jwt",
  },

  // ── 数据库连接串 ──
  // 拆两条，因为两档对「无认证信息的 URL」处理不同：
  //   - wide 档（落盘）宁可多遮：`redis://localhost:6379` 也遮，代价只是排查时少看几个字符；
  //   - strict 档（记忆闸门）只收 `user:pwd@` 形态：把 `redis://localhost` 判成凭证会挡正常写入。
  {
    id: "db-conn-string",
    label: "DB 连接串",
    pattern: /(?:mysql|postgres|postgresql|mongodb(?:\+srv)?|redis):\/\/[^\s'"]{10,}/gi,
    tiers: ["wide"],
    keepHead: 10,
    keepTail: 4,
    category: "db_conn_string",
  },
  {
    id: "db-conn-string-auth",
    label: "DB 连接串（含认证）",
    // 第 1 组 schema、第 2 组 user、第 3 组 password（R2 的呈现要保留 schema/host，只遮 password）
    pattern: /\b(postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/([^\s'":@]+):([^@\s'"]+)@/g,
    tiers: ["strict"],
    category: "db_conn_string",
  },

  // ── 密码 / 凭据赋值 ──
  // 密码赋值只进 wide：`password: process.env.DB_PASS` 这类代码片段会被它命中，
  // 落盘多遮无害，但记忆闸门若据此拒写就是误伤。
  {
    id: "password-assignment",
    label: "密码赋值",
    pattern: /(?:password|passwd|pwd|secret)[\s]*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi,
    tiers: ["wide"],
    keepHead: 10,
    keepTail: 0,
    category: "password_assignment",
  },
  // 环境变量 / 配置赋值写法：`OPENAI_API_KEY=…`、`GITHUB_TOKEN: …`、`MY_SECRET=…`
  // 只遮值、保留键名；值必须像字面量凭证（见 literalSecretValue 的误伤约束）。
  // B15：这条此前只在 R1，R2 的 GENERIC_API_KEY 只认 api_key/access_token/secret_key 三个键名，
  // 所以 `SECRET='…'` / `AWS_SECRET_ACCESS_KEY=…` 写不进私有记忆的闸门是漏的。
  {
    id: "env-assignment",
    label: "凭证赋值",
    pattern: ENV_ASSIGNMENT_PATTERN,
    tiers: ["strict", "wide"],
    keepHead: 0,
    keepTail: 0,
    validate: assignmentValueOk(ENV_ASSIGNMENT_PATTERN),
    mask: maskAssignment,
    keepKeyName: true,
    category: "api_key",
  },
  // 文本形态的鉴权请求头（curl -H 'x-api-key: …'、日志里的头部打印）
  {
    id: "auth-header",
    label: "鉴权请求头",
    pattern: HEADER_ASSIGNMENT_PATTERN,
    tiers: ["strict", "wide"],
    keepHead: 0,
    keepTail: 0,
    validate: assignmentValueOk(HEADER_ASSIGNMENT_PATTERN),
    mask: maskAssignment,
    keepKeyName: true,
    // R2 此前经 GENERIC_API_KEY 的 `api[_-]?key` 命中 x-api-key，占位名是 api_key —— 保持不变
    category: "api_key",
  },

  // ── 私钥（PEM 整块）──
  // 旧规则只认 BEGIN 行：遮掉头一行，base64 正文与 END 行原样落盘，等于没遮；
  // `ENCRYPTED PRIVATE KEY` 头也不认。现在：
  //   - 类型前缀任意（RSA / EC / DSA / OPENSSH / ENCRYPTED / 无），第 1 组捕获类型供占位用；
  //   - 有 END 行时遮到 END 行；**没有 END 行**（工具输出被截断时很常见）时遮到正文结束；
  //   - 正文字符类含 `\`，兼容 `JSON.stringify` 文本里的字面 `\n`（warn.log 就是这种）；
  //   - 有限量词 {0,16384}：真实私钥 < 4KB，上限防大文件上的回溯。
  {
    // label 沿用旧值「SSH 私钥」：检测结果按 type 聚合告警（tool-executor），改名会断口径
    id: "private-key",
    label: "SSH 私钥",
    pattern:
      /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----(?:[\s\S]{0,16384}?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|[A-Za-z0-9+/=\s\\:,-]{0,16384})/g,
    tiers: ["strict", "wide"],
    keepHead: 0,
    keepTail: 0,
    mask: maskPem,
    category: "private_key",
  },

  // ── 其它平台 ──
  {
    id: "slack-token",
    label: "Slack Token",
    pattern: /xox[bpors]-[A-Za-z0-9-]{10,}/g,
    tiers: ["wide"],
    keepHead: 5,
    keepTail: 4,
    category: "slack_token",
  },
  {
    id: "npm-token",
    label: "npm Token",
    pattern: /npm_[A-Za-z0-9]{36,}/g,
    tiers: ["wide"],
    keepHead: 4,
    keepTail: 4,
    category: "npm_token",
  },

  // ── 信用卡号（简化：16 位数字，可含空格/横线分隔）──
  // 两道二次校验，缺一不可：
  //   - isolatedNumber：排除小数尾数/长数字的一部分（`\b` 挡不住 `0.4428…` 里的 `.`）
  //   - luhnValid：真实卡号必过校验位；随机 16 位数字仅 1/10 概率误过
  {
    id: "credit-card",
    label: "信用卡号",
    pattern:
      /\b(?:4[0-9]{3}|5[1-5][0-9]{2}|3[47][0-9]{2}|6(?:011|5[0-9]{2}))[- ]?[0-9]{4}[- ]?[0-9]{4}[- ]?[0-9]{4}\b/g,
    tiers: ["wide"],
    keepHead: 4,
    keepTail: 4,
    validate: (value, index, text) =>
      isolatedNumber(value, index, text) && luhnValid(value.replace(/[- ]/g, "")),
    category: "credit_card",
  },

  // ── AWS Secret Key / 私有 Token ──
  {
    id: "aws-secret-key",
    label: "AWS Secret Key",
    pattern:
      /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)[\s]*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi,
    tiers: ["strict", "wide"],
    keepHead: 25,
    keepTail: 4,
    category: "aws_secret_key",
  },
  {
    id: "private-token",
    label: "Private Token",
    pattern:
      /(?:private_token|access_token|api_token|auth_token)[\s]*[=:]\s*['"]?[A-Za-z0-9_\-.]{16,}['"]?/gi,
    tiers: ["strict", "wide"],
    keepHead: 15,
    keepTail: 4,
    category: "private_token",
  },
];

/** 按 id 取规则（一致性测试与 R3 的引用都用它索引） */
export function getSecretRule(id: string): SecretRule | undefined {
  return SECRET_RULES.find((r) => r.id === id);
}

/** 取某一档的全部规则 */
export function rulesForTier(tier: SecretTier): SecretRule[] {
  return SECRET_RULES.filter((r) => r.tiers.includes(tier));
}

/**
 * 把规则编译成带 `g` 的正则。
 *
 * 每次调用返回**新实例**：R1 的 exec 循环依赖 `lastIndex`，R2 的链式 replace 也会
 * 复用同一个 RegExp 对象，共享实例会让两条消费路径互相干扰。
 * 消费方自己缓存编译结果（模块级），不要每次脱敏都重编。
 */
export function compileSecretRule(rule: SecretRule): RegExp {
  const base = typeof rule.pattern === "function" ? rule.pattern() : rule.pattern;
  return new RegExp(base.source, base.flags.includes("g") ? base.flags : base.flags + "g");
}
