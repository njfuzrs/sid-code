/**
 * ripgrep 超时路径回归测试（2026-10-10，轨迹 20261009-135641-0083c051）
 *
 * 覆盖三个曾经同时存在的缺陷：
 * 1. glob 给 rg 传 --sortr=modified → rg 退化单线程 + 扫完才吐第一行，超时必丢全部结果
 * 2. ripGrep 超时且有部分结果时直接 return（伪装成完整结果），调用方的部分结果分支成了死接线
 * 3. 超时上限只能靠环境变量调，settings.json 不可配，报错也不提怎么调
 * 4. path=~ 时 rg 遇到 macOS 受保护目录以 exit 2 结束 → 整体判失败，已扫到的 stdout 全丢
 *
 * 用一个假 rg（SID_RIPGREP_PATH）模拟「先吐几行再挂起」，1s 超时即可稳定复现，
 * 不依赖真实大目录的扫描速度（那种测试在快机器上会静默变成「没超时 → 跳过断言」）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ripGrep,
  RipgrepTimeoutError,
  getTimeoutMs,
  formatTimeoutMessage,
  isOnlyPathAccessErrors,
  __resetRgCommandCacheForTest,
} from "@sid-code/core/tool/ripgrep.ts";
import { GlobTool } from "@sid-code/core/tool/glob.ts";
import { GrepTool } from "@sid-code/core/tool/grep.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/cache.ts";

const ENV_KEYS = ["SID_RIPGREP_PATH", "SID_GREP_TIMEOUT_SECONDS", "SID_CONFIG_DIR"] as const;
let saved: Record<string, string | undefined> = {};
let work: string;

/** 假 rg：吐出给定 stdout / stderr 后以给定退出码结束（不挂起） */
function makeExitingRg(stdout: string[], stderr: string[], code: number): string {
  const bin = join(work, "fake-rg-exit.sh");
  const out = stdout.map((l) => `printf '%s\\n' '${l}'`).join("\n");
  const err = stderr.map((l) => `printf '%s\\n' '${l}' >&2`).join("\n");
  writeFileSync(bin, `#!/bin/sh\n${out}\n${err}\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** 假 rg：把参数记到 args.txt，吐出给定行，然后 exec sleep 挂起（exec 让 SIGTERM 直达、管道随之关闭） */
function makeFakeRg(lines: string[]): { bin: string; argsFile: string } {
  const bin = join(work, "fake-rg.sh");
  const argsFile = join(work, "args.txt");
  const body = lines.map((l) => `printf '%s\\n' '${l}'`).join("\n");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\n${body}\nexec sleep 30\n`);
  chmodSync(bin, 0o755);
  return { bin, argsFile };
}

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  work = mkdtempSync(join(tmpdir(), "rg-timeout-"));
  // settings 读 SID_CONFIG_DIR 下的 settings.json；指到空目录，避免读到用户真实配置
  process.env.SID_CONFIG_DIR = join(work, "home");
  mkdirSync(process.env.SID_CONFIG_DIR, { recursive: true });
  resetSettingsCache();
  __resetRgCommandCacheForTest();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetSettingsCache();
  __resetRgCommandCacheForTest();
  rmSync(work, { recursive: true, force: true });
});

describe("ripGrep 超时", () => {
  test("有部分结果时抛 RipgrepTimeoutError 并携带 partialResults（不伪装成完整结果）", async () => {
    const { bin } = makeFakeRg(["./a.txt", "./b.txt", "./c.txt"]);
    process.env.SID_RIPGREP_PATH = bin;
    process.env.SID_GREP_TIMEOUT_SECONDS = "1";

    let caught: unknown;
    try {
      await ripGrep(["--files"], ".", new AbortController().signal, work);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RipgrepTimeoutError);
    // 最后一行可能不完整 → 丢弃
    expect((caught as RipgrepTimeoutError).partialResults).toEqual(["./a.txt", "./b.txt"]);
  }, 15_000);

  test("报错文案告诉模型别搜家目录、告诉用户上限在哪调", () => {
    const msg = formatTimeoutMessage(20_000);
    expect(msg).toContain("20秒");
    expect(msg).toContain("家目录");
    expect(msg).toContain("searchTimeoutSeconds");
    expect(msg).toContain("SID_GREP_TIMEOUT_SECONDS");
  });
});

describe("超时上限配置", () => {
  test("缺省 20s（非 WSL）/ 60s（WSL）", () => {
    delete process.env.SID_GREP_TIMEOUT_SECONDS;
    const isWsl = process.env.WSL_DISTRO_NAME !== undefined || process.env.WSLENV !== undefined;
    expect(getTimeoutMs()).toBe(isWsl ? 60_000 : 20_000);
  });

  test("环境变量生效", () => {
    process.env.SID_GREP_TIMEOUT_SECONDS = "45";
    expect(getTimeoutMs()).toBe(45_000);
  });

  test("settings.json searchTimeoutSeconds 优先于环境变量", () => {
    writeFileSync(
      join(process.env.SID_CONFIG_DIR!, "settings.json"),
      JSON.stringify({ searchTimeoutSeconds: 90 }),
    );
    resetSettingsCache();
    process.env.SID_GREP_TIMEOUT_SECONDS = "45";
    expect(getTimeoutMs()).toBe(90_000);
  });
});

