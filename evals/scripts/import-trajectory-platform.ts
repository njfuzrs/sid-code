#!/usr/bin/env bun
/**
 * import-trajectory-platform.ts —— B6-1 适配器骨架
 *
 * 用途：
 *   把 trajectory-platform/bench/tasks/<task_id>/task.yaml 转换为
 *   sid-code/evals/real-tasks/<category>/real_<task_id>.yaml
 *   可被 sid-code 的 eval-runner 直接消费。
 *
 * 规格来源：
 *   docs/eval/演进路线/agent-eval-真化路线-v1.md §8.2.1（导入流程）
 *   docs/eval/演进路线/agent-eval-真化路线-v1.md §9.1.1（白名单字段提取铁律）
 *
 * 流程（任意一步失败即 reject 不落盘）：
 *   1. 白名单 lint：扫描源 task.yaml 中是否含 contamination 关键词
 *      （tool_result_content / response_content / patch_content / observation_content / completion_text）
 *      —— 这些是 trajectory-platform 上游污染字段，**严禁**进入 sid-code case yaml
 *   2. 路径相对化：/project/sid-code/X → ${REPO_ROOT}/X（防止机器路径泄露）
 *   3. secret/PII 二次扫描：API key / email / IP / private key 基础正则
 *   4. 推断 grader_type：has must_modify_files_in → execution_test，否则 rubric_5d
 *   5. 生成 setup 脚本（git clone + git checkout）写入 evals/real-tasks/scripts/
 *   6. buildCaseYaml：白名单字段提取（only allow-listed fields, 严禁全量拷贝）
 *   7. 写入 evals/real-tasks/<category>/real_<task_id>.yaml（已存在需 --force）
 *
 * 用法：
 *   # dry-run 单个任务
 *   bun run evals/scripts/import-trajectory-platform.ts \
 *     --source /Users/dev/Code/person/trajectory-platform/bench/tasks/T0042 \
 *     --target evals/real-tasks/bug-fix \
 *     --category bug-fix \
 *     --dry-run
 *
 *   # 实际写入（已存在不覆盖）
 *   bun run evals/scripts/import-trajectory-platform.ts \
 *     --source ... --target ... --category bug-fix
 *
 *   # 强制覆盖 + 进 holdout
 *   bun run evals/scripts/import-trajectory-platform.ts \
 *     --source ... --target evals/real-tasks/holdout \
 *     --category bug-fix --holdout --force
 *
 * 依赖：
 *   - bun runtime（import.meta.main / Bun globals）
 *   - yaml（已是 sid-code 现有依赖，与 baseline-sync.ts / migrate-cost-formula.ts 保持一致）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import * as yamlLib from "yaml";

// ============================================================================
// 类型定义
// ============================================================================

export interface ImportConfig {
  /** 源 task 目录（包含 task.yaml） */
  source_path: string;
  /** 目标目录（如 evals/real-tasks/bug-fix） */
  target_dir: string;
  /** 分类标签 */
  category: string;
  /** 是否做路径相对化重写 */
  do_path_rewrite: boolean;
  /** 是否做 secret/PII 二次扫描 */
  do_secret_scan: boolean;
  /** 是否进 holdout（影响 yaml 的 holdout 字段） */
  do_holdout: boolean;
  /** dry-run：仅打印不落盘 */
  dry_run?: boolean;
  /** 已存在则覆盖 */
  force?: boolean;
}

export interface ImportResult {
  status: "ok" | "rejected";
  reject_reasons?: string[];
  written_path?: string;
  setup_script_path?: string;
  warnings?: string[];
}

// ============================================================================
// 默认配置（§9.1.1 + 通用 secret 扫描）
// ============================================================================

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
 * case yaml 白名单字段（仅供文档/未来全量映射参考；当前 buildCaseYaml 走显式 schema 提取，
 * 比纯字段拷贝更稳——保留这份清单作为 §9.1.1 白名单的可读对照）
 */
