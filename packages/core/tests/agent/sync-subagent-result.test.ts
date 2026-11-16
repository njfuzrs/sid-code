/**
 * T4（06H1）：同步回程向后台看齐 —— 超长结论截断 + 全文落盘。
 *
 * 三条判据对应方案里的「上限、提示和指引一致」：
 *  1. 不超上限：全文进 `<subagent-result>`，**不出现** `<output-file>`
 *     （全文已经在窗口里，再给一个文件指针只是噪音，还会让模型以为结论被截断过）；
 *  2. 超上限：正文按后台同一上限（16,000 字符）截断、带「已截断」提示、给出 `<output-file>`；
 *  3. 那个文件里是**完整原文** —— 否则提示词里「用 read(<output-file>) 拉全文」就是骗人。
 *
 * 隔离：`buildSyncSubagentSummary` 会经 `persistLargeOutput` 写
 * `sidPaths.trajectories()`，按 CONTRIBUTING 的硬约定必须显式把 `SID_CONFIG_DIR`
 * 指到 tmpdir 并 `assertIsolated()`，不依赖 bunfig 的 preload 兜底。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyncSubagentSummary } from "../../src/agent/tool.ts";
import { NOTIFICATION_OUTPUT_MAX_CHARS } from "../../src/task/notification.ts";
import { buildSubagentResultBoundarySectionEn } from "../../src/config/prompt-sections-en.ts";
import { buildSystemPrompt, clearPromptCache } from "../../src/config/system-prompt.ts";
import { assertIsolated } from "../helpers/assert-isolated.ts";

let tmpHome = "";
let savedConfigDir: string | undefined;

beforeEach(() => {
  savedConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-sync-subagent-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  assertIsolated();
  clearPromptCache();
});

afterEach(() => {
  // 存/恢复原值而不是无条件 delete：bun test 同批多文件跑在同一进程，
  // 直接删会把 preload 的兜底一起抹掉（CONTRIBUTING 的测试隔离约定第 1 条）。
  if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
  clearPromptCache();
});

function makeResult(output: string) {
  return {
    success: true,
    output,
    usage: { inputTokens: 11, outputTokens: 22 },
    turns: 2,
    toolUseCount: 3,
  };
}

function outputFileOf(summary: string): string | undefined {
  return /<output-file>(.+?)<\/output-file>/.exec(summary)?.[1];
}

describe("buildSyncSubagentSummary — 不超上限", () => {
  test("全文进 <subagent-result>，且不出现 <output-file>", () => {
    const output = "短结论：3 个文件已改完。";
    const summary = buildSyncSubagentSummary({
      type: "explore",
      result: makeResult(output),
      sessionId: "s1",
      toolUseId: "toolu_abc123",
    });

    expect(summary).toContain("[子代理完成] 类型: explore, 轮次: 2");
    expect(summary).toContain("Token 用量: input=11, output=22");
    expect(summary).toContain(`<subagent-result untrusted="true">\n${output}\n</subagent-result>`);
    // 不落盘：没有文件指针，也不该真的写文件
    expect(outputFileOf(summary)).toBeUndefined();
    expect(existsSync(join(tmpHome, "trajectories"))).toBe(false);
  });

  test("恰好等于上限（16,000 码点）不截断、不落盘", () => {
    const output = "a".repeat(NOTIFICATION_OUTPUT_MAX_CHARS);
    const summary = buildSyncSubagentSummary({
      type: "general-purpose",
      result: makeResult(output),
    });

    expect(outputFileOf(summary)).toBeUndefined();
    expect(summary).not.toContain("[输出过长，已截断");
    expect(summary).toContain(output);
  });
});

describe("buildSyncSubagentSummary — 超过上限", () => {
  /** 头部标记 + 中部填充 + 尾部落款：断言「头在、尾不在窗口、尾在文件里」 */
  const HEAD = "SYNC-HEAD：逐条结论从这里开始。";
  const TAIL = "SYNC-TAIL：最后一条结论（只有完整文件里才有）。";
  const longOutput = `${HEAD}\n${"x".repeat(NOTIFICATION_OUTPUT_MAX_CHARS)}\n${TAIL}`;

  test("截断到 16,000 字符并带截断提示", () => {
    const summary = buildSyncSubagentSummary({
      type: "general-purpose",
      result: makeResult(longOutput),
      sessionId: "s1",
      toolUseId: "toolu_abc123",
    });

    const omitted = Array.from(longOutput).length - NOTIFICATION_OUTPUT_MAX_CHARS;
    expect(summary).toContain(HEAD);
    // 尾部标记只出现在截断提示之后的文件里，不该落进窗口
    expect(summary).not.toContain(TAIL);
    expect(summary).toContain(`[输出过长，已截断 ${omitted} 字符。完整内容见 `);
  });

  test("给出 <output-file>，且文件里是完整原文", () => {
    const summary = buildSyncSubagentSummary({
      type: "general-purpose",
      result: makeResult(longOutput),
      sessionId: "s1",
      toolUseId: "toolu_abc123",
    });

    const outputFile = outputFileOf(summary);
    expect(outputFile).toBeDefined();
    // 落盘必须在隔离目录内，不能写真实 ~/.sid-code
    expect(outputFile!.startsWith(join(tmpHome, "trajectories"))).toBe(true);
    expect(readFileSync(outputFile!, "utf-8")).toBe(longOutput);

    // 文件指针出现在 <subagent-result> 之前：模型先看到「有全文」，再读截断正文
    expect(summary.indexOf("<output-file>")).toBeLessThan(summary.indexOf("<subagent-result"));
  });

  test("截断提示里的路径与 <output-file> 一致（模型读得到的那一份就是它）", () => {
    const summary = buildSyncSubagentSummary({
      type: "general-purpose",
      result: makeResult(longOutput),
      sessionId: "s1",
      toolUseId: "toolu_abc123",
    });

    const outputFile = outputFileOf(summary)!;
    expect(summary).toContain(`完整内容见 ${outputFile}]`);
  });
});

describe("提示词：同步回程与后台同一套说法", () => {
  /** 只造 sub_agent 一个工具，触发 <subagent-result-policy> 注入（其余段落不影响断言）。 */
  function promptWithSubAgent(language?: "zh" | "en"): string {
    const fakeTool = {
      name: () => "sub_agent",
      description: () => "派子代理执行子任务",
      inputSchema: () => ({ type: "object", properties: {} }),
      execute: async () => ({ output: "" }),
      readOnly: () => true,
    };
    return buildSystemPrompt({ tools: [fakeTool as never], preferredLanguage: language });
  }

  test("中文段并列写出 <task-notification> 与 <subagent-result> 两种回传形态", () => {
    const prompt = promptWithSubAgent("zh");
    expect(prompt).toContain("<subagent-result-policy>");
    expect(prompt).toContain("走 <task-notification>");
    expect(prompt).toContain("<subagent-result>");
    // 同步结果的上限与后台一致，且指向文件
    expect(prompt).toContain("不超过 16,000 字符时就是全文");
    expect(prompt).toContain("超过时按与后台相同的上限截断");
  });

  test("英文段同步更新（同一判据，不留只讲 task-notification 的旧文案）", () => {
    const section = buildSubagentResultBoundarySectionEn();
    expect(section).toContain("<subagent-result>");
    expect(section).toContain("at most 16,000 characters");
    expect(section).toContain("<output-file>");
    // 旧文案把回传形态写死成 task-notification，是这次要修的错误前提
    expect(section).not.toContain("comes back into your context as a `<task-notification>`.");
  });
});
