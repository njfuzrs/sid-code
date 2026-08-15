/**
 * `scripts/trace-digest.ts` flag 对账门禁（P2-7）
 *
 * ## 治的是什么
 *
 * 脚本头注释第 18 行长期写着"`--cache` 与 `--health` 在产品内也可达"，
 * 但脚本自己只解析了 `--json` / `--full` / `--list` / `--cache` —— `--health` **从未接上**。
 * 跑 `bun scripts/trace-digest.ts --health` 得到的是"最近一次会话的单会话摘要"：
 * 未识别的 flag 被当作无参调用，**不报错、不提示**。而产品内 `/trace --health` 是通的，
 * 于是同一个能力"文档说有、产品里有、脚本里没有"，且没有任何信号。
 *
 * 静默忽略未知 flag 是这个 bug 能存活的**唯一原因**。修掉具体的 `--health`
 * 而不修这个静默行为，下一个漏接的 flag 会以完全相同的方式潜伏。
 *
 * ## 双向对账（照 `loop-detection-exemption-audit` 的既有模式）
 *
 * 两个事实源必须互相印证，任一侧新增漏改就红：
 *   A) 声明事实源：脚本导出的 `KNOWN_FLAGS`（未识别兜底告警读它）
 *   B) 运行时事实源：脚本源码里所有 `flags.has("--x")` / `args.indexOf("--x")` 的实参
 *
 * 三条断言：
 *   1. B ⊆ A —— 脚本实际消费的每个 flag 都在 KNOWN_FLAGS 里
 *      （防"接了新 flag 却忘了登记" → 该 flag 会被兜底告警当未知参数拒掉）；
 *   2. A ⊆ B —— KNOWN_FLAGS 里的每个 flag 都被脚本真的消费
 *      （防"登记了却没实现" → 就是 --health 此前的形态：登记/文档说有，实际静默降级）；
 *   3. 端到端：未识别 flag 在 stderr 告警且退出码非 0。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { KNOWN_FLAGS } from "../../scripts/trace-digest.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "trace-digest.ts");

/**
 * 从脚本源码里抽出所有被真实消费的 flag 名。
 *
 * 两种消费形态都要抓（只抓第一种会漏掉带值参数）：
 *   · `flags.has("--health")`  —— 布尔开关
 *   · `args.indexOf("--days")` —— 带值参数，靠 indexOf 定位后读下一个 argv
 *
 * 刻意**不**抓 `KNOWN_FLAGS` 那个 Set 字面量自身，否则两个事实源塌缩成一个，
 * 对账变成自己跟自己比（永远绿）。做法是先按 `KNOWN_FLAGS = new Set([...])`
 * 把声明块切掉，再在剩余源码里扫。
 */
function extractConsumedFlags(source: string): Set<string> {
  const declStart = source.indexOf("KNOWN_FLAGS = new Set([");
  let body = source;
  if (declStart >= 0) {
    const declEnd = source.indexOf("]);", declStart);
    body = source.slice(0, declStart) + source.slice(declEnd >= 0 ? declEnd + 3 : declStart);
  }

  const found = new Set<string>();
  for (const re of [
    /flags\.has\(\s*"(--[a-z-]+)"\s*\)/g,
    /args\.indexOf\(\s*"(--[a-z-]+)"\s*\)/g,
  ]) {
    for (const m of body.matchAll(re)) found.add(m[1]!);
  }
  return found;
}