export const ALLOWED_TASK_FIELDS = [
  "id",
  "instruction",
  "repo",
  "repo_url",
  "repo_commit",
  "category",
  "must_include_any_of",
  "must_not_include",
  "must_call_tools",
  "must_not_call_tools",
  "must_modify_files_in",
  "must_not_modify_files",
  "max_steps",
  "reference_answer",
  "rubric",
  "outcome",
  "attachments",
];

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 扫描文本中的 contamination 关键词。
 * 返回每条违反的 `<keyword>@line:<n>` 字符串。
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

/**
 * 路径相对化：把绝对路径替换为 ${REPO_ROOT}/...
 * - 默认 repoRoot 取 process.env.REPO_ROOT，否则 cwd（sid-code 仓库根）
 * - 处理 trajectory-platform 常见 mount path: /project/<any-repo>/... → ${REPO_ROOT}/<any-repo>/...
 *   说明：trajectory-platform 容器同时挂多个 repo（sid-code / claude-code / docs / ...）；
 *   全部统一转为 ${REPO_ROOT}/<repo>/，由 setup 脚本决定具体 mount 位置
 */
export function rewritePaths(text: string, repoRoot: string): string {
  // 上游 trajectory-platform 容器内 mount 路径（通用匹配，不限定单一 repo 名）
  let out = text.replace(/\/project\//g, "${REPO_ROOT}/");

  // 命中 repoRoot 绝对路径（防机器名泄露）
  if (repoRoot) {
    const escaped = repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), "${REPO_ROOT}");
  }

  return out;
}

/**
 * 推断 grader_type：
 *   - 含 must_modify_files_in（非空数组）→ execution_test（需要 fixture，需要后续人补 setup）
 *   - 否则 → rubric_5d
 */
export function inferGraderType(
  taskYaml: any
): "execution_test" | "rubric_5d" {
  const mustModify = taskYaml?.expected?.must_modify_files_in
    ?? taskYaml?.must_modify_files_in;
  if (Array.isArray(mustModify) && mustModify.length > 0) {
    return "execution_test";
  }
  return "rubric_5d";
}

/**
 * 生成 setup 脚本：git clone + git checkout 到指定 commit。
 * 输出到 scriptPath（绝对路径），权限 0755。
 */
export function generateSetupScript(taskYaml: any, scriptPath: string): void {
  const repoUrl = taskYaml?.input?.repo_url
    ?? taskYaml?.repo_url
    ?? `# TODO: fill repo_url for ${taskYaml?.id ?? "unknown"}`;
  const repoCommit = taskYaml?.input?.repo_commit
    ?? taskYaml?.repo_commit
    ?? "HEAD";
  const taskId = taskYaml?.id ?? "unknown";

  const content = `#!/usr/bin/env bash
# Auto-generated setup script for ${taskId}
# 由 import-trajectory-platform.ts 生成；请勿手改（重新导入会覆盖）
set -euo pipefail

WORKDIR="\${1:-/tmp/sid-eval-${taskId}}"
REPO_URL="${repoUrl}"
REPO_COMMIT="${repoCommit}"

if [ ! -d "$WORKDIR/.git" ]; then
  git clone "$REPO_URL" "$WORKDIR"
fi
cd "$WORKDIR"
git fetch --all --quiet || true
git checkout "$REPO_COMMIT"
echo "[setup] ${taskId} ready at $WORKDIR @ $REPO_COMMIT"
`;
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, content, "utf-8");
  try {
    chmodSync(scriptPath, 0o755);
  } catch {
    // chmod 在某些 FS 上可能失败（如 Windows），忽略不阻断
  }
}

/**
 * 白名单字段提取：构造 case yaml 字符串。
 * 严格只取 ALLOWED_TASK_FIELDS，其余一概丢弃。
 */
