/**
 * rg 命令解析的「探测超时」与「并发缓存」回归测试（2026-11-13 缺陷文档 §6.1 / §6.2）
 *
 * 两个缺陷同源：`probeRg` 没有超时，且 `resolveRgCommand` 的缓存写在 await 之后。
 * - 单个探测挂起 → await 永不返回 → grep/glob 的 hasRipgrep() 一起静默卡死；
 * - N 个并发首次调用同时穿过缓存检查 → 各 spawn 一次 `rg --version`，
 *   叠加无超时就是「瞬时多个 rg 进程同时挂起」。
 *
 * 为什么用子进程跑：被测代码用 `spawn(["rg", "--version"])` 按 PATH 查找真实可执行文件，
 * 而 **Bun 的 spawn 只看进程启动时的 PATH**，父测试里改 `process.env.PATH` 不生效
 * （2026-11-14 实测：Bun.spawn 与 Bun.which 都仍解析到原 PATH，只有显式传 env 选项才生效）。
 * 所以把假 rg 目录塞进子进程启动时的 PATH，才能真的替换掉 `rg`。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RIPGREP_SRC_URL = new URL("../../src/tool/ripgrep.ts", import.meta.url).href;

const ENV_KEYS = ["SID_RIPGREP_PATH", "SID_CONFIG_DIR"] as const;
let saved: Record<string, string | undefined> = {};
let work: string;
let childSeq = 0;

/**
 * 在 <work>/bin/rg 放一个假 rg，返回该目录与计数文件路径。
 * 每次执行都会往计数文件追加一行，用于断言「一共 spawn 了几次」。
 */
function installFakeRg(body: string): { binDir: string; countFile: string } {
  const binDir = join(work, "bin");
  mkdirSync(binDir, { recursive: true });
  const countFile = join(work, "spawn-count.txt");
  const rg = join(binDir, "rg");
  writeFileSync(rg, `#!/bin/sh\nprintf 'x\\n' >> '${countFile}'\n${body}\n`);
  chmodSync(rg, 0o755);
  return { binDir, countFile };
}

/** 读计数文件行数（每次假 rg 执行写一行） */
function spawnCount(countFile: string): number {
  try {
    return readFileSync(countFile, "utf-8").split("\n").filter(Boolean).length;
  } catch {
    return 0; // 文件不存在 = 一次都没 spawn
  }
}

/**
 * 在子进程里跑一段调用 resolveRgCommand 的脚本，子进程启动时 PATH 已前置假 rg 目录。
 * 返回脚本的 stdout（JSON）、SIGTERM 之外的退出码、以及子进程总耗时。
 */
async function runChild(
  scriptBody: string,
  env: Record<string, string>,
  importNames: string[] = ["resolveRgCommand"],
): Promise<{ stdout: string; stderr: string; exitCode: number; elapsedMs: number }> {
  const scriptPath = join(work, `child-${childSeq++}.ts`);
  writeFileSync(
    scriptPath,
    `import { ${importNames.join(", ")} } from ${JSON.stringify(RIPGREP_SRC_URL)};\n${scriptBody}\n`,
  );

  const started = Date.now();
  const proc = Bun.spawn([process.execPath, scriptPath], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SID_CONFIG_DIR: join(work, "home"), ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr, exitCode, elapsedMs: Date.now() - started };
}

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  work = mkdtempSync(join(tmpdir(), "rg-probe-"));
  // 防任何路径写真实 ~/.sid-code（含子进程继承的这一份）
  process.env.SID_CONFIG_DIR = join(work, "home");
  mkdirSync(process.env.SID_CONFIG_DIR, { recursive: true });
  delete process.env.SID_RIPGREP_PATH;
  childSeq = 0;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(work, { recursive: true, force: true });
});

describe("probeRg 探测超时（§6.1）", () => {
  test("探测挂起时按超时放弃，resolveRgCommand 正常返回而不是永久挂起", async () => {
    // exec 让 sleep 取代 sh，SIGTERM 直达；不 exec 时 sh 可能不把信号传给子进程
    const { binDir } = installFakeRg("exec sleep 1");

    const r = await runChild(
      `__setProbeTimeoutForTest(200);
const cmd = await resolveRgCommand();
console.log(JSON.stringify({ cmd }));`,
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
      ["resolveRgCommand", "__setProbeTimeoutForTest"],
    );

    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    // 修好前：假 rg 自己 sleep 满 1s 退出码 0 → 探测成功 → "rg"
    // 修好之后：200ms 超时 SIGTERM → 探测失败 → null
    expect(JSON.parse(r.stdout)).toEqual({ cmd: null });
    expect(r.elapsedMs).toBeLessThan(5_000);
  });
});

describe("resolveRgCommand 并发缓存（§6.2）", () => {
  test("N 个并发首次调用只 spawn 一次探测（无 cache stampede）", async () => {
    const { binDir, countFile } = installFakeRg(""); // 立即以 0 退出 = 探测成功

    const r = await runChild(
      `const results = await Promise.all(
  Array.from({ length: 5 }, () => resolveRgCommand()),
);
console.log(JSON.stringify(results));`,
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["rg", "rg", "rg", "rg", "rg"]);
    // 修好前是 5（每个调用各 spawn 一次）；修好后必须是 1
    expect(spawnCount(countFile)).toBe(1);
  });

  test("探测失败时并发也只 spawn 一次（失败结果同样走缓存）", async () => {
    const { binDir, countFile } = installFakeRg("exit 1");

    const r = await runChild(
      `const results = await Promise.all(
  Array.from({ length: 4 }, () => resolveRgCommand()),
);
console.log(JSON.stringify(results));`,
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([null, null, null, null]);
    expect(spawnCount(countFile)).toBe(1);
  });
});
