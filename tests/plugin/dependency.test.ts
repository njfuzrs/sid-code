import { describe, expect, test } from "bun:test";
import {
  resolveDependencyClosure,
  verifyAndDemote,
  findReverseDependents,
} from "@sid-code/cli/plugin/dependency.ts";
import type { LoadedPlugin } from "@sid-code/cli/plugin/types.ts";

/** 构造一个最小 LoadedPlugin（用于依赖测试） */
function mkPlugin(name: string, deps: string[] = [], enabled = true): LoadedPlugin {
  return {
    name,
    manifest: { name, version: "1.0.0", description: name, dependencies: deps },
    path: `/fake/${name}`,
    source: `${name}@local`,
    enabled,
    isBuiltin: false,
    commandsPaths: [],
    skillsPaths: [],
    agentsPaths: [],
  };
}

describe("resolveDependencyClosure - 依赖闭包", () => {
  // 依赖图：a → b → c
  const graph: Record<string, { dependencies?: string[] }> = {
    a: { dependencies: ["b"] },
    b: { dependencies: ["c"] },
    c: {},
  };
  const lookup = async (id: string) => graph[id] ?? null;

  test("线性依赖按后序排列（依赖在前）", async () => {
    const r = await resolveDependencyClosure("a", lookup, new Set());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.closure).toEqual(["c", "b", "a"]);
  });

  test("已启用的依赖被跳过", async () => {
    const r = await resolveDependencyClosure("a", lookup, new Set(["c"]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.closure).toEqual(["b", "a"]);
  });

  test("依赖缺失返回 not-found", async () => {
    const r = await resolveDependencyClosure("a", async (id) => (id === "a" ? { dependencies: ["missing"] } : null), new Set());
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "not-found") {
      expect(r.missing).toBe("missing");
      expect(r.requiredBy).toBe("a");
    }
  });

  test("循环依赖被检测", async () => {
    const cyclic: Record<string, { dependencies?: string[] }> = {
      x: { dependencies: ["y"] },
      y: { dependencies: ["x"] },
    };
    const r = await resolveDependencyClosure("x", async (id) => cyclic[id] ?? null, new Set());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("cycle");
  });

  test("根插件即使已启用也不跳过（重装场景）", async () => {
    const r = await resolveDependencyClosure("a", lookup, new Set(["a"]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.closure).toContain("a");
  });
});

describe("verifyAndDemote - 固定点降级", () => {
  test("依赖满足时不降级", () => {
    const a = mkPlugin("a", ["b"]);
    const b = mkPlugin("b");
    const r = verifyAndDemote([a, b], []);
    expect(r.enabled.map((p) => p.name).sort()).toEqual(["a", "b"]);
    expect(r.errors).toEqual([]);
  });

  test("依赖缺失时降级单个插件", () => {
    const a = mkPlugin("a", ["b"]);
    const r = verifyAndDemote([a], []);
    expect(r.enabled).toEqual([]);
    expect(r.disabled.map((p) => p.name)).toEqual(["a"]);
    expect(r.errors[0].type).toBe("dependency-unsatisfied");
  });

  test("级联降级：a→b→c，c 被禁用导致 a、b 都降级", () => {
    const a = mkPlugin("a", ["b"]);
    const b = mkPlugin("b", ["c"]);
    // c 不在 enabled 列表（已禁用）
    const c = mkPlugin("c", [], false);
    const r = verifyAndDemote([a, b], [c]);
    expect(r.enabled).toEqual([]);
    expect(r.disabled.map((p) => p.name).sort()).toEqual(["a", "b", "c"]);
  });

  test("降级原因区分 not-enabled 与 not-found", () => {
    const a = mkPlugin("a", ["c"]); // c 存在但被禁用
    const c = mkPlugin("c", [], false);
    const r1 = verifyAndDemote([a], [c]);
    expect(r1.errors[0]).toMatchObject({ reason: "not-enabled" });

    const b = mkPlugin("b", ["ghost"]); // ghost 完全不存在
    const r2 = verifyAndDemote([b], []);
    expect(r2.errors[0]).toMatchObject({ reason: "not-found" });
  });

  test("依赖可用插件名或完整 source 匹配", () => {
    const a = mkPlugin("a", ["b@local"]); // 用 source 形式依赖
    const b = mkPlugin("b");
    const r = verifyAndDemote([a, b], []);
    expect(r.enabled.map((p) => p.name).sort()).toEqual(["a", "b"]);
  });
});

describe("findReverseDependents - 反向依赖", () => {
  test("找到依赖目标的已启用插件", () => {
    const a = mkPlugin("a", ["b"]);
    const b = mkPlugin("b");
    const c = mkPlugin("c", ["b"]);
    const dependents = findReverseDependents("b", [a, b, c]);
    expect(dependents.sort()).toEqual(["a", "c"]);
  });

  test("无反向依赖返回空", () => {
    const a = mkPlugin("a");
    const b = mkPlugin("b");
    expect(findReverseDependents("a", [a, b])).toEqual([]);
  });

  test("禁用的依赖者不计入", () => {
    const a = mkPlugin("a", ["b"], false); // a 已禁用
    const b = mkPlugin("b");
    expect(findReverseDependents("b", [a, b])).toEqual([]);
  });
});
