/**
 * /trace --prune-index N 接线测试。
 *
 * 这个分支存在的全部理由是让 pruneSessionIndex 不再是死函数：它刻意不自动调用
 * （索引 10 万会话 ≈ 50MB，自动清理正是 P0-2 要治的病），所以手动入口就是它唯一
 * 的生产调用点。方案当初承诺了 `/trace --prune-index N`，但从未接线 —— 本文件
 * 断言的是"入口真的通到了那个函数"，而不只是"函数自己算得对"
 * （后者由 packages/core/tests/trace/session-index.test.ts 覆盖）。
 *
 * 经 SID_CODE_SESSION_INDEX 重定向到 tmp，不触碰真实 ~/.sid-code。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceCommand } from "@sid-code/cli/command/builtins.ts";
import type { AppContext } from "@sid-code/cli/command/types.ts";

let dir: string;
let indexPath: string;
// 存/恢复原值，不无条件 delete —— bun test 同进程跑多文件，delete 会抹掉 preload 兜底
const savedIndex = process.env.SID_CODE_SESSION_INDEX;

/** 造 N 行合法索引：只有带 session_id 的行会被 readSessionIndex 认领 */
function seed(n: number): void {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({ session_id: `s${i}`, ts: 1_700_000_000 + i, model: "m" }));
  }
  writeFileSync(indexPath, lines.join("\n") + "\n", "utf-8");
}

const ctx = { sessionId: undefined } as unknown as AppContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-trace-prune-"));
  indexPath = join(dir, "session-index.jsonl");
  process.env.SID_CODE_SESSION_INDEX = indexPath;
});

afterEach(() => {
  if (savedIndex === undefined) delete process.env.SID_CODE_SESSION_INDEX;
  else process.env.SID_CODE_SESSION_INDEX = savedIndex;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("/trace --prune-index", () => {
  test("正常裁剪：10 行保留最近 5 行，且真的落盘", async () => {
    seed(10);
    const res = await new TraceCommand().execute("--prune-index 5", ctx);

    expect(res.kind).toBe("message");
    expect((res as { message: string }).message).toContain("保留最近 5 行");

    // 断言落盘内容，而不只是返回文案 —— 文案对而没写盘是这类命令最容易出的错
    const kept = readFileSync(indexPath, "utf-8").trim().split("\n");
    expect(kept).toHaveLength(5);
    // 保留的是"最近"的，即尾部 5 行
    expect(JSON.parse(kept[0]!).session_id).toBe("s5");
    expect(JSON.parse(kept[4]!).session_id).toBe("s9");
  });

  test("裁剪到 0 行是合法操作，与'索引不存在'文案可区分", async () => {
    seed(3);
    const res = await new TraceCommand().execute("--prune-index 0", ctx);
    expect((res as { message: string }).message).toContain("保留最近 0 行");
    expect((res as { message: string }).message).not.toContain("不存在");
  });

  test("N 大于现有行数时不报错、不丢行", async () => {
    seed(3);
    const res = await new TraceCommand().execute("--prune-index 100", ctx);
    expect((res as { message: string }).message).toContain("保留最近 3 行");
    expect(readFileSync(indexPath, "utf-8").trim().split("\n")).toHaveLength(3);
  });

  describe("非法参数一律 error，且不碰文件", () => {
    // 空缺参数、负数、非数字、宽容解析陷阱各一例。"5x" 这条专门盯 parseInt：
    // parseInt("5x") 静默得到 5，会把用户的错字当成有效的删除行数
    for (const arg of [
      "--prune-index",
      "--prune-index abc",
      "--prune-index -1",
      "--prune-index 5x",
    ]) {
      test(arg, async () => {
        seed(4);
        const res = await new TraceCommand().execute(arg, ctx);
        expect(res.kind).toBe("error");
        expect((res as { message: string }).message).toContain("--prune-index 需要一个非负整数");
        // 参数校验失败必须零副作用
        expect(readFileSync(indexPath, "utf-8").trim().split("\n")).toHaveLength(4);
      });
    }
  });

  test("索引不存在时给出专属文案，不渲染成'已裁剪 0 行'", async () => {
    expect(existsSync(indexPath)).toBe(false);
    const res = await new TraceCommand().execute("--prune-index 5", ctx);
    expect(res.kind).toBe("message");
    expect((res as { message: string }).message).toContain("会话索引不存在");
    expect((res as { message: string }).message).not.toContain("已裁剪");
  });

  test("pruneSessionIndex 返回 -1（写盘失败）渲染成失败，不是'保留 -1 行'", async () => {
    seed(5);
    // 让 writeFileSync 失败的最省事真实途径：把索引路径指向一个目录。
    // 目录存在 → 通过 existsSync 那道门；写它必然 EISDIR → 函数 catch 返回 -1。
    // 这比 mock 模块更可信：走的是真实错误路径，不是我们假造的返回值。
    rmSync(indexPath, { force: true });
    const asDir = join(dir, "index-as-dir");
    mkdirSync(asDir, { recursive: true });
    process.env.SID_CODE_SESSION_INDEX = asDir;

    const res = await new TraceCommand().execute("--prune-index 5", ctx);
    expect(res.kind).toBe("message");
    expect((res as { message: string }).message).toContain("裁剪失败");
    expect((res as { message: string }).message).not.toContain("-1 行");
  });
});
