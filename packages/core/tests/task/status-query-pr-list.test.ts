/**
 * P1 / P2：命令表补 `gh pr list` 族 + 归一化抹墙钟时间戳（方案 §4.6 / §4.7，T-P1-* / T-P2-*）。
 *
 * 事故形态（本会话取证）：
 * - 最后 140 条 bash 命令里 128 条 `matchStatusQuery → null`，**全部是 `gh pr list`** ——
 *   命令表只认 `pr checks|view|status`，模型最常用的「一次看一批 PR」写法完全失明；
 * - 剩下能识别的那些又因为首行带 `date` 的 `HH:MM:SS`（无害段放行了 `date`，它产生的
 *   时间戳正文却留着）每轮都算「状态变了」→ P1 全程只拦下 1 次，模型空转 400+ 轮。
 */

import { describe, test, expect } from "bun:test";
import {
  matchStatusQuery,
  normalizeStatusOutput,
} from "@sid-code/core/task/status-query-commands.ts";

describe("P1 gh pr list 族", () => {
  test("T-P1-1 命中，family = gh_pr_list，签名含过滤键", () => {
    const m = matchStatusQuery("gh pr list --state open --json number");
    expect(m).not.toBeNull();
    expect(m!.family).toBe("gh_pr_list");
    // kind 仍是 gh_pr：归一化策略（TSV/JSON）与单个 PR 的查询一致
    expect(m!.kind).toBe("gh_pr");
    // 对象是「一批 PR」而不是某一个 → 前缀必须是 gh:prs:，否则会和 `gh pr view 662` 撞
    expect(m!.subject).toBe("gh:prs:current:open");
    expect(m!.signature).toContain("state=open");
    expect(m!.signature).toContain("json=number");
  });

  test("T-P1-2 --json 字段不同 → 签名不同（输出结构不同，不能共享 memo）", () => {
    const a = matchStatusQuery("gh pr list --state open --json number");
    const b = matchStatusQuery("gh pr list --state open --json number,mergeStateStatus");
    expect(a!.signature).not.toBe(b!.signature);
    // subject 相同：查的是同一批 PR。若把 --json 排除出签名，模型先查 number、
    // 再查 number,mergeStateStatus 会被回执告知「结果与上次相同」——误拦 + 假回执。
    expect(a!.subject).toBe(b!.subject);
  });

  test("T-P1-2b 加 --jq 改变输出内容 → 签名不同", () => {
    const a = matchStatusQuery("gh pr list --state open --json number");
    const b = matchStatusQuery("gh pr list --state open --json number --jq '.[]'");
    expect(a!.signature).not.toBe(b!.signature);
  });

  test("T-P1-3 --state 决定对象集合 → 签名与 subject 都不同", () => {
    const open = matchStatusQuery("gh pr list --state open");
    const merged = matchStatusQuery("gh pr list --state merged");
    expect(open!.signature).not.toBe(merged!.signature);
    expect(open!.subject).toBe("gh:prs:current:open");
    expect(merged!.subject).toBe("gh:prs:current:merged");
  });

  test("T-P1-3b -R/--repo 进 subject（缺省是 current）", () => {
    expect(matchStatusQuery("gh pr list -R owner/other")!.subject).toBe("gh:prs:owner/other:open");
    expect(matchStatusQuery("gh pr list --repo=owner/other --state all")!.subject).toBe(
      "gh:prs:owner/other:all",
    );
    expect(matchStatusQuery("gh pr list")!.subject).toBe("gh:prs:current:open");
  });

  test("T-P1-4 混合命令（gh pr list + gh run list）命中，签名覆盖两段", () => {
    // 修复前：`gh pr list` 段既不无害也不是查询 → 整条 return null（一次都不拦）
    const m = matchStatusQuery(
      "gh pr list --state open --json number | sort -n && gh run list --limit 6",
    );
    expect(m).not.toBeNull();
    expect(m!.signature).toContain("gh pr list");
    expect(m!.signature).toContain("gh run list");
    // 多段命中时 subject 取并集（方案 §4.6 第 5 条）：输出是两段 stdout 的拼接
    expect(m!.subject).toBe("gh:prs:current:open+gh:run:list");
  });

  test("D11 --limit 不参与身份判定：两个 list 命令同口径（subject 相同、签名不同）", () => {
    const pr5 = matchStatusQuery("gh pr list --limit 5 --json number");
    const pr6 = matchStatusQuery("gh pr list --limit 6 --json number");
    expect(pr5!.subject).toBe(pr6!.subject);
    expect(pr5!.signature).not.toBe(pr6!.signature);

    const run5 = matchStatusQuery("gh run list --limit 5");
    const run6 = matchStatusQuery("gh run list --limit 6");
    expect(run5!.subject).toBe("gh:run:list");
    expect(run6!.subject).toBe("gh:run:list");
    expect(run5!.signature).not.toBe(run6!.signature);

    // `--branch` 决定对象集合（不同分支是两个对象），仍进 subject ——
    // 这是 R4 取证会话里的真实写法 `gh run list --branch fix/x --limit 2`
    expect(matchStatusQuery("gh run list --branch fix/x --limit 2")!.subject).toBe(
      "gh:run:list:fix/x",
    );
  });

  test("签名与过滤键书写顺序无关（同义命令共享 memo）", () => {
    const a = matchStatusQuery("gh pr list --state open --json number");
    const b = matchStatusQuery("gh pr list --json number --state open");
    expect(a!.signature).toBe(b!.signature);
  });

  test("安全边界：不认识的 flag（--web 会开浏览器）→ null（表外不拦）", () => {
    expect(matchStatusQuery("gh pr list --web")).toBeNull();
  });

  test("安全边界：gh pr list 后面跟写操作仍然放行", () => {
    expect(matchStatusQuery("gh pr list --state open && gh pr merge 846")).toBeNull();
  });
});

