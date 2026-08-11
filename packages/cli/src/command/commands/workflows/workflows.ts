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
 * 无参 → 列出当前/最近的 workflow run（task 注册表提供实时状态：
 *        runId / name / phase / agent 计数 / 状态 / 时长）。
 * 带 runId/taskId → 该 run 的进度详情 + journal 回放的各 agent 结果快照。
 *
 * 数据源：
 *   - task 注册表（getAllTasks + isWorkflowTask）：实时的运行态/终态、当前 phase、agent 数。
 *   - journal（~/.sid-code/workflows/journals/<runId>.jsonl）：每个 agent() 调用的结果快照。
 */
const mod: LocalCommandModule = {
  async call(args: string): Promise<LocalCommandResult> {
    const { getAllTasks } = await import("@sid-code/core/task/registry.ts");
    const { isWorkflowTask } = await import("@sid-code/core/task/types.ts");

    const workflows = getAllTasks().filter(isWorkflowTask);
    const target = args.trim();

    if (!target) {
      return { type: "text", value: renderList(workflows) };
    }

    // 带参：按 runId 或 taskId 精确匹配（runId 更常用，taskId 兜底）。
    const wf = workflows.find((w) => w.runId === target || w.id === target);
    if (!wf) {
      return {
        type: "text",
        value: `未找到 workflow run "${target}"。\n用 /workflows（无参）查看当前所有 run。`,
      };
    }
    return { type: "text", value: await renderDetail(wf) };

    function renderList(list: typeof workflows): string {
      const lines: string[] = ["动态工作流 run:"];
      if (list.length === 0) {
        lines.push("  (无 —— 用 Workflow 工具启动一个编排脚本后可在此查看)");
        return lines.join("\n");
      }
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

      // journal 回放：列出各 agent() 调用的结果快照（截断展示，避免刷屏）。
      try {
        const { Journal } = await import("@sid-code/core/workflow/journal.ts");
        const { sidHomePath } = await import("@sid-code/core/config/paths.ts");
        const path = sidHomePath("workflows", "journals", `${w.runId}.jsonl`);
        const journal = new Journal(path);
        journal.load();
        const entries = journal.all();
        if (entries.length > 0) {
          lines.push("", `agent 调用快照（${entries.length} 条）:`);
          for (const entry of entries) {
            const label = entry.label ?? `call#${entry.callIndex}`;
            const preview = previewResult(entry.result);
            lines.push(`  [${entry.callIndex}] ${label}  →  ${preview}`);
          }
        }
      } catch {
        // journal 不存在/读取失败不阻断——运行中或极早期 run 可能还没落盘。
      }

      return lines.join("\n");
    }
  },
};

/** 把 agent 结果压成一行预览（对象 JSON 化，字符串截断）。 */
function previewResult(result: unknown): string {
  if (result === null || result === undefined) return "(空)";
  const s = typeof result === "string" ? result : JSON.stringify(result);
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? oneLine.slice(0, 77) + "..." : oneLine;
}

export default mod;
