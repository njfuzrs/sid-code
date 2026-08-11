/**
 * System-reminder 注入（对标 Claude Code attachment 通道）
 *
 * 从 query/loop.ts 抽出为纯函数，便于单测覆盖。核心职责：把本轮收集的
 * system-reminder 片段（plan 提醒 / todo 回注 / 工作日志摘要 / 延迟工具列表 …）
 * 注入到消息序列**最后一条 user 消息**。
 *
 * ─── 三条不变量（均有实测事故背书，改动前务必读完）───
 *
 * **不变量 1：每个片段强制 `<system-reminder>` 围栏**（P0-a，对标 CC
 * `utils/messages.ts` `ensureSystemReminderWrap`）。
 * 2026-07-29 实测（轨迹 20260729-180624-b8ae8e78）：用户只输入 `/commit`，但
 * `<available-deferred-tools>` / `# MCP Server Instructions` 两段**裸文本**注入在前，
 * 它们用 `#` markdown 标题开头，与用户 prompt 的 `# Commit:` 形态完全混同 →
 * glm-5.2 分不清"谁在说话"，转而抓 system prompt 记忆索引里的一条 `## 陈述句`
 * 当用户意图，第一轮跑去 glob 记忆文件。围栏是这个问题的**治本地基**，且是
 * OpenAI 族的**唯一**保底边界（见不变量 3）。
 *
 * **不变量 2：分级顺序 —— critical 在用户指令前，ambient 在用户指令后**（P1-a）。
 * 不能一刀切前置（会把真实指令推到 40% 偏移、被背景元信息淹没），也不能一刀切
 * 后置（会废掉 4 处止损阀的设计前提："在被冻结快照带偏前先读到实时事实"）。
 * 见下方 ReminderTiers 注释。
 *
 * **不变量 3：注入产物只进发送副本，永不写回 ctxMgr**。
 * `reactive-compact.ts` / `auto-compact.ts` / `history-adapter.ts` 三处都靠这个前提
 * 才安全。破坏它会同时引发：TUI 泄漏内部文本、压缩把工具列表当"用户最初的请求"、
 * reminder 在历史里逐轮累积。哨兵测试见 tests/query/reminder-inject-invariant.test.ts。
 *
 * ─── 承载形态：同一条 user message 内的独立 text block ───
 *
 * 不做字符串拼接（旧实现把 reminder 拼进用户的 text block，两种语义熔成一块、
 * 边界彻底消失）。也不照搬 CC 的"独立 message"——本项目 `Message.role` 只有
 * `"user" | "assistant"`（无 system role），且 OpenAI 路径连续 user 消息会被合并、
 * 部分网关直接拒。同 message 内多 block 是跨 provider 最稳的形态：
 *   - Anthropic：多 text block 原生支持；`anthropic.ts:167-173` 在最后一条 user 的
 *     **末块**打 cache_control → ambient 落在末尾正好成为缓存断点，顺带改善缓存；
 *   - OpenAI 族：`openai.ts:568-573` 把多 text block `join("\n")` 成单 string，
 *     block 边界在 wire 上丢失 → 此时唯一残存的语义边界就是围栏标签文本本身。
 */

import type { Message } from "../llm/types.ts";

/** 分级 reminder 输入。critical 前置于用户指令、ambient 后置。 */
export interface ReminderTiers {
  /**
   * **止损阀档**：设计前提就是"必须在模型被带偏前先读到"，故保持前置。
   *
   * 成员（loop.ts）：矛盾中断、死循环止损（实时 git 状态）、思考发散收敛、产出停滞。
   * 它们**只在 tool_result 轮触发**（上一轮检出、本轮注入），彼时用户没有新指令，
   * 不存在"淹没用户指令"的问题——这正是它们可以安全保留前置的依据。
   *
   * ⚠️ 不要往这里加背景元信息。新增成员前先问："它是否在纠正模型当前的错误方向？"
   * 答案为否就该进 ambient。回归哨兵见 reminder-inject.test.ts 的 critical 来源断言。
   */
  critical?: string[];
  /**
   * **背景元信息档**：延迟工具列表、MCP 说明、LSP 诊断、skill listing、todo 回注、
   * 权限模式、上下文压力、goal 状态、IDE 增量等。它们不该抢主信号位置，故后置。
   */
  ambient?: string[];
}

