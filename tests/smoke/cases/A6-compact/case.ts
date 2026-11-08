/**
 * A6 手动部分压缩：stream-json 长驻会话里 `/compact` 真的压了，并落 `context_compact` 遥测。
 *
 * 期望来源：核心功能触发清单 A6——`context_compact` 落 `telemetry/events.jsonl`（不在会话轨迹，
 * 触发清单已注明），`tokens_after < tokens_before`。形态取自 2026-11-08 构建产物探针：
 * 三轮问答后 `/compact` → result「对话已压缩：已将最早 4 条压成 LLM 摘要…（6 → 4 条消息）」，
 * 遥测 `context_compact{outcome=summarized,trigger=manual,messages_before=6}`。
 *
 * 为什么走 stream-json：`/compact` 只声明 `modes: ["stream-json","bridge"]`（无头方案 T6），
 * `-p` 单轮被拒是有意契约。必须逐条等 result 再写下一条（见 `SmokeCase.streamInput`）。
 *
 * 为什么打开遥测：运行器默认 `SID_CODE_DISABLE_TELEMETRY=1`，analytics sink 在
 * no-telemetry 下直接丢弃，`context_compact` 一条都不落。隔离配置里没有远程后端，打开只会写本地。
 *
 * 夹具第 4 条是摘要调用的响应（partialCompact 发给 summarize 模型，未配置时即主模型）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "A6-compact",
  ledger: "A6",
  feature: "手动部分压缩",
  kind: "guard",
  repo: {},
  env: { SID_CODE_DISABLE_TELEMETRY: "0", SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0" },
  argv: [],
  streamInput: ["问题一", "问题二", "问题三", "/compact"],
  expect: {
    exitCode: 0,
    events: [{ event: "PreCompact", where: { trigger: "manual" }, count: 1 }],
    output: ({ stdout, configDir }) => {
      const results = (stdout as Array<{ type?: string; result?: string }>).filter(
        (m) => m.type === "result",
      );
      const last = results.at(-1)?.result ?? "";
      if (!last.startsWith("对话已压缩")) return `/compact 的 result 不是压缩成功：${last}`;
      const lines = readFileSync(join(configDir, "telemetry/events.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.includes('"eventName":"context_compact"'));
      if (lines.length !== 1) return `context_compact 期望 1 条，实际 ${lines.length} 条`;
      const m = JSON.parse(lines[0]!).metadata;
      if (m.outcome !== "summarized" || m.trigger !== "manual")
        return `context_compact 形态不对：outcome=${m.outcome} trigger=${m.trigger}`;
      if (!(m.tokens_after < m.tokens_before))
        return `tokens_after(${m.tokens_after}) 不小于 tokens_before(${m.tokens_before})`;
      return null;
    },
  },
  mutations: [
    {
      file: "packages/cli/src/command/commands/compact/index.ts",
      find: '    modes: ["stream-json", "bridge"],',
      replace: '    modes: ["bridge"],',
      why: "/compact 在 stream-json 下被拒（T6 放行面收窄），长驻宿主没法手动压缩",
    },
    {
      file: "packages/cli/src/command/commands/compact/compact.ts",
      find: "  ctx.ctxMgr.setMessages(result.messages);\n  // T6：",
      replace: "  // T6：",
      why: "摘要生成了但没写回上下文：报「已压缩」，实际一个 token 都没省（tokens_after 不降）",
    },
  ],
};

export default def;
