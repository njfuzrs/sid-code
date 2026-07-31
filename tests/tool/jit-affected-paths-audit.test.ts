/**
 * JIT 触发路径自报的双向对账审计（P2-9）
 *
 * 背景：`app.ts` 原来硬编码 `["read","write","edit","grep","glob"]` 并手挑
 * `file_path` / `path` 字段名，与真实注册工具之间**没有任何对账机制**。后果实测过两类：
 *   - 漏工具：`read_many` / `notebook_edit` / `ls` / `lsp` 全在名单外，子代理用
 *     `read_many` 批量读 `src/ui/*.tsx` 时那个目录的规范一份都拿不到，**且静默无日志**；
 *   - 漏字段：`glob("src/ui/**\/*.tsx")` 把目录写在 pattern 里、不传 path，
 *     集中式提取只能退化成项目根。
 * 已改为工具自报 `jitAffectedPaths`（`types.ts` 有完整契约），但"自报"本身也会漂移——
 * 新增一个接受路径参数的工具时，没人提醒你评估要不要实现它。
 *
 * 本审计把这件事 codify 成可执行测试（`types.ts` 的契约注释里明确承诺了本文件的存在）。
 * 与 `loop-detection-exemption-audit.test.ts` 同一范式：把"该维护的清单"变成 CI 硬错误，
 * 而不是靠人记得。
 *
 * 三条断言：
 *   1. 【无遗漏】源码里凡 schema 含路径类字段的工具，要么实现 `jitAffectedPaths`，
 *      要么在 `INTENTIONALLY_NO_JIT` 里显式登记豁免理由 —— 不允许"既没实现也没登记"。
 *   2. 【无多余】`INTENTIONALLY_NO_JIT` 里的每个名字都必须真实存在且确实没实现
 *      —— 防"工具已删/已实现，豁免登记还留着"这种反向漂移。
 *   3. 【契约】已实现的工具，其 `jitAffectedPaths` 必须遵守 types.ts 的契约：
 *      纯函数、不抛（畸形入参返回空数组而非崩溃）。
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL_SRC_DIRS = [join(REPO_ROOT, "src", "tool"), join(REPO_ROOT, "src", "agent")];

/**
 * schema 中被视为「文件语义路径」的字段名。命中其一即认为该工具触达文件系统，
 * 需要就 JIT 触发做出显式决定（实现 or 登记豁免）。
 *
 * 不含 `pattern`：grep/glob 的 pattern 是正则/通配，本身不是路径 —— 它们各自的
 * `jitAffectedPaths` 内部才做前缀提取（`globPatternDirs` / `searchToolPaths`）。
 *
 * 含 `cwd`（第 7 批新增）：`bash` 的 `command` 字段本身不是路径字段，靠字段名匹配
 * 永远发现不了 bash 需要评估 —— 这正是「共同盲区」审计本身的盲区（bash 写文件
 * 不触发 JIT 这条缺口存在了很久却没有测试红灯提醒）。`cwd` 是 bash 唯一真实的
 * 路径类字段，加入后审计至少能把 bash 拉进「需要显式决定」的范围；bash 是否
 * 该报 cwd 本身、以及它从 command 文本提取写目标的实现见 `bash.ts:jitAffectedPaths`
 * 与 `jit-affected-paths.ts:bashWriteTargets`。
 */
const PATH_FIELD_NAMES = ["file_path", "notebook_path", "dir_path", "paths", "path", "cwd"] as const;

/**
 * 显式豁免名单：接受路径参数但**有意**不触发 JIT 的工具。
 *
 * 加进来必须写清理由。判据是 types.ts 契约里的那句「只报文件语义的路径」——
 * 报错路径的代价是无意义 stat + 把不相干目录的规则灌进上下文。
 */
const INTENTIONALLY_NO_JIT: Record<string, string> = {
  enter_worktree:
    "path 指的是 worktree 目录本身（一个 git 工作区根），不是被读写的业务文件。" +
    "进入 worktree 后其内部的文件访问会各自触发 JIT，在这里再报一次只会把 worktree " +
    "根目录的规则提前灌进来，且此时 projectRoot 尚未切换，边界判定的语义是错的。",
};

/** 从工具源文件里抽出 `name(): string { return "xxx" }` 的工具名 */
function extractToolName(source: string): string | null {
  const m = source.match(/name\(\)\s*:\s*string\s*\{\s*return\s*"([a-z_]+)"/);
  return m ? m[1]! : null;
}

interface ToolFacts {
  tool: string;
  file: string;
  /** schema 中出现的路径类字段 */
  pathFields: string[];
  /** 是否实现了 jitAffectedPaths */
  declaresJit: boolean;
}

/** 扫描全部工具源码，收集「路径字段」与「是否自报」两项事实 */
function collectToolFacts(): ToolFacts[] {
  const out: ToolFacts[] = [];
  for (const dir of TOOL_SRC_DIRS) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const file = join(dir, f);
      const source = readFileSync(file, "utf8");
      const tool = extractToolName(source);
      if (!tool) continue;
      // 只看 zod schema 声明处（`xxx: z.string()` 形态），避免把正文里的变量名误当字段
      const pathFields = PATH_FIELD_NAMES.filter((name) =>
        new RegExp(`\\b${name}\\s*:\\s*z\\.`).test(source),
      );
      out.push({ tool, file, pathFields, declaresJit: /jitAffectedPaths\s*\(/.test(source) });
    }
  }
  return out;
}