describe("P2 归一化抹墙钟时间戳", () => {
  test("T-P2-1 时分秒不同 → 归一化相等", () => {
    const a = normalizeStatusOutput("gh_pr", "09:16:25\n#846\tBEHIND");
    const b = normalizeStatusOutput("gh_pr", "09:16:33\n#846\tBEHIND");
    expect(a).toBe(b);
  });

  test("T-P2-2 PR 号与状态不被时分规则吞掉（`846:BEHIND` 形态）", () => {
    const text = "846:BEHIND:A 848:BLOCKED:A";
    const a = normalizeStatusOutput("gh_pr", text);
    // 抹过头会把 `846:BEHIND` 也吃了 —— 断言原文仍在
    expect(a).toContain("846:BEHIND");
    expect(a).toContain("848:BLOCKED");
    expect(a).toBe(normalizeStatusOutput("gh_pr", text));

    // 另一半：**行内**的时分（不在行首、不在 `[` 里）不能被无条件抹掉。
    // 它可能是耗时 / 比例 / 计数比（`3:15`），抹掉就把真实变化抹平了。
    // 变异自证就跑这一条：把时分规则放宽成无条件 `\b\d{1,2}:\d{2}\b` 时它变红。
    const inline = normalizeStatusOutput("gh_pr", "elapsed 3:15 pending");
    expect(inline).toContain("3:15");
    expect(inline).toBe("elapsed 3:15 pending");
  });

  test("T-P2-3 ISO 时间戳不同秒 → 归一化相等", () => {
    expect(normalizeStatusOutput("gh_pr", "2026-11-16T01:16:25Z #846 pending")).toBe(
      normalizeStatusOutput("gh_pr", "2026-11-16T01:16:33Z #846 pending"),
    );
    // 带时区偏移的形态
    expect(normalizeStatusOutput("gh_pr", "2026-11-16 01:16:25+08:00 x")).toBe(
      normalizeStatusOutput("gh_pr", "2026-11-16 01:16:33+08:00 x"),
    );
  });

  test("行首 / `[` 之后的裸时分被抹（date +%H:%M 的两种真实形态）", () => {
    expect(normalizeStatusOutput("gh_pr", "09:16\n#846 BEHIND")).toBe(
      normalizeStatusOutput("gh_pr", "09:18\n#846 BEHIND"),
    );
    expect(normalizeStatusOutput("gh_pr", "[09:16] open=3")).toBe(
      normalizeStatusOutput("gh_pr", "[09:18] open=3"),
    );
  });

  test("真实状态变化仍然不等（抹除没有过头）", () => {
    expect(normalizeStatusOutput("gh_pr", "09:16:25\n#846\tBEHIND")).not.toBe(
      normalizeStatusOutput("gh_pr", "09:16:25\n#846\tMERGEABLE"),
    );
    expect(normalizeStatusOutput("gh_pr", "[09:16] open=3")).not.toBe(
      normalizeStatusOutput("gh_pr", "[09:16] open=4"),
    );
  });

  test("耗时 token 与时间戳互不干扰（`13m43s` 仍整体抹掉）", () => {
    expect(normalizeStatusOutput("gh_run", "09:16:25 #1 13m43s done")).toBe(
      normalizeStatusOutput("gh_run", "09:16:33 #1 5m2s done"),
    );
  });
});
