/**
 * SecretRedactHook — runtime secret redaction
 *
 * 实现: ADR-026 §3 接口设计 + §4 实施方案
 *
 * 7 类 pattern (§3.1):
 *   1. GitHub Token   ghp_/gho_/ghu_/ghs_/ghr_
 *   2. LLM API Key    sk-* / sk-proj-* / sk-ant-*
 *   3. AWS Access Key AKIA[A-Z0-9]{16}
 *   4. Generic API Key  api_key/access_token/secret_key = "..."
 *   5. Bearer Token   Authorization: Bearer xxx
 *   6. Private Key    -----BEGIN ... PRIVATE KEY-----
 *   7. DB Conn String postgres://user:pwd@host
 *
 * 误报守护 (§3.3): 测试 fixture / 代码标识符 / markdown 占位说明
 */

import type { DetectMatch, RedactInput, RedactPattern, RedactResult, SecretHit } from "./types.ts";

// ============================================================================
// 内置 patterns (按 ADR-026 §3.1 顺序)
// ============================================================================

/** 测试 fixture 标记: EXAMPLE / FAKE / TEST_ / DUMMY / PLACEHOLDER (大小写不敏感) */
const FIXTURE_MARKERS = /(EXAMPLE|FAKE|TEST_|DUMMY|PLACEHOLDER|FAKEKEY|EXAMPLEKEY)/i;

/** markdown 占位说明锚点 */
const PLACEHOLDER_HINTS = /(占位|示例|sample|mock|placeholder|example)/i;

/** 上下文窗口大小 (前后各取 N 字符判断 false-positive guard) */
const CONTEXT_WINDOW = 80;

function getContext(text: string, start: number, end: number): string {
  const lo = Math.max(0, start - CONTEXT_WINDOW);
  const hi = Math.min(text.length, end + CONTEXT_WINDOW);
  return text.slice(lo, hi);
}

/** 通用 fixture 守护: match 含 EXAMPLE/FAKE 等 = 跳过 */
function fixtureGuard(match: string, context: string): boolean {
  if (FIXTURE_MARKERS.test(match)) return true;
  if (PLACEHOLDER_HINTS.test(context)) return true;
  return false;
}

/** GitHub Token: ghp_ / gho_ / ghu_ / ghs_ / ghr_ + 36 chars */
const GITHUB_TOKEN: RedactPattern = {
  category: "github_token",
  pattern: /\bgh[poushr]_[A-Za-z0-9]{36}\b/g,
  replacer: () => "<REDACTED:github_token>",
  falsePositiveGuard: fixtureGuard,
};

/** OpenAI / Anthropic / 类 LLM API Key */
const LLM_API_KEY: RedactPattern = {
  category: "llm_api_key",
  // sk- 后跟 20+ 安全字符; 排除路径分隔以避免误命中如 sk-foo/bar
  pattern: /\bsk(?:-proj|-ant)?-[A-Za-z0-9_\-]{20,}\b/g,
  replacer: () => "<REDACTED:llm_api_key>",
  falsePositiveGuard: fixtureGuard,
};

/** AWS Access Key */
const AWS_ACCESS_KEY: RedactPattern = {
  category: "aws_access_key",
  pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  replacer: () => "<REDACTED:aws_access_key>",
  // 注意: AKIAIOSFODNN7EXAMPLE 是 AWS 官方文档 placeholder, 测试 fixture 内常见
  falsePositiveGuard: fixtureGuard,
};

/**
 * Generic API Key — `api_key = "..."` / `access_token: "..."` 等
 * 保留 key 名, 只 redact value
 */
