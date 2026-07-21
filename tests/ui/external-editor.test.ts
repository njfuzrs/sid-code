/**
 * P1-3 外部编辑器命令解析单测。
 * editInExternalEditor 本身要 spawn 全屏编辑器 + 操作 ink 实例，不适合单测；
 * 这里只覆盖纯函数 resolveEditorCommand 的优先级/回退逻辑。
 */

import { describe, test, expect } from "bun:test";
import { resolveEditorCommand } from "../../src/ui/utils/external-editor.ts";

describe("resolveEditorCommand", () => {
  test("优先 $VISUAL", () => {
    expect(resolveEditorCommand({ VISUAL: "vim", EDITOR: "nano" })).toEqual(["vim"]);
  });

  test("无 VISUAL 时用 $EDITOR", () => {
    expect(resolveEditorCommand({ EDITOR: "nano" })).toEqual(["nano"]);
  });

  test("支持带参数的编辑器命令", () => {
    expect(resolveEditorCommand({ VISUAL: "code --wait" })).toEqual(["code", "--wait"]);
  });

  test("都为空时回退平台默认", () => {
    const cmd = resolveEditorCommand({});
    expect(cmd.length).toBe(1);
    expect(["vi", "notepad"]).toContain(cmd[0]);
  });

  test("空白值视为未设置", () => {
    const cmd = resolveEditorCommand({ VISUAL: "   ", EDITOR: "" });
    expect(["vi", "notepad"]).toContain(cmd[0]);
  });
});
