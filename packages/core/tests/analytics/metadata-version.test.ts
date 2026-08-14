// 事件版本维度回归测试
//
// 背景：`metadata.ts` 里曾有一个局部 `getVersion()` 遮蔽了
// `@sid-code/shared/version.ts` 的同名导出，实现是
// `process.env.SID_CODE_VERSION ?? "dev"`。该 env 全仓只有安装脚本在读，
// 运行时无人设置 —— 于是每个发布版本的每条事件 `_ctx_version` 都是 `"dev"`
// （实测本机 3658 条事件无一例外）。
//
// 这类故障为什么必须靠测试锁住：字段存在、非空、类型正确，
// **只有值是废的**。没有任何常规断言会红，而版本维度是
// release-over-release 趋势的唯一分组键，值恒定即所有趋势退化成快照。
// 所以下面断言的不是"有这个字段"，而是**它的值随版本变化且不是占位符**。

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { getEventMetadataFields, __resetMetadataForTest } from "../../src/analytics/metadata.ts";
import { getRawVersion } from "@sid-code/shared/version.ts";

describe("事件元数据 · 版本维度", () => {
  const originalEnv = process.env.SID_CODE_VERSION;

  beforeEach(() => {
    // 必须存/恢复原值而非无条件 delete：bun test 同批多文件跑在同一进程里
    delete process.env.SID_CODE_VERSION;
    __resetMetadataForTest();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SID_CODE_VERSION;
    else process.env.SID_CODE_VERSION = originalEnv;
    __resetMetadataForTest();
  });

  test("_ctx_version 缺省取 package.json 真实版本号，不是 'dev' 占位符", () => {
    // 用 String() 剥掉 EventMetadataValue 的 brand 再比对，否则字面量与
    // branded 类型不兼容（值相等但 tsc 报 2769）
    const actual = String(getEventMetadataFields()._ctx_version);
    // 核心断言：这个值曾经恒为 "dev"，那正是 bug 本身
    expect(actual).not.toBe("dev");
    expect(actual).toBe(getRawVersion());
  });

  test("_ctx_version 是裸 x.y.z，不带 'sid-code v' 前缀或 '(TypeScript)' 后缀", () => {
    // 取 getRawVersion 而非 getVersion 是刻意的：带前后缀的字符串当分组键
    // 会让下游每次都要剥壳，且容易因措辞变动而把同一版本拆成两组
    const v = String(getEventMetadataFields()._ctx_version);
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    expect(v).not.toContain("sid-code");
    expect(v).not.toContain("TypeScript");
  });

  test("SID_CODE_VERSION 仍可覆盖（灰度/回放时手动打标）", () => {
    process.env.SID_CODE_VERSION = "9.9.9-canary";
    __resetMetadataForTest();
    expect(String(getEventMetadataFields()._ctx_version)).toBe("9.9.9-canary");
  });

  test("版本维度可用作分组键：同一进程内多次取值稳定", () => {
    // 趋势分析要求同一 release 内的事件归到同一组，值必须稳定
    const a = getEventMetadataFields()._ctx_version;
    const b = getEventMetadataFields()._ctx_version;
    expect(a).toBe(b);
  });
});
