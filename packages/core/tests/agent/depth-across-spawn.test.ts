/**
 * 多代理 F8：spawn 子进程必须继承嵌套深度。
 * 用真子进程验证「env → getAgentDepth/canSpawnSubAgent」这一跳，再用源码断言
 * 锁住 spawn 点确实把深度写进了 env（否则单测全绿而生产仍归零）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { AGENT_DEPTH_ENV, resolveBaseDepth } from "@sid-code/core/agent/depth-context.ts";

const DEPTH_MODULE = join(import.meta.dir, "../../src/agent/depth-context.ts");

function probe(env: Record<string, string | undefined>): { depth: number; canSpawn: boolean } {
  const code = `import { getAgentDepth, canSpawnSubAgent, withIncrementedDepth } from ${JSON.stringify(DEPTH_MODULE)};
console.log(JSON.stringify({ depth: getAgentDepth(), canSpawn: canSpawnSubAgent(),
  inner: withIncrementedDepth(() => getAgentDepth()) }));`;
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env }))
    if (v !== undefined) merged[k] = v;
  const r = Bun.spawnSync(["bun", "-e", code], { env: merged });
  return JSON.parse(r.stdout.toString().trim());
}

describe("跨进程嵌套深度", () => {
  test("未传深度 = 主进程，depth 0 放行", () => {
    const r = probe({ [AGENT_DEPTH_ENV]: undefined, SID_ENABLE_NESTED_SUBAGENT: undefined });
    expect(r).toMatchObject({ depth: 0, canSpawn: true });
  });

  test("嵌套关：子进程 depth 1 不能再派", () => {
    const r = probe({ [AGENT_DEPTH_ENV]: "1", SID_ENABLE_NESTED_SUBAGENT: undefined });
    expect(r).toMatchObject({ depth: 1, canSpawn: false });
  });

  test("嵌套开：depth 1 可派，depth 2 到上限被拒，且进程内 +1 在继承值上累加", () => {
    expect(probe({ [AGENT_DEPTH_ENV]: "1", SID_ENABLE_NESTED_SUBAGENT: "1" })).toMatchObject({
      depth: 1,
      canSpawn: true,
      inner: 2,
    });
    expect(probe({ [AGENT_DEPTH_ENV]: "2", SID_ENABLE_NESTED_SUBAGENT: "1" })).toMatchObject({
      depth: 2,
      canSpawn: false,
    });
  });

  test("非法值回退 0", () => {
    for (const raw of ["", "abc", "-3", undefined]) expect(resolveBaseDepth(raw)).toBe(0);
    expect(resolveBaseDepth("2")).toBe(2);
  });

  test("spawn 点把深度写进子进程 env", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/agent/sub-agent.ts"), "utf-8");
    expect(src).toMatch(
      /env:\s*\{\s*\.\.\.process\.env,\s*\[AGENT_DEPTH_ENV\]:\s*String\(getAgentDepth\(\)\)/,
    );
  });
});
