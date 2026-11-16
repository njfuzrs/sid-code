/**
 * 06H1 T6 —— 回程侧「由你自己综合」引导的门禁
 *
 * 对应 `docs/bugfixes/todo/20261115-06H1-剩余T4T6T7-落地方案.md` 的 T6。
 *
 * 事故形态：父代理拿到子代理结果后，把「按上面的发现去修」整个再派给下一个 task
 * 子代理——理解与判断也被外包。下一个子代理拿不到父代理手上的其它结果，父代理也
 * 失去了判断改得对不对的依据。
 *
 * 为什么只有一条（方案原定两条）：方案里同批要求的「引用子代理给的 `文件:行号` 做
 * 修改前先自己读那一处」，被前置抽样否掉了 —— 本地 194 条可判定的子代理结果里，
 * 160 条（82%）父代理自己去读了原文，**0 条「不读就改」**（3 条初判经人工核验为
 * 文件名子串误判）。核验已在自发发生，再加一条只会白增 read 调用，方案原文的判读
 * 规则是「核验占比已经很高，则只加第一条」。
 *
 * 文案是唯一能立门禁的落点：此处断言「判据供给存在」，不测模型行为。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import type { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";

// usageGuide() 不触碰 providerRegistry，用最小 stub 即可（与 subagent-divide-criteria 同法）
const tool = new SubAgentTool({} as unknown as ProviderRegistry, new ToolRegistry());

describe("06H1 T6 · sub_agent usageGuide 含回程综合指引", () => {
  test("要求多个子代理结果由父代理自己综合", () => {
    const guide = tool.usageGuide();
    expect(guide).toContain("由你自己综合");
  });

  test("禁止把「按发现去修」再派一个子代理（理解不许外包）", () => {
    const guide = tool.usageGuide();
    expect(guide).toContain("按发现去修");
    expect(guide).toContain("再派出去");
    // 区分「派执行」与「派综合」——只禁后者，不能读成「不许再派 task 子代理」
    expect(guide).toContain("执行");
    expect(guide).toContain("综合");
  });

  test("嵌套限制仍在新条目之后（新增不能挤掉末尾判据）", () => {
    const guide = tool.usageGuide();
    const synthesis = guide.indexOf("由你自己综合");
    const nesting = guide.indexOf("嵌套限制");
    expect(synthesis).toBeGreaterThan(-1);
    expect(nesting).toBeGreaterThan(synthesis);
  });

  test("不包含被抽样否掉的「先自己读那一处」第二条（避免重复喂 read 预算）", () => {
    // 若将来数据表明「不读就改」真的发生，再加这条并更新本断言与方案文档的判据。
    const guide = tool.usageGuide();
    expect(guide).not.toContain("动手修改前先自己读");
  });
});
