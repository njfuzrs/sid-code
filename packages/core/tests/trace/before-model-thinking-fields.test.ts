/**
 * PR5 回归：BeforeModel 必须采集 thinking / reasoning_effort
 *
 * ## 为什么这条值得一个常驻测试
 *
 * 2026-08-17 排查 GLM-5.3 的 400「该模型始终思考」时，查 `raw.jsonl` 得到
 * `thinking=None reasoning_effort=None`，据此判定"两个字段都没下发"，
 * 于是一路查到"模型未注册 → 能力退化"这个**错误根因**上，整轮方向被带偏。
 *
 * 真相是：**这个采集点的 schema 里从来就没有这两个字段位**。
 * "没在这里出现"被读成了"没发到线上" —— 仪器空洞被当成了事实。
 *
 * 这类失效方式的特征是**静默**：schema 缺字段不会报错，只会让排查的人看到一个
 * 看起来很确定的 `None`。测试是唯一能在合并前拦住它的东西。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("PR5 推理旋钮采集", () => {
  let hookSystem: HookSystem;
  let collector: TraceCollector;

  beforeEach(() => {
    const testDir = join(
      tmpdir(),
      `trace-thinking-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    hookSystem = new HookSystem();
    hookSystem.setSessionId("sess-thinking");
    hookSystem.setCwd("/tmp/test");
    collector = new TraceCollector({ outputDir: testDir });
    collector.registerHooks(hookSystem);
  });

  /** BeforeModel 需要 SessionStart 已初始化 metadata 才会建 pair（与生产顺序一致） */
  async function sessionStart() {
    await hookSystem.fireSessionStartEvent("startup", { model: "glm-5.3" });
    hookSystem.setSessionId("sess-thinking");
    hookSystem.setCwd("/tmp/test");
  }

  /** 取当前在途 pair 的 request 侧（BeforeModel 已发、AfterModel 未到时的形态） */
  function currentRequest(): any {
    return (collector as any).currentPair?.request;
  }

  test("主循环开思考 → thinking + reasoning_effort 都进 pair.request", async () => {
    await sessionStart();
    await hookSystem.fireBeforeModelEvent({
      model: "glm-5.3",
      messages: [{ role: "user", content: "hi" }],
      raw_messages: [{ role: "user", content: "hi" }],
      thinking: { enabled: true, budgetTokens: 0 },
      reasoning_effort: "max",
    });

    const req = currentRequest();
    expect(req.thinking).toEqual({ enabled: true, budgetTokens: 0 });
    expect(req.reasoning_effort).toBe("max");
  });

  test("side-call 关思考 → 采到 enabled:false（这正是当初查不到的那个值）", async () => {
    await sessionStart();
    await hookSystem.fireBeforeModelEvent({
      model: "glm-5.3",
      messages: [{ role: "user", content: "hi" }],
      raw_messages: [{ role: "user", content: "hi" }],
      thinking: { enabled: false, budgetTokens: 0 },
    });

    const req = currentRequest();
    expect(req.thinking).toEqual({ enabled: false, budgetTokens: 0 });
    // 关思考时不下发 effort（与 dialect 的 effortGatedByThinking 一致），故此处应缺席
    expect(req.reasoning_effort).toBeUndefined();
  });

  test("每轮都记，不是只记首次 —— 旋钮是逐轮可变的", async () => {
    await sessionStart();
    // 只记首次等于记了一个会漂移的快照：同一会话里 side-call 关思考、主循环开思考、
    // 用户中途 `/think off`，都会让不同请求拿到不同值。比不记更容易误导。
    const fire = async (enabled: boolean, effort?: string) => {
      await hookSystem.fireBeforeModelEvent({
        model: "glm-5.3",
        messages: [{ role: "user", content: "hi" }],
        raw_messages: [{ role: "user", content: "hi" }],
        thinking: { enabled, budgetTokens: 0 },
        ...(effort ? { reasoning_effort: effort } : {}),
      });
      return currentRequest();
    };

    expect((await fire(true, "max")).thinking.enabled).toBe(true);
    const second = await fire(false);
    expect(second.thinking.enabled).toBe(false); // 第二轮拿到的是第二轮的值
    expect(second.reasoning_effort).toBeUndefined(); // 不残留第一轮的 "max"
  });

  test("负向对照：上游不传时字段缺席，不写 undefined 占位", async () => {
    await sessionStart();
    // `{thinking: undefined}` 经 JSON.stringify 会消失，但下游做 `"thinking" in req`
    // 判断时会拿到 true —— 本仓已记过「显式 undefined 击穿默认值」的坑。
    await hookSystem.fireBeforeModelEvent({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      raw_messages: [{ role: "user", content: "hi" }],
    });

    const req = currentRequest();
    expect("thinking" in req).toBe(false);
    expect("reasoning_effort" in req).toBe(false);
  });
});
