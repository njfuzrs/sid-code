/**
 * 第 5 批 · JIT 埋点单一事实源单测
 *
 * 这个模块存在的理由就是「主循环与子代理必须走同一条通道」——
 * 此前子代理接了独立 JitContextManager（P2-1）但没接埋点，用到子代理的会话
 * JIT 命中率与字节量系统性偏低。所以本文件的核心断言是：
 *  1. payload 字段名与消费侧（`aggregateJitStats`）对得上
 *  2. `source` 能区分两条通道
 *  3. 未命中也产出可统计的 payload（分母不能缺）
 *  4. 绝对路径不进轨迹（会上传，含用户名）
 *  5. sink 未注入 / 抛错都不影响主流程
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  buildJitEventData,
  emitJitEvent,
  setJitTraceSink,
  JIT_EVENT_NAME,
} from "@sid-code/core/trace/jit-telemetry.ts";
import { aggregateJitStats } from "@sid-code/core/trace/digest.ts";

afterEach(() => {
  setJitTraceSink(null); // 模块级单例，用完复位避免串味
});

function discovery(over: Partial<Parameters<typeof buildJitEventData>[0]["discovery"]> = {}) {
  return {
    loaded: [],
    scopeSkipped: 0,
    failures: [],
    elapsedMs: 3,
    ...over,
  };
}

describe("buildJitEventData", () => {
  it("命中时产出完整字段（字节/归因/累积量）", () => {
    const data = buildJitEventData({
      accessedPath: "/proj/src/ui/Footer.tsx",
      projectRoot: "/proj",
      discovery: discovery({
        loaded: [
          { relPath: "src/ui/CLAUDE.md", bytes: 512, reason: "nested_traversal", oversized: false },
        ],
        elapsedMs: 7.4,
      }),
      cumulativeBytes: 512,
      source: "main",
    });

    expect(data.hit).toBe(true);
    expect(data.loaded_count).toBe(1);
    expect(data.injected_bytes).toBe(512);
    expect(data.cumulative_bytes).toBe(512);
    expect(data.accessed_path).toBe("src/ui/Footer.tsx");
    expect(data.elapsed_ms).toBe(7); // 四舍五入，轨迹不需要小数精度
    expect(data.source).toBe("main");
  });

  it("未命中也产出可统计 payload（hit=false，不是不打点）", () => {
    const data = buildJitEventData({
      accessedPath: "/proj/src/a.ts",
      projectRoot: "/proj",
      discovery: discovery(),
      cumulativeBytes: 0,
      source: "main",
    });
    expect(data.hit).toBe(false);
    expect(data.loaded_count).toBe(0);
    // 关键：这条能被聚合器算进分母
    expect(aggregateJitStats([{ event: JIT_EVENT_NAME, data }])!.injections).toBe(1);
  });

  it("source 区分主循环与子代理两条通道", () => {
    const mk = (source: "main" | "subagent") =>
      buildJitEventData({
        accessedPath: "/proj/a.ts",
        projectRoot: "/proj",
        discovery: discovery(),
        cumulativeBytes: 0,
        source,
      });
    expect(mk("main").source).toBe("main");
    expect(mk("subagent").source).toBe("subagent");
  });

  it("项目外路径只留文件名，绝对路径不进轨迹（轨迹会上传）", () => {
    const data = buildJitEventData({
      accessedPath: "/Users/someone/secret/x.ts",
      projectRoot: "/proj",
      discovery: discovery({
        failures: [{ path: "/Users/someone/private/CLAUDE.md", code: "EACCES", phase: "read" }],
      }),
      cumulativeBytes: 0,
      source: "main",
    });
    expect(String(data.accessed_path)).not.toContain("/Users/");
    expect(data.accessed_path).toBe("x.ts");
    const fails = data.failures as Array<{ path: string }>;
    expect(fails[0].path).toBe("CLAUDE.md");
    expect(JSON.stringify(data)).not.toContain("/Users/");
  });

  it("payload 字段名与消费侧口径一致（改名会在此失败 —— 这是漂移哨兵）", () => {
    const data = buildJitEventData({
      accessedPath: "/proj/a.ts",
      projectRoot: "/proj",
      discovery: discovery({
        loaded: [{ relPath: "CLAUDE.md", bytes: 100, reason: "rules_dir", oversized: true }],
        scopeSkipped: 2,
        failures: [{ path: "/proj/b.md", code: "EISDIR", phase: "probe" }],
      }),
      cumulativeBytes: 100,
      source: "main",
    });
    // 直接喂给聚合器：任一字段改名，下面的断言就会塌
    const s = aggregateJitStats([{ event: JIT_EVENT_NAME, data }])!;
    expect(s.hits).toBe(1);
    expect(s.loadedCount).toBe(1);
    expect(s.injectedBytes).toBe(100);
    expect(s.cumulativeBytes).toBe(100);
    expect(s.scopeSkipped).toBe(2);
    expect(s.oversized).toBe(1);
    expect(s.failures).toBe(1);
    expect(s.failureCodes.EISDIR).toBe(1);
    expect(s.reasonCounts.rules_dir).toBe(1);
    expect(s.elapsedP50).toBe(3);
  });
});

describe("emitJitEvent / setJitTraceSink", () => {
  it("注入后写入 sink", () => {
    const seen: Array<Record<string, unknown>> = [];
    setJitTraceSink((d) => seen.push(d));
    emitJitEvent({ hit: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].hit).toBe(true);
  });

  it("sink 未注入时静默（轨迹未启用不该抛）", () => {
    setJitTraceSink(null);
    expect(() => emitJitEvent({ hit: true })).not.toThrow();
  });

  it("sink 抛错被吞掉（埋点绝不影响主流程）", () => {
    setJitTraceSink(() => {
      throw new Error("磁盘满");
    });
    expect(() => emitJitEvent({ hit: true })).not.toThrow();
  });

  it("事件名常量与聚合器过滤条件一致", () => {
    expect(JIT_EVENT_NAME).toBe("jit_context");
    // 用错事件名 → 聚合器返回 null，这个断言锁住两侧同源
    expect(aggregateJitStats([{ event: "jit_ctx_wrong", data: { hit: true } }])).toBeNull();
    expect(aggregateJitStats([{ event: JIT_EVENT_NAME, data: { hit: true } }])).not.toBeNull();
  });
});
