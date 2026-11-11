/**
 * 团队记忆密钥扫描器（对标 claude-code teamMemorySync/secretScanner.ts）
 *
 * 团队记忆会同步给仓库所有协作者，因此在「写入团队记忆」与「push 同步」两道
 * 关口都要先扫描凭证：secret 永远不离开本机。
 *
 * 规则来自 gitleaks（https://github.com/gitleaks/gitleaks, MIT）的高置信度
 * 子集——只收录具有「独特前缀、近零误报」特征的规则，不收录泛化的
 * 关键词上下文规则（那类误报高，交给 sid 既有 SecretRedactHook 的 generic
 * api_key / bearer / db conn 规则覆盖运行时 redact 场景）。
 *
 * 设计要点：
 *   - scanForSecrets 只返回 ruleId + label，绝不返回命中的明文（不泄露 secret）。
 *   - redactSecrets 用于「保留周边文本，仅替换 secret 段」的安全落盘场景。
 *   - Go 正则的内联 (?i) / 模式组不可移植到 JS，已改写为显式字符类 / flags。
 *   - B15：与 R1/R2 重复的形态改为引用 `permission/secret-rules.ts`（`ref` 字段），
 *     规则只写一次。gitleaks 独有的、或需要更严格精确长度的，留作 extension。
 */

import { compileSecretRule, getSecretRule } from "../../permission/secret-rules.ts";

/** 单条扫描规则：要么自带正则源串（gitleaks 扩展），要么引用统一规则表的 id */
interface ScanRule {
  /** 扫描 id（kebab-case），用于 label 与诊断 */
  id: string;
  /** gitleaks 扩展规则：正则源串，首次扫描时惰性编译 */
  source?: string;
  /** 可选 JS 正则 flags（多数规则大小写敏感，默认无 flag） */
  flags?: string;
  /** B15：引用统一规则表（`permission/secret-rules.ts`）的规则 id */
  ref?: string;
}

/** 扫描命中（不含明文） */
export interface SecretMatch {
  /** 命中的 gitleaks rule id（如 "github-pat"） */
  ruleId: string;
  /** 由 rule id 派生的可读标签（如 "GitHub PAT"） */
  label: string;
}

// Anthropic API key 前缀运行时拼接，避免字面量出现在源码/产物里（excluded-strings）。
const ANT_KEY_PFX = ["sk", "ant", "api"].join("-");

