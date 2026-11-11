/**
 * SecretRedactHook — runtime secret redaction
 *
 * 实现: ADR-026 §3 接口设计 + §4 实施方案
 *
 * ── B15：规则本体已迁到 `permission/secret-rules.ts` ──
 *
 * 本文件现在只做 **strict 档**的呈现：`<REDACTED:category>` 占位。规则表按「误报代价」
 * 分档（strict = 命中即拒场景，wide = 脱敏场景），消费方只声明自己要哪一档，
 * 不再各自维护一份正则 —— 2026-11-10 实测 `github_pat_` 在 R1 是 `{22,}`、在 R2 完全缺失，
 * 「私有记忆可以写进 fine-grained PAT」就是这么漏的。
 *
 * 与规则表的分工：
 *   - 规则（正则 + 二次校验）：`secret-rules.ts`
 *   - **fixture 守护**：留在这里。它是「命中之后要不要当成真凭证」的判断，依赖上下文
 *     （命中前后 80 字符），规则层只看命中本身。下沉进规则表会让 R1 也开始放过
 *     `AKIA…EXAMPLE`，与「落盘宁可多遮」的准则相反。
 *   - 呈现：占位替换 + 赋值类保留键名 + db 连接串只遮 password。
 *
 * 历史 7 类 pattern (§3.1) 现在全部来自规则表的 strict 档：
 *   1. GitHub Token   gh[poushr]_（含 fine-grained，B15 补）
 *   2. LLM API Key    sk-* / sk-proj-* / sk-ant-*
 *   3. AWS Access Key AKIA/ASIA/ABIA/ACCA/A3T
 *   4. Generic API Key  api_key/access_token/secret_key = "..." + x-api-key:
 *                       （B15 补齐 `SECRET=` / `AWS_SECRET_ACCESS_KEY=`）
 *   5. Bearer Token   Authorization: Bearer xxx
 *   6. Private Key    -----BEGIN ... PRIVATE KEY-----
 *   7. DB Conn String postgres://user:pwd@host
 */

import type { DetectMatch, RedactInput, RedactPattern, RedactResult, SecretHit } from "./types.ts";
import { SECRET_RULES, compileSecretRule, type SecretRule } from "../../permission/secret-rules.ts";

// ============================================================================
// 误报守护（留在消费侧，见文件头）
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

/**
 * 每条规则用哪种 fixture 守护。
 *
 * 两条规则**不**用通用守护，都是实测踩出来的：
 *   - PEM：正文是随机 base64，上下文里出现 "example"/"示例" 不代表它是假密钥。
 *     通用守护会让真实的私钥因为附近一句「下面是示例」而整块放过。
 *   - DB 连接串：只对 password 段判断。host 含 `example.com` 是无害域名，
 *     误把真 conn string 放过去比让 example.com host 误报更危险。
 */
