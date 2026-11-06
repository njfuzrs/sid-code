/**
 * A7 花费上限：`--max-budget-usd` 超限后硬停。
 *
 * 期望来源：核心功能触发清单 A7 的人工实测（`SessionEnd.exit_status=budget_exceeded`）。
 *
 * 为什么能确定性复现：运行器把模型价格写死为每百万 token $1（settings.json 里用户手写价，
 * 定价解析第 2 优先级，不依赖网关价格缓存），夹具第 1 轮报 100 万输入 token = $1，
 * 上限 $0.5，所以第 1 轮响应后必然越线。第 2 轮的 edit 不应该被执行。
 */
import { HookEventName } from "@sid-code/core/hook/types.ts";
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "A7-budget-exceeded",
  ledger: "A7",
  feature: "花费上限",
  kind: "guard",
  repo: { "hello.txt": "hello world\n" },
  argv: ["--max-budget-usd", "0.5", "-p", "把 hello.txt 的 hello world 改成 hello sid-code"],
  expect: {
    events: [
      { event: HookEventName.SessionEnd, where: { exit_status: "budget_exceeded" }, count: 1 },
      // 只发出了 1 次模型请求：硬停后不再请求
      { event: HookEventName.BeforeModel, count: 1 },
      { event: HookEventName.PostToolUse, where: { tool_name: "edit" }, count: 0 },
    ],
    // 硬停后第 2 轮的 edit 没有执行
    files: [{ path: "hello.txt", equals: "hello world\n" }],
    // app.ts 收尾：预算硬停与运行时异常同为非 0，CI 靠它判失败
    exitCode: 1,
    output: ({ stdout }) => {
      const err = (stdout as any)?.error;
      if ((stdout as any)?.is_error !== true)
        return `结果体 is_error 期望 true，实际 ${(stdout as any)?.is_error}`;
      if (err?.reason !== "max_budget_usd")
        return `结果体 error.reason 期望 max_budget_usd，实际 ${err?.reason}`;
      if (err?.limitUsd !== 0.5) return `结果体 error.limitUsd 期望 0.5，实际 ${err?.limitUsd}`;
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/llm/quota.ts",
      find: "return currentCost >= this.costLimit;",
      replace: "return false;",
      why: "花费上限判定恒为未超限，任务会一路跑完",
    },
  ],
};

export default def;
