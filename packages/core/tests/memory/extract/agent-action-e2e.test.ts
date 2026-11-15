/**
 * §8.3「agent 把自身行为固化成记忆」的可重复验收（判据里确定性的那一半）。
 *
 * 方案 §8.2 已证明 G2 回放做不出来：fork 请求不进 `raw.jsonl`，回放时 fork 拿不到响应，
 * 「提取代理没写入」这个断言恒为真 —— 是假绿，比没有用例更糟。于是 §8.3 的三项验收
 * 原本只能靠真实模型手工跑。但手工跑不可重复、进不了 CI，而「等日常使用撞上这个场景」
 * 可能永远等不到（用户 2026-11-15：缺样本就自己造）。
 *
 * 这里造的是判据里**确定性的那一半**：脚本化的假模型（固定返回某几次工具调用）驱动
 * **真实**的 extractor → 真实 `MemoryTool`（含所有写盘闸门）→ 真实 `MemoryStore`，
 * 断言「模型写成什么 → 磁盘上留下什么 → 提示文案怎么记」。
 *
 * ⚠️ 它替代不了「真实模型会不会自己写出污染记忆」——那是 G3，仍要人跑真实会话。
 * 它守的是另一半：给定模型这么写了，闸门是否真的拦住、`written` 是否真的不计数。
 *
 * 覆盖 §8.3 的三项：
 * 1/2. 「agent 做了一件用户没评价的事」→ 提取代理想把它写成 feedback → 拦下，磁盘无变化
 * 3.   反向验收：用户明确说「以后都这样做」→ 同样路径**应该**写进去（证明没把正常写入掐死）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initExtractMemories } from "@sid-code/core/memory/extract/extractor.ts";
import { MemoryStore } from "@sid-code/core/memory/store.ts";
import { MemoryTool } from "@sid-code/core/tool/memory.ts";
import { MEMORY_EXTRACT_QUERY_SOURCE } from "@sid-code/core/memory/types.ts";

let root: string;
let savedSidConfigDir: string | undefined;

beforeEach(() => {
  // 落盘隔离：本文件 import 了 `MemoryStore`（落盘类导出），
  // `packages/core/tests/telemetry/no-real-path-writes.test.ts` 的哨兵要求显式声明。
  // 只把 `root` 传给 MemoryStore 不够 —— 被测链路里任何走默认路径的分支
  // （`getSidHome()` / read-stats / 遥测）都会落到用户真实的 `~/.sid-code/`。
  savedSidConfigDir = process.env.SID_CONFIG_DIR;
  root = mkdtempSync(join(tmpdir(), "sid-extract-e2e-"));
  process.env.SID_CONFIG_DIR = root;
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
  // 存/恢复原值，不无条件 delete：`bun test` 同批多文件跑在同一进程里，
  // 直接删会把 bunfig preload 的兜底一起抹掉（CONTRIBUTING.md 测试约定第 1 条）。
  if (savedSidConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedSidConfigDir;
});

/** 假模型「写这一步」的脚本：一条 save_memory 调用 */
interface Step {
  key: string;
  value: string;
  type?: string;
}

/**
 * 构造一个假 fork：按 plan 逐条发起 `save_memory`，**内部真实执行** `MemoryTool.execute`
 * （所以闸门、落盘、去重全走生产代码，不是 stub）。
 *
 * 返回值刻意带上 `tool_result`：写入判定要求「有配对结果且非 error」才算落盘
 * （见 `extractor.ts` 的 `settledToolUseIds`）。真实 fork 也是这个形状。
 */
function scriptedFork(store: MemoryStore, plan: Step[]) {
  return (async () => {
    const messages: any[] = [];
    for (let i = 0; i < plan.length; i++) {
      const id = `call_${i}`;
      const input = {
        key: plan[i].key,
        value: plan[i].value,
        type: plan[i].type ?? "feedback",
        _querySource: MEMORY_EXTRACT_QUERY_SOURCE,
        _agentId: "forked-agent",
      };
      const r = await new MemoryTool(store).execute(input);
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id, name: "save_memory", input }],
      });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: r.output,
            ...(r.isError ? { is_error: true } : {}),
          },
        ],
      });
    }
    return {
      messages,
      usage: { inputTokens: 120, outputTokens: 8 },
      turns: 1,
      deniedToolCalls: 0,
    };
  }) as any;
}

