/**
 * src/context/tool-result-storage.ts 单测
 */

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import {
  persistLargeOutput,
  isPersistedReference,
  ContentReplacementState,
  cleanupPersistedOutputs,
  PERSISTED_OUTPUT_PREFIX,
} from "@sid-code/core/context/tool-result-storage.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import { assertIsolated } from "../helpers/assert-isolated.ts";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
// 注：enforceToolResultBudget 及其单测已删除（2026-07-11 决策：不接入，见 docs/bugfixes/todo/enforceToolResultBudget-待接入分析.md）

const testSessionId = "test-storage-session-001";

/**
 * 显式落盘隔离。
 *
 * persistLargeOutput 除返回引用文本外，还会**同步写** sidPaths.trajectories() 下的
 * sessions/<id>/tool-outputs/ —— 按 CONTRIBUTING.md 的硬约定，调它的测试必须显式隔离。
 *
 * 此前本文件只靠 bunfig.toml 的 preload 兜底。兜底确实生效（实测从仓库根与从
 * packages/ 两处跑都不写真实家目录），但它有两个已知失效面，都不是假设：
 *   1. 同批跑的**别的**测试文件里若有无条件 `delete process.env.SID_CONFIG_DIR`，
 *      兜底会被抹掉 —— bun test 多文件同进程，env 跨文件泄漏（实测 delta=84 行，
 *      见 tests/guard/test-isolation-guard.test.ts 的订正注释）。
 *   2. 新增含 tests/ 的包若漏配 bunfig.toml，该包的 preload 直接消失。
 * 受控实验证实过后果：手工抹掉 SID_CONFIG_DIR 后调 persistLargeOutput，
 * 文件确实落进真实的 ~/.sid-code/trajectories/sessions/。
 *
 * 所以这里显式设置，不依赖兜底；assertIsolated() 再校验一次真的没指向真实 HOME。
 */
let TMP_HOME: string;
const savedConfigDir = process.env.SID_CONFIG_DIR;

beforeAll(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), "sid-tool-storage-"));
  process.env.SID_CONFIG_DIR = TMP_HOME;
  assertIsolated();
});

describe("persistLargeOutput", () => {
  it("短内容不持久化，返回原内容", () => {
    const result = persistLargeOutput("hello", "tool_001", "bash", testSessionId, 100);
    expect(result.reference).toBe("hello");
    expect(result.savedPath).toBe("");
    expect(result.originalLength).toBe(5);
  });

  it("长内容持久化到磁盘", () => {
    const longContent = "A".repeat(500);
    const result = persistLargeOutput(longContent, "tool_002", "grep", testSessionId, 100);

    expect(result.originalLength).toBe(500);
    expect(result.savedPath).not.toBe("");
    expect(result.reference).toContain(PERSISTED_OUTPUT_PREFIX);
    expect(result.reference).toContain("tool_use_id=tool_002");
    expect(result.reference).toContain("tool=grep");
    expect(result.reference).toContain("字符数=500");

    // 验证文件存在
    expect(existsSync(result.savedPath)).toBe(true);
  });

  it("持久化后的引用约 200 字节", () => {
    const longContent = "B".repeat(500);
    const result = persistLargeOutput(longContent, "tool_003", "bash", testSessionId, 100);

    // 引用应该远小于原内容
    expect(result.reference.length).toBeLessThan(500);
    expect(result.reference.length).toBeLessThanOrEqual(300);
  });

  it("cleanupPersistedOutputs(0) 清空文件并回收空目录（含父目录）", () => {
    // 这条同时是产品缺陷的回归测试：`maxAgeMs=0` 语义是"全删"，
    // 但旧实现用 `now - mtimeMs > maxAgeMs`，而 mtimeMs 是亚毫秒浮点、
    // Date.now() 是毫秒整数 —— 刚写完的文件差值为**负**（实测 -0.64ms），
    // `-0.64 > 0` 恒 false，于是一个文件都没删。函数吞异常又不返回计数，
    // 调用方看不出失败，空目录就这么留在盘上灌水会话数分母。
    const sid = "test-storage-cleanup-001";
    const r = persistLargeOutput("C".repeat(500), "tool_c1", "bash", sid, 100);
    const outputDir = dirname(r.savedPath);
    expect(existsSync(r.savedPath)).toBe(true);

    cleanupPersistedOutputs(sid, 0);

    expect(existsSync(r.savedPath)).toBe(false);
    // tool-outputs/ 与父目录 sessions/<id>/ 都应被回收
    expect(existsSync(outputDir)).toBe(false);
    expect(existsSync(dirname(outputDir))).toBe(false);
  });

  it("默认保留期内的新文件不被清理（防清理过激）", () => {
    // 上一条的反向断言：钳制成 0 之后，`0 >= 7天` 仍为 false，生产路径行为不变。
    // 少了这条，把比较改成 `>=` 就可能在默认参数下把刚写的文件全删掉，
    // 而正好又不会被上一条测出来。
    const sid = "test-storage-keep-001";
    const r = persistLargeOutput("K".repeat(500), "tool_k1", "bash", sid, 100);
    cleanupPersistedOutputs(sid); // 默认 7 天
    expect(existsSync(r.savedPath)).toBe(true);
    cleanupPersistedOutputs(sid, 0); // 收尾
  });

  it("有真实轨迹数据的会话目录绝不被回收（父目录回收的安全边界）", () => {
    // 这条守的是**数据安全**，不是功能。上面新增的"顺带回收父目录"逻辑跑在
    // startup-housekeeping.ts:183 的启动清理里，那里会遍历**用户全部真实会话目录** ——
    // 一旦父目录回收变得过激（比如哪天有人改成 rmSync recursive），
    // 就会静默删掉用户的 events.jsonl / session.traj，且没有回收站可救。
    // 所以把"非空会话目录必须留下"钉成断言，而不是依赖 rmdirSync 恰好会抛错。
    const sid = "test-storage-realdata-001";
    const r = persistLargeOutput("R".repeat(500), "tool_r1", "bash", sid, 100);
    const outputDir = dirname(r.savedPath);
    const sessionDir = dirname(outputDir);
    const traj = join(sessionDir, "events.jsonl");
    writeFileSync(traj, '{"event":"SessionStart"}\n');

    cleanupPersistedOutputs(sid, 0);

    expect(existsSync(outputDir)).toBe(false); // 空的 tool-outputs 该收
    expect(existsSync(sessionDir)).toBe(true); // 但会话目录非空，必须留
    expect(existsSync(traj)).toBe(true); // 真实轨迹数据分毫未动
  });

  afterAll(() => {
    // 清理测试文件。
    // 原先这里还算了一个 `dir`（join(homedir(), ".sid-code", ...)）却从没用过 ——
    // 既是死变量，也正是 CLAUDE.md「测试约定」点名禁止的硬编码家目录写法
    // （SID_CONFIG_DIR 重定向后它必然失配）。清理本就由下面这个函数负责。
    try {
      cleanupPersistedOutputs(testSessionId, 0);
    } catch {}
  });
});