describe("GlobTool 超时路径", () => {
  test("不传 --sort/--sortr；超时返回部分结果，且经 deny 过滤 + mtime 降序", async () => {
    const dir = join(work, "repo");
    mkdirSync(dir, { recursive: true });
    for (const f of ["old.jpg", "new.jpg", "secret.jpg", "tail.jpg"]) {
      writeFileSync(join(dir, f), "x");
    }
    const now = Date.now() / 1000;
    utimesSync(join(dir, "old.jpg"), now - 1000, now - 1000);
    utimesSync(join(dir, "new.jpg"), now, now);

    // rg 先吐 old 再吐 new：输出顺序 ≠ mtime 顺序，验证排序在 JS 侧做了
    const { bin, argsFile } = makeFakeRg(["./old.jpg", "./secret.jpg", "./new.jpg", "./tail.jpg"]);
    process.env.SID_RIPGREP_PATH = bin;
    process.env.SID_GREP_TIMEOUT_SECONDS = "1";

    const tool = new GlobTool((abs) => abs.endsWith("secret.jpg"));
    const r = await tool.execute({ pattern: "**/*.jpg", path: dir });

    const args = readFileSync(argsFile, "utf8").split("\n");
    expect(args.some((a) => /^--sortr?(=|$)/.test(a))).toBe(false);

    expect(r.isError).toBeFalsy();
    // tail.jpg 是最后一行（可能不完整）被丢弃；secret.jpg 被 deny 隐藏
    expect(r.output.split("\n").slice(0, 2)).toEqual(["new.jpg", "old.jpg"]);
    expect(r.output).not.toContain("secret.jpg");
    expect(r.output).not.toContain("tail.jpg");
    expect(r.output).toContain("部分结果");
  }, 15_000);

  test("超时且零结果 → isError + 可操作的报错文案", async () => {
    const { bin } = makeFakeRg([]);
    process.env.SID_RIPGREP_PATH = bin;
    process.env.SID_GREP_TIMEOUT_SECONDS = "1";

    const r = await new GlobTool().execute({ pattern: "**/*.jpg", path: work });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("searchTimeoutSeconds");
  }, 15_000);
});

describe("GrepTool 超时路径", () => {
  test("超时返回部分结果并标注（以前 ripGrep 先 return，这个分支永远走不到）", async () => {
    const dir = join(work, "repo");
    mkdirSync(dir, { recursive: true });
    for (const f of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(dir, f), "hello");
    const { bin } = makeFakeRg([join(dir, "a.ts"), join(dir, "b.ts"), join(dir, "c.ts")]);
    process.env.SID_RIPGREP_PATH = bin;
    process.env.SID_GREP_TIMEOUT_SECONDS = "1";

    const r = await new GrepTool().execute({ pattern: "hello", path: dir });
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("搜索超时");
    expect(r.output).toContain("a.ts");
    expect(r.output).not.toContain("c.ts");
  }, 15_000);
});

describe("exit 2 + 逐路径访问错误", () => {
  const PERM = [
    "rg: ./Library/Messages: Operation not permitted (os error 1)",
    "rg: ./.Trash: Permission denied (os error 13)",
  ];

  test("判据：全是 (os error N) 路径错误才算；混入参数错误不算", () => {
    expect(isOnlyPathAccessErrors(PERM.join("\n"))).toBe(true);
    expect(isOnlyPathAccessErrors("")).toBe(false);
    expect(
      isOnlyPathAccessErrors([...PERM, "rg: unrecognized flag --node-entity-bg"].join("\n")),
    ).toBe(false);
    expect(isOnlyPathAccessErrors("rg: regex parse error:\n    (\n    ^")).toBe(false);
  });

  test("glob 在受保护目录下仍返回已扫到的匹配（以前整体报「文件匹配失败」）", async () => {
    const dir = join(work, "repo");
    mkdirSync(join(dir, "Desktop"), { recursive: true });
    writeFileSync(join(dir, "Desktop", "pic.jpg"), "x");
    process.env.SID_RIPGREP_PATH = makeExitingRg(["./Desktop/pic.jpg"], PERM, 2);

    const r = await new GlobTool().execute({ pattern: "**/*.jpg", path: dir });
    expect(r.isError).toBeFalsy();
    expect(r.output).toBe("Desktop/pic.jpg");
  });

  test("exit 2 + 参数错误仍按失败处理", async () => {
    process.env.SID_RIPGREP_PATH = makeExitingRg([], ["rg: unrecognized flag --bogus"], 2);
    let caught: unknown;
    try {
      await ripGrep(["--files"], ".", new AbortController().signal, work);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain("ripgrep 退出码 2");
  });
});
