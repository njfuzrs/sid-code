/**
 * `/doctor --disk` 子视图测试（2026-08-16）
 *
 * 为什么要测渲染层而不只测 `collectDiskUsage()`：本 PR 治的缺陷是
 * 「没有任何命令能回答我的 ~/.sid-code/ 为什么占了 N MB」——
 * 缺的正是**入口**。核心统计函数写得再对，`--disk` 没接上就等于没做
 *（这与 checkpoints 那个「清理代码全在、调用全 0」是同一种失败）。
 *
 * 所以这里断言两件事：参数确实路由到磁盘视图，且输出里带上了
 * 判断所需的三样东西——占用、保留策略、超期未回收量。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CommandContext } from "@sid-code/cli/command/types.ts";

let tmpHome: string;
let prevConfigDir: string | undefined;

/**
 * 最小可用 ctx。
 *
 * 磁盘视图本身只读配置目录、不碰 `ctx.config`，但"无参数走主诊断"那条用例会真的跑完
 * 整个环境自检，其中 `checkModelProvider()` 直接解 `ctx.config.model`
 *（`doctor.ts:150`）—— 只给 `cwd` 会在那里抛 TypeError。补一个空 config 即可：
 * 我们断言的是"路由没走磁盘分支"，不是模型配置的具体内容。
 */
function makeCtx(): CommandContext {
  return { cwd: tmpHome, config: {} } as unknown as CommandContext;
}

async function loadDoctor() {
  return (await import("@sid-code/cli/command/commands/doctor/doctor.ts")).default;
}

/**
 * 取文本结果。`LocalCommandResult` 是联合类型（还有 compact 分支），
 * 这里先断言拿到的是 text 再取 value —— 顺带把"返回类型变了"也变成一条会红的断言，
 * 而不是一个 as any 掩盖过去的类型洞。
 */
async function runDoctor(args: string): Promise<string> {
  const doctor = await loadDoctor();
  const r = await doctor.call(args, makeCtx());
  expect(r.type).toBe("text");
  if (r.type !== "text") throw new Error(`期望 text 结果，实得 ${r.type}`);
  return r.value;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-doctor-disk-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterEach(() => {
  // 存/恢复原值，不无条件 delete（同进程多文件跑，会抹掉 preload 兜底）
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("/doctor --disk 路由", () => {
  test("--disk 走磁盘视图（而不是跑主环境诊断）", async () => {
    const out = await runDoctor("--disk");
    expect(out).toContain("磁盘占用");
    // 主诊断的标志性字段不该出现——否则说明参数没被识别、走了默认分支
    expect(out).not.toContain("sid-code 环境诊断");
  });

  test("裸 disk 也认（少打两个横线是常见输入）", async () => {
    expect(await runDoctor("disk")).toContain("磁盘占用");
  });

  test("无参数时仍走主环境诊断（不因新增子视图而改变既有行为）", async () => {
    const out = await runDoctor("");
    expect(out).toContain("sid-code 环境诊断");
    expect(out).not.toContain("磁盘占用");
  });
});

describe("/doctor --disk 输出内容", () => {
  test("同时给出占用、保留策略与超期未回收量", async () => {
    const dir = join(tmpHome, "shell-snapshots");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.sh"), "o".repeat(2048));
    const t = new Date(Date.now() - 10 * 24 * 3600_000);
    utimesSync(join(dir, "old.sh"), t, t);

    const out = await runDoctor("--disk");

    expect(out).toContain("shell-snapshots");
    expect(out).toContain("合计");
    // 策略文案：光有大小无法判断"这是正常水位还是清理坏了"
    expect(out).toContain("兜底回收");
    // 超期量：这正是上一轮 checkpoints 缺陷本可以一眼看出来的那个信号
    expect(out).toContain("超期未回收");
  });

  test("未登记策略的目录被显式标出，而不是留空", async () => {
    // 留空看着像"没问题"，而真实含义是"这块没人管"——恰恰最该被看见
    mkdirSync(join(tmpHome, "mystery-dir"), { recursive: true });
    writeFileSync(join(tmpHome, "mystery-dir", "a.bin"), "x".repeat(4096));

    const out = await runDoctor("--disk");
    expect(out).toContain("mystery-dir");
    expect(out).toContain("未登记");
  });

  test("点明与 du 的口径差异（用户必然会拿去对比）", async () => {
    mkdirSync(join(tmpHome, "logs"), { recursive: true });
    writeFileSync(join(tmpHome, "logs", "a.log"), "x");
    const out = await runDoctor("--disk");
    // 实测 checkpoints/：本模块 22.3MB vs du -sh 34MB（块粒度开销）。
    // 不说清楚会被当成 bug 报回来。
    expect(out).toContain("du");
  });

  test("声明只读——本视图不删任何数据", async () => {
    const out = await runDoctor("--disk");
    expect(out).toContain("只读");
  });
});
