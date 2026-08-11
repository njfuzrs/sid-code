import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";

/**
 * /batch 命令实现（按需加载）。对齐 claude-code §4.4。
 *
 * 设计取舍：CC 的 /batch 把任务拆成 5-30 个独立单元、各自 worktree 执行。我们已有两块实体基建——
 * Workflow 工具（deterministic fan-out 编排 + 并发上限）与 src/worktree/（隔离工作树 + include-copy +
 * 自动清理）。自造一个 batch 执行引擎会与二者重复，且更弱。
 *
 * 因此本命令不执行分解，而是把用户任务转成一段结构化编排指令（submit_prompt），引导模型：
 * 先探查工作清单，再用 Workflow 按单元 fan-out，冲突写场景用 worktree 隔离。真正的分解与并行
 * 交给既有基建，命令只做"入口 + 意图翻译"。
 *
 * 用法：
 *   /batch <任务>   — 引导模型把任务分解为独立单元并行执行
 *   /batch          — 打印用法
 */
const mod: LocalCommandModule = {
  async call(args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    const task = args.trim();
    if (!task) {
      return {
        type: "text",
        value: [
          "用法: /batch <要批量处理的任务>",
          "",
          "把一个大任务分解为多个独立单元并行执行，例如：",
          "  /batch 给 src/command/commands 下每个命令补一个单测",
          "  /batch 把所有 .js 迁移到 .ts",
          "",
          "会分解为独立单元、经 Workflow 并行执行；涉及并行写文件时用独立 worktree 隔离，避免冲突。",
        ].join("\n"),
      };
    }

    const prompt = [
      `请把下面的任务当作「批处理」来做——分解为多个相互独立的单元并行执行，而不是串行一个个做：`,
      "",
      `任务：${task}`,
      "",
      "执行要求：",
      "1. 先探查得到确定的工作清单（要处理的文件/模块/单元逐一列出），不要凭空假设数量。",
      "2. 用 Workflow 工具做 fan-out 编排：每个独立单元一个 agent，用 pipeline/parallel 并行推进。",
      "3. 若各单元会并行修改文件、可能互相冲突，给对应 agent 加 isolation:'worktree' 用独立工作树隔离。",
      "4. 单元之间彼此独立、无顺序依赖；汇总每个单元的结果，最后回报整体完成情况与失败项。",
      "5. 规模较大时（单元数多）注意 Workflow 的并发上限，分批推进即可，不要漏单元。",
    ].join("\n");

    return { type: "submit_prompt", prompt };
  },
};

export default mod;
