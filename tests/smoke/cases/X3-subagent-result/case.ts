/**
 * X3 子代理结果回传：主会话真的收到子代理的输出，子代理对话落 sidechain。
 *
 * 构造：主会话第 1 轮调 `sub_agent`；子代理与主会话共用同一个 ReplayProvider 游标，
 * 第 2 条响应被子代理消费（带标记串 SMOKE-X3-MARKER），第 3 条是主会话的汇总轮。
 *
 * 期望来源：2026-11-08 构建产物探针——`SubagentStart` / `SubagentStop{status=completed}` 各 1 条、
 * `PostToolUse{sub_agent,is_error=false}`、主会话 JSONL 的 tool_result 含标记串、
 * 同目录 `<sessionId>-<agentId>.jsonl` 首行 `sidechain_start`、末行 `sidechain_end{completed}`、含标记串。
 * 未经人工 TUI 实测，台账已注明。
 *
 * 判据是「标记串到达主会话」而不是「子代理跑完」：子代理跑完、结果没拼进 tool_result，
 * 主会话照样能产出汇总（回放的汇总轮是录好的），只看事件会假绿。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SmokeCase } from "../../lib/types.ts";

const MARKER = "SMOKE-X3-MARKER";

function sessionFiles(configDir: string): string[] {
  const root = join(configDir, "sessions");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((p) =>
    readdirSync(join(root, p))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(root, p, f)),
  );
}

const def: SmokeCase = {
  id: "X3-subagent-result",
  ledger: "X3",
  feature: "子代理结果回传",
  kind: "guard",
  repo: {},
  argv: ["-p", "派个子代理查代号"],
  expect: {
    exitCode: 0,
    events: [
      { event: "SubagentStart", count: 1 },
      { event: "SubagentStop", where: { status: "completed" }, count: 1 },
      { event: "PostToolUse", where: { tool_name: "sub_agent", is_error: false }, count: 1 },
    ],
    output: ({ stdout, configDir }) => {
      const sid = (stdout as { session_id?: string }).session_id;
      const files = sessionFiles(configDir);
      const main = files.find((f) => f.endsWith(`/${sid}.jsonl`));
      if (!main) return `找不到主会话 JSONL（session_id=${sid}）`;
      const toolResults = readFileSync(main, "utf8")
        .split("\n")
        .filter((l) => l.includes('"tool_result"'));
      if (!toolResults.some((l) => l.includes(MARKER)))
        return "主会话的 tool_result 里没有子代理输出（标记串未回传）";
      const side = files.filter((f) => f !== main && f.includes(`/${sid}-`));
      if (side.length !== 1) return `sidechain 文件期望 1 个，实际 ${side.length} 个`;
      const lines = readFileSync(side[0]!, "utf8").trim().split("\n");
      if (JSON.parse(lines[0]!).type !== "sidechain_start")
        return "sidechain 首行不是 sidechain_start";
      const last = JSON.parse(lines.at(-1)!);
      if (last.type !== "sidechain_end" || last.status !== "completed")
        return `sidechain 末行不是 sidechain_end{completed}：${lines.at(-1)}`;
      if (!lines.some((l) => l.includes(MARKER))) return "sidechain 里没有子代理的回答";
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/agent/tool.ts",
      find: '        `<subagent-result untrusted="true">`,\n        result.output,',
      replace: '        `<subagent-result untrusted="true">`,',
      why: "子代理跑完但输出没拼进 tool_result：主会话只看到「已完成」和用量，结论丢失",
    },
    {
      file: "packages/core/src/agent/sub-agent.ts",
      find: "      this.parentSessionId && agentId\n        ? new SidechainWriter(",
      replace: "      false\n        ? new SidechainWriter(",
      why: "sidechain 写入端断开（曾经的形态：默认 spawn 路径一条都没写），子代理对话无从回溯",
    },
  ],
};

export default def;
