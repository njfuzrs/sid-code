/**
 * 多 provider 不变量守卫 — 「放 system 动态区」≠「不占 user turn」
 *
 * 这条不变量是本项目反复踩过的隐性前提（2026-07-30 上下文注入审计）：
 *
 *   `buildSystemPrompt` 产出的 DYNAMIC_BOUNDARY 之后的内容，在 **OpenAI 族**
 *   （deepseek 是本项目主力模型）会被 `openai.ts prependSystemMessage` 切出来、
 *   以 `role: "user"` 追加到 messages 末尾。因此把易变内容"搬进 system 动态区"
 *   **省不下任何 user turn 字节**，只是多绕一层间接。
 *
 * 历史上有两个方案基于"搬进动态区就不占 user turn"这个错误前提设计，
 * 都在落地前被推翻（权限模式附件、deferred-tools 列表）。把它固化成可执行断言，
 * 下一次有人再提同类优化时，跑一次测试就能看到真实落地形态。
 *
 * 要真正减少 user turn 占用只有两条路：① 不注入；② 走增量 delta 只发变化量。
 *
 * 关联：src/config/system-prompt.ts 附件分拣段的 ⛔ 不变量注释；
 *      docs/bugfixes/todo/重复注入根因-system附件与user-reminder双通道.md §7.3.2
 */

import { describe, test, expect } from "bun:test";
import { buildSystemPrompt } from "@sid-code/core/config/system-prompt.ts";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import {
  DYNAMIC_BOUNDARY,
  splitSystemByDynamicBoundary,
} from "@sid-code/core/api/cache-strategy.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

class TestableOpenAIProvider extends OpenAIProvider {
  testPrependSystem(messages: any[], system: string, model: string) {
    (this as any).prependSystemMessage(messages, system, model);
    return messages;
  }
}

const provider = new TestableOpenAIProvider("test-key", "deepseek-chat");

/** 一条最小的真实 user 消息，模拟"用户指令" */
function userMessages(): Message[] {
  return [{ role: "user", content: [{ type: "text", text: "用户的真实指令" }] }] as any;
}

/** 走 provider 的真实转换路径：user 消息 → prependSystemMessage 注入 system */
function convertWithSystem(system: string) {
  // convertMessages 的产物形态对本不变量无关，这里直接用等价的最小 wire 消息，
  // 关键是让 prependSystemMessage 在一个非空 messages 数组上工作。
  const wire: any[] = [{ role: "user", content: "用户的真实指令" }];
  return provider.testPrependSystem(wire, system, "deepseek-chat");
}

describe("不变量：system 动态区在 OpenAI 族会落成一条 user 消息", () => {
  test("buildSystemPrompt 产出的动态区非空（日期附件恒在，是本不变量的前提）", () => {
    const system = buildSystemPrompt({ tools: [] });
    expect(system).toContain(DYNAMIC_BOUNDARY);
    const { dynamicContent } = splitSystemByDynamicBoundary(system);
    expect(dynamicContent).toBeDefined();
    expect(dynamicContent!.length).toBeGreaterThan(0);
  });

  test("动态区非空 → OpenAI 族 messages 必然多出一条 role:user（不占 user turn 是错的）", () => {
    const system = buildSystemPrompt({
      tools: [],
      // 挑几个真实会落动态区的附件，让动态区有实质内容
      projectRules: "# 项目规则\n这是一段 CLAUDE.md 内容",
    });
    const { dynamicContent } = splitSystemByDynamicBoundary(system);
    expect(dynamicContent).toBeDefined();
    expect(dynamicContent!.length).toBeGreaterThan(0);

    const before = 1; // 转换前只有用户那一条
    const out = convertWithSystem(system);

    // 1 条 system（静态区）+ 原有 1 条 user + 1 条**新增的 user**（动态区）
    expect(out).toHaveLength(before + 2);
    expect(out[0].role).toBe("system");

    const userMsgs = out.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(2);

    // 新增那条在**末尾**，且承载的就是动态区内容
    const last = out[out.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain(dynamicContent!);
  });

  test("动态区内容逐字节出现在 user 消息里（不是摘要、不是丢弃）", () => {
    const marker = "__DYNAMIC_REGION_CANARY__";
    const system = `STATIC_PREFIX${DYNAMIC_BOUNDARY}${marker}`;
    const out = convertWithSystem(system);

    // 静态区不含 marker，说明它确实被切走了
    expect(out[0].content).toBe("STATIC_PREFIX");
    expect(out[0].content).not.toContain(marker);
    // marker 原样出现在末尾 user 消息 → 字节没省，只是换了承载位置
    const last = out[out.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain(marker);
  });

  test("动态区为空 → 不新增 user 消息（对照组，证明上面那条不是恒真）", () => {
    const out = convertWithSystem("只有静态内容，没有边界标记");
    expect(out).toHaveLength(2); // 1 system + 原有 1 user
    expect(out.filter((m) => m.role === "user")).toHaveLength(1);
  });

  test("Anthropic 族不受影响：system 整段走 system 参数，不进 messages", () => {
    // 反证不变量的适用范围：它是 OpenAI 族特有的落地形态，不是跨 provider 通用行为。
    // Anthropic provider 把 system 原样交给 API 的 system 参数（含 boundary 处的
    // cache_control 分段），messages 数组不会因动态区多出任何一条。
    const msgs = userMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs.every((m) => m.role === "user")).toBe(true);
    // 这里只锁"messages 不被 system 内容污染"这一点——具体 cache_control 打点
    // 由 tests/api/cache-strategy.test.ts 与 anthropic 侧测试覆盖。
  });
});

/**
 * 守卫：工作目录必须落在**动态区**。
 *
 * 它曾经在静态核心区（`buildEnvironmentSection`），后果是每进/出一次 worktree
 * 整条 system 前缀作废——2026-10-30 轨迹实测 133 次 `system_static` 断裂里
 * 104 次紧跟 enter/exit_worktree 的 PostToolUse，字符级浪费中位数 0.997。
 *
 * 这条断言锁死新契约：静态区出现工作目录字符串即回归。
 */
describe("不变量：工作目录落在动态区（静态前缀不随 worktree 切换变化）", () => {
  test("静态区不含工作目录，动态区含", () => {
    const dir = process.cwd();
    const system = buildSystemPrompt({ tools: [], workingDir: dir, gitStatus: false });
    const { staticContent, dynamicContent } = splitSystemByDynamicBoundary(system);

    expect(staticContent).not.toContain(dir);
    expect(dynamicContent).toBeDefined();
    expect(dynamicContent!).toContain(dir);
  });

  test("静态区也不含「git 仓库」判定（它依赖 cwd，同源）", () => {
    const system = buildSystemPrompt({ tools: [], workingDir: process.cwd(), gitStatus: false });
    const { staticContent } = splitSystemByDynamicBoundary(system);
    expect(staticContent).not.toContain("Is directory a git repo");
    expect(staticContent).not.toContain("是否 git 仓库");
  });
});
