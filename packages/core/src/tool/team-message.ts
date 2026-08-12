/**
 * TeamMessageTool —— 团队成员之间 / 成员→leader 的消息投递（P1-3 mailbox 写入口）
 *
 * 此前 mailbox 只有 TeamManager 自己 send（leader→成员 投递初始任务、成员结果→leader），
 * 成员**没有**任何主动发消息的手段：peer 之间无法协商，也无法中途向 leader 汇报进展。
 * 双向通道只有读的一半（成员 onBeforeTurn drain 收件箱），写的一半缺失。
 *
 * 本工具补上写的一半：成员在自己的执行上下文里调用 team_message，消息落进目标成员
 * （或 leader）的收件箱，目标成员下一轮 onBeforeTurn drain 时读到，形成真正的双向通信。
 *
 * 身份从 AsyncLocalStorage（swarm/team-context.ts）取，不靠调用方自报——
 * 防止成员伪装成其他成员发消息，也保证 N 个成员并发时身份不串台。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import { getTeamMemberContext } from "../swarm/team-context.ts";
import { getLogger } from "../debug/logger.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** leader 的固定收件箱名（与 team.ts 里 send({to:"leader"}) 口径一致）。 */
const LEADER = "leader";

const teamMessageSchema = lazySchema(() =>
  z.object({
    to: z.string().describe(`收信人：其他成员名，或 "${LEADER}" 发给团队负责人（主代理）`),
    message: z.string().describe("消息内容"),
    kind: z
      .enum(["task", "result", "info"])
      .optional()
      .describe("消息类型：task=派活 / result=交付结果 / info=进展或协商（默认 info）"),
  }),
);

export class TeamMessageTool implements Tool {
  readonly zodSchema = teamMessageSchema();
  /** 长尾工具：仅团队成员场景使用，延迟加载，由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly searchHint = "team message teammate peer mailbox 团队 成员 消息 通信 协商";
  /** 分派/通信类工具：每次发给不同对象、内容天然不同，豁免循环检测（与 send_message 同款） */
  readonly exemptFromLoopDetection = true;
  /** 只投递消息，不改文件、不执行命令 */
  readonly isReadOnly = true;

  name(): string {
    return "team_message";
  }

  description(): string {
    return `给同团队的其他成员或团队负责人（leader）发消息。仅在你作为团队成员执行任务时可用。
对方会在下一轮开始时收到你的消息，可用于：向 leader 汇报进展/提问、与依赖你的成员协商接口、把发现同步给 peer。
收信人写成员名，或写 "${LEADER}" 发给团队负责人。`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(teamMessageSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as { to?: string; message?: string; kind?: "task" | "result" | "info" };

    if (!params.to || !params.message) {
      return { output: "错误: 缺少必需参数 (to, message)", isError: true };
    }

    // 身份只从 ALS 取：不在团队上下文里（如主代理直接调用）时明确报错，不猜。
    const ctx = getTeamMemberContext();
    if (!ctx) {
      return {
        output:
          "错误: 当前不在团队成员上下文中，team_message 不可用。" +
          "若你是主代理，请用 send_message 向后台 Agent 发消息。",
        isError: true,
      };
    }

    const to = params.to.trim();
    // 收信人必须是 leader 或团队内已知成员——防止消息投进永远没人读的收件箱后静默丢失。
    if (to !== LEADER && !ctx.memberNames.includes(to)) {
      const known = [LEADER, ...ctx.memberNames.filter((n) => n !== ctx.memberName)].join(", ");
      return { output: `错误: 收信人 "${to}" 不在团队中。可选: ${known}`, isError: true };
    }
    if (to === ctx.memberName) {
      return { output: "错误: 不能给自己发消息", isError: true };
    }

    try {
      ctx.mailbox.send({
        from: ctx.memberName,
        to,
        content: params.message,
        kind: params.kind ?? "info",
        // 时间戳由 mailbox 侧统一处理；此处传 0 保持与 team.ts 同款「调用方不造时间」口径。
        timestamp: 0,
      });
    } catch (err: any) {
      getLogger().warn(
        "SWARM",
        `team_message 投递失败 (${ctx.memberName}→${to}): ${err?.message ?? err}`,
      );
      return { output: `消息投递失败: ${err?.message ?? err}`, isError: true };
    }

    getLogger().info(
      "SWARM",
      `team_message: ${ctx.memberName} → ${to} (${params.message.length} 字符)`,
    );
    return {
      output: `已发送给 ${to}（对方将在下一轮收到）。`,
    };
  }
}
