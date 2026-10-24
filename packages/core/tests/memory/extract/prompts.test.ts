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
});
