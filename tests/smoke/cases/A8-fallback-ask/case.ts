/**
 * A8 降级链（ask 档，生产默认）：无头下没有交互通道 → auto 兜底 + 把降级模型提升为主模型。
 *
 * 期望来源：核心功能触发清单 A8「讲的时候留余地 (b)」的人工实测对照会话 20261105-202417-64949629：
 * ask 档在 `-p` 下只产生 **1 条** `ModelSwitch`（`reason="<主模型名> 降级"`、`after_request_index=0`），
 * 后续轮次直接用降级模型；auto 档则每轮重撞主模型、各降级一次（同清单 3 轮 → 3 条）。
 * 两条路径 `trigger` 都是 `fallback`，区分它们的是条数与 `reason`。
 *
 * 所以夹具是多轮（两次 read + 收尾），只有「提升为主模型」生效时 `ModelSwitch` 才恰好 1 条、
 * 且只有第 1 轮的 `BeforeModel.model` 是主模型。
 *
 * 不断言 read 的次数（2026-11-07 实测是 3 次，不是夹具里的 2 次）：第 1 轮降级用的是
 * `buildFallbackProvider` 建的 ReplayProvider，提升后主循环从 registry 拿到的是另一个实例，
 * 每个实例都从夹具第 1 行开始放，所以第 1 行被放了两遍。这是回放器的实例语义，不是降级链的行为。
 * 构造方式与 A8-fallback-auto 相同（主模型连被拒端口、降级模型走 replay、重试压到 1 次），
 * 见那边的注释。
 */
import { HookEventName } from "@sid-code/core/hook/types.ts";
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "A8-fallback-ask",
  ledger: "A8",
  feature: "降级链",
  kind: "guard",
  repo: { "hello.txt": "hello world\n" },
  argv: ["-p", "读两遍 hello.txt 再说一句话"],
  env: {
    SID_CODE_MAX_RETRIES_PER_CALL: "1",
    SID_CODE_MAX_TIMEOUT_RETRIES: "1",
    SID_CODE_RETRY_BACKOFF_BASE_MS: "50",
    SID_CODE_RETRY_BACKOFF_MAX_MS: "100",
  },
  settings: ({ refusedBaseURL }) => ({
    model: "smoke-primary",
    fallbackModel: "smoke-fallback",
    fallbackSwitchMode: "ask",
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
      // 恰好 1 条：3 轮里只降级一次，后两轮直接用已提升的降级模型
      {
        event: "ModelSwitch",
        where: {
          from_model: "smoke-primary",
          to_model: "smoke-fallback",
          trigger: "fallback",
          reason: "smoke-primary 降级",
        },
        count: 1,
      },
      { event: "ModelSwitch", count: 1 },
      // 「提升为主模型」的直接证据：只有第 1 轮打到主模型，之后各轮的 BeforeModel 都是降级模型
      { event: "BeforeModel", where: { model: "smoke-primary" }, count: 1 },
      { event: "BeforeModel", where: { model: "smoke-fallback" }, count: ">=2" },
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
      file: "packages/cli/src/app.ts",
      find: "promoteToPrimary(def);",
      replace: "void def;",
      why: "无头兜底只换当次调用、不提升主模型，每轮都重撞失败的主模型（ask 退化成 auto 的行为）",
    },
  ],
};

export default def;
