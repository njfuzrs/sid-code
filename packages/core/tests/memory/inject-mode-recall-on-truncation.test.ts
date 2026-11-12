/**
 * F5 / PR-4：项目索引被截断时切换到按需召回，并停止在 system 里全量注入索引。
 *
 * 验收 V5-1 的单测半边：召回模式下 system 里**不再含任何索引条目**，只剩指向 MEMORY.md 的一行；
 * 没截断时维持全量注入；召回失败只回退一次（会话内单向 recall → full）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  decideMemoryInjectMode,
  resolveMemoryInjectMode,
  fallbackToFullInjection,
  resetMemoryInjectModeForTest,
} from "@sid-code/core/memory/inject-mode.ts";
import { MemoryStore } from "@sid-code/core/memory/store.ts";
import { INDEX_TRUNCATION_NOTICE } from "@sid-code/core/memory/index-budget.ts";

const ENV = "SID_CODE_MEMORY_RECALL";
let root: string;
let projDir: string;
let globalDir: string;
let savedEnv: string | undefined;
// `new MemoryStore(root, { projectMemoryDir, globalMemoryDir })` 只覆盖了显式传入的两个目录，
// 内部还有走 `projectsRoot()` 的默认路径，读的是 SID_CONFIG_DIR —— 不重定向就会在真实
// ~/.sid-code/ 下留文件（防复发哨兵 packages/core/tests/telemetry/no-real-path-writes.test.ts 会点名）。
let savedConfigDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sid-inject-mode-"));
  projDir = join(root, "proj-memory");
  globalDir = join(root, "global-memory");
  mkdirSync(projDir, { recursive: true });
  mkdirSync(globalDir, { recursive: true });
  savedEnv = process.env[ENV];
  delete process.env[ENV];
  savedConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = root;
  resetMemoryInjectModeForTest();
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  // 存/恢复原值，不要无条件 delete：bun test 同进程跑多文件，删掉会连 preload 的兜底一起抹掉。
  if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedConfigDir;
  resetMemoryInjectModeForTest();
  rmSync(root, { recursive: true, force: true });
});

function writeIndex(dir: string, entries: string[], truncated: boolean) {
  let text = "# Memory Index\n\n" + entries.join("\n") + "\n";
  if (truncated) text += INDEX_TRUNCATION_NOTICE;
  writeFileSync(join(dir, "MEMORY.md"), text);
}

function writeMem(dir: string, key: string) {
  writeFileSync(
    join(dir, `${key}.md`),
    `---\nname: ${key}\ndescription: desc ${key}\ntype: project\n---\n\nbody ${key}\n`,
  );
}

describe("decideMemoryInjectMode：判据只看索引是否截断", () => {
  test("未截断 → full", () => {
    writeIndex(projDir, ["- [a](a.md) — A"], false);
    expect(decideMemoryInjectMode(projDir)).toEqual({ mode: "full", reason: "index_fits" });
  });

  test("已截断 → recall", () => {
    writeIndex(projDir, ["- [a](a.md) — A"], true);
    expect(decideMemoryInjectMode(projDir)).toEqual({ mode: "recall", reason: "index_truncated" });
  });

  test("索引不存在 → full", () => {
    expect(decideMemoryInjectMode(projDir).mode).toBe("full");
  });

  test("SID_CODE_MEMORY_RECALL=0 强制全量（回滚出口），=1 强制召回", () => {
    writeIndex(projDir, ["- [a](a.md) — A"], true);
    process.env[ENV] = "0";
    expect(decideMemoryInjectMode(projDir)).toEqual({ mode: "full", reason: "env_force_full" });
    writeIndex(projDir, ["- [a](a.md) — A"], false);
    process.env[ENV] = "1";
    expect(decideMemoryInjectMode(projDir)).toEqual({
      mode: "recall",
      reason: "env_force_recall",
    });
  });
});

describe("resolveMemoryInjectMode：会话内锁定，不随磁盘翻转", () => {
  test("首次判定后，索引变为未截断也不翻转（避免会话中途击穿 prompt cache）", () => {
    writeIndex(projDir, ["- [a](a.md) — A"], true);
    expect(resolveMemoryInjectMode(projDir).mode).toBe("recall");
    writeIndex(projDir, ["- [a](a.md) — A"], false);
    expect(resolveMemoryInjectMode(projDir).mode).toBe("recall");
  });

  test("召回失败回退：只切换一次，之后保持 full", () => {
    writeIndex(projDir, ["- [a](a.md) — A"], true);
    expect(resolveMemoryInjectMode(projDir).mode).toBe("recall");
    expect(fallbackToFullInjection(projDir)).toBe(true);
    expect(resolveMemoryInjectMode(projDir)).toEqual({
      mode: "full",
      reason: "recall_failed_fallback",
    });
    // 第二次失败不再触发重建
    expect(fallbackToFullInjection(projDir)).toBe(false);
  });

  test("原本就是 full 时回退返回 false（不做无意义的重建）", () => {
    writeIndex(projDir, ["- [a](a.md) — A"], false);
    resolveMemoryInjectMode(projDir);
    expect(fallbackToFullInjection(projDir)).toBe(false);
  });
});

describe("getIndexContent：召回模式下停止全量注入项目索引", () => {
  const entries = ["- [alpha](alpha.md) — 第一条", "- [beta](beta.md) — 第二条"];

  test("索引已截断 → 项目段只剩指针，没有任何索引条目；全局段照常", async () => {
    writeMem(projDir, "alpha");
    writeMem(projDir, "beta");
    writeIndex(projDir, entries, true);
    writeMem(globalDir, "gamma");
    writeIndex(globalDir, ["- [gamma](gamma.md) — 全局"], false);

    const store = new MemoryStore(root, { projectMemoryDir: projDir, globalMemoryDir: globalDir });
    const content = (await store.getIndexContent())!;
    expect(content).toContain(`#### 项目记忆（目录：${projDir}）`);
    expect(content).toContain(join(projDir, "MEMORY.md"));
    expect(content).toContain("按需召回");
    // 关键：项目索引条目一条都不在
    expect(content).not.toContain("[alpha](alpha.md)");
    expect(content).not.toContain("[beta](beta.md)");
    expect(content).not.toContain("索引已截断");
    // 全局段不受影响（召回只覆盖项目目录）
    expect(content).toContain("[gamma](gamma.md)");
  });

  test("索引未截断 → 维持全量注入（与 CC 默认一致）", async () => {
    writeMem(projDir, "alpha");
    writeMem(projDir, "beta");
    writeIndex(projDir, entries, false);
    const store = new MemoryStore(root, { projectMemoryDir: projDir, globalMemoryDir: globalDir });
    const content = (await store.getIndexContent())!;
    expect(content).toContain("[alpha](alpha.md)");
    expect(content).toContain("[beta](beta.md)");
    expect(content).not.toContain("按需召回");
  });

  test("召回失败回退后再构建 → 恢复全量（截断版）注入", async () => {
    writeMem(projDir, "alpha");
    writeIndex(projDir, entries, true);
    const store = new MemoryStore(root, { projectMemoryDir: projDir, globalMemoryDir: globalDir });
    expect((await store.getIndexContent())!).not.toContain("[alpha](alpha.md)");
    fallbackToFullInjection(projDir);
    const after = (await store.getIndexContent())!;
    expect(after).toContain("[alpha](alpha.md)");
    expect(after).not.toContain("按需召回");
  });
});