/**
 * 强制 `<system-reminder>` 围栏（对标 CC `ensureSystemReminderWrap`）。
 *
 * 已被围栏包裹的片段原样返回（避免嵌套），否则强制包裹。这是**兜底**——
 * 各注入点最好自己带围栏让意图显式化，但兜底必须存在：漏一处就等于把一段
 * 无标记文本喂给模型，而"漏一处"在 16 类注入点的规模下是必然事件。
 */
function ensureFenced(part: string): string {
  const t = part.trim();
  if (!t) return "";
  if (t.startsWith("<system-reminder>") && t.endsWith("</system-reminder>")) return part;
  return `<system-reminder>\n${part}\n</system-reminder>`;
}

/** 归一化入参：兼容旧的 `string[]`（等价于全部 ambient），并逐片段过围栏。 */
function normalizeTiers(parts: ReminderTiers | string[]): {
  critical: string;
  ambient: string;
} {
  const rawCritical = Array.isArray(parts) ? [] : (parts.critical ?? []);
  const rawAmbient = Array.isArray(parts) ? parts : (parts.ambient ?? []);
  const fence = (arr: string[]) =>
    arr.map(ensureFenced).filter((s) => s.length > 0).join("\n\n");
  return { critical: fence(rawCritical), ambient: fence(rawAmbient) };
}

/**
 * 把分级 reminder 注入到 messages 最后一条 user 消息。
 *
 * 不修改入参（in-place 安全）：仅当需要改动时，浅拷贝 messages 数组 + 目标消息 + 其 content。
 * 返回的数组可能与入参同引用（无内容可注入时）或为新数组（注入发生时）。
 *
 * @param messages 当前消息序列（通常是 ctxMgr.getCleanedMessages() 的浅拷贝）
 * @param parts    分级 reminder；传 `string[]` 时按 ambient 处理（向后兼容）
 * @returns 注入后的消息序列
 */
export function injectReminders(
  messages: Message[],
  parts: ReminderTiers | string[],
): Message[] {
  const { critical, ambient } = normalizeTiers(parts);
  if (!critical && !ambient) return messages;

  let result = messages;

  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.role !== "user") continue;

    const content = msg.content as any[];
    const textIdx = content.findIndex((c: any) => c.type === "text");
    const newContent = [...content];

    if (textIdx >= 0) {
      // 已有 text block（含真实用户指令的轮次）：用**独立 block** 前后夹住它，
      // 不做字符串拼接——用户指令保持为一个独立、边界清晰的 block。
      // 先插 ambient（在用户 block 之后），再插 critical（在用户 block 之前），
      // 顺序很关键：先插前面的会让 textIdx 失效。
      if (ambient) {
        newContent.splice(textIdx + 1, 0, { type: "text", text: ambient });
      }
      if (critical) {
        newContent.splice(textIdx, 0, { type: "text", text: critical });
      }
    } else {
      // 无 text block（纯 tool_result 轮）：本轮没有用户指令可被淹没，
      // critical / ambient 的相对顺序仍保留（critical 先），合成一个 block 追加到末尾。
      // OpenAI provider 会把 [tool_result..., text] 拆成「N 条 role:tool + 1 条 role:user」，
      // 顺序合法（见 openai.ts convertMessages），不破坏 tool_calls 协议。
      //
      // 注：CC 在这一形态上更进一步——把文本 smoosh 进 tool_result.content 内部，
      // 因为 tool_result 之后的兄弟 block 在 wire 上会渲染成 `</function_results>\n\nHuman:`，
      // 反复出现会教模型在空尾部提前吐 stop sequence（A/B 实测 92%→0%）。
      // 本项目该改造牵涉 provider 转换层与工具结果保真，已单独立项，不在本次范围。
      const merged = [critical, ambient].filter(Boolean).join("\n\n");
      newContent.push({ type: "text", text: merged });
    }

    result = [...result];
    result[i] = { ...msg, content: newContent };
    break;
  }

  return result;
}
