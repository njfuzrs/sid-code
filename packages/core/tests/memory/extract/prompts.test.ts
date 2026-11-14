/**
 * 后台提取提示词测试
 *
 * 聚焦：提示词与 `extract/permissions.ts` 的权限口径一致。
 *
 * 旧版在团队记忆启用时追加「满足条件就用 scope=team」的分流段，而权限层对后台代理
 * 只放行 project —— 提示词引导模型去调一个必然被拒的工具（2026-10-24 移除）。
 * 本组断言锁住「提示词不再出现任何引导写 team / 其它 scope 的措辞」，
 * 并与权限函数做一次交叉核对：提示词说能写的，权限层必须真的放行。
 */

import { describe, test, expect } from "bun:test";
import { buildExtractPrompt } from "@sid-code/core/memory/extract/prompts.ts";
import { createExtractPermissions } from "@sid-code/core/memory/extract/permissions.ts";

const MANIFEST = "- [project] foo.md (2026-01-01): 示例";

describe("buildExtractPrompt — 与权限层同口径", () => {
  test("不出现 team scope 分流引导", () => {
    const prompt = buildExtractPrompt(MANIFEST);
    expect(prompt).not.toContain("scope=team");
    expect(prompt).not.toContain("记忆范围（scope）分流");
  });

  test("明确 type 必填、不要传 scope", () => {
    const prompt = buildExtractPrompt(MANIFEST);
    expect(prompt).toContain("type 必填");
    expect(prompt).toContain("不要传 scope");
  });

  test("提示词描述的调用形态（带 type、不带 scope）权限层放行", async () => {
    const perms = createExtractPermissions("/tmp/sid-extract-prompt-mem");
    const r = await perms("save_memory", { key: "k", value: "v", type: "feedback" });
    expect(r.behavior).toBe("allow");
  });

  test("现有记忆清单始终注入", () => {
    expect(buildExtractPrompt(MANIFEST)).toContain(MANIFEST);
  });

  /**
   * PR-B（B3）：后台提取必须与主提示同一套「临时内容」判据。
   *
   * 只改主提示是不够的：主路径不存的临时内容，后台提取下一轮会把它补存回来，
   * 事故只是延后一轮发生。两处断言的锚点字面量刻意与
   * `tests/memory/prompt-injection.test.ts` 的 B1 用例保持一致 ——
   * 只改一边就会有一处变红。
   */
  test("B3：与主提示同一套判据（临时内容 + 显式禁止）", () => {
    const prompt = buildExtractPrompt(MANIFEST);
    expect(prompt).toContain("只在本会话内使用的临时内容");
    expect(prompt).toContain("不要写入记忆");
  });
});

/**
 * P0-1（MD1/MD3）：提取代理不能把「agent 自己的行为」固化成经验。
 *
 * 本缺陷的原始形态是 `feedback_browser_batch_screenshot` 这类条目：内容是 agent
 * 怎么批量截图、按什么顺序跑命令，整条没有一句来自用户。它当时的依据是
 * 「用户没有反对」——而提示词里没有任何一句拦这个。
 *
 * 三条断言的锚点都是**结构性**的（哪一段、哪一条、从什么词开头），不是关键词黑名单：
 * 黑名单挡不住换个说法重写一遍，而「应该保存的四条只能以『用户』开头」能。
 */
describe("buildExtractPrompt — P0-1：不许把 agent 行为写成经验", () => {
  /** 取提示词里某个二级标题下的正文（到下一个二级标题或文末为止） */
  function sectionOf(prompt: string, heading: string): string {
    const start = prompt.indexOf(heading);
    if (start < 0) throw new Error(`提示词里找不到段落: ${heading}`);
    const rest = prompt.slice(start + heading.length);
    const next = rest.indexOf("\n## ");
    return next < 0 ? rest : rest.slice(0, next);
  }

  // T-M1：显式禁止条。
  // 只写「不应该」不够——模型对"没反对 ≠ 要求"这层含义完全没有先验，
  // 必须把这句反例本身写进提示词。
  test("T-M1：明确禁止把本轮操作步骤写成经验，并点破「没反对 ≠ 要求」", () => {
    const prompt = buildExtractPrompt(MANIFEST);
    expect(prompt).toContain("你自己本轮采取的操作步骤");
    expect(prompt).toContain("用户没反对 ≠ 用户要求");
  });

  // T-M2：feedback 必须逐字引用用户原话。
  // 文案锁与 P0-2 的代码闸门是同一个判据的两个落点：只写提示词会漏（模型可以不听），
  // 只写代码会让模型每次都被拒一次（浪费一轮）。两边必须同时存在。
  test("T-M2：feedback 必须带用户原话，禁止「这一次要求」升级成「总是要求」", () => {
    const prompt = buildExtractPrompt(MANIFEST);
    expect(prompt).toContain("必须");
    expect(prompt).toContain("逐字引用用户原话");
    expect(prompt).toContain("用户这一次要求 X");
  });

  // T-M3：正面判据 —— 「应该保存」四条，每条的主语都必须是「用户」。
  // 反向断言（「不出现 agent / 你做了」）是死的：把「用户的长期偏好」改成
  // 「值得复用的做法」既不含 agent 也不含「你做了」，照样过。
  test("T-M3：「应该保存」四条每条都以「用户」开头", () => {
    const section = sectionOf(buildExtractPrompt(MANIFEST), "## 应该保存的内容");
    const bullets = section
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(4);
    for (const bullet of bullets) {
      // 变异「用户的长期偏好 → 值得复用的做法」会在这里变红。
      expect(bullet).toMatch(/^- 用户/);
    }
  });

  // 「用户自己说出来的」这层限定只加在第一条上：它是唯一一条靠「长期」积累的，
  // 也最容易从「用户没反对」被错读成偏好。
  test("T-M3b：第一条带上「必须是用户自己说出来的」限定", () => {
    const section = sectionOf(buildExtractPrompt(MANIFEST), "## 应该保存的内容");
    expect(section).toContain("必须是用户自己说出来的");
  });
});
