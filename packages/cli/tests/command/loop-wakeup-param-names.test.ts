/**
 * D6：/loop 自适应轮询提示词曾写 delaySeconds，schedule_wakeup 实际参数是 delay_seconds。
 * 提示词里出现的每个参数名式标识符都必须在工具 schema 里，防止再漂移。
 */

import { describe, test, expect } from "bun:test";
import loopCmd from "@sid-code/cli/command/commands/loop/index.ts";
import type { CommandContext, LocalCommand } from "@sid-code/cli/command/types.ts";
import { ScheduleWakeupTool } from "@sid-code/core/tool/schedule-wakeup.ts";

describe("/loop 提示词与 schedule_wakeup schema 一致", () => {
  test("提示词里的参数名都在 schema properties 里", async () => {
    const mod = await (loopCmd as LocalCommand).load();
    const r = (await mod.call("检查 CI 直到通过", {} as CommandContext)) as {
      type: string;
      prompt?: string;
    };
    expect(r.type).toBe("submit_prompt");
    const tool = new ScheduleWakeupTool();
    const props = Object.keys((tool.inputSchema() as any).properties);
    // snake_case 或 camelCase 标识符（工具名本身除外）
    const idents = (
      r.prompt!.match(/\b[a-z]+(?:_[a-z]+)+\b|\b[a-z]+[A-Z][A-Za-z]*\b/g) ?? []
    ).filter((w) => w !== tool.name());
    expect(idents).toContain("delay_seconds");
    for (const w of idents) expect(props).toContain(w);
  });
});
