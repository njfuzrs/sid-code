import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "@sid-code/core/workflow/journal.ts";
import type { LocalCommandModule, LocalCommandResult } from "../../types.ts";

/** 时长格式化（复用 advanced.ts /ps 的口径）。 */
function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** 状态中文标签（与 TaskStatus 对齐）。 */
function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: "等待中",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    killed: "已终止",
  };
  return map[status] ?? status;
}

/**
 * /workflows 命令实现（按需加载）
 *
 * 无参 → 列出当前会话的 workflow run（task 注册表提供实时状态：
 *        runId / name / phase / agent 计数 / 状态 / 时长），
 *        外加磁盘上不在当前会话里的历史 run（仅 journal，标「历史」）。
 * 带 runId/taskId → 该 run 的进度详情 + journal 回放的各 agent 结果快照；
 *        内存里没有时回退读磁盘 journal，并给出 resume 用的 script_path / runId。
 *
 * 数据源：
 *   - task 注册表（getAllTasks + isWorkflowTask）：进程内，实时的运行态/终态、当前 phase、agent 数。
 *   - journal（~/.sid-code/workflows/journals/<runId>.jsonl）：每个 agent() 调用的结果快照，永久保留。
 */
const mod: LocalCommandModule = {
  async call(args: string): Promise<LocalCommandResult> {
    const { getAllTasks } = await import("@sid-code/core/task/registry.ts");
    const { isWorkflowTask } = await import("@sid-code/core/task/types.ts");

    const { sidHomePath } = await import("@sid-code/core/config/paths.ts");

    const workflows = getAllTasks().filter(isWorkflowTask);
    const target = args.trim();
    const journalsDir = sidHomePath("workflows", "journals");
    const scriptsDir = sidHomePath("workflows", "scripts");

    if (!target) {
      // F1：task 注册表只在进程内，重启会话后历史 run 就看不到了，而 journal 永久留在磁盘上、
      // 仍可 resume。这里把「内存里没有的 journal」并进列表，标为「历史（仅磁盘）」。
      const inMemory = new Set(workflows.map((w) => w.runId));
      const history = listDiskRuns(journalsDir).filter((r) => !inMemory.has(r.runId));
      return { type: "text", value: renderList(workflows, history) };
    }

    // 带参：按 runId 或 taskId 精确匹配（runId 更常用，taskId 兜底）。
    const wf = workflows.find((w) => w.runId === target || w.id === target);
    if (!wf) {
      // F1：内存里没有时回退到磁盘 journal——它在，就还能看进度树、还能续跑。
      const disk = renderDiskDetail(target, journalsDir, scriptsDir);
      if (disk) return { type: "text", value: disk };
      return {
        type: "text",
        value: `未找到 workflow run "${target}"（当前会话与磁盘 journal 都没有）。\n用 /workflows（无参）查看所有 run。`,
      };
    }
    return { type: "text", value: await renderDetail(wf) };

    function renderList(list: typeof workflows, history: DiskRun[]): string {
      const lines: string[] = ["动态工作流 run:"];
      if (list.length === 0 && history.length === 0) {
        lines.push("  (无 —— 用 Workflow 工具启动一个编排脚本后可在此查看)");
        return lines.join("\n");
      }
      if (list.length === 0) lines.push("  (当前会话无 run)");
      // 运行中的排前面，其余按开始时间倒序。
      const sorted = [...list].sort((a, b) => {
        const ra = a.status === "running" ? 0 : 1;
        const rb = b.status === "running" ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return b.startTime - a.startTime;
      });
      for (const w of sorted) {
        const age = fmtAge(Date.now() - w.startTime);
        const phase = w.currentPhase ? ` · ${w.currentPhase}` : "";
        const agents = w.agentCount ? ` · ${w.agentCount} agents` : "";
        lines.push(
          `  ${w.runId}  ${statusLabel(w.status).padEnd(4)} ${age.padStart(4)}  ${w.workflowName}${phase}${agents}`,
        );
      }
      if (history.length > 0) {
        // 磁盘历史可能很多（journal 不自动清理），只列最近的若干条，避免刷屏。
        const shown = history.slice(0, MAX_HISTORY_ROWS);
        lines.push("", `历史（仅磁盘，${history.length} 个，可 resume）:`);
        for (const r of shown) {
          const age = fmtAge(Date.now() - r.mtime);
          lines.push(`  ${r.runId}  历史 ${age.padStart(4)}  ${r.entryCount} 条 agent 记录`);
        }
        if (history.length > shown.length) {
          lines.push(`  …… 另有 ${history.length - shown.length} 个更早的 run 未列出`);
        }
      }
      lines.push("", "查看详情：/workflows <runId>");
      return lines.join("\n");
    }

    async function renderDetail(w: (typeof workflows)[number]): Promise<string> {
      const lines: string[] = [
        `工作流: ${w.workflowName}`,
        `runId : ${w.runId}`,
        `状态  : ${statusLabel(w.status)}（${fmtAge(Date.now() - w.startTime)}）`,
      ];
      if (w.currentPhase) lines.push(`当前 phase: ${w.currentPhase}`);
      if (w.agentCount) lines.push(`已发起 agent: ${w.agentCount}`);
      if (w.error) lines.push(`错误: ${w.error}`);
      if (w.result) {
        lines.push(
          `结果: ${w.result.totalToolUseCount} 次工具调用 · ${w.result.totalTokens} tokens`,
        );
      }

      lines.push(...renderJournalTree(join(journalsDir, `${w.runId}.jsonl`)));
      return lines.join("\n");
    }
  },
};

