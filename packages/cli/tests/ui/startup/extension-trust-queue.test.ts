/**
 * 项目扩展信任进首屏对话框队列：紧跟工作区信任、排在 @import / MCP 审批之前，
 * 关闭后接续下一个——此前它在 TUI 起来之前用终端 y/N 问。
 */

import { describe, test, expect } from "bun:test";
import { nextStartupDialog } from "@sid-code/cli/ui/startup/dialog-queue.ts";

describe("首屏队列 · extension-trust", () => {
  test("有待确认扩展时排在工作区信任之后、MCP 审批之前", () => {
    const pending = new Set(["trust", "extension-trust", "mcp-approval"]);
    const has = (d: string) => pending.has(d);
    expect(nextStartupDialog(null, has)).toBe("trust");
    expect(nextStartupDialog("trust", has)).toBe("extension-trust");
    expect(nextStartupDialog("extension-trust", has)).toBe("mcp-approval");
  });

  test("没有工作区信任项时首屏直接是扩展信任", () => {
    expect(nextStartupDialog(null, (d) => d === "extension-trust")).toBe("extension-trust");
  });
});