describe("落盘隔离自证", () => {
  it("落盘路径确实在临时目录内，而非真实家目录", () => {
    // 不是重复 assertIsolated()：那个只校验 env 变量的值，这条校验**真实写出来的路径**。
    // 两者能分离 —— 若哪天 tool-result-storage 绕过 sidPaths 自行拼 homedir()，
    // env 校验照样通过而文件照样写进用户家目录。这条盯的是后者。
    const r = persistLargeOutput("I".repeat(500), "tool_iso", "bash", "test-storage-iso-001", 100);
    expect(r.savedPath.startsWith(TMP_HOME)).toBe(true);
    expect(r.savedPath.startsWith(sidPaths.trajectories())).toBe(true);
    cleanupPersistedOutputs("test-storage-iso-001", 0);
  });
});

afterAll(() => {
  // 存/恢复原值，**不无条件 delete** —— bun test 同批多文件跑在同一进程里，
  // 无条件删会把 preload 的兜底（tests/preload-isolate-sid-home.ts）一起抹掉，
  // 让本文件之后跑的测试失去隔离。CLAUDE.md 实测记录过这个坑：
  // migrations + permission 同批跑因此往真实家目录泄漏 84 行。
  if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedConfigDir;
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败无妨，系统会回收 */
  }
});

describe("isPersistedReference", () => {
  it("应识别持久化引用", () => {
    const ref = "[持久化输出] tool_use_id=xxx | tool=bash | 字符数=1000 | 文件=/tmp/test.txt";
    expect(isPersistedReference(ref)).toBe(true);
  });

  it("普通内容不应识别为持久化引用", () => {
    expect(isPersistedReference("hello world")).toBe(false);
    expect(isPersistedReference("")).toBe(false);
  });
});

describe("ContentReplacementState", () => {
  it("首次调用应使用 generator", () => {
    const state = new ContentReplacementState();
    let callCount = 0;

    const val = state.getOrCreate("tool_a", () => {
      callCount++;
      return "generated_value";
    });

    expect(val).toBe("generated_value");
    expect(callCount).toBe(1);
  });

  it("同一 tool_use_id 多次调用返回相同值，不触发 generator", () => {
    const state = new ContentReplacementState();
    let callCount = 0;

    const val1 = state.getOrCreate("tool_a", () => {
      callCount++;
      return "value_1";
    });
    const val2 = state.getOrCreate("tool_a", () => {
      callCount++;
      return "value_2";
    });

    expect(val1).toBe("value_1");
    expect(val2).toBe("value_1"); // 应返回缓存值
    expect(callCount).toBe(1); // generator 只调用一次
  });

  it("不同 tool_use_id 应独立缓存", () => {
    const state = new ContentReplacementState();

    const valA = state.getOrCreate("tool_a", () => "a");
    const valB = state.getOrCreate("tool_b", () => "b");

    expect(valA).toBe("a");
    expect(valB).toBe("b");
    expect(state.size).toBe(2);
  });

  it("clear 应清空所有状态", () => {
    const state = new ContentReplacementState();
    state.getOrCreate("tool_a", () => "a");
    expect(state.size).toBe(1);

    state.clear();
    expect(state.size).toBe(0);
  });
});