const FACTS = collectToolFacts();

describe("P2-9 JIT 触发路径自报：与真实工具双向对账", () => {
  test("扫描到了工具源码（防正则失配导致整个审计空跑通过）", () => {
    // 没有这条时，`extractToolName` 的正则一旦因代码风格变化而全部失配，
    // 下面两条断言会在空集合上"通过"，审计变成装饰品。
    expect(FACTS.length).toBeGreaterThan(20);
    expect(FACTS.some((f) => f.tool === "read" && f.declaresJit)).toBe(true);
  });

  test("无遗漏：含路径字段的工具必须实现 jitAffectedPaths 或显式登记豁免", () => {
    const missing = FACTS.filter(
      (f) => f.pathFields.length > 0 && !f.declaresJit && !(f.tool in INTENTIONALLY_NO_JIT),
    );
    // 失败信息要能直接指导修复：给出工具名、文件、命中的字段名
    const detail = missing
      .map((f) => `  - ${f.tool} (${f.file}) 路径字段: ${f.pathFields.join(", ")}`)
      .join("\n");
    expect(
      missing.length,
      missing.length === 0
        ? ""
        : `以下工具接受路径参数但既没实现 jitAffectedPaths、也没登记豁免：\n${detail}\n` +
            `请二选一：① 在工具里实现 jitAffectedPaths（契约见 src/tool/types.ts）；` +
            `② 若确实不该触发 JIT，加进本文件的 INTENTIONALLY_NO_JIT 并写明理由。`,
    ).toBe(0);
  });

  test("无多余：豁免名单里的工具必须真实存在且确实没实现", () => {
    for (const [tool, reason] of Object.entries(INTENTIONALLY_NO_JIT)) {
      expect(reason.length, `${tool} 的豁免理由不能为空`).toBeGreaterThan(20);
      const fact = FACTS.find((f) => f.tool === tool);
      expect(fact, `豁免名单里的 ${tool} 在源码中不存在（工具已删？请同步删除豁免登记）`).toBeDefined();
      expect(
        fact!.declaresJit,
        `${tool} 已实现 jitAffectedPaths，但仍留在豁免名单里 —— 请删除豁免登记，否则会误导后来人`,
      ).toBe(false);
    }
  });

  test("已实现的工具数量符合预期（新增/移除时强制回看本审计）", () => {
    const declared = FACTS.filter((f) => f.declaresJit).map((f) => f.tool).sort();
    // 快照式断言：不是为了锁死数字，而是让"某个工具的 JIT 触发被悄悄删掉"变成红灯。
    expect(declared).toEqual([
      "bash", "edit", "glob", "grep", "ls", "lsp",
      "notebook_edit", "read", "read_many", "write",
    ]);
  });
});

describe("P2-9 契约：jitAffectedPaths 不得抛异常（畸形入参返回空数组）", () => {
  // 契约要求「纯函数、不抛」——它在工具执行后被调用，抛了会污染工具结果返回路径。
  // 这里用真实实例过一遍畸形入参，比读代码更可靠。
  const MALFORMED: unknown[] = [
    undefined, null, {}, [], "string", 42,
    { file_path: null }, { file_path: 123 }, { paths: "not-an-array" },
    { paths: [null, 1, {}] }, { path: {} }, { pattern: null },
    { command: null }, { command: 123 }, { command: "a".repeat(20_000) },
  ];

  test("各工具对畸形入参均返回数组且不抛", async () => {
    const { ReadTool } = await import("../../src/tool/read.ts");
    const { WriteTool } = await import("../../src/tool/write.ts");
    const { EditTool } = await import("../../src/tool/edit.ts");
    const { GrepTool } = await import("../../src/tool/grep.ts");
    const { GlobTool } = await import("../../src/tool/glob.ts");
    const { LsTool } = await import("../../src/tool/ls.ts");
    const { BashTool } = await import("../../src/tool/bash.ts");

    const instances: Array<{ name: string; fn: (i: unknown) => string[] }> = [];
    for (const Ctor of [ReadTool, WriteTool, EditTool, GrepTool, GlobTool, LsTool, BashTool] as any[]) {
      const inst = new Ctor();
      if (typeof inst.jitAffectedPaths !== "function") continue;
      instances.push({ name: inst.name(), fn: (i) => inst.jitAffectedPaths(i) });
    }
    expect(instances.length).toBeGreaterThanOrEqual(7);

    for (const { name, fn } of instances) {
      for (const input of MALFORMED) {
        let result: string[];
        expect(() => {
          result = fn(input);
        }, `${name}.jitAffectedPaths(${JSON.stringify(input)}) 抛异常 —— 违反 types.ts「不抛」契约`).not.toThrow();
        expect(Array.isArray(result!), `${name} 未返回数组`).toBe(true);
        // 返回值必须全是字符串：下游 normalizeToolPath 只接受字符串，混入其它类型会在
        // JIT 内部抛错并被 catch 成"路径归一化失败"，表现为静默丢规则。
        for (const p of result!) expect(typeof p).toBe("string");
      }
    }
  });
});