const GENERIC_API_KEY: RedactPattern = {
  category: "api_key",
  pattern:
    /\b(api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9_\-]{16,})\b["']?/gi,
  replacer: (match) => {
    // 保留 key 名 + 分隔符, 只替换 value
    const keep = match.match(/^([^"':=]+[:=]\s*["']?)/);
    const prefix = keep ? keep[1] : "";
    // 末尾若有引号也保留
    const suffix = /["']$/.test(match) ? match.slice(-1) : "";
    return `${prefix}<REDACTED:api_key>${suffix}`;
  },
  falsePositiveGuard: (match, context) => {
    // 代码标识符: 全大写变量名作为类型/常量声明 (`const SECRET_KEY = process.env...`)
    // 仅当 value 是 process.env / require / 函数调用 时跳过 (那不是真 secret)
    const valuePart = match.replace(/^[^"':=]+[:=]\s*["']?/, "").replace(/["']$/, "");
    if (/^(process\.env|require|import|getenv|os\.environ)/.test(valuePart)) return true;
    if (fixtureGuard(valuePart, context)) return true;
    return false;
  },
};

/** Bearer Token */
const BEARER_TOKEN: RedactPattern = {
  category: "bearer_token",
  pattern: /\bBearer\s+([A-Za-z0-9_\-\.=]{20,})\b/g,
  replacer: () => "Bearer <REDACTED:bearer_token>",
  falsePositiveGuard: (match, context) => {
    const tokenPart = match.replace(/^Bearer\s+/, "");
    return fixtureGuard(tokenPart, context);
  },
};

/** Private Key — 整段 (BEGIN ... END) 替换 */
const PRIVATE_KEY: RedactPattern = {
  category: "private_key",
  // 跨行匹配 BEGIN…END
  pattern:
    /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED)? ?PRIVATE KEY-----[\s\S]*?-----END (?:RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED)? ?PRIVATE KEY-----/g,
  replacer: () => "<REDACTED:private_key>",
};

/** DB Connection String — 保留 schema/host, redact password */
const DB_CONN_STRING: RedactPattern = {
  category: "db_conn_string",
  // 形如 postgres://user:pwd@host[:port]/db
  pattern: /\b(postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/([^\s'":@]+):([^@\s'"]+)@/g,
  replacer: (match) => {
    return match.replace(/(:\/\/[^\s'":@]+:)([^@\s'"]+)(@)/, "$1<REDACTED:db_password>$3");
  },
  // 仅当 password 部分本身是 fixture 标记 (FAKE/EXAMPLE/PLACEHOLDER) 时才跳过.
  // 不使用 context 范围扫描——host 可能含 example.com 这类无害域名,
  // 误把真 conn string 放过去比让 example.com host 误报 redact 更危险.
  falsePositiveGuard: (match, _context) => {
    const pwd = match.match(/:\/\/[^\s'":@]+:([^@\s'"]+)@/)?.[1] ?? "";
    return FIXTURE_MARKERS.test(pwd);
  },
};

const BUILTIN_PATTERNS: RedactPattern[] = [
  PRIVATE_KEY, // 优先, 整段匹配
  GITHUB_TOKEN,
  LLM_API_KEY,
  AWS_ACCESS_KEY,
  BEARER_TOKEN,
  GENERIC_API_KEY,
  DB_CONN_STRING,
];

// ============================================================================
// SecretRedactHook
// ============================================================================

export class SecretRedactHook {
  private patterns: RedactPattern[];

  constructor(patterns?: RedactPattern[]) {
    this.patterns = patterns ?? [...BUILTIN_PATTERNS];
  }

  /** 注册自定义 pattern (企业 SDK key 等) */
  registerPattern(
    category: string,
    pattern: RegExp,
    replacer: (match: string) => string,
    falsePositiveGuard?: (match: string, context: string) => boolean,
  ): void {
    this.patterns.push({ category, pattern, replacer, falsePositiveGuard });
  }

  /** 仅检测, 不替换 (策略决策用 — 例如 save_memory 决定是否拒绝写入) */
  detect(text: string): DetectMatch[] {
    const hits: DetectMatch[] = [];
    for (const p of this.patterns) {
      const re = new RegExp(p.pattern.source, p.pattern.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (p.falsePositiveGuard) {
          const ctx = getContext(text, start, end);
          if (p.falsePositiveGuard(m[0], ctx)) continue;
        }
        hits.push({ category: p.category, match: m[0], start, end });
      }
    }
    return hits;
  }

  /** 实际 redact (替换命中文本) */
  redact(input: RedactInput): RedactResult {
    let text = input.text;
    const counter = new Map<string, number>();

    for (const p of this.patterns) {
      const re = new RegExp(p.pattern.source, p.pattern.flags);
      text = text.replace(re, (matchStr, ..._args) => {
        if (p.falsePositiveGuard) {
          // 用原始 input 作为 context (替换链中无法稳定取窗口)
          const ctx = input.text;
          if (p.falsePositiveGuard(matchStr, ctx)) return matchStr;
        }
        counter.set(p.category, (counter.get(p.category) ?? 0) + 1);
        return p.replacer(matchStr);
      });
    }

    const hits: SecretHit[] = Array.from(counter.entries()).map(([category, count]) => ({
      category,
      count,
    }));

    return {
      text,
      hits,
      hasSecrets: hits.length > 0,
    };
  }
}

/** 全局单例 (内核挂载点共用) */
let _shared: SecretRedactHook | null = null;
export function getSharedSecretRedactHook(): SecretRedactHook {
  if (!_shared) _shared = new SecretRedactHook();
  return _shared;
}
