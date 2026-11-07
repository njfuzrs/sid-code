/**
 * T2-1：Read 记忆文件时年龄提醒真的到达模型眼前（2026-11-07）
 *
 * ## 为什么这个断言不能只测 `buildFreshnessWarning`
 *
 * `freshness.ts` 的实现早就正确，`paths-scan.test.ts` 也早就在测它返回什么字符串。
 * 但「实现正确 + 单测齐全 + 生产路径零调用」正是本仓反复出现的失效模式
 * （见 `read-side-drift-p0.test.ts` 头注释）。所以这里的断言必须**穿过 ReadTool**
 * 走一遍真实调用，否则把 read.ts 里那段前置删掉，测试照样全绿。
 *
 * ## 四条判据
 *
 * 1. 超过 1 天的单条记忆 → 输出**以** `<system-reminder>` 开场（前置，不是追加在末尾）。
 * 2. 1 天内的记忆 → 不加（与 `buildFreshnessWarning` 同判据，今天写的不是嫌疑对象）。
 * 3. `MEMORY.md` 索引 → 不加（索引里每行已有 ⏳，再叠全局警告只是噪声）。
 * 4. 普通文件 → 不加（不受影响）。
 *
 * 落盘隔离：全部测试文件写在 `SID_CONFIG_DIR` 指向的 tmpdir 下，不碰真实 `~/.sid-code/`。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadTool } from "@sid-code/core/tool/read.ts";

const DAY = 24 * 60 * 60 * 1000;

let tmpHome: string;
let memDir: string;
let workDir: string;
const prevEnv = {
  SID_CONFIG_DIR: process.env.SID_CONFIG_DIR,
  SID_CODE_HOME: process.env.SID_CODE_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};

beforeAll(() => {
  // 记忆目录必须落在 SID_CONFIG_DIR 下，classifyMemoryReadPath 才认它是 global 记忆
  tmpHome = mkdtempSync(join(tmpdir(), "sid-read-freshness-home-"));
  workDir = mkdtempSync(join(tmpdir(), "sid-read-freshness-work-"));
  memDir = join(tmpHome, "memory");
  mkdirSync(memDir, { recursive: true });
  // SID_CONFIG_DIR 是权威名，优先级高于另外两个别名，但仍显式清掉以免 restore 时混淆
  process.env.SID_CONFIG_DIR = tmpHome;
  delete process.env.SID_CODE_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterAll(() => {
  // 必须存/恢复原值：同批测试共享进程，无条件 delete 会抹掉 preload 的兜底
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [tmpHome, workDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});

beforeEach(() => {
  // 每个用例一个干净记忆目录（read-stats 会往里写 .read-stats.json）
  rmSync(memDir, { recursive: true, force: true });
  mkdirSync(memDir, { recursive: true });
});

afterEach(() => {
  rmSync(memDir, { recursive: true, force: true });
});

/** 写一个记忆文件并把 mtime 设成指定天数前 */
function writeMemory(filename: string, content: string, ageDays: number): string {
  const path = join(memDir, filename);
  writeFileSync(path, content);
  const ts = new Date(Date.now() - ageDays * DAY);
  utimesSync(path, ts, ts);
  return path;
}

describe("Read 记忆文件时的年龄提醒", () => {
  test("超过 1 天的记忆：输出以 system-reminder 前置提醒开场", async () => {
    const path = writeMemory("feedback_old.md", "# 旧记忆\n\n这条写于三天前。\n", 3);
    const result = await new ReadTool().execute({ file_path: path });

    expect(result.isError).toBeUndefined();
    expect(result.output).toStartWith("<system-reminder>");
    expect(result.output).toContain("This memory is 3 days old");
    // 正文必须还在提醒之后（前置不是替换）
    expect(result.output).toContain("这条写于三天前。");
  });

  test("1 天内的记忆：不加提醒（与 buildFreshnessWarning 同判据）", async () => {
    const path = writeMemory("feedback_fresh.md", "# 新记忆\n\n刚写的。\n", 0);
    const result = await new ReadTool().execute({ file_path: path });

    expect(result.isError).toBeUndefined();
    expect(result.output).not.toContain("This memory is");
    expect(result.output).toStartWith("1\t");
  });

  test("MEMORY.md 索引：即使很旧也不加提醒（每行已有 ⏳）", async () => {
    const path = writeMemory("MEMORY.md", "- [old](feedback_old.md) — 一条旧记忆\n", 30);
    const result = await new ReadTool().execute({ file_path: path });

    expect(result.isError).toBeUndefined();
    expect(result.output).not.toContain("This memory is");
  });

  test("普通文件：不受影响", async () => {
    const path = join(workDir, "notes.md");
    writeFileSync(path, "普通文件\n");
    const ts = new Date(Date.now() - 10 * DAY);
    utimesSync(path, ts, ts);
    const result = await new ReadTool().execute({ file_path: path });

    expect(result.isError).toBeUndefined();
    expect(result.output).not.toContain("This memory is");
  });
});
