/**
 * 确认框选项集构建 + 快捷键匹配单测。
 *
 * 这些断言锁的是**用户可感知的契约**，不是实现细节：
 * ① y/n/a 三个字母必须一直在（官网 first-task.md / glossary.md 写明，也是既有肌肉记忆）；
 * ② 危险操作的光标默认落点必须是「拒绝」（src/ui/CLAUDE.md L4-E 安全默认），
 *    且**不得**出现持久档（一键永久放行破坏性命令）；
 * ③ Bash 类工具必须有 `always-persist` 档——app.ts 的 persistBashAllowRule 整条链路
 *    早已实现，线上 UI 却按不出来，这条断言就是防这类「后端有、前端不给入口」复发；
 * ④ `A`（Shift+A）与 `a` 必须能被区分开——终端上报 Shift+A 时 key.name 仍是 "a"，
 *    只比 name 会让裸 a 把持久档截胡，是最容易写错的一处。
 */

import { test, expect, describe } from "bun:test";
import {
  buildPermissionChoices,
  buildShellConfirmChoices,
  initialPermissionChoiceIndex,
  initialShellChoiceIndex,
  isBashLikeTool,
  matchHotkey,
  resolveChoiceKey,
  type ChoiceKeyInput,
  type PermissionAnswer,
} from "@sid-code/cli/ui/components/permission-choices.ts";

/** 取快捷键序列，便于整体断言选项集形状 */
const keysOf = (cs: ReadonlyArray<{ hotkey: string }>) => cs.map((c) => c.hotkey);
const valuesOf = (cs: ReadonlyArray<{ value: unknown }>) => cs.map((c) => c.value);

describe("buildPermissionChoices — 选项集随工具与危险性变化", () => {
  test("普通文件工具：y/n/a 三档，不给持久档", () => {
    const cs = buildPermissionChoices({ toolName: "write", isDangerous: false });
    expect(keysOf(cs)).toEqual(["y", "n", "a"]);
    expect(valuesOf(cs)).toEqual(["yes", "no", "always"]);
    // 文件编辑类不给持久档（对齐 CC「Edit always 仅会话」）
    expect(keysOf(cs)).not.toContain("A");
  });

  test("Bash 工具：额外给 A 持久档，且 always-persist 可达", () => {
    const cs = buildPermissionChoices({ toolName: "bash", isDangerous: false });
    expect(keysOf(cs)).toEqual(["y", "n", "a", "A"]);
    // 这一条是回归防线：app.ts 的持久化链路必须有 UI 入口
    expect(valuesOf(cs)).toContain("always-persist");
  });

  test("危险命令：拒绝在首位、且不提供持久档", () => {
    const cs = buildPermissionChoices({ toolName: "bash", isDangerous: true });
    expect(cs[0].value).toBe("no");
    expect(keysOf(cs)).toEqual(["n", "y", "a"]);
    expect(valuesOf(cs)).not.toContain("always-persist");
  });

  test("危险命令的允许项文案带仪式感（不是平淡的「允许」）", () => {
    const cs = buildPermissionChoices({ toolName: "bash", isDangerous: true });
    const allow = cs.find((c) => c.value === "yes")!;
    expect(allow.label).toBe("确认执行");
    const deny = cs.find((c) => c.value === "no")!;
    expect(deny.label).toContain("推荐");
  });

  test("y/n/a 三个字母在所有分支下恒定存在（官网文档写明的契约）", () => {
    for (const toolName of ["bash", "write", "edit", "read", "shell", ""]) {
      for (const isDangerous of [true, false]) {
        const keys = keysOf(buildPermissionChoices({ toolName, isDangerous }));
        expect(keys).toContain("y");
        expect(keys).toContain("n");
        expect(keys).toContain("a");
      }
    }
  });

  test("选项的快捷键互不重复（含大小写：a 与 A 是两个键）", () => {
    const cs = buildPermissionChoices({ toolName: "bash", isDangerous: false });
    expect(new Set(keysOf(cs)).size).toBe(cs.length);
  });
});