function guardFor(rule: SecretRule): RedactPattern["falsePositiveGuard"] {
  if (rule.id === "private-key") return undefined;
  if (rule.id === "db-conn-string-auth") {
    return (match: string) => {
      const pwd = match.match(/:\/\/[^\s'":@]+:([^@\s'"]+)@/)?.[1] ?? "";
      return FIXTURE_MARKERS.test(pwd);
    };
  }
  return fixtureGuard;
}

// ============================================================================
// 呈现（strict 档的占位形态）
// ============================================================================

/** 内置规则：比对外接口多一个 validate（规则表的二次校验，true = 命中有效）与 render（需要捕获组） */
interface BuiltinPattern extends RedactPattern {
  validate?: (value: string, index: number, text: string) => boolean;
  /** 需要捕获组的呈现，优先于 replacer */
  render?: (match: string, groups: string[], category: string) => string;
}

/** R2 的占位名：规则表声明了 category 就用它，否则由 kebab-case id 派生 */
function categoryOf(rule: SecretRule): string {
  return rule.category ?? rule.id.replace(/-/g, "_");
}

/** db 连接串的呈现：保留 schema / user / host，只遮 password（读者要能看出连的是哪个库） */
function renderDbConn(match: string): string {
  return match.replace(/(:\/\/[^\s'":@]+:)([^@\s'"]+)(@)/, "$1<REDACTED:db_password>$3");
}

/**
 * 鉴权方案名的呈现：保留 `Bearer` / `Basic` 前缀，只遮 token 本体。
 *
 * 读者要能看出「这是哪种鉴权」—— 全遮成 `<REDACTED:bearer_token>` 会让
 * 「Authorization: Bearer …」变成「Authorization: <REDACTED:…>」，方案名丢了。
 */
const SCHEME_PREFIX: Record<string, string> = {
  "bearer-token": "Bearer",
  "basic-auth": "Basic",
};

function renderFor(rule: SecretRule, category: string): BuiltinPattern["render"] {
  if (rule.id === "db-conn-string-auth") {
    return (match) => renderDbConn(match);
  }
  const scheme = SCHEME_PREFIX[rule.id];
  if (scheme) {
    return (_match, _groups, cat) => `${scheme} <REDACTED:${cat}>`;
  }
  if (rule.keepKeyName) {
    // 第 1 组 = 键名 + 分隔符 + 可选开引号；只把值换成占位（键名是排查时最有用的线索）
    return (_match, groups) => `${groups[0] ?? ""}<REDACTED:${category}>`;
  }
  return undefined;
}

/**
 * 从规则表构建 strict 档的内置 pattern。
 *
 * 模块级缓存：`getSharedSecretRedactHook` 每个进程只建一次，
 * 但测试会 `new SecretRedactHook()` 多次 —— 缓存的是**未编译的规则清单**，
 * 每次构造仍复制新的 RegExp（`compileSecretRule`），因为 `detect`/`redact`
 * 会各自复用 `lastIndex`，共享实例会让两条路径互相干扰。
 */
function strictRules(): SecretRule[] {
  return SECRET_RULES.filter((r) => r.tiers.includes("strict"));
}

function buildBuiltinPatterns(): BuiltinPattern[] {
  return strictRules().map((rule) => {
    const category = categoryOf(rule);
    return {
      category,
      pattern: compileSecretRule(rule),
      replacer: () => `<REDACTED:${category}>`,
      falsePositiveGuard: guardFor(rule),
      validate: rule.validate,
      render: renderFor(rule, category),
    };
  });
}

// ============================================================================
// SecretRedactHook
// ============================================================================

export class SecretRedactHook {
  private patterns: BuiltinPattern[];

  constructor(patterns?: RedactPattern[]) {
    this.patterns = patterns ?? buildBuiltinPatterns();
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
        // 规则表的二次校验（如赋值写法要求值像字面量凭证），语义是 true = 命中有效
        if (p.validate && !p.validate(m[0], start, text)) continue;
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
      text = text.replace(re, (matchStr: string, ...args: unknown[]) => {
        // replace 回调参数尾部固定是 (offset, wholeString)，其余是捕获组。
        // render 需要捕获组（赋值类保留键名、db 连接串保留 host），所以这里要解出来。
        const groupCount = Math.max(args.length - 2, 0);
        const groups = args.slice(0, groupCount).map((g) => (typeof g === "string" ? g : ""));
        const offset = typeof args[groupCount] === "number" ? (args[groupCount] as number) : 0;
        if (p.validate && !p.validate(matchStr, offset, input.text)) return matchStr;
        if (p.falsePositiveGuard) {
          // 用原始 input 作为 context (替换链中无法稳定取窗口)
          if (p.falsePositiveGuard(matchStr, input.text)) return matchStr;
        }
        counter.set(p.category, (counter.get(p.category) ?? 0) + 1);
        if (p.render) return p.render(matchStr, groups, p.category);
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
