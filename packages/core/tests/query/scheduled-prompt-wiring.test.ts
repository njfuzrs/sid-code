/**
 * F3 接线契约：`QueryEngine.submitMessage` 必须真的把定时来源用上。
 *
 * ## 为什么单独一个文件
 *
 * `scheduled-prompt.ts` 的纯函数测试全绿 ≠ 引擎接上了。三处接线的失效形态都是**静默**的：
 * - 不打 `_meta`：消息照常进模型，只是 TUI 又渲染成 `> …`（用户看到的「不是我输入的话」）；
 * - 不拼来源头：模型又要靠 thinking 猜「这条哪来的」，这正是要修的那半个 bug；
 * - 不给 hook 载荷带 source：用户 hook 分不出来源，轨迹里与人手敲的依旧不可区分。
 * 三者都不会让任何既有测试变红——所以这里用源码字面量断言把它们钉住
 * （与 `tests/query/edit-failure-reminder-wiring.test.ts` 同款做法）。
 *
 * ## 为什么不做成「构造真引擎跑一轮」
 *
 * `QueryEngine` 的依赖有 10+ 项（provider / ctxMgr / fallback / thinkingMgr / …），
 * 构造它需要一整套 mock，测试成本远高于它要保护的三行接线；而接线的正确性已经由
 * 纯函数（`buildScheduledMessageMeta` / `toHookSourceFields` / `withScheduledPromptHeader`）
 * 与 UI 侧分流测试（`tests/ui/scheduled-prompt-render.test.tsx`）分别覆盖。
 * 这里只补最后一环：**引擎确实调了它们**。
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildScheduledMessageMeta,
  toHookSourceFields,
  withScheduledPromptHeader,
} from "@sid-code/core/query/scheduled-prompt.ts";

const ENGINE_SRC = readFileSync(join(import.meta.dir, "../../src/query/engine.ts"), "utf8");

describe("F3 引擎接线", () => {
  it("user 消息正文经 withScheduledPromptHeader 拼来源头", () => {
    expect(ENGINE_SRC).toContain("withScheduledPromptHeader(");
    // 拼在 thinking 解析之后、hook 之后（hook 必须拿到原始 prompt）
    expect(ENGINE_SRC).toContain("const modelInput = scheduled");
  });

  it("user 消息打 _meta（走 buildScheduledMessageMeta，不在引擎里手写字面量）", () => {
    expect(ENGINE_SRC).toContain("buildScheduledMessageMeta(");
  });

  it("hook 载荷经 toHookSourceFields 带来源字段", () => {
    expect(ENGINE_SRC).toContain("toHookSourceFields(");
  });

  it("displayCommand 与 scheduled 互斥：同时给时以命令优先并告警", () => {
    // 两个都表示「这条不是人手敲的」，同时出现说明调用方接线错了。
    // 静默挑一个会让另一半信息凭空消失，排查时无从下手。
    expect(ENGINE_SRC).toContain("两者互斥");
    expect(ENGINE_SRC).toContain("options?.scheduled && !options.displayCommand");
  });

  it("不传 scheduled 时不产生任何来源标记（普通用户输入逐字节不变）", () => {
    // 三个纯函数只有在传入 source 时才会产出内容；引擎里由 `scheduled ? … : …` 守着。
    // 这里锁的是「缺省路径不写 _meta」这一条：`_meta` 只在 scheduled 分支里出现。
    const metaBlock = /\.\.\.\(options\?\.displayCommand[\s\S]*?\n\s{0,4}\}/.exec(ENGINE_SRC)?.[0];
    expect(metaBlock).toBeDefined();
    expect(metaBlock!).toContain("scheduled");
    // 三元链的最后必须落到空对象（否则普通消息也会被塞进 _meta）
    expect(metaBlock!).toMatch(/\}\s*:\s*\{\}/);
  });
});

describe("F3 来源字段形状（引擎与 hook 共用）", () => {
  it("_meta 带 origin + 任务 id + 来源，足以让 TUI 分流并显示来源", () => {
    expect(buildScheduledMessageMeta({ taskId: "abc", origin: "schedule_wakeup" })).toEqual({
      origin: "scheduled-prompt",
      scheduledTaskId: "abc",
      scheduledOrigin: "schedule_wakeup",
    });
  });

  it("hook 载荷用 snake_case（与 tool_name / duration_ms 一致），缺省 source=user 由调用方决定", () => {
    expect(toHookSourceFields({ taskId: "abc", origin: "loop" })).toEqual({
      source: "scheduled",
      scheduled_task_id: "abc",
      scheduled_origin: "loop",
    });
  });

  it("来源头 + 正文是一个整体（首行头、次行起是原文）", () => {
    const text = withScheduledPromptHeader("检查 CI", { taskId: "abc", origin: "loop" }, "zh");
    const lines = text.split("\n");
    expect(lines[0]).toContain("[");
    expect(lines[0]).toContain("abc");
    expect(lines[1]).toBe("检查 CI");
  });
});