export function buildCaseYaml(source: any, opts: ImportConfig): string {
  const taskId: string = source.id ?? basename(opts.source_path);
  const graderType = inferGraderType(source);

  // 提取 instruction（兼容多种上游写法）
  const instructionText: string =
    source?.instruction?.text
    ?? source?.instruction
    ?? source?.input?.user_query
    ?? "";

  // expected 字段提取
  const expected = source?.expected ?? source ?? {};
  const pickArr = (k: string) =>
    Array.isArray(expected[k]) ? expected[k] : Array.isArray(source[k]) ? source[k] : [];

  const caseObj: Record<string, any> = {
    id: `real_${taskId}`,
    category: opts.category,
    priority: "P0",
    created_date: new Date().toISOString().slice(0, 10),
    eval_type: "real_task",
    target_score: 4.0,
    graduated_at: null,
    holdout: opts.do_holdout,
    holdout_reason: opts.do_holdout ? "imported via B6-1 adapter" : null,
    grader_type: graderType,
    source_meta: {
      origin: "trajectory-platform",
      source_task_id: taskId,
      imported_at: new Date().toISOString(),
      imported_by: "import-trajectory-platform.ts",
    },
    input: {
      user_query: instructionText,
      repo: source?.input?.repo ?? source?.repo ?? null,
      repo_commit: source?.input?.repo_commit ?? source?.repo_commit ?? null,
      attachments: source?.input?.attachments ?? [],
    },
    expected: {
      outcome: expected?.outcome ?? source?.outcome ?? `complete_real_task_${taskId}`,
      must_include_any_of: pickArr("must_include_any_of"),
      must_not_include: pickArr("must_not_include"),
      must_call_tools: pickArr("must_call_tools"),
      must_not_call_tools: pickArr("must_not_call_tools"),
      must_modify_files_in: pickArr("must_modify_files_in"),
      must_not_modify_files: pickArr("must_not_modify_files"),
      max_steps: expected?.max_steps ?? source?.max_steps ?? 30,
      reference_answer: expected?.reference_answer ?? source?.reference_answer ?? null,
    },
    rubric: source?.rubric ?? {
      completeness: "TODO: 由 importer 占位，请人审补充",
      precision: "TODO",
      helpfulness: "TODO",
    },
    baseline_scores: {},
    setup_script: `evals/real-tasks/scripts/setup_${taskId}.sh`,
    notes: `由 import-trajectory-platform.ts 自动生成（B6-1 适配器）。grader_type=${graderType}。`
      + (graderType === "execution_test"
        ? " 注意：execution_test 需要补 fixture / 验证脚本后才能跑。"
        : ""),
  };

  // 序列化（lineWidth: 0 避免长字符串被强行折行破坏可读性）
  return yamlLib.stringify(caseObj, { lineWidth: 0 });
}

// ============================================================================
// 主流程
// ============================================================================

