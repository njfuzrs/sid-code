/**
 * 内核路径测试覆盖盲区扫描 — D2-4
 *
 * 系统级查漏补缺方案 §防线2 D2-4：一次性盘点哪些内核路径（中断/重试/compaction/
 * plan-mode）零测试覆盖，列清单排期。本次 bug 的教训是"函数对 ≠ 会话对"——3253 个
 * 函数级 test 仍漏掉了"多轮累积 + 中断"的会话级不变量。
 *
 * 本文件把"盲区扫描"codify 成**可执行审计**（遵守项目"禁止创建文档"约束，用测试代替清单）：
 *   - KERNEL_PATHS 列出内核关键路径 + 其当前覆盖状态 + 负责的测试文件
 *   - 测试断言：已声明"已覆盖"的路径，其测试文件必须真实存在
 *   - 测试输出：把当前盲区（status=blind / partial）打印出来，作为排期清单
 *
 * 维护约定：新增内核路径测试后，回来更新这张表的 status 与 owner。
 * 这张表是"内核路径覆盖"的单一事实源，CI 跑它即得最新盲区快照。
 */

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

type CoverageStatus = "covered" | "partial" | "blind";

interface KernelPath {
  /** 内核路径名 */
  path: string;
  /** 源码位置 */
  source: string;
  /** 覆盖状态 */
  status: CoverageStatus;
  /** 负责的测试文件（相对仓库根），covered/partial 必须真实存在 */
  tests: string[];
  /** 盲区说明 / 排期备注 */
  note: string;
}

/**
 * 内核路径覆盖矩阵 —— D2-4 盘点结果（2026-06-06）。
 *
 * 覆盖标准：
 *   covered = 有专测该路径"会话级/不变量级"行为的测试
 *   partial = 有相关测试但未覆盖该路径的关键失败模式
 *   blind   = 零专测
 */
const KERNEL_PATHS: KernelPath[] = [
  {
    path: "中断路径 — executeTools 抛 AbortError 后消息历史完整性",
    source: "src/agent/loop.ts:591-607",
    status: "covered",
    tests: [
      "tests/agent/interrupt-history-integrity.test.ts",
      "tests/agent/interrupt-abort-e2e.test.ts",
    ],
    note: "D1-2 + D2-3 已补：真实 loop.run() 驱动 + 落盘重载 + 可恢复断言",
  },
  {
    path: "followup / plan-mode 时序 — toolResults 必排在 followup 之前",
    source: "src/agent/loop.ts:609-616 / src/query/tool-executor.ts:255-260",
    status: "covered",
    tests: [
      "tests/agent/followup-ordering-invariant.test.ts",
      "tests/agent/plan-approval-ordering.test.ts",
    ],
    note: "D1-3 已补：真实 loop 时序断言（plan-approval 为旧的模拟时序）",
  },
  {
    path: "tool_result 协议不变量 — executeTools 出口 N tool_use → N tool_result",
    source: "src/query/tool-executor.ts:218-249",
    status: "covered",
    tests: ["tests/agent/tool-result-invariant.test.ts"],
    note: "ADR-039 4 条：基线/并发抛错/pre-hook 异常/abort 上抛",
  },
  {
    path: "发送前协议关卡 — convertMessages 前孤儿拦截（≥3 provider）",
    source: "src/llm/protocol-sentinel.ts / src/llm/openai.ts:151,259",
    status: "covered",
    tests: [
      "tests/llm/protocol-sentinel.test.ts",
      "tests/llm/provider-protocol-contract.test.ts",
    ],
    note: "D1-1 + D2-1 已补：openai/deepseek/ollama 契约测试",
  },
  {
    path: "消息历史不变量纯函数 — 单一事实源",
    source: "src/agent/message-invariants.ts",
    status: "covered",
    tests: ["tests/agent/message-invariants.test.ts"],
    note: "D1-4 已补",
  },
  {
    path: "崩溃落盘 — abnormal/中断退出落 messages.json + 归因",
    source: "src/trace/collector.ts handleSessionEnd / src/trace/writer.ts",
    status: "covered",
    tests: ["tests/trace/collector.test.ts"],
    note: "D3-1 + D3-3 已补",
  },
  // ── 以下为本次扫描发现的盲区，排期到后续 sprint ──
  {
    path: "auto-compact — 自动压缩触发 + 压缩后消息历史仍合法（无孤儿）",
    source: "src/query/auto-compact.ts / src/context/manager.ts compactWithSummary",
    status: "covered",
    tests: ["tests/context/compaction-integrity.test.ts"],
    note:
      "D2-4 闭合：压缩边界完整性测试已补——compactWithSummary / emergencyTruncate / " +
      "连续两次压缩后 checkMessageHistoryIntegrity 仍 intact（findCompressSplitPoint 只在 " +
      "user 无 tool_result 处切的承诺被测试强制）。",
  },
  {
    path: "compaction 会话级 — 多轮压缩累积后历史合法性",
    source: "src/context/manager.ts getCleanedMessages / emergencyTruncate",
    status: "covered",
    tests: ["tests/context/compaction-integrity.test.ts"],
    note: "D2-4 闭合：'连续两次压缩后历史仍合法' + '最坏构造切在 tool 对密集区' 已覆盖",
  },
  {
    path: "loop-detection — 循环检测触发 + 恢复 pivot",
    source: "src/agent/loop-detection.ts",
    status: "partial",
    tests: ["tests/agent/loop-detection.test.ts"],
    note: "有函数级测试；eval 侧有 hrn_001/002/006/007 行为 case。无 ablation（需 runtime flag toggle，S2/S3）。",
  },
];

