/**
 * 附录 C-2：bash 超时被上限**静默**钳制时，结果首行必须说明实际值（2026-11-18）
 *
 * ## 这份测试守的是什么
 *
 * `executeCommand` 里 `const timeout = Math.min(Math.max(params.timeout || defaultMs, FLOOR), maxMs)`
 * 是静默钳制。修前请求 1800s、上限 600s 时，模型收到的只有
 * 「命令执行超过 600 秒被终止（超时）」—— 它自己请求的数字没出现在任何地方，
 * 于是一次真实的可解释现象被归因成「平台 flake」，原样重试。
 *
 * 修法是在 `execute` 的统一收口（`clampTimeoutNotice`）里前置一行说明。
 *
 * ## 边界（同样要钉住）
 *
 * - 未超上限 / 未传 timeout：**不能**出现这行说明（否则每条命令都多一行噪声）。
 * - `run_in_background=true`：结果体是 JSON（`task_id` / `output_file`），前置文本会破坏解析，
 *   且后台的等待期限走 `wait_until_seconds`，不读这个 timeout 的回执。
 *
 * ⚠ 落盘隔离：BashTool 会写日志，必须把 `SID_CONFIG_DIR` 重定向到 tmpdir，
 * 恢复时存/恢复原值（同批多文件跑在一个进程里，无条件 delete 会抹掉 preload 兜底）。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BashTool } from "@sid-code/core/tool/bash.ts";

let configRoot: string;
let prevConfigDir: string | undefined;
let prevMax: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-clamp-cfg-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
  prevMax = process.env.BASH_MAX_TIMEOUT_MS;
  // 固定上限，避免宿主 env 影响断言（CI 与本机可能不同）
  process.env.BASH_MAX_TIMEOUT_MS = "600000";
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  if (prevMax === undefined) delete process.env.BASH_MAX_TIMEOUT_MS;
  else process.env.BASH_MAX_TIMEOUT_MS = prevMax;
  rmSync(configRoot, { recursive: true, force: true });
});

describe("附录 C-2 · 超时钳制必须有回执", () => {
  it("请求超过上限：首行说明请求值与实际值", async () => {
    const bash = new BashTool();
    const r = await bash.execute({ command: "echo hi", timeout: 1_800_000 });
    const first = (r.output ?? "").split("\n")[0];
    expect(first).toContain("请求的超时 1800s 超过上限");
    expect(first).toContain("实际按 600s 执行");
    // 说明只是前置一行，命令本身的输出仍在
    expect(r.output).toContain("hi");
    expect(r.isError).toBeFalsy();
  });

  it("请求未超过上限：不出现说明", async () => {
    const bash = new BashTool();
    const r = await bash.execute({ command: "echo hi", timeout: 5_000 });
    expect(r.output ?? "").not.toContain("超过上限");
    expect(r.output ?? "").toContain("hi");
  });

  it("未传 timeout：不出现说明", async () => {
    const bash = new BashTool();
    const r = await bash.execute({ command: "echo hi" });
    expect(r.output ?? "").not.toContain("超过上限");
  });

  it("后台命令：结果体保持 JSON，不前置文本", async () => {
    const bash = new BashTool();
    const r = await bash.execute({
      command: "echo hi",
      timeout: 1_800_000,
      run_in_background: true,
    });
    const text = r.output ?? "";
    // 前置文本会让 JSON.parse 失配（agent 侧解析 task_id 的地方会炸）
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text).task_id).toBeString();
  });

  it("上限来自 BASH_MAX_TIMEOUT_MS：提示里的实际值随 env 变化", async () => {
    process.env.BASH_MAX_TIMEOUT_MS = "300000";
    const bash = new BashTool();
    const r = await bash.execute({ command: "echo hi", timeout: 900_000 });
    expect((r.output ?? "").split("\n")[0]).toContain("实际按 300s 执行");
  });
});
