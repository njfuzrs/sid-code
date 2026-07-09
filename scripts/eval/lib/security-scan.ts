/**
 * security-scan.ts — real-tasks / trajectory-platform 数据污染与 secret 扫描共享函数
 *
 * 从原 evals/scripts/import-trajectory-platform.ts 抽出（importer 本身已废弃删除，
 * 见 case 生成流程下线说明），供 check-real-tasks-pollution.ts / scan-trajectory-secrets.ts
 * 两个安全扫描脚本复用，避免关键词/正则重复实现导致漂移。
 */

/**
 * 白名单 contamination 关键词：
 * 这些字段在 trajectory-platform 上游 task.yaml 中携带"上一轮 agent 的输出"，
 * 若进入 case yaml 会让 LLM 在跑 case 时直接读到答案 —— 严重污染信号。
 */
const CONTAMINATION_KEYWORDS = [
  "tool_result_content",
  "response_content",
  "patch_content",
  "observation_content",
  "completion_text",
];

/**
 * secret / PII 基础正则。
 * 注意：仅做"基础守门"，更严格的扫描应靠上游 trajectory-platform 完成。
 */
const SECRET_PATTERNS: { kind: string; regex: RegExp }[] = [
  { kind: "api_key", regex: /(?:api[_-]?key|secret|token).{0,5}[=:].{20,}/i },
  { kind: "email", regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { kind: "ip", regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { kind: "private_key", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
];

/**
 * 扫描 contamination 关键词命中，返回每处命中的上下文（供人审定位）。
 */
export function scanContamination(text: string): string[] {
  const violations: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const kw of CONTAMINATION_KEYWORDS) {
      if (line.includes(kw)) {
        // 上下文 3 行用于人审定位
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length, i + 2);
        const ctx = lines.slice(start, end).join(" | ");
        violations.push(`${kw}@line:${i + 1} ctx="${ctx.slice(0, 200)}"`);
      }
    }
  }
  return violations;
}

/**
 * secret / PII 扫描。返回命中的种类与片段。
 */
export function scanSecrets(text: string): { kind: string; match: string }[] {
  const hits: { kind: string; match: string }[] = [];
  for (const { kind, regex } of SECRET_PATTERNS) {
    // 全局正则需要 reset lastIndex，构造副本避免互相干扰
    const re = new RegExp(regex.source, regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push({ kind, match: m[0].slice(0, 80) });
      if (!re.global) break;
    }
  }
  return hits;
}
