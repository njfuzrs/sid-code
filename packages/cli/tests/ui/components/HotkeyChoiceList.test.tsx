/**
 * HotkeyChoiceList 真实按键端到端测试。
 *
 * 为什么需要它、而不是只有 permission-choices 的纯函数单测：纯函数测的是「给一个 up 键
 * 应该返回 move」，测不到「组件真的把 up 键收到了」。本次缺陷的完整形态是两段：
 * ① 判定顺序错（纯函数单测覆盖）；② 按键要经 KeypressProvider 的转义序列解析 + 优先级
 * 分发才能到 handler 手上（本文件覆盖）。少了 ②，「方向键能用」仍然是个未验证的推断。
 *
 * 手段：vendored ink 的测试 shim（`_vendor/testing.tsx`）暴露了 `stdin.write`，
 * 往里写真实终端转义序列（`\x1b[A` = ↑、`\r` = Enter），让 KeypressProvider 走完整解析链。
 * 本文件是仓库里第一处这么测键盘交互的地方——`grep -rl KeypressProvider packages/cli/tests/`
 * 此前零命中，新增确认类弹窗可照此写。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { renderSync } from "@sid-code/tui-renderer/root.ts";
import { KeypressProvider, ESC_TIMEOUT } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { HotkeyChoiceList } from "@sid-code/cli/ui/components/shared/HotkeyChoiceList.tsx";
import { buildPermissionChoices } from "@sid-code/cli/ui/components/permission-choices.ts";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

/** 去 ANSI，断言只看内容与字形，不与配色耦合（沿用 CoreRendering.test.tsx 的做法） */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** 取最后一个完整帧（非 TTY 下 ink 每帧包在 DEC 同步序列里），同 _vendor/testing.tsx 的做法 */
function extractLastFrame(output: string): string {
  const lastStart = output.lastIndexOf(SYNC_START);
  if (lastStart === -1) return output;
  const contentStart = lastStart + SYNC_START.length;
  const endIndex = output.indexOf(SYNC_END, contentStart);
  return endIndex === -1 ? output.slice(contentStart) : output.slice(contentStart, endIndex);
}

/**
 * 本地渲染 harness（**不复用 `_vendor/testing.tsx` 的 render**）。
 *
 * 原因：那个 shim 的 `stdin.write` 发的是 `Buffer`，而生产路径里 KeypressProvider
 * 会先 `process.stdin.setEncoding("utf8")`，所以它的解析器按**字符串**逐字符遍历。
 * 拿 Buffer 喂进去，`for (const char of data)` 得到的是数字，`ch.toLowerCase` 直接 undefined
 * 报 TypeError——按键根本到不了 handler。这里自己建 stdin 并 emit 字符串，才是生产同形态。
 * （没去改 vendor 那个 shim：它被 CoreRendering 等既有测试依赖，改它的 IO 语义风险大于收益。）
 */
function renderWithKeys(node: React.ReactElement) {
  let output = "";
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
  };
  stdout.columns = 80;
  stdout.rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = false;
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const stdinAny = stdin as unknown as Record<string, unknown>;
  stdinAny.isTTY = true;
  stdinAny.setRawMode = () => stdin;
  stdinAny.setEncoding = () => stdin;
  stdinAny.ref = () => stdin;
  stdinAny.unref = () => stdin;

  const instance = renderSync(node, {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    lastFrame: () => extractLastFrame(output),
    /**
     * 打一个键并等状态落地。**必须 await**：
     * ① `setCursor` 是 React 状态更新，要一个 tick 才 flush 到下一帧，同步读帧会读到旧光标；
     * ② 裸 `\x1b`（Esc）在解析器里要等 `ESC_TIMEOUT`(50ms) 才确认「不是转义序列前缀」而
     *    上报成 escape 键——这是终端 Esc 与方向键前缀天生歧义的必要代价，不是测试的瑕疵。
     * 等待时长取 ESC_TIMEOUT 的两倍余量，避免慢机器上抖动。
     */
    press: async (seq: string) => {
      stdin.emit("data", seq);
      await new Promise((r) => setTimeout(r, ESC_TIMEOUT * 2));
    },
    unmount: () => instance.unmount(),
  };
}

/** 终端上报的按键序列 */
const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
} as const;

const CHOICES = buildPermissionChoices({ toolName: "bash", isDangerous: false }); // y n a A

/** 挂载一个受控列表，返回帧读取器 + 打键器 + 已捕获的选择结果 */
function mount(initialIndex = 0) {
  const picked: string[] = [];
  const r = renderWithKeys(
    <KeypressProvider>
      <HotkeyChoiceList
        choices={CHOICES}
        initialIndex={initialIndex}
        onSelect={(v) => picked.push(v)}
        escapeValue="no"
      />
    </KeypressProvider>,
  );
  return {
    picked,
    frame: () => stripAnsi(r.lastFrame()),
    press: r.press,
    unmount: r.unmount,
  };
}