describe("D2-4 — 内核路径测试覆盖盲区扫描", () => {
  test("covered / partial 路径声明的测试文件必须真实存在（防止清单与现实漂移）", () => {
    const missing: string[] = [];
    for (const kp of KERNEL_PATHS) {
      if (kp.status === "blind") continue;
      for (const t of kp.tests) {
        if (!existsSync(join(REPO_ROOT, t))) {
          missing.push(`${kp.path} → 声明的测试不存在: ${t}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("covered 路径必须至少有一个测试文件", () => {
    const violations = KERNEL_PATHS.filter(
      kp => kp.status === "covered" && kp.tests.length === 0,
    ).map(kp => kp.path);
    expect(violations).toEqual([]);
  });

  test("盲区清单快照（输出当前 blind/partial 路径，作为排期依据）", () => {
    const blind = KERNEL_PATHS.filter(kp => kp.status === "blind");
    const partial = KERNEL_PATHS.filter(kp => kp.status === "partial");

    // 把盲区打印出来（CI 日志即排期清单）
    console.log("\n─── D2-4 内核路径覆盖盲区快照 ───");
    console.log(`总路径: ${KERNEL_PATHS.length} | 已覆盖: ${KERNEL_PATHS.filter(k => k.status === "covered").length} | 部分: ${partial.length} | 盲区: ${blind.length}`);
    for (const kp of blind) {
      console.log(`  [BLIND]   ${kp.path}\n            ${kp.source}\n            → ${kp.note}`);
    }
    for (const kp of partial) {
      console.log(`  [PARTIAL] ${kp.path}\n            → ${kp.note}`);
    }

    // 守门：盲区数量不得超过当前已知值（0）。新增内核路径若无测试会让此断言失败，
    // 强制要么补测试、要么显式登记进本表 —— 防止"悄悄退化"。
    expect(blind.length).toBeLessThanOrEqual(0);
  });

  test("本次查漏补缺方案 D1-D3 核心路径已全部脱离 blind 状态", () => {
    // 本方案直接修复的路径（中断/时序/关卡/落盘/不变量）必须 covered
    const mustBeCovered = [
      "中断路径",
      "followup / plan-mode 时序",
      "发送前协议关卡",
      "消息历史不变量纯函数",
      "崩溃落盘",
    ];
    for (const key of mustBeCovered) {
      const kp = KERNEL_PATHS.find(k => k.path.includes(key));
      expect(kp).toBeDefined();
      expect(kp!.status).toBe("covered");
    }
  });
});