function makeHandle(store: MemoryStore, plan: Step[]) {
  const dir = join(root, "projects", "demo", "memory");
  mkdirSync(dir, { recursive: true });
  const appended: string[] = [];
  const h = initExtractMemories({
    // 主代理这一轮只「做了一件事」，没有写记忆 —— 正是 §8.3 第 1/2 项的场景。
    getMainContext: () => ({ messages: [] }) as any,
    memoryDir: dir,
    canUseTool: () => ({ behavior: "allow" }),
    interval: 1,
    runFork: scriptedFork(store, plan),
    appendSystemMessage: (msg: any) => {
      appended.push(msg.content.map((b: any) => b.text ?? "").join(""));
    },
  });
  return { h, appended, dir };
}

/** `executeExtract` 是 fire-and-forget（生产语义），等微任务链排干 */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("§8.3 造数据验收：agent 自身行为不会被固化成记忆", () => {
  test("场景 1/2：提取代理写「本轮操作步骤」类 feedback（无原话）→ 不落盘、无「已保存」文案", async () => {
    // 完本缺陷的原始形态：把「先归档再移附件、按什么顺序跑命令」写成经验，
    // 依据只有「用户没有反对」。
    const store = new MemoryStore(root);
    const { h, appended } = makeHandle(store, [
      {
        key: "archive_move_attachment",
        value:
          "归档方案文档时先移动正文，再逐个移动附件目录，最后核对图片引用是否失效。\n" +
          "Why: 这样能避免中途失败留下半归档状态。\n" +
          "How to apply: 每次归档带附件的文档时按这个顺序做。",
      },
    ]);

    await h.executeExtract();
    await drain();

    // 磁盘上不能留下这条「经验」
    expect(await store.get("archive_move_attachment")).toBeNull();
    // 「已保存 N 条记忆」也不能出现：被拒的写入不是写入
    expect(appended).toEqual([]);
  });

  test("场景 3（反向验收）：用户明确说过「以后归档都要连附件一起移」→ 同样路径写进去了", async () => {
    const store = new MemoryStore(root);
    const { h, appended } = makeHandle(store, [
      {
        key: "archive_always_move_attachment",
        value:
          "归档文档时必须连附件一起移动。\n" +
          "Why: 用户说「以后归档都要连附件一起移」，漏移会让文档里的图片全部失效。\n" +
          "How to apply: 每次归档带附件的文档时，连附件目录一起移过去。",
      },
    ]);

    await h.executeExtract();
    await drain();

    // 反向验收：这条**应该**写进去 —— 否则说明闸门把正常写入也一起掐死了
    const entry = await store.get("archive_always_move_attachment");
    expect(entry).not.toBeNull();
    // 写入来源必须是强制覆写后的 agent_action（P0-3 不靠模型自觉）
    expect(entry?.source).toBe("agent_action");
    expect(appended.join("\n")).toContain("已保存 1 条记忆");
  });

  test("混合：一条被拒一条通过 → 「已保存」文案只列通过的那条（written 口径）", async () => {
    // 这条守的是 §8.5 的回滚判据：被拒的写入若也计入 written / 也出现在文案里，
    // P0-2 生效后指标不会下降，「连续 3 天 p50 = 0」就测不出闸门到底有没有掐死。
    const store = new MemoryStore(root);
    const { h, appended } = makeHandle(store, [
      {
        key: "agent_own_steps",
        value: "我先跑了 ls，再跑了 git status，然后才读文件。",
      },
      {
        key: "user_explicit_pref",
        value:
          "提交前先跑 lint。\n" +
          "Why: 用户明确说「以后提交前都跑一遍 lint」。\n" +
          "How to apply: 每次 git commit 前跑 bun run lint。",
      },
    ]);

    await h.executeExtract();
    await drain();

    expect(await store.get("agent_own_steps")).toBeNull();
    expect(await store.get("user_explicit_pref")).not.toBeNull();
    const text = appended.join("\n");
    expect(text).toContain("已保存 1 条记忆");
    expect(text).toContain("user_explicit_pref");
    // 被拒的那条绝不能出现在「已保存」列表里
    expect(text).not.toContain("agent_own_steps");
  });

  test("主代理手动写同一形态的 feedback → 放行（闸门不该误伤用户显式记忆）", async () => {
    // 与上面第一条同样的 value，区别只是没有 `_querySource`（主会话路径）。
    // 这条守住「闸门只打在污染源上」这个设计前提 —— 删掉来源限定就会静默误伤。
    const store = new MemoryStore(root);
    const r = await new MemoryTool(store).execute({
      type: "feedback",
      key: "no_quote_but_manual",
      value: "用户希望我以后先跑测试再改代码。",
      scope: "project",
    });
    expect(r.isError).toBeFalsy();
    expect(await store.get("no_quote_but_manual")).not.toBeNull();
  });
});