/**
 * 光标位置的可观测判据：焦点行带 POINTER(▸) 且填充 radio(●)，非焦点行是空 radio(○)。
 * 返回带 ▸ 的那一行，用于断言「光标落在哪个选项上」。
 */
function focusedLine(frame: string): string {
  return frame.split("\n").find((l) => l.includes("▸")) ?? "";
}

describe("HotkeyChoiceList — 初始渲染", () => {
  test("四个选项与快捷键徽标都在（可见即可用）", () => {
    const { frame, unmount } = mount();
    const f = frame();
    expect(f).toContain("允许");
    expect(f).toContain("拒绝");
    expect(f).toContain("本会话始终允许");
    expect(f).toContain("持久化到项目配置");
    unmount();
  });

  test("光标初始落在第 0 项，且只有一行有指针", () => {
    const { frame, unmount } = mount();
    const f = frame();
    expect(focusedLine(f)).toContain("允许");
    expect(f.split("\n").filter((l) => l.includes("▸")).length).toBe(1);
    unmount();
  });

  test("initialIndex 生效——危险操作的安全默认靠它落在「拒绝」上", () => {
    const dangerous = buildPermissionChoices({ toolName: "bash", isDangerous: true }); // n y a
    const r = renderWithKeys(
      <KeypressProvider>
        <HotkeyChoiceList
          choices={dangerous}
          initialIndex={0}
          onSelect={() => {}}
          escapeValue="no"
        />
      </KeypressProvider>,
    );
    expect(focusedLine(stripAnsi(r.lastFrame()))).toContain("拒绝");
    r.unmount();
  });
});

describe("HotkeyChoiceList — 方向键真的走通了（原缺陷的端到端反证）", () => {
  test("↓ 让光标从「允许」移到「拒绝」", async () => {
    const { frame, press, unmount } = mount();
    expect(focusedLine(frame())).toContain("允许");
    await press(KEY.down);
    expect(focusedLine(frame())).toContain("拒绝");
    unmount();
  });

  test("↓↓ 到第 3 项「本会话始终允许」", async () => {
    const { frame, press, unmount } = mount();
    await press(KEY.down);
    await press(KEY.down);
    expect(focusedLine(frame())).toContain("本会话始终允许");
    unmount();
  });

  test("↑ 从首项环绕到末项「持久化到项目配置」", async () => {
    const { frame, press, unmount } = mount();
    await press(KEY.up);
    expect(focusedLine(frame())).toContain("持久化到项目配置");
    unmount();
  });

  test("方向键本身不产生选择（移动 ≠ 确认，防手滑）", async () => {
    const { picked, press, unmount } = mount();
    await press(KEY.down);
    await press(KEY.up);
    expect(picked).toEqual([]);
    unmount();
  });
});

describe("HotkeyChoiceList — Enter 确认（原实现没有这条路径）", () => {
  test("Enter 选中光标所在项", async () => {
    const { picked, press, unmount } = mount();
    await press(KEY.enter);
    expect(picked).toEqual(["yes"]);
    unmount();
  });

  test("↓ 后 Enter 选中「拒绝」", async () => {
    const { picked, press, unmount } = mount();
    await press(KEY.down);
    await press(KEY.enter);
    expect(picked).toEqual(["no"]);
    unmount();
  });

  test("↓↓↓ 后 Enter 选中持久档（跨会话档位在 UI 上真的可达）", async () => {
    const { picked, press, unmount } = mount();
    await press(KEY.down);
    await press(KEY.down);
    await press(KEY.down);
    await press(KEY.enter);
    expect(picked).toEqual(["always-persist"]);
    unmount();
  });
});

describe("HotkeyChoiceList — 字母与数字直达仍在", () => {
  test("y / n / a 各自直达，不必先移光标", async () => {
    for (const [seq, expected] of [
      ["y", "yes"],
      ["n", "no"],
      ["a", "always"],
    ] as const) {
      const { picked, press, unmount } = mount();
      await press(seq);
      expect(picked).toEqual([expected]);
      unmount();
    }
  });

  test("大写 A 直达持久档（与裸 a 的会话档区分开）", async () => {
    const { picked, press, unmount } = mount();
    await press("A");
    expect(picked).toEqual(["always-persist"]);
    unmount();
  });

  test("数字 2 直达第 2 项「拒绝」", async () => {
    const { picked, press, unmount } = mount();
    await press("2");
    expect(picked).toEqual(["no"]);
    unmount();
  });

  test("无关字母不触发任何选择", async () => {
    const { picked, press, unmount } = mount();
    await press("z");
    expect(picked).toEqual([]);
    unmount();
  });
});

describe("HotkeyChoiceList — Esc 出口", () => {
  test("Esc 回灌保守值（权限框=拒绝），用户不必靠 Ctrl+C 逃出去", async () => {
    const { picked, press, unmount } = mount();
    await press(KEY.escape);
    expect(picked).toEqual(["no"]);
    unmount();
  });
});