/** 磁盘历史列表最多展示的行数 */
const MAX_HISTORY_ROWS = 20;

/** runId 形态（与 tool/workflow.ts newRunId 一致）。用户输入拼路径前先校验，防 `../` 越出目录。 */
const RUN_ID_RE = /^wf_[0-9a-f]{12}$/;

/** 磁盘上的一个历史 run（只有 journal，没有进程内 task 状态） */
interface DiskRun {
  runId: string;
  /** journal 最后写入时间——作为「多久之前」的近似（journal 只追加，mtime ≈ 最后一个 agent 完成时刻） */
  mtime: number;
  entryCount: number;
}

/** 枚举 journals 目录，按 mtime 倒序。目录不存在 = 从未跑过 workflow。 */
function listDiskRuns(journalsDir: string): DiskRun[] {
  let files: string[];
  try {
    files = readdirSync(journalsDir);
  } catch {
    return [];
  }
  const runs: DiskRun[] = [];
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const runId = f.slice(0, -".jsonl".length);
    if (!RUN_ID_RE.test(runId)) continue;
    try {
      const p = join(journalsDir, f);
      const mtime = statSync(p).mtimeMs;
      // 只数非空行，不解析——列表页不需要内容，且历史 journal 可能很多
      const entryCount = readFileSync(p, "utf-8")
        .split("\n")
        .filter((l) => l.trim()).length;
      runs.push({ runId, mtime, entryCount });
    } catch {
      // 单个文件读失败不影响其余
    }
  }
  return runs.sort((a, b) => b.mtime - a.mtime);
}

/** 找到该 run 自动落盘的脚本（`<safeName>-<runId>.js`），续跑需要它作为 script_path。 */
function findScriptForRun(scriptsDir: string, runId: string): string | undefined {
  try {
    const f = readdirSync(scriptsDir).find((name) => name.endsWith(`-${runId}.js`));
    return f ? join(scriptsDir, f) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 内存里查不到时，按磁盘 journal 渲染详情；journal 不存在返回 undefined（由调用方报「未找到」）。
 * 历史 run 没有 task 状态（成功/失败/中止都不可知），只能如实说「状态未知」，不去猜。
 */
function renderDiskDetail(
  runId: string,
  journalsDir: string,
  scriptsDir: string,
): string | undefined {
  if (!RUN_ID_RE.test(runId)) return undefined;
  const journal = join(journalsDir, `${runId}.jsonl`);
  if (!existsSync(journal)) return undefined;
  const script = findScriptForRun(scriptsDir, runId);
  const lines: string[] = [
    `runId : ${runId}`,
    `状态  : 历史（仅磁盘；不在当前会话中，最终状态未知）`,
    `journal: ${journal}`,
  ];
  if (script) lines.push(`脚本  : ${script}`);
  lines.push(...renderJournalTree(journal));
  lines.push(
    "",
    script
      ? `续跑：workflow 工具传 {script_path:"${script}", resume_from_run_id:"${runId}"}（已完成的 agent 走缓存）`
      : `续跑：workflow 工具传 {script_path:<脚本路径>, resume_from_run_id:"${runId}"}（未找到该 run 的落盘脚本）`,
  );
  return lines.join("\n");
}

/**
 * journal 回放成进度树：按 phase 分组，phase 内按 callIndex 顺序。
 * 无 phase 的条目（老 journal 或 phase() 之前的调用）归到「未分组」。
 * 分组顺序按该 phase 首次出现的 callIndex，即脚本实际执行顺序。
 * 内存 run 与磁盘历史 run 共用，保证两种详情长得一样。
 */
function renderJournalTree(path: string): string[] {
  const lines: string[] = [];
  try {
    const journal = new Journal(path);
    journal.load();
    const entries = journal.all();
    if (entries.length === 0) return lines;
    const groups = new Map<string, typeof entries>();
    for (const entry of entries) {
      const key = entry.phase && entry.phase.trim() ? entry.phase : "(未分组)";
      const list = groups.get(key);
      if (list) list.push(entry);
      else groups.set(key, [entry]);
    }
    lines.push("", `进度树（${entries.length} 个 agent）:`);
    for (const [phase, list] of groups) {
      lines.push(`  ${phase}`);
      for (const entry of list) {
        const label = entry.label ?? `call#${entry.callIndex}`;
        lines.push(`    ⎿ [${entry.callIndex}] ${label}  →  ${previewResult(entry.result)}`);
      }
    }
  } catch {
    // journal 不存在/读取失败不阻断——运行中或极早期 run 可能还没落盘。
  }
  return lines;
}

/** 把 agent 结果压成一行预览（对象 JSON 化，字符串截断）。 */
function previewResult(result: unknown): string {
  if (result === null || result === undefined) return "(空)";
  const s = typeof result === "string" ? result : JSON.stringify(result);
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? oneLine.slice(0, 77) + "..." : oneLine;
}

export default mod;