describe("isBashLikeTool — 持久档的适用范围", () => {
  test("命中 shell 类工具名（含别名，不是硬编码等值判断）", () => {
    expect(isBashLikeTool("bash")).toBe(true);
    expect(isBashLikeTool("Bash")).toBe(true);
    expect(isBashLikeTool("shell")).toBe(true);
    expect(isBashLikeTool("exec_command")).toBe(true);
  });

  test("不命中文件类工具", () => {
    expect(isBashLikeTool("write")).toBe(false);
    expect(isBashLikeTool("edit")).toBe(false);
    expect(isBashLikeTool("read")).toBe(false);
    expect(isBashLikeTool("")).toBe(false);
  });
});

describe("initialPermissionChoiceIndex — 危险操作安全默认", () => {
  test("普通操作光标落在第 0 项（允许）", () => {
    const cs = buildPermissionChoices({ toolName: "write", isDangerous: false });
    expect(initialPermissionChoiceIndex(cs, false)).toBe(0);
  });

  test("危险操作光标落在「拒绝」上（按 value 反查，顺序调整也不会漂）", () => {
    const cs = buildPermissionChoices({ toolName: "bash", isDangerous: true });
    const idx = initialPermissionChoiceIndex(cs, true);
    expect(cs[idx].value).toBe("no");
  });

  test("选项集里没有 no 时退化为 0，不越界", () => {
    const fake = [
      { value: "yes" as PermissionAnswer, hotkey: "y", label: "允许", tone: "allow" as const },
    ];
    expect(initialPermissionChoiceIndex(fake, true)).toBe(0);
  });
});

describe("buildShellConfirmChoices / initialShellChoiceIndex", () => {
  test("普通：确认执行在前", () => {
    const cs = buildShellConfirmChoices(false);
    expect(valuesOf(cs)).toEqual([true, false]);
    expect(initialShellChoiceIndex(cs, false)).toBe(0);
  });

  test("危险：取消在前，且光标默认落在取消上", () => {
    const cs = buildShellConfirmChoices(true);
    expect(cs[0].value).toBe(false);
    const idx = initialShellChoiceIndex(cs, true);
    expect(cs[idx].value).toBe(false);
  });
});