export async function importTask(config: ImportConfig): Promise<ImportResult> {
  const warnings: string[] = [];
  const rejectReasons: string[] = [];

  // ---- 1. 读取源 task.yaml ----
  const taskYamlPath = join(config.source_path, "task.yaml");
  if (!existsSync(taskYamlPath)) {
    return {
      status: "rejected",
      reject_reasons: [`task.yaml not found at ${taskYamlPath}`],
    };
  }
  const rawText = readFileSync(taskYamlPath, "utf-8");

  // ---- 2. 白名单 lint（最高优先级，§9.1.1 铁律）----
  const contaminations = scanContamination(rawText);
  if (contaminations.length > 0) {
    rejectReasons.push("CONTAMINATION_DETECTED:");
    rejectReasons.push(...contaminations.map((c) => `  - ${c}`));
    return { status: "rejected", reject_reasons: rejectReasons };
  }

  // ---- 3. 路径相对化 ----
  const repoRoot = process.env.REPO_ROOT ?? process.cwd();
  let processedText = config.do_path_rewrite
    ? rewritePaths(rawText, repoRoot)
    : rawText;

  // ---- 4. secret / PII 扫描（仅 warning，除非命中 private_key）----
  if (config.do_secret_scan) {
    const hits = scanSecrets(processedText);
    for (const h of hits) {
      if (h.kind === "private_key") {
        rejectReasons.push(`PRIVATE_KEY_DETECTED: ${h.match}`);
      } else {
        warnings.push(`secret_warn: kind=${h.kind} match="${h.match}"`);
      }
    }
    if (rejectReasons.length > 0) {
      return { status: "rejected", reject_reasons: rejectReasons, warnings };
    }
  }

  // ---- 5. 解析 yaml ----
  let parsed: any;
  try {
    parsed = yamlLib.parse(processedText);
  } catch (err) {
    return {
      status: "rejected",
      reject_reasons: [`yaml parse failed: ${(err as Error).message}`],
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { status: "rejected", reject_reasons: ["task.yaml empty or not an object"] };
  }

  const taskId: string = parsed.id ?? basename(config.source_path);

  // ---- 6. 推断 grader_type / 生成 setup 脚本 ----
  const graderType = inferGraderType(parsed);
  const setupScriptRel = `evals/real-tasks/scripts/setup_${taskId}.sh`;
  const setupScriptAbs = resolve(repoRoot, setupScriptRel);

  // ---- 7. 构造 case yaml 内容 ----
  const yamlContent = buildCaseYaml(parsed, config);

  // ---- 8. 决定写入路径 ----
  const targetFileName = `real_${taskId}.yaml`;
  const targetAbs = resolve(repoRoot, config.target_dir, targetFileName);

  if (existsSync(targetAbs) && !config.force) {
    return {
      status: "rejected",
      reject_reasons: [`target already exists: ${targetAbs} (use --force to overwrite)`],
      warnings,
    };
  }

  // ---- 9. dry-run：只打印 ----
  if (config.dry_run) {
    console.log(`[dry-run] would write: ${targetAbs}`);
    console.log(`[dry-run] grader_type: ${graderType}`);
    console.log(`[dry-run] setup_script: ${setupScriptAbs}`);
    console.log(`---- yaml preview (first 600 chars) ----`);
    console.log(yamlContent.slice(0, 600));
    return {
      status: "ok",
      written_path: targetAbs,
      setup_script_path: setupScriptAbs,
      warnings: [...warnings, "dry-run: nothing written"],
    };
  }

  // ---- 10. 落盘 ----
  mkdirSync(dirname(targetAbs), { recursive: true });
  writeFileSync(targetAbs, yamlContent, "utf-8");
  generateSetupScript(parsed, setupScriptAbs);

  return {
    status: "ok",
    written_path: targetAbs,
    setup_script_path: setupScriptAbs,
    warnings,
  };
}

// ============================================================================
// CLI 入口
// ============================================================================

function parseArgs(argv: string[]): Partial<ImportConfig> & { help?: boolean } {
  const out: any = {
    do_path_rewrite: true,
    do_secret_scan: true,
    do_holdout: false,
    dry_run: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--source": out.source_path = argv[++i]; break;
      case "--target": out.target_dir = argv[++i]; break;
      case "--category": out.category = argv[++i]; break;
      case "--holdout": out.do_holdout = true; break;
      case "--no-rewrite": out.do_path_rewrite = false; break;
      case "--no-secret-scan": out.do_secret_scan = false; break;
      case "--dry-run": out.dry_run = true; break;
      case "--force": out.force = true; break;
      case "-h":
      case "--help": out.help = true; break;
      default:
        if (a.startsWith("--")) {
          console.warn(`[warn] unknown flag: ${a}`);
        }
    }
  }
  return out;
}

function printUsage(): void {
  console.log(`Usage:
  bun run evals/scripts/import-trajectory-platform.ts \\
    --source <path-to-task-dir> \\
    --target <evals/real-tasks/category-dir> \\
    --category <docs|bug-fix|refactor|capability|...> \\
    [--holdout] [--no-rewrite] [--no-secret-scan] [--dry-run] [--force]
`);
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.source_path || !args.target_dir || !args.category) {
    printUsage();
    process.exit(args.help ? 0 : 2);
  }
  importTask(args as ImportConfig)
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
      process.exit(res.status === "ok" ? 0 : 1);
    })
    .catch((err) => {
      console.error("[fatal]", err);
      process.exit(2);
    });
}
