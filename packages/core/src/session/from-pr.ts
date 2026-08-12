/**
 * 从 PR 恢复会话上下文（P2-G9，对齐 claude-code `--from-pr <number>`）。
 *
 * 两种落地路径：
 *   1. PR 描述里嵌了会话溯源 id（CC 的 PR body 会带 `sid-session: <id>` 之类标记）——
 *      直接解析出该 id，交给上层走正常 resume 流程恢复原会话。
 *   2. 未嵌 id——把 PR 的标题 / 描述 / 改动文件列表拼成一段上下文文本，作为初始上下文
 *      注入新会话（让模型带着"这个 PR 改了什么"的背景开始）。
 *
 * 依赖 gh CLI（仓库已有 gh 依赖，见 skill/bundled/pr.ts）。gh 不可用 / 未登录 / PR 不存在
 * 时抛出带可读原因的 Error，由 cli.ts 捕获后报错降级（不静默吞，PR 恢复失败用户需要知道）。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getLogger } from "../debug/logger.ts";

const execFileAsync = promisify(execFile);

/** gh pr view --json 拉取的字段子集 */
interface PrView {
  number: number;
  title: string;
  body: string;
  headRefName?: string;
  baseRefName?: string;
  files?: Array<{ path: string }>;
}

/** from-pr 解析结果 */
export interface FromPrResult {
  /** PR body 里解析到的会话 id（命中则上层直接 resume 它）；否则 undefined */
  sessionId?: string;
  /** 未命中会话 id 时，供注入新会话的初始上下文文本 */
  contextText?: string;
  /** PR 编号（日志/展示用） */
  prNumber: number;
  /** PR 标题 */
  title: string;
}

/**
 * 从 PR body 里提取会话溯源 id。
 * 匹配形如 `sid-session: <id>`、`session-id: <id>`、`Session: <id>` 的行（大小写不敏感）。
 * id 允许我们自己的 `YYYYMMDD-HHMMSS-8hex` 形态或标准 UUID。
 */
export function extractSessionIdFromBody(body: string): string | undefined {
  if (!body) return undefined;
  const patterns = [/(?:sid[-_]?session|session[-_]?id|session)\s*[:=]\s*([0-9a-zA-Z-]{8,})/i];
  for (const re of patterns) {
    const m = body.match(re);
    if (m && m[1]) {
      const id = m[1].trim();
      // 过滤明显不是 id 的常见词，避免 "Session: none" 之类误命中
      if (id && !/^(none|n\/a|null|tbd)$/i.test(id)) return id;
    }
  }
  return undefined;
}

/** 把 PR 视图拼成注入新会话的初始上下文文本 */
export function buildPrContextText(pr: PrView): string {
  const lines: string[] = [];
  lines.push(`我正在基于 PR #${pr.number} 继续工作，以下是该 PR 的上下文：`);
  lines.push("");
  lines.push(`标题：${pr.title}`);
  if (pr.headRefName || pr.baseRefName) {
    lines.push(`分支：${pr.headRefName ?? "?"} → ${pr.baseRefName ?? "?"}`);
  }
  if (pr.body?.trim()) {
    lines.push("");
    lines.push("描述：");
    lines.push(pr.body.trim());
  }
  if (pr.files && pr.files.length > 0) {
    lines.push("");
    lines.push(`改动文件（${pr.files.length}）：`);
    for (const f of pr.files.slice(0, 100)) lines.push(`  - ${f.path}`);
    if (pr.files.length > 100) lines.push(`  …… 及另外 ${pr.files.length - 100} 个文件`);
  }
  return lines.join("\n");
}

/**
 * 从 PR 编号拉取上下文。
 *
 * @param prNumber PR 编号（字符串，来自 --from-pr）
 * @param cwd 执行 gh 的目录（决定 PR 所属仓库）
 * @throws gh 不可用 / 未登录 / PR 不存在 / 解析失败时抛出带原因的 Error
 */
export async function loadFromPr(prNumber: string, cwd: string): Promise<FromPrResult> {
  const log = getLogger();
  const n = prNumber.trim();
  if (!/^\d+$/.test(n)) {
    throw new Error(`--from-pr 需要一个 PR 编号（数字），收到: "${prNumber}"`);
  }

  let raw: string;
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", n, "--json", "number,title,body,headRefName,baseRefName,files"],
      { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
    );
    raw = stdout;
  } catch (err: any) {
    // gh 不存在 → ENOENT；未登录 / PR 不存在 → 非零退出码，stderr 带原因。
    const msg =
      err?.code === "ENOENT"
        ? "未找到 gh CLI。请先安装 GitHub CLI（https://cli.github.com/）并 gh auth login。"
        : err?.stderr?.toString().trim() || err?.message || String(err);
    throw new Error(`gh pr view ${n} 失败：${msg}`);
  }

  let pr: PrView;
  try {
    pr = JSON.parse(raw) as PrView;
  } catch (e: any) {
    throw new Error(`解析 gh pr view 输出失败：${e?.message}`);
  }

  const sessionId = extractSessionIdFromBody(pr.body ?? "");
  if (sessionId) {
    log.info("FROM_PR", `PR #${n} 描述中解析到会话 id: ${sessionId}，将尝试恢复该会话`);
    return { sessionId, prNumber: pr.number, title: pr.title };
  }

  log.info("FROM_PR", `PR #${n} 未内嵌会话 id，将把 PR 上下文注入新会话`);
  return { contextText: buildPrContextText(pr), prNumber: pr.number, title: pr.title };
}