// ─── 高置信度规则集（来自 gitleaks，按团队内容出现概率粗排） ──────────────
const SECRET_RULES: ScanRule[] = [
  // — 引用统一规则表（B15）—
  // 这 6 条形态与 R1/R2 共享同一份正则：同一形态不在两处各写一条，长度漂移就是必然
  // （实测 github_pat_ 在 R1 是 {22,}、在这里精确 {82}、在 R2 缺失）。
  // 规则表里这些规则的 tiers 都含 strict —— 团队扫描是「命中即拒」场景。
  { id: "aws-access-token", ref: "aws-access-token" },
  { id: "github-pat", ref: "github-pat" },
  { id: "gitlab-pat", ref: "gitlab-pat" },
  // 原 slack-bot-token / slack-user-token 合并为一条：规则表的 slack-token 覆盖
  // `xox[bpors]-` 全部前缀（含 team 的 xoxb / xoxp），前缀独特、误报近零。
  { id: "slack-token", ref: "slack-token" },
  { id: "npm-access-token", ref: "npm-token" },
  { id: "private-key", ref: "private-key" },

  // — gitleaks 扩展（strict 扩展，不进 wide 档）—
  // 判据：形态明确、近零误报，但规则表不需要（或这里需要比规则表更严格的精确长度）。
  // 加新规则前先问：它是不是已经在 secret-rules.ts 里？是就加 ref，不要另写一条。
  {
    id: "gcp-api-key",
    source: "\\b(AIza[\\w-]{35})(?:[`'\"\\s;]|\\\\[nr]|$)",
  },
  {
    id: "digitalocean-pat",
    source: "\\b(dop_v1_[a-f0-9]{64})(?:[`'\"\\s;]|\\\\[nr]|$)",
  },
  {
    id: "digitalocean-access-token",
    source: "\\b(doo_v1_[a-f0-9]{64})(?:[`'\"\\s;]|\\\\[nr]|$)",
  },

  // — AI API —
  {
    id: "anthropic-api-key",
    source: `\\b(${ANT_KEY_PFX}03-[a-zA-Z0-9_\\-]{93}AA)(?:[\`'"\\s;]|\\\\[nr]|$)`,
  },
  {
    id: "anthropic-admin-api-key",
    source: "\\b(sk-ant-admin01-[a-zA-Z0-9_\\-]{93}AA)(?:[`'\"\\s;]|\\\\[nr]|$)",
  },
  {
    id: "openai-api-key",
    source:
      "\\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[`'\"\\s;]|\\\\[nr]|$)",
  },
  {
    id: "huggingface-access-token",
    source: "\\b(hf_[a-zA-Z]{34})(?:[`'\"\\s;]|\\\\[nr]|$)",
  },
  {
    id: "deepseek-api-key",
    // DeepSeek 平台 key：sk- + 32 hex（sid 跑国产模型，补一条本土高频规则）
    source: "\\b(sk-[a-f0-9]{32})(?:[`'\"\\s;]|\\\\[nr]|$)",
  },

  // — 版本控制 —
  // github-pat / gitlab-pat 见数组开头的 ref；
  // github-fine-grained-pat 保留精确 {82}：团队记忆误拒代价高，只收 gitleaks 精确形态。
  // ghu/ghs/gho/ghr 前缀已被规则表的 github-pat（gh[poushr]_）覆盖，不再单列。
  { id: "github-fine-grained-pat", source: "github_pat_\\w{82}" },
  { id: "gitlab-deploy-token", source: "gldt-[0-9a-zA-Z_\\-]{20}" },

  // — 通讯 —
  // slack-bot-token / slack-user-token 合并为规则表的 slack-token（见数组开头）；
  // xapp- 前缀不被覆盖，留 extension
  {
    id: "slack-app-token",
    source: "xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+",
    flags: "i",
  },
  { id: "twilio-api-key", source: "SK[0-9a-fA-F]{32}" },
  {
    id: "sendgrid-api-token",
    source: "\\b(SG\\.[a-zA-Z0-9=_\\-.]{66})(?:[`'\"\\s;]|\\\\[nr]|$)",
  },

  // — 开发工具 —
  // npm-access-token 见数组开头的 ref
  {
    id: "pypi-upload-token",
    source: "pypi-AgEIcHlwaS5vcmc[\\w-]{50,1000}",
  },
  {
    id: "databricks-api-token",
    source: "\\b(dapi[a-f0-9]{32}(?:-\\d)?)(?:[`'\"\\s;]|\\\\[nr]|$)",
  },
  {
    id: "hashicorp-tf-api-token",
    source: "[a-zA-Z0-9]{14}\\.atlasv1\\.[a-zA-Z0-9\\-_=]{60,70}",
  },
  {
    id: "pulumi-api-token",
    source: "\\b(pul-[a-f0-9]{40})(?:[`'\"\\s;]|\\\\[nr]|$)",
  },
  {
    id: "postman-api-token",
    source: "\\b(PMAK-[a-fA-F0-9]{24}-[a-fA-F0-9]{34})(?:[`'\"\\s;]|\\\\[nr]|$)",
  },

  // — 可观测性 —
  {
    id: "grafana-api-key",
    source: "\\b(eyJrIjoi[A-Za-z0-9+/]{70,400}={0,3})(?:[`'\"\\s;]|\\\\[nr]|$)",
  },
  {
    id: "grafana-cloud-api-token",
    source: "\\b(glc_[A-Za-z0-9+/]{32,400}={0,3})(?:[`'\"\\s;]|\\\\[nr]|$)",
  },
  {
    id: "grafana-service-account-token",
    source: "\\b(glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8})(?:[`'\"\\s;]|\\\\[nr]|$)",
  },
  {
    id: "sentry-user-token",
    source: "\\b(sntryu_[a-f0-9]{64})(?:[`'\"\\s;]|\\\\[nr]|$)",
  },

  // — 支付 / 电商 —
  {
    id: "stripe-access-token",
    source: "\\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[`'\"\\s;]|\\\\[nr]|$)",
  },
  { id: "shopify-access-token", source: "shpat_[a-fA-F0-9]{32}" },
  { id: "shopify-shared-secret", source: "shpss_[a-fA-F0-9]{32}" },
  // private-key 见数组开头的 ref（规则表的 PEM 规则更宽：截断输出没有 END 行也遮）
];

/** rule id 特例大写映射（canonical 拼写与 title case 不同的词） */
const SPECIAL_CASE: Record<string, string> = {
  aws: "AWS",
  gcp: "GCP",
  api: "API",
  pat: "PAT",
  ad: "AD",
  tf: "TF",
  oauth: "OAuth",
  npm: "NPM",
  pypi: "PyPI",
  jwt: "JWT",
  github: "GitHub",
  gitlab: "GitLab",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  digitalocean: "DigitalOcean",
  huggingface: "HuggingFace",
  hashicorp: "HashiCorp",
  sendgrid: "SendGrid",
};

