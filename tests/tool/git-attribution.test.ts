/**
 * P3-1：可配置 git 归因
 */

import { describe, test, expect } from "bun:test";
import {
  resolveCommitAttribution,
  resolvePrAttribution,
  commitAttributionInstruction,
  prAttributionInstruction,
  DEFAULT_COMMIT_ATTRIBUTION,
  DEFAULT_PR_ATTRIBUTION,
} from "../../src/tool/git-attribution.ts";

describe("P3-1 resolveCommitAttribution", () => {
  test("默认启用返回默认文本", () => {
    expect(resolveCommitAttribution(undefined)).toBe(DEFAULT_COMMIT_ATTRIBUTION);
    expect(resolveCommitAttribution({})).toBe(DEFAULT_COMMIT_ATTRIBUTION);
    expect(resolveCommitAttribution({ commitAttribution: {} })).toBe(DEFAULT_COMMIT_ATTRIBUTION);
  });

  test("enabled=false 返回空串", () => {
    expect(resolveCommitAttribution({ commitAttribution: { enabled: false } })).toBe("");
  });

  test("自定义 text 生效", () => {
    expect(
      resolveCommitAttribution({ commitAttribution: { enabled: true, text: "Co-Authored-By: bot <b@x.com>" } }),
    ).toBe("Co-Authored-By: bot <b@x.com>");
  });

  test("空 text 回退默认", () => {
    expect(resolveCommitAttribution({ commitAttribution: { text: "   " } })).toBe(DEFAULT_COMMIT_ATTRIBUTION);
  });
});

describe("P3-1 resolvePrAttribution", () => {
  test("默认启用返回默认文本", () => {
    expect(resolvePrAttribution(undefined)).toBe(DEFAULT_PR_ATTRIBUTION);
  });
  test("独立可关（关 PR 不影响 commit）", () => {
    const git = { prAttribution: { enabled: false } };
    expect(resolvePrAttribution(git)).toBe("");
    expect(resolveCommitAttribution(git)).toBe(DEFAULT_COMMIT_ATTRIBUTION);
  });
});

describe("P3-1 prompt 指令段", () => {
  test("启用时含归因文本", () => {
    const s = commitAttributionInstruction(undefined);
    expect(s).toContain(DEFAULT_COMMIT_ATTRIBUTION);
  });
  test("关闭时为空串（prompt 不出现归因）", () => {
    expect(commitAttributionInstruction({ commitAttribution: { enabled: false } })).toBe("");
    expect(prAttributionInstruction({ prAttribution: { enabled: false } })).toBe("");
  });
});
