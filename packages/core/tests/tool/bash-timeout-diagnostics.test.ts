/**
 * Bash 前台超时诊断回归
 *
 * 缺陷来源：会话 20261019-163503-c0e3e484。`pnpm -r test:unit > /tmp/all-unit.txt 2>&1`
 * 中 test:unit 是裸 `vitest`，非 CI 下进 watch 永不退出；超时提示只说「请用
 * run_in_background=true 重试」+「(命令无输出)」，模型照做后后台同样挂住。
 *
 * 断言两件事：
 *   1. 输出被重定向进文件时，超时结果里能看到文件尾部（线索不再被藏起来）；
 *   2. 识别到 watch 特征时，提示明确说「转后台无效、改成一次性运行」。
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BashTool } from "../../src/tool/bash.ts";
import {
  buildTimeoutGuidance,
  detectNonTerminatingSignal,
  readRedirectTails,
} from "../../src/tool/bash/timeout-diagnostics.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bash-timeout-diag-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("detectNonTerminatingSignal", () => {
  it("识别 vitest watch 原文（取自真实轨迹）", () => {
    const tail =
      "packages/ontology-studio test:unit:  PASS  Waiting for file changes...\n" +
      "packages/ontology-studio test:unit:        press h to show help, press q to quit\n";
    expect(detectNonTerminatingSignal(tail)).not.toBeNull();
  });

  it("正常结束的 vitest run 输出不误判", () => {
    const done =
      " Test Files  94 passed (94)\n      Tests  1394 passed (1394)\n   Duration  12.3s\n";
    expect(detectNonTerminatingSignal(done)).toBeNull();
    expect(detectNonTerminatingSignal("(命令无输出)")).toBeNull();
  });
});

describe("readRedirectTails", () => {
  it("只回读绝对路径的写入重定向目标，/dev/null 与相对路径跳过", () => {
    const f = join(dir, "out.txt");
    writeFileSync(f, "hello-tail");
    const tails = readRedirectTails(`cmd >/dev/null; cmd2 > rel.txt; cmd3 > ${f} 2>&1`);
    expect(tails.map((t) => t.tail)).toEqual(["hello-tail"]);
  });

  it("文件不存在/为空时静默返回空", () => {
    expect(readRedirectTails(`cmd > ${join(dir, "missing.txt")}`)).toEqual([]);
    const empty = join(dir, "empty.txt");
    writeFileSync(empty, "");
    expect(readRedirectTails(`cmd > ${empty}`)).toEqual([]);
  });
});

describe("buildTimeoutGuidance", () => {
  it("管道有输出时不回读文件（避免冗余）", () => {
    const f = join(dir, "noread.txt");
    writeFileSync(f, "SHOULD_NOT_APPEAR");
    const { redirectSection } = buildTimeoutGuidance(`cmd > ${f}`, "some output", false);
    expect(redirectSection).toBe("");
  });

  it("未命中特征时仍保留 run_in_background 引导（真慢命令的正确出路）", () => {
    const { guidance } = buildTimeoutGuidance("sleep 5", "(命令无输出)", true);
    expect(guidance).toContain("run_in_background=true");
    expect(guidance).toContain("是否会自己退出");
  });
});

describe("端到端：BashTool 超时结果", () => {
  it("重定向进文件的 watch 命令：超时结果带出文件尾部并判定为不会退出", async () => {
    if (process.platform === "win32") return;
    const log = join(dir, "watch.log");
    const bash = new BashTool();
    // 模拟 vitest：先打印 watch 提示（进文件），再常驻不退出
    const result = await bash.execute({
      command: `{ echo ' PASS  Waiting for file changes...'; sleep 30; } > ${log} 2>&1`,
      description: "模拟 watch 模式",
      timeout: 1000,
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("超时");
    expect(result.output).toContain("Waiting for file changes");
    expect(result.output).toContain("不会自己退出");
    expect(result.output).toContain("转后台");
  }, 10000);
});