/** kebab-case rule id → 可读标签（如 "github-pat" → "GitHub PAT"） */
function ruleIdToLabel(ruleId: string): string {
  return ruleId
    .split("-")
    .map((part) => SPECIAL_CASE[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// 惰性编译缓存：首次扫描时编译一次。
// bodyGroup：redact 时替换哪个捕获组（0 = 整个 match）。规则表引用的规则整段替换，
// gitleaks extension 的捕获组 1 是 secret 本体（保留两侧的引号/分号/空白边界）。
interface CompiledScanRule {
  id: string;
  re: RegExp;
  bodyGroup: number;
}

let compiledRules: CompiledScanRule[] | null = null;

/**
 * 解析一条 ScanRule 成已编译的正则。
 *
 * `ref` 走规则表：规则表的正则带 `g`（R1 的 exec 循环要用），而 `scanForSecrets` 用
 * `test()` —— 带 g 的 test 会推进 lastIndex，导致第二次扫描漏检，所以这里去掉 g。
 */
function compileScanRule(rule: ScanRule): CompiledScanRule {
  if (rule.ref) {
    const shared = getSecretRule(rule.ref);
    if (!shared) {
      throw new Error(`secret-scanner: ref "${rule.ref}" 在 secret-rules.ts 里不存在`);
    }
    const base = compileSecretRule(shared);
    return {
      id: rule.id,
      re: new RegExp(base.source, base.flags.replace("g", "")),
      // 规则表的捕获组是给 R1 的 mask 用的（如 PEM 的类型名），不是给 R3 的 secret 本体
      bodyGroup: 0,
    };
  }
  if (!rule.source) {
    throw new Error(`secret-scanner: 规则 "${rule.id}" 既没有 source 也没有 ref`);
  }
  return { id: rule.id, re: new RegExp(rule.source, rule.flags), bodyGroup: 1 };
}

function getCompiledRules(): CompiledScanRule[] {
  if (compiledRules === null) {
    compiledRules = SECRET_RULES.map(compileScanRule);
  }
  return compiledRules;
}

/**
 * 扫描字符串中的潜在 secret。
 *
 * 每条命中的规则返回一项（按 rule id 去重）。**故意不返回命中的明文**——
 * 我们绝不记录或展示 secret 值。
 */
export function scanForSecrets(content: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const seen = new Set<string>();

  for (const rule of getCompiledRules()) {
    if (seen.has(rule.id)) continue;
    if (rule.re.test(content)) {
      seen.add(rule.id);
      matches.push({ ruleId: rule.id, label: ruleIdToLabel(rule.id) });
    }
  }
  return matches;
}

/** 获取 rule id 的可读标签（未知 id 回退 kebab→Title） */
export function getSecretLabel(ruleId: string): string {
  return ruleIdToLabel(ruleId);
}

// redact 用的规则：复用 scan 的编译结果（已处理 ref），只额外补 g 标志。
let redactRules: CompiledScanRule[] | null = null;

/**
 * 原地 redact 命中的 secret 为 [REDACTED]。
 * 与 scanForSecrets 不同，本函数返回替换后的内容，使周边文本仍可安全落盘。
 *
 * 替换粒度按 `bodyGroup`：
 *   - gitleaks extension（1）：只替换捕获组 1（secret 本体），保留 pattern 中作为
 *     边界的引号/分号/空白 —— 否则整段替换会吃掉分隔符，破坏周边文本；
 *   - 规则表引用（0）：整段替换。规则表的捕获组是给 R1 的保形遮盖用的
 *     （如 PEM 的第 1 组是密钥类型名），不能当成本体。
 */
export function redactSecrets(content: string): string {
  if (redactRules === null) {
    redactRules = getCompiledRules().map(({ id, re, bodyGroup }) => ({
      id,
      re: new RegExp(re.source, re.flags.replace("g", "") + "g"),
      bodyGroup,
    }));
  }
  for (const { re, bodyGroup } of redactRules) {
    content = content.replace(re, (match: string, ...args: unknown[]) => {
      const groups = args.slice(0, Math.max(args.length - 2, 0));
      const body = bodyGroup > 0 ? groups[bodyGroup - 1] : undefined;
      // 用函数替换，避免 secret 里含 `$&` / `$1` 这类被当成替换模板
      if (typeof body === "string" && body.length > 0) {
        return match.replace(body, () => "[REDACTED]");
      }
      return "[REDACTED]";
    });
  }
  return content;
}
