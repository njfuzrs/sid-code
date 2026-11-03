/**
 * worktree 切换不再作废 system 静态前缀 —— 回归哨兵
 *
 * 缺陷背景（docs-research/sid-code/bugfixes/todo/20261030-worktree切换重建system静态区-整段前缀作废.md）：
 * 工作目录写在 system 的静态核心区（`buildEnvironmentSection`），进出 worktree 触发
 * `onWorkspaceChange` → `rebuildSystemPrompt`，静态区第一段就变了 → 后面的 system、tools、
 * 全部历史跟着重算。轨迹实测：133 次 `system_static` 断裂里 104 次紧跟 enter/exit_worktree
 * 的 PostToolUse，字符级浪费中位数 0.997（几乎等于整条前缀作废）。
 *
 * 修复把工作目录与「是否 git 仓库」移出静态区，改由动态区的 `<working-directory>` 下发。
 * 本文件锁两件事：
 *   ① cwd 变化时**静态区逐字节不变**（缓存可完整命中）；
 *   ② 切换事实仍能传给模型（动态区 + 待注入的持久块），否则模型会按旧目录推相对路径。
 *
 * 防「假绿」：第 1 条如果只比较含 boundary 的整串，动态区（日期/工作目录）本来就不同，
 * 断言会恒假。所以必须显式切出 staticContent 再比 —— 见 splitSystemByDynamicBoundary。
 */

import { describe, test, expect } from "bun:test";
import { buildSystemPrompt } from "@sid-code/core/config/system-prompt.ts";
import { splitSystemByDynamicBoundary } from "@sid-code/core/api/cache-strategy.ts";
import { Manager } from "@sid-code/core/context/manager.ts";

/** 两个"不同工作目录"的替身。不落盘、不用真实目录：本文件只验字符串组装，不跑 git。 */
const MAIN_WT = "/repo/main-checkout";
const FEATURE_WT = "/repo/.sid-code/worktrees/feature-x";

function staticOf(workingDir: string): string {
  // gitStatus: false —— gitStatus 会调真实 git 命令，且其内容取决于跑测试的目录，
  // 与本缺陷（环境段的工作目录）无关，排除掉才能得到确定性断言。
  const prompt = buildSystemPrompt({ tools: [], workingDir, gitStatus: false });
  return splitSystemByDynamicBoundary(prompt).staticContent;
}

describe("worktree 切换：system 静态区逐字节稳定", () => {
  test("cwd 从主仓换到 worktree，静态区完全相同（这是缓存能命中的前提）", () => {
    expect(staticOf(MAIN_WT)).toBe(staticOf(FEATURE_WT));
  });

  test("静态区里不出现任何一个工作目录路径", () => {
    const s = staticOf(FEATURE_WT);
    expect(s).not.toContain(MAIN_WT);
    expect(s).not.toContain(FEATURE_WT);
  });

  test("动态区跟随切换（模型仍拿得到当前路径，不会按旧目录推相对路径）", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      workingDir: FEATURE_WT,
      gitStatus: false,
    });
    const { staticContent, dynamicContent } = splitSystemByDynamicBoundary(prompt);
    expect(staticContent).not.toContain(FEATURE_WT);
    expect(dynamicContent).toBeDefined();
    expect(dynamicContent!).toContain(FEATURE_WT);
    expect(dynamicContent!).toContain("<working-directory>");
  });

  test("动态区仍带日期（工作目录没有挤掉原有内容）", () => {
    const prompt = buildSystemPrompt({ tools: [], workingDir: FEATURE_WT, gitStatus: false });
    const { dynamicContent } = splitSystemByDynamicBoundary(prompt);
    expect(dynamicContent!).toContain("<current-date>");
    // 两者在同一个附件里紧邻（`generateDateAttachment` 拼成一段）：
    // 断言这个相对位置，而不是对整串 indexOf —— 静态区的路径提示里也提到
    // `<working-directory>` 这个字面量（「见 <working-directory>」），
    // 用整串 indexOf 会命中那处提示，得到"工作目录出现在 boundary 之前"的假失败。
    const dateIdx = dynamicContent!.indexOf("<current-date>");
    const cwdIdx = dynamicContent!.indexOf("<working-directory>");
    expect(dateIdx).toBeGreaterThanOrEqual(0);
    expect(cwdIdx).toBeGreaterThan(dateIdx);
  });
});

describe("工作区切换通知：排队一次、消费一次", () => {
  test("record 后 consume 取得到，且再取为空（不会逐轮累积）", () => {
    const ctx = new Manager({ maxTokens: 100_000 });
    ctx.recordWorkspaceNotice(`工作目录已切换为：${FEATURE_WT}`);

    const first = ctx.consumeWorkspaceNotices();
    expect(first).toHaveLength(1);
    expect(first[0]).toContain(FEATURE_WT);

    // 持久块必须"只播一次"：重复消费会让同一事实每轮重新写进历史，
    // 那就从"尾部追加"退化成"逐轮累积"。
    expect(ctx.consumeWorkspaceNotices()).toEqual([]);
  });

  test("空文本不排队（避免注入一个只有围栏的空块）", () => {
    const ctx = new Manager({ maxTokens: 100_000 });
    ctx.recordWorkspaceNotice("");
    expect(ctx.consumeWorkspaceNotices()).toEqual([]);
  });

  test("clear() 丢弃未消费的通知（切完立刻 /clear 不该漏给下个会话）", () => {
    const ctx = new Manager({ maxTokens: 100_000 });
    ctx.recordWorkspaceNotice("工作目录已切换为：/x");
    ctx.clear();
    expect(ctx.consumeWorkspaceNotices()).toEqual([]);
  });
});