describe("resolveChoiceKey — 按键决策（锁住本次修的判定顺序缺陷）", () => {
  const cs = buildPermissionChoices({ toolName: "bash", isDangerous: false }); // y n a A
  /** 构造按键：默认非 insertable（方向键这类），字母键显式传 insertable */
  const k = (over: Partial<ChoiceKeyInput> & { name: string }): ChoiceKeyInput => ({
    shift: false,
    ctrl: false,
    insertable: false,
    sequence: "",
    ...over,
  });

  describe("方向键必须生效 —— 这就是原缺陷", () => {
    // 原实现把 `if (!key.insertable) return false` 写在导航判定**之前**，
    // 而方向键 insertable=false，于是 ↑↓ 在第一步就被吞掉，光标根本不存在。
    // 这两条断言是该缺陷的直接反向自证：把 insertable 门禁挪回导航之前，它们必红。
    test("↑ 从 0 环绕到末项", () => {
      expect(resolveChoiceKey(cs, 0, k({ name: "up" }), true)).toEqual({ kind: "move", index: 3 });
    });

    test("↓ 从末项环绕回 0", () => {
      expect(resolveChoiceKey(cs, 3, k({ name: "down" }), true)).toEqual({
        kind: "move",
        index: 0,
      });
    });

    test("↓ 常规下移", () => {
      expect(resolveChoiceKey(cs, 1, k({ name: "down" }), true)).toEqual({
        kind: "move",
        index: 2,
      });
    });

    test("emacs 键位 ctrl+p / ctrl+n 同样导航", () => {
      expect(resolveChoiceKey(cs, 1, k({ name: "p", ctrl: true }), true)).toEqual({
        kind: "move",
        index: 0,
      });
      expect(resolveChoiceKey(cs, 1, k({ name: "n", ctrl: true }), true)).toEqual({
        kind: "move",
        index: 2,
      });
    });

    test("ctrl+n 是下移、裸 n 是拒绝 —— 两者不得混淆", () => {
      const bare = resolveChoiceKey(cs, 0, k({ name: "n", insertable: true, sequence: "n" }), true);
      expect(bare).toEqual({ kind: "select", index: 1 }); // n = 第 2 项拒绝
    });
  });

  describe("Enter 必须能确认 —— 原实现完全没有 enter 分支", () => {
    test("Enter 选定光标所在项", () => {
      expect(resolveChoiceKey(cs, 2, k({ name: "enter" }), true)).toEqual({
        kind: "select",
        index: 2,
      });
    });

    test("return 与 enter 等价（不同终端上报名不同）", () => {
      expect(resolveChoiceKey(cs, 0, k({ name: "return" }), true)).toEqual({
        kind: "select",
        index: 0,
      });
    });
  });

  describe("Esc 出口", () => {
    test("提供 escapeValue 时消费 Esc", () => {
      expect(resolveChoiceKey(cs, 0, k({ name: "escape" }), true)).toEqual({ kind: "escape" });
    });

    test("未提供 escapeValue 时放行给外层（不吞键）", () => {
      expect(resolveChoiceKey(cs, 0, k({ name: "escape" }), false)).toEqual({ kind: "ignore" });
    });
  });

  describe("数字直达", () => {
    test("1 选第 1 项、4 选第 4 项", () => {
      expect(
        resolveChoiceKey(cs, 0, k({ name: "1", insertable: true, sequence: "1" }), true),
      ).toEqual({ kind: "select", index: 0 });
      expect(
        resolveChoiceKey(cs, 0, k({ name: "4", insertable: true, sequence: "4" }), true),
      ).toEqual({ kind: "select", index: 3 });
    });

    test("超出选项数的数字不消费（3 项时按 4 无效）", () => {
      const three = buildPermissionChoices({ toolName: "write", isDangerous: false });
      expect(
        resolveChoiceKey(three, 0, k({ name: "4", insertable: true, sequence: "4" }), true),
      ).toEqual({ kind: "ignore" });
    });
  });

  describe("字母直达仍在（既有肌肉记忆不能丢）", () => {
    test("y/n/a 各选中对应项", () => {
      expect(
        resolveChoiceKey(cs, 0, k({ name: "y", insertable: true, sequence: "y" }), true),
      ).toEqual({ kind: "select", index: 0 });
      expect(
        resolveChoiceKey(cs, 0, k({ name: "a", insertable: true, sequence: "a" }), true),
      ).toEqual({ kind: "select", index: 2 });
    });

    test("Shift+A 选中持久档（第 4 项），不被裸 a 截胡", () => {
      expect(
        resolveChoiceKey(
          cs,
          0,
          k({ name: "a", shift: true, insertable: true, sequence: "A" }),
          true,
        ),
      ).toEqual({ kind: "select", index: 3 });
    });

    test("无关字母不消费，交给下一个 handler", () => {
      expect(
        resolveChoiceKey(cs, 0, k({ name: "z", insertable: true, sequence: "z" }), true),
      ).toEqual({ kind: "ignore" });
    });
  });

  test("空选项集不崩溃、不消费", () => {
    expect(resolveChoiceKey([], 0, k({ name: "up" }), true)).toEqual({ kind: "ignore" });
  });
});

describe("matchHotkey — 大小写与 shift 联合匹配", () => {
  const cs = buildPermissionChoices({ toolName: "bash", isDangerous: false });

  test("裸 a → 会话档 always（不被持久档截胡）", () => {
    expect(matchHotkey(cs, "a", false)?.value).toBe("always");
  });

  test("Shift+A → 持久档 always-persist（key.name 仍是小写 a）", () => {
    expect(matchHotkey(cs, "a", true)?.value).toBe("always-persist");
  });

  test("小写键位不接受 shift 修饰（Shift+Y 不误触发允许）", () => {
    expect(matchHotkey(cs, "y", true)).toBeUndefined();
    expect(matchHotkey(cs, "y", false)?.value).toBe("yes");
  });

  test("未定义的键返回 undefined（handler 应放行给下一层）", () => {
    expect(matchHotkey(cs, "z", false)).toBeUndefined();
  });

  test("无持久档时 Shift+A 不匹配任何项（危险操作下按 A 无效）", () => {
    const dangerous = buildPermissionChoices({ toolName: "bash", isDangerous: true });
    expect(matchHotkey(dangerous, "a", true)).toBeUndefined();
    expect(matchHotkey(dangerous, "a", false)?.value).toBe("always");
  });
});
