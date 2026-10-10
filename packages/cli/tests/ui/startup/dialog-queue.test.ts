/**
 * 首屏对话框队列（Bug：信任框 / @import 框关掉后 MCP 启动审批框不再出现）。
 * 变异自证：把 App.tsx handleDialogClose 改回直接置 null、或把 nextStartupDialog 改成
 * 恒返回 null →「信任框关闭后接续 MCP 审批」红。
 */
import { describe, test, expect } from "bun:test";
import { nextStartupDialog, type StartupDialog } from "../../../src/ui/startup/dialog-queue.ts";

const pending =
  (...on: StartupDialog[]) =>
  (d: StartupDialog) =>
    on.includes(d);

describe("nextStartupDialog", () => {
  test("从头取第一个有待办的", () => {
    expect(nextStartupDialog(null, pending("trust", "mcp-approval"))).toBe("trust");
    expect(nextStartupDialog(null, pending("mcp-approval"))).toBe("mcp-approval");
    expect(nextStartupDialog(null, pending())).toBeNull();
  });

  test("信任框关闭后接续 MCP 审批（跳过没有待办的 @import）", () => {
    expect(nextStartupDialog("trust", pending("trust", "mcp-approval"))).toBe("mcp-approval");
  });

  test("onboarding 完成后接续信任框", () => {
    expect(nextStartupDialog("onboarding", pending("trust"))).toBe("trust");
  });

  test("只往后走：MCP 审批框 Esc 暂不决定后不再反复弹", () => {
    expect(nextStartupDialog("mcp-approval", pending("mcp-approval"))).toBeNull();
  });

  test("用户主动打开的对话框关闭时不把首屏队列拉起来", () => {
    expect(nextStartupDialog("model", pending("mcp-approval"))).toBeNull();
  });
});
