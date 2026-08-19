/**
 * enter_plan_mode 的措辞纠偏（源头侧，不是防线）。
 *
 * 事故里模型连续 5 次误触 enter_plan_mode（真实意图是 enter_worktree），其中两次的 topic
 * 直接是 `noop` / `noop2` —— 模型自己都没编出主题。而每次它都是先 exit 再 enter，所以
 * `isActive()` 恒 false、原有的重入拦截恒不命中；命中时那句「已经在计划模式中」也只说状态、
 * 不说"你想做的事该怎么做"，对模型没有信息量。
 *
 * 这里锁的是「把正确的下一步写进模型此刻正在读的那段文本」这一手法，
 * 与 bash 的 cwd 告知、提示词的分区标注同源。
 *
 * ⚠️ 刻意**不**测「检测 enter/exit 振荡并阻断」—— 本项目的启发式防线实测误判率≈100%
 * （循环检测因此默认关闭），加防线不是修复。根因已在提示词分区 + worktree un-defer 处修掉。
 */

import { describe, test, expect } from "bun:test";
import { EnterPlanModeTool } from "@sid-code/core/tool/enter-plan-mode.ts";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";

function makeTool() {
  return new EnterPlanModeTool(new PlanModeManager());
}

describe("topic 缺失/无意义时补 worktree 纠偏提示", () => {
  test("topic 省略 → 返回值点名 enter_worktree", async () => {
    const result = await makeTool().execute({});
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("enter_worktree");
    expect(result.output).toContain("本工具只切换计划模式");
  });

  test("topic 是 noop / noop2 这类占位 → 同样补提示（实测出现过）", async () => {
    for (const topic of ["noop", "noop2", "NOOP"]) {
      const result = await makeTool().execute({ topic });
      expect(result.output).toContain("enter_worktree");
    }
  });

  test("topic 是真实主题 → 不补提示（避免每次进 plan mode 都刷一段无关文字）", async () => {
    const result = await makeTool().execute({ topic: "重构认证模块" });
    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain("enter_worktree");
  });
});

describe("重入拦截的措辞带纠偏信息", () => {
  test("已在 plan mode 时再调 → 除状态外还给出正确的下一步", async () => {
    const manager = new PlanModeManager();
    const tool = new EnterPlanModeTool(manager);

    const first = await tool.execute({ topic: "第一次进入" });
    expect(first.isError).toBeFalsy();
    expect(manager.isActive()).toBe(true);

    const second = await tool.execute({ topic: "第二次进入" });
    expect(second.isError).toBe(true);
    expect(second.output).toContain("已经在计划模式中");
    // 原文案只有上面那半句，对模型没有信息量
    expect(second.output).toContain("enter_worktree");
  });
});
