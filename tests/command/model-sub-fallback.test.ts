/**
 * /model sub 与 /model fallback 的行为测试
 *
 * 针对**实际生效**的实现 `src/command/commands/model/model.ts`（迁移后的新命令体系）。
 * 注意：`builtins.ts` 里还有一个同名 legacy `ModelCommand`，被 loadBuiltinCommands 的
 * migratedNames 过滤掉、不会服务 TUI 输入（仅作旧 Registry 回退路径），
 * 因此这些用例不通过它验证——tests/command/model.test.ts 测的是那份 legacy 实现。
 *
 * 覆盖两个回归点：
 *   sub      —— 类型列表从活跃 agent registry 派生（含 general-purpose / 自定义 agent），
 *                此前硬编码 5 个内置名，registry 有的类型被命令拒绝。
 *   fallback —— fallback == 主模型时给出「零降级覆盖」告警（此前静默接受）。
 */
import { describe, test, expect } from "bun:test";
import mod from "@sid-code/cli/command/commands/model/model.ts";
import type { CommandContext } from "@sid-code/cli/command/types.ts";

interface Calls {
  sub: Array<[string, string | undefined, boolean | undefined]>;
  fallback: Array<[string | undefined, boolean | undefined]>;
}

function makeCtx(overrides: Record<string, unknown> = {}): { ctx: CommandContext; calls: Calls } {
  const calls: Calls = { sub: [], fallback: [] };
  const ctx = {
    config: {
      model: "qwen3.5-plus",
      provider: "openai",
      availableModels: [
        { name: "qwen-plus", provider: "openai" },
        { name: "qwen3.5-plus", provider: "openai" },
      ],
      subAgentModels: {},
      ...(overrides.config as Record<string, unknown> | undefined),
    },
    setSubAgentModel: (t: string, m: string | undefined, p?: boolean) => {
      calls.sub.push([t, m, p]);
      return true;
    },
    setFallbackModel: (m: string | undefined, p?: boolean) => {
      calls.fallback.push([m, p]);
      return true;
    },
  } as unknown as CommandContext;
  return { ctx, calls };
}

/** 取命令的文本输出（非 text 类型结果返回空串，断言自然失败而非崩在类型上） */
const text = async (args: string, ctx: CommandContext): Promise<string> => {
  const r = await mod.call(args, ctx);
  return r.type === "text" ? String(r.value ?? "") : "";
};

describe("/model sub：类型列表与 agent registry 对齐", () => {
  test("接受 registry 里的 general-purpose（此前被硬编码列表拒绝）", async () => {
    const { ctx, calls } = makeCtx();
    const out = await text("sub general-purpose qwen-plus", ctx);
    expect(out).not.toContain("无效的子代理类型");
    expect(calls.sub).toEqual([["general-purpose", "qwen-plus", false]]);
  });

  test("内置类型仍然可用", async () => {
    const { ctx, calls } = makeCtx();
    await text("sub explore qwen-plus", ctx);
    expect(calls.sub).toEqual([["explore", "qwen-plus", false]]);
  });

  test("不存在的类型被拒绝，且错误信息里的合法类型来自 registry", async () => {
    const { ctx, calls } = makeCtx();
    const out = await text("sub bogus-type qwen-plus", ctx);
    expect(out).toContain("无效的子代理类型");
    expect(out).toContain("general-purpose"); // 派生自 registry，不是写死的 5 个内置名
    expect(calls.sub).toHaveLength(0);
  });

  test("-p 透传持久化标志", async () => {
    const { ctx, calls } = makeCtx();
    await text("sub general-purpose qwen-plus -p", ctx);
    expect(calls.sub).toEqual([["general-purpose", "qwen-plus", true]]);
  });

  test("sub clear <type> 清除映射", async () => {
    const { ctx, calls } = makeCtx();
    await text("sub clear general-purpose", ctx);
    expect(calls.sub).toEqual([["general-purpose", undefined, false]]);
  });

  test("模型名不在 availableModels 时拒绝，且不调用 setter", async () => {
    const { ctx, calls } = makeCtx();
    const out = await text("sub explore no-such-model", ctx);
    expect(out).toContain("不在可用模型列表中");
    expect(calls.sub).toHaveLength(0);
  });
});

describe("模型名校验：大小写敏感 + 手误提示", () => {
  test("只差大小写时直接给出正确写法（不擅自纠正）", async () => {
    const { ctx, calls } = makeCtx();
    const out = await text("QWEN-PLUS", ctx);
    expect(out).toContain("区分大小写");
    expect(out).toContain("qwen-plus");
    // 仍然拒绝切换：网关按原样透传模型名，擅自纠正可能切到另一个真实条目
    expect(calls.sub).toHaveLength(0);
  });

  test("完全不认识的名字：列出全部可用模型", async () => {
    const { ctx } = makeCtx();
    const out = await text("totally-unknown", ctx);
    expect(out).toContain("不在可用模型列表中");
    expect(out).toContain("qwen-plus");
    expect(out).toContain("qwen3.5-plus");
    expect(out).not.toContain("区分大小写");
  });
});

describe("/model fallback：与主模型相同时告警", () => {
  test("fallback == 主模型 → 仍生效但告警零降级覆盖", async () => {
    const { ctx, calls } = makeCtx();
    const out = await text("fallback qwen3.5-plus", ctx);
    expect(out).toContain("与当前主模型相同");
    // 不阻断：用户可能刻意用它做一次重试
    expect(calls.fallback).toEqual([["qwen3.5-plus", false]]);
  });

  test("fallback 为不同模型 → 无该告警", async () => {
    const { ctx, calls } = makeCtx();
    const out = await text("fallback qwen-plus", ctx);
    expect(out).not.toContain("与当前主模型相同");
    expect(calls.fallback).toEqual([["qwen-plus", false]]);
  });

  test("fallback clear 清除降级目标", async () => {
    const { ctx, calls } = makeCtx();
    const out = await text("fallback clear", ctx);
    expect(out).toContain("已清除");
    expect(calls.fallback).toEqual([[undefined, false]]);
  });

  test("fallback 目标缺 provider 时给出运行时禁用提示", async () => {
    const { ctx } = makeCtx({
      config: {
        model: "qwen3.5-plus",
        provider: "openai",
        availableModels: [
          { name: "qwen3.5-plus", provider: "openai" },
          { name: "no-provider-model" }, // 故意缺 provider
        ],
        subAgentModels: {},
      },
    });
    const out = await text("fallback no-provider-model", ctx);
    expect(out).toContain("缺少 provider");
  });

  test("fallback 目标不存在时拒绝", async () => {
    const { ctx, calls } = makeCtx();
    const out = await text("fallback no-such-model", ctx);
    expect(out).toContain("不在可用模型列表中");
    expect(calls.fallback).toHaveLength(0);
  });
});