describe("P2-7：trace-digest.ts flag 双向对账", () => {
  const source = readFileSync(SCRIPT_PATH, "utf-8");
  const consumed = extractConsumedFlags(source);

  test("提取器自身有效：确实扫到了 flag（防正则失效导致空对空的假绿）", () => {
    // 提取器返回空集时，下面两条对账都会"通过"——那是最坏的假绿。
    expect(consumed.size).toBeGreaterThanOrEqual(4);
    // --health 是本次修复的主体，它必须在运行时事实源里
    expect(consumed.has("--health")).toBe(true);
  });

  test("① 脚本消费的每个 flag 都在 KNOWN_FLAGS 里（防漏登记 → 被兜底告警拒掉）", () => {
    const missing = [...consumed].filter((f) => !KNOWN_FLAGS.has(f));
    expect(missing).toEqual([]);
  });

  test("② KNOWN_FLAGS 里的每个 flag 都被脚本真的消费（防登记了却没实现）", () => {
    // 这一条正是 --health 此前那个 bug 的形态：文档/注释说有，代码里没人读。
    const unimplemented = [...KNOWN_FLAGS].filter((f) => !consumed.has(f));
    expect(unimplemented).toEqual([]);
  });

  test("KNOWN_FLAGS 含本次接上的 --health 与 --period", () => {
    // 锁值形态而不只是"集合非空"：防止将来有人把清单清空后两条对账依然全绿。
    expect(KNOWN_FLAGS.has("--health")).toBe(true);
    expect(KNOWN_FLAGS.has("--period")).toBe(true);
    expect(KNOWN_FLAGS.has("--cache")).toBe(true);
  });
});

/**
 * ③ 端到端：未识别 flag 必须**告警 + 退出码非 0**。
 *
 * 上面两条对账是静态扫描，它们证明不了"兜底真的接线了"——KNOWN_FLAGS 完全可以
 * 登记齐全而那段 stderr 分支根本没人走（同仓踩过的"防线全在、调用全 0"）。
 * 所以这条必须起真进程。
 *
 * ⚠️ 落盘隔离：本脚本会读 `~/.sid-code/trajectories/`。子进程**不继承**进程内的
 * env 改动，必须显式传 `SID_CONFIG_DIR` 指向 tmpdir，否则测试去读用户真实轨迹
 * （只读也不该依赖它——本机有没有轨迹会让断言时绿时红）。
 */
describe("P2-7：未识别 flag 端到端（真起子进程）", () => {
  let tempHome: string;

  beforeAll(() => {
    tempHome = mkdtempSync(join(tmpdir(), "sid-digest-flags-"));
  });

  afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  /** 跑脚本，返回 { code, stdout, stderr }。SID_CONFIG_DIR 显式传给子进程。 */
  function runScript(args: string[]): { code: number; stdout: string; stderr: string } {
    const proc = spawnSync("bun", [SCRIPT_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, SID_CONFIG_DIR: tempHome, NO_COLOR: "1" },
    });
    return {
      code: proc.status ?? -1,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
    };
  }

  test("★ --nonexistent-flag：stderr 有告警且退出码非 0", () => {
    const r = runScript(["--nonexistent-flag"]);
    expect(r.stderr).toContain("未识别参数");
    expect(r.stderr).toContain("--nonexistent-flag");
    expect(r.code).not.toBe(0);
    // 关键：**不得**降级去打单会话摘要。此前的 bug 形态正是"照常输出一份摘要"，
    // 用户看到的是一份看似正常的结果，而他要的是别的视图。
    expect(r.stdout).toBe("");
  });

  test("告警里列出可用参数（否则用户只知道错了，不知道该写什么）", () => {
    const r = runScript(["--helth"]); // 拼错 --health，最常见的真实场景
    expect(r.stderr).toContain("--health");
    expect(r.code).not.toBe(0);
  });

  test("已识别的 flag 不触发告警：--health 正常出看板", () => {
    // 反向自证：兜底不能把真 flag 也拦掉（那就成了另一个方向的 bug）。
    const r = runScript(["--health"]);
    expect(r.stderr).not.toContain("未识别参数");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Provider 健康度看板");
    // tmpdir 里没有任何轨迹 → 应当是"无数据"而不是崩溃
    expect(r.stdout).toContain("无数据");
  });

  test("--health --period 校验周期取值，非法值报错而不是静默用默认值", () => {
    const bad = runScript(["--health", "--period", "3天"]);
    expect(bad.stderr).toContain("未知周期");
    expect(bad.code).not.toBe(0);

    const good = runScript(["--health", "--period", "7d"]);
    expect(good.code).toBe(0);
    expect(good.stdout).toContain("周期: 7d");
  });
});
