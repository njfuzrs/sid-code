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
 */

/** 单条扫描规则 */
interface SecretRule {
  /** gitleaks rule id（kebab-case），用于 label 与诊断 */
  id: string;
  /** 正则源串，首次扫描时惰性编译 */
  source: string;
  /** 可选 JS 正则 flags（多数规则大小写敏感，默认无 flag） */
  flags?: string;
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
const SECRET_RULES: SecretRule[] = [
  // — 云厂商 —
  {
    id: "aws-access-token",
    source: "\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b",
  },
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
  { id: "github-pat", source: "ghp_[0-9a-zA-Z]{36}" },
  { id: "github-fine-grained-pat", source: "github_pat_\\w{82}" },
  { id: "github-app-token", source: "(?:ghu|ghs)_[0-9a-zA-Z]{36}" },
  { id: "github-oauth", source: "gho_[0-9a-zA-Z]{36}" },
  { id: "github-refresh-token", source: "ghr_[0-9a-zA-Z]{36}" },
  { id: "gitlab-pat", source: "glpat-[\\w-]{20}" },
  { id: "gitlab-deploy-token", source: "gldt-[0-9a-zA-Z_\\-]{20}" },

  // — 通讯 —
  {
    id: "slack-bot-token",
    source: "xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*",
  },
  {
    id: "slack-user-token",
    source: "xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}",
  },
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
  {
    id: "npm-access-token",
    source: "\\b(npm_[a-zA-Z0-9]{36})(?:[`'\"\\s;]|\\\\[nr]|$)",
  },
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

  // — 加密私钥 —
  {
    id: "private-key",
    source:
      "-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S-]{64,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----",
    flags: "i",
  },
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
let compiledRules: Array<{ id: string; re: RegExp }> | null = null;

function getCompiledRules(): Array<{ id: string; re: RegExp }> {
  if (compiledRules === null) {
    compiledRules = SECRET_RULES.map((r) => ({
      id: r.id,
      re: new RegExp(r.source, r.flags),
    }));
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

// redact 用的规则（全局 flag，惰性编译）。
let redactRules: RegExp[] | null = null;

/**
 * 原地 redact 命中的 secret 为 [REDACTED]。
 * 与 scanForSecrets 不同，本函数返回替换后的内容，使周边文本仍可安全落盘。
 * 只替换捕获组（若有），保留 pattern 中作为边界的引号/分号/空白等字符。
 */
export function redactSecrets(content: string): string {
  if (redactRules === null) {
    redactRules = SECRET_RULES.map(
      (r) => new RegExp(r.source, (r.flags ?? "").replace("g", "") + "g"),
    );
  }
  for (const re of redactRules) {
    content = content.replace(re, (match: string, g1?: string) =>
      typeof g1 === "string" ? match.replace(g1, "[REDACTED]") : "[REDACTED]",
    );
  }
  return content;
}
