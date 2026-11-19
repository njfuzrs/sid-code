import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import { buildContextReport } from "@sid-code/core/context/context-report.ts";
import { renderContextReport } from "./context-render.ts";

/**
 * /context 命令实现（PR3 重做后的薄封装）。
 *
 * 分层：取数在 core 的 `buildContextReport`（context/context-report.ts），
 * 排版在 `context-render.ts`（`ContextReport → string`）。本文件只剩**接线**：
 * 从 `CommandContext` 取 `ctxMgr`、`sessionState`、当前模型名与 `@` 导入清单，
 * 决定要不要颜色。排版层重算指标正是 D9 的根因，这里不许出现第二份算法。
 *
 * 形态：`src/ui/CLAUDE.md` 的 L4-H 规定查看/诊断类命令直接标 `outputPanel`，
 * 不再写专属 Dialog（专属面板只留给需要选择/编辑交互的场景）。`/context` 没有任何交互，
 * 且旧 Dialog 的 `round` 全框复制出来是满屏竖线、不能滚动。
 */
const mod: LocalCommandModule = {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const report = buildContextReport(ctx.ctxMgr, {
      model: ctx.config?.model ?? "",
      toolCount: ctx.toolRegistry.size(),
      // PR5 之后这是会话级单值（不再跨模型求和），与 footer 的 `↑` 同源。
      stockPromptTokens: ctx.sessionState.getStockPromptTokens(),
      ...(ctx.projectRules?.importedFiles ? { importedFiles: ctx.projectRules.importedFiles } : {}),
      projectRoot: ctx.cwd,
    });

    // 颜色只在真终端给（与 /cost 同一条规则）：`/context` 是 headless 命令，
    // `-p` / 管道输出走的就是这条路径，ANSI 转义码会污染脚本解析。isTTY 是唯一判据。
    const stdout = process.stdout as { isTTY?: boolean; columns?: number };
    const value = renderContextReport(report, {
      color: stdout.isTTY === true,
      width: stdout.columns ?? 80,
      // D-07：回答规范 #8 的行为观测（接收确认开场白比例）。取数源是 collector 自持的
      // 一对计数，不是 ContextReport 的一部分 —— 它不改任何 token 账，只是同一面板上的
      // 一个观测位。轨迹采集关闭时 collector 不存在，整节不画（缺失 ≠ 0 个开场白）。
      ...(ctx.traceCollector
        ? {
            ackOpener: ctx.traceCollector.getAckOpenerStats(),
          }
        : {}),
    });

    return { type: "text", value };
  },
};

export default mod;
