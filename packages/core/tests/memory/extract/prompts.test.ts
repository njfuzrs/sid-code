/**
 * 后台提取提示词测试（§2 team scope 保守分流）
 *
 * 聚焦：teamMemoryEnabled 开关是否正确控制 team scope 分流指引的注入，
 * 以及分流指引是否体现"比 claude-code 更保守（存疑走私有）"的门槛。
 */

import { describe, test, expect } from "bun:test";
import { buildExtractPrompt } from "@sid-code/core/memory/extract/prompts.ts";

const MANIFEST = "- [project] foo.md (2026-01-01): 示例";

describe("buildExtractPrompt — team scope 分流", () => {
  test("默认（未启用团队记忆）不注入 team scope 指引", () => {
    const prompt = buildExtractPrompt(MANIFEST);
    expect(prompt).not.toContain("scope=team");
    expect(prompt).not.toContain("记忆范围（scope）分流");
  });

  test("teamMemoryEnabled=false 显式传入也不注入", () => {
    const prompt = buildExtractPrompt(MANIFEST, false);
    expect(prompt).not.toContain("scope=team");
  });

  test("teamMemoryEnabled=true 注入 team scope 分流指引", () => {
    const prompt = buildExtractPrompt(MANIFEST, true);
    expect(prompt).toContain("记忆范围（scope）分流");
    expect(prompt).toContain("scope=team");
  });

  test("team scope 指引体现保守门槛：存疑走私有、user 类永远私有", () => {
    const prompt = buildExtractPrompt(MANIFEST, true);
    // 保守：存疑走私有
    expect(prompt).toContain("存疑");
    expect(prompt).toContain("保存为私有");
    // user 类永远私有
    expect(prompt).toContain("永远私有");
    // 不写 secret 到 team
    expect(prompt).toContain("secret");
  });

  test("现有记忆清单始终注入（不受 team 开关影响）", () => {
    expect(buildExtractPrompt(MANIFEST)).toContain(MANIFEST);
    expect(buildExtractPrompt(MANIFEST, true)).toContain(MANIFEST);
  });
});
