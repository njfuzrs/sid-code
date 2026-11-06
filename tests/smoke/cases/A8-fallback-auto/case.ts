/**
 * A8 降级链（auto 档）：主模型连接被拒 → 重试耗尽 → 自动切到 fallbackModel。
 *
 * 期望来源：核心功能触发清单 A8 的人工实测（`ModelSwitch{trigger=fallback}`）。
 *
 * 构造方式（2026-11-07 P-4 探针）：
 * - `mock-*` provider 过不了配置校验（只认 anthropic/openai/ollama/replay），不能用；
 * - 主模型 `provider: openai` 指向运行器现场找的空闲端口，连接必然被拒；
 * - 降级模型 `provider: replay`，回答来自本用例夹具；
 * - 重试压到 1 次、退避 50ms。不压的话会按缺省（单次调用最多 12 次、基数 5s）一直退避，
 *   实测 4.5 分钟没结束。
 *
 * 没断言 `BilledRequest.model`：这条路径上本会话没有 BilledRequest 事件（实测），
 * 触发清单那一句要回源码核对后再决定是否加。
 */
import { HookEventName } from "@sid-code/core/hook/types.ts";
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "A8-fallback-auto",
  ledger: "A8",
  feature: "降级链",
  kind: "guard",
  repo: { "hello.txt": "hello world\n" },
  argv: ["-p", "说一句话"],
  env: {
    SID_CODE_MAX_RETRIES_PER_CALL: "1",
    SID_CODE_MAX_TIMEOUT_RETRIES: "1",
    SID_CODE_RETRY_BACKOFF_BASE_MS: "50",
    SID_CODE_RETRY_BACKOFF_MAX_MS: "100",
  },
  settings: ({ refusedBaseURL }) => ({
    model: "smoke-primary",
    fallbackModel: "smoke-fallback",
    fallbackSwitchMode: "auto",
    availableModels: [
      {
        name: "smoke-primary",
        provider: "openai",
        baseURL: refusedBaseURL,
        apiKey: "smoke-primary-not-a-key",
        pricing: { input: 1, output: 1 },
      },
      {
        name: "smoke-fallback",
        provider: "replay",
        apiKey: "smoke-fallback-not-a-key",
        pricing: { input: 1, output: 1 },
      },
    ],
  }),
  expect: {
    events: [
      {
        event: "ModelSwitch",
        where: { from_model: "smoke-primary", to_model: "smoke-fallback", trigger: "fallback" },
        count: 1,
      },
      { event: HookEventName.SessionEnd, where: { exit_status: "end_turn" }, count: 1 },
    ],
    output: ({ stdout }) => {
      const r = (stdout as any)?.result;
      return r === "来自降级模型的回答"
        ? null
        : `result 期望来自降级夹具，实际 ${JSON.stringify(r)}`;
    },
  },
  mutations: [
    {
      file: "packages/core/src/llm/fallback.ts",
      find: "targetModel = cfgFallbackModel || undefined;",
      replace: "targetModel = undefined;",
      why: "auto 档拿不到配置里的降级模型，主模型失败后直接报错",
    },
    {
      file: "packages/core/src/trace/collector.ts",
      find: 'this.recordCustomEvent("ModelSwitch", {',
      replace: 'void ("ModelSwitch", {',
      why: "降级照常发生，但 ModelSwitch 埋点断了（轨迹里看不出换过模型）",
    },
  ],
};

export default def;
