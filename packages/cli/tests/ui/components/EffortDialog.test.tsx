/**
 * `/effort` 面板：档位说明必须随模型数据变化（2026-11-13 §8.4）。
 *
 * 两条曾经**写死**的话术都是错的：
 *
 * - `high` 的 desc 写死「（多数模型默认）」—— GLM-5.3 / Kimi K3 默认 `max`、
 *   Claude Opus 5.5 默认 `medium`，在这些模型上那句话直接把默认档说错；
 * - `low` 的 desc 写死「快速响应，跳过深度推理」—— 在恒思考模型上 low 是 `/think off`
 *   的落点（`cap.thinkingOffFloor`），用户看到这句话不会知道「这已经是我能拿到的最省了」。
 *
 * 现在两处都按 `cap.defaultEffort` / `cap.thinkingControl` 生成，本文件用**整帧渲染**锁住它
 * （纯函数断言看不出窄终端下会不会塌版，UI 规范 L5.2 要求布局相关改动走整帧）。
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSync } from "@sid-code/cli/ui/render-port/testing.ts";
import { KeypressProvider } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { TerminalProvider } from "@sid-code/cli/ui/contexts/TerminalContext.tsx";
import { EffortDialog } from "@sid-code/cli/ui/components/EffortDialog.tsx";
import {
  resolveEffortCapability,
  getDisplayedEffort,
  type EffortSetting,
} from "@sid-code/core/llm/effort.ts";

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/** 渲染一整帧；`model` 走真实 `resolveEffortCapability`，不手搓 cap（手搓会漏掉数据驱动的部分） */
function frameOf(
  model: string,
  runtime: EffortSetting = undefined,
  columns = 100,
  thinkingApplied?: boolean,
): string {
  let output = "";
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
  };
  stdout.columns = columns;
  stdout.rows = 30;
  (stdout as unknown as { isTTY: boolean }).isTTY = false;
  stdout.on("data", (c: Buffer) => (output += c.toString()));
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const a = stdin as unknown as Record<string, unknown>;
  a.isTTY = true;
  a.setRawMode = () => stdin;
  a.setEncoding = () => stdin;
  a.ref = () => stdin;
  a.unref = () => stdin;

  const capability = resolveEffortCapability({
    model,
    provider: "openai",
    baseURL: "https://gw.example.com/v1",
  });
  const inst = renderSync(
    <TerminalProvider>
      <KeypressProvider>
        <EffortDialog
          onClose={() => {}}
          getEffortState={() => ({
            runtime,
            applied: getDisplayedEffort(capability, runtime, null, thinkingApplied),
            isAuto: runtime === undefined,
            capability,
          })}
          getThinkingState={
            thinkingApplied === undefined
              ? undefined
              : () => ({ runtime: thinkingApplied ? "on" : "off", applied: thinkingApplied })
          }
        />
      </KeypressProvider>
    </TerminalProvider>,
    { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
  );
  inst.unmount();
  return stripAnsi(output);
}

/**
 * 取某个档位所在的行。
 *
 * 不锚定行首：面板有 `round` 边框，行首实际是 `│` 加缩进，锚定 `^` 会一行都匹配不到
 * （UI 规范 L5.2 记过这类「先按行过滤再断言」的坑）。用「字形 + 空格 + 标签」定位，
 * 既避开边框，也避开 auto 行说明里的 `= max` 这类同名字符串。
 */
const line = (frame: string, label: string) =>
  frame.split("\n").find((l) => new RegExp(`[▁▃▅▇█]\\s*${label}\\b`).test(l)) ?? "";

let savedConfigDir: string | undefined;
let tmpHome: string;

beforeEach(() => {
  // 落盘隔离：`resolveEffortCapability` 的消费链上存在能力缓存读写，
  // 不重定向会写进用户真实 `~/.sid-code/`（CONTRIBUTING「测试约定」）。
  savedConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-effort-dialog-"));
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterEach(() => {
  // 存/恢复原值，不要无条件 delete：同批多文件跑在同一进程，删掉会连 preload 兜底一起抹掉。
  if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("EffortDialog 档位说明由模型数据生成", () => {
  test("GLM-5.3（默认 max、恒思考）：默认标记落在 max，low 说明是关思考的落点", () => {
    const f = frameOf("glm-5.3");
    // 默认档标记跟着数据走，不再写死在 high 上
    expect(line(f, "max")).toContain("模型默认");
    expect(line(f, "high")).not.toContain("模型默认");
    // 恒思考模型的 low 是 /think off 的落点，说法必须点明「思考不可关」和落点
    expect(line(f, "low")).toContain("最低强度（思考不可关，/think off 落到这档）");
    // auto 把默认档写进说明：用户选 auto 最想知道的就是「那到底跑哪档」
    expect(f).toContain("不下发，按模型默认（= max）");
    // 面板只列该模型真实有的档（GLM-5.3 没有 medium / xhigh）
    expect(f).not.toContain("medium");
    expect(f).not.toContain("xhigh");
  });

  test("DeepSeek V4（默认 high、可关）：默认标记落在 high，low 保持普通说明", () => {
    const f = frameOf("deepseek-v4");
    expect(line(f, "high")).toContain("模型默认");
    expect(line(f, "low")).toContain("快速响应，跳过深度推理");
    expect(line(f, "low")).not.toContain("思考不可关");
    expect(f).toContain("不下发，按模型默认（= high）");
  });

  test("Claude Opus 5.5（默认 medium、恒思考）：默认标记落在 medium", () => {
    const f = frameOf("claude-opus-5-5");
    expect(line(f, "medium")).toContain("模型默认");
    expect(line(f, "high")).not.toContain("模型默认");
    expect(f).toContain("不下发，按模型默认（= medium）");
  });

  test("恒思考 + 思考关：状态行显示兜底档（实发 low），不显示用户选的档", () => {
    // `/think off` + 之前选的 max：线上实发 low（thinkingOffFloor），面板必须说 low
    const f = frameOf("glm-5.3", "max", 100, false);
    expect(f).toContain("当前: max（本模型按 low 下发）");
    // 兜底档会真的发出去，所以「档位不会下发」的警告不能出现（两者会互相矛盾）
    expect(f).not.toContain("本模型的档位不会下发");
  });

  test("窄终端（70 列）下不塌版：每个档位行都完整且不超宽", () => {
    const f = frameOf("claude-opus-5-5", undefined, 70);
    for (const [label, text] of [
      ["low", "最低强度"],
      ["medium", "平衡模式（模型默认）"],
      ["xhigh", "更深推理"],
    ] as const) {
      const l = line(f, label);
      expect(l, `${label} 行缺失或与档位标签错位`).not.toBe("");
      // 文案不能被截断
      expect(l).toContain(text);
      // 去掉左右框线再量可见宽度：框线是终端宽度的固定成本，不算塌版。
      // 不量整帧：`renderSync` 的多次 layout pass 会把两帧的框线拼在同一行里，那是渲染器的
      // 输出形态，不是面板宽度问题（按 UI 规范 L5.2「先按行过滤出目标行再断言」）。
      expect(l.replace(/[│╭╮╰╯]/g, "").length).toBeLessThanOrEqual(70);
    }
  });
});
