/**
 * bun test 子进程 stdio 探针 —— 2026-09-21 本地 230 fail 的最小复现。
 *
 * ## 治的是什么
 *
 * bun 1.3.14 在无参数扫描大量测试文件之后，`spawnSync` 的 stdout/stderr 变成
 * 空字符串（长度 0，不是 null）。bash 与 python3 两种解释器同一形态。
 * 单文件路径不踩这个状态，所以「一题一题修断言」会把运行器 bug 修成 230 个假补丁。
 *
 * ## 判据
 *
 * 本文件自己 spawn 一次 `echo SID_SPAWN_OK`，断言 stdout 含该标记。
 * 扫描范围就是本文件，不在探针里再扫 800 个文件（否则探针自己就是受害者）。
 *
 * 变异自证：人为丢掉 stdout 时断言必须翻红——否则一个永远拿得到空串却
 * `toBeDefined()` 的实现会让这道门禁全绿。
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const MARKER = "SID_SPAWN_OK";

function captureEcho(): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync("bash", ["-lc", `echo ${MARKER}`], { encoding: "utf8" });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status,
  };
}

describe("bun test 子进程 stdio 仍能读回", () => {
  test("spawnSync(bash echo) 的 stdout 含标记（空串即 1.3.14 全量发现回归）", () => {
    const r = captureEcho();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MARKER);
  });

  test("人为丢掉 stdout 时断言必须翻红（变异自证）", () => {
    const dropped = { stdout: "", stderr: "", status: 0 };
    const wouldPass = dropped.stdout.includes(MARKER);
    expect(wouldPass).toBe(false);
  });
});
