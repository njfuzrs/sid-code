/**
 * §3「拒绝器比提取器重要」写入闸门回归（2026-10-24）
 *
 * 每一组对应一条本机轨迹 / 磁盘实测到的缺陷，用例输入取自真实失败形态：
 *
 * | 组 | 缺陷 | 本机基线 |
 * | --- | --- | --- |
 * | A | 类型靠关键词猜：正文提「文档」即 reference | 磁盘 202 条 reference 里 172 条无 URL |
 * | B | save_memory 无 type 参数 → 模型把类型塞进 scope | 遥测 28 次 scope_denied 中 20 次 |
 * | C | Why 检测命中疑问词「为什么」 | 磁盘 39 条缺 Why 行，18 条逃过提示 |
 * | D | 相对日期不认星期 | §3.4 原例「周四冻结合并」0 条提示 |
 * | E | team / agent scope 不走写入提示 | 两条路径无格式闸 |
 * | F | 写入质量无埋点 | 只能离线回读 raw.jsonl |
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryTool, memoryWriteHints, assessMemoryWrite } from "@sid-code/core/tool/memory.ts";
import { MemoryStore, inferMemoryType } from "@sid-code/core/memory/store.ts";
import { createExtractPermissions } from "@sid-code/core/memory/extract/permissions.ts";
import {
  attachAnalyticsSink,
  __resetAnalyticsForTest,
  type EventMetadata,
} from "@sid-code/core/analytics/index.ts";
import { EVENT_NAMES } from "@sid-code/core/analytics/events.ts";

let tmpHome: string;
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-wq-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  __resetAnalyticsForTest();
});

afterEach(async () => {
  // 落盘与埋点可能走微任务，先排空再恢复 env（CONTRIBUTING 测试约定第 2 条）
  await new Promise((r) => setTimeout(r, 0));
  __resetAnalyticsForTest();
  if (prevEnv === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevEnv;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
});

function capture(): Array<{ name: string; meta: EventMetadata }> {
  const seen: Array<{ name: string; meta: EventMetadata }> = [];
  attachAnalyticsSink({ logEvent: (name, meta) => seen.push({ name, meta }) });
  return seen;
}

describe("A · inferMemoryType 不再因普通名词判 reference", () => {
  test("正文提到「文档」的约定 → 不是 reference", () => {
    expect(inferMemoryType("edit_docs_feedback", "改完代码别忘了同步更新官网文档")).not.toBe(
      "reference",
    );
  });

  test("本机真实误判样本：正文只有本地路径、没有 URL → 不是 reference", () => {
    expect(
      inferMemoryType(
        "worktree-node-modules-symlink-to-main-repo",
        "sid-code 用 enter_worktree 建的 worktree 根目录 node_modules 是指向主仓的软链",
      ),
    ).not.toBe("reference");
  });

  test("真 URL 仍判 reference", () => {
    expect(inferMemoryType("latency", "延迟看板 https://grafana.internal/d/api")).toBe("reference");
  });

  test("key 点名外部系统仍判 reference", () => {
    expect(inferMemoryType("oncall_dashboard", "值班先看这个")).toBe("reference");
  });
});

describe("B · type 显式参数 + scope 类型混淆单独归类", () => {
  test("缺 type → 拒绝，且不退回关键词猜测", async () => {
    const tool = new MemoryTool(new MemoryStore(tmpHome));
    const r = await tool.execute({ key: "k", value: "以后都不要 mock" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("type");
  });

  test("显式 type 决定落盘类型，即使正文命中别的关键词", async () => {
    const store = new MemoryStore(tmpHome);
    const tool = new MemoryTool(store);
    await tool.execute({
      key: "docs_sync",
      value: "改完代码同步更新官网文档\nWhy: 文档漂移\nHow to apply: 每个 PR",
      type: "feedback",
    });
    expect((await store.get("docs_sync"))?.type).toBe("feedback");
  });

  test("后台代理把类型填进 scope → scope_type_confusion，提示里给出改法", async () => {
    const seen = capture();
    const perms = createExtractPermissions(join(tmpHome, "mem"));
    const r = await perms("save_memory", { key: "k", value: "v", scope: "feedback" });
    expect(r.behavior).toBe("deny");
    expect(r.behavior === "deny" && r.message).toContain('type="feedback"');
    const g = seen.find((e) => e.name === EVENT_NAMES.MEMORY_GUARD);
    expect(g?.meta.guard_kind).toBe("scope_type_confusion" as any);
  });

  test("真越权（global）仍记 scope_denied，两类不混", async () => {
    const seen = capture();
    const perms = createExtractPermissions(join(tmpHome, "mem"));
    await perms("save_memory", { key: "k", value: "v", scope: "global" });
    const g = seen.find((e) => e.name === EVENT_NAMES.MEMORY_GUARD);
    expect(g?.meta.guard_kind).toBe("scope_denied" as any);
  });
});

describe("C · Why / How 必须是标签而非疑问词", () => {
  test("正文只有「为什么」疑问词 → 仍提示缺 Why", () => {
    const h = memoryWriteHints("分支策略为什么用 GitHub Flow 我也说不清，以后都这样", "feedback");
    expect(h.some((x) => x.includes("Why:"))).toBe(true);
  });

  test("有 Why 缺 How to apply → 提示缺 How", () => {
    const h = memoryWriteHints("不要 mock 数据库\nWhy: 迁移事故", "feedback");
    expect(h.some((x) => x.includes("How to apply:"))).toBe(true);
    expect(h.some((x) => x.includes("Why: 与"))).toBe(false);
  });

  test("**Why:** 粗体写法与单行句读写法都认", () => {
    expect(assessMemoryWrite("k", "规则\n**Why:** 原因\n**How to apply:** 场景").hasWhy).toBe(true);
    expect(assessMemoryWrite("k", "规则。Why: 原因。How to apply: 场景").hasHow).toBe(true);
  });

  test("标签后为空不算", () => {
    expect(assessMemoryWrite("k", "规则\nWhy:\n").hasWhy).toBe(false);
  });
});

describe("D · 相对日期覆盖星期", () => {
  test.each(["周四冻结非关键合并", "星期五发版", "Merge freeze starts Thursday", "下周一前交付"])(
    "%s → 提示改绝对日期",
    (v) => {
      expect(memoryWriteHints(v, "user").some((x) => x.includes("绝对日期"))).toBe(true);
    },
  );

  test("「周报」「每周」不误报为相对日期", () => {
    expect(assessMemoryWrite("k", "每周写周报").relativeDate).toBeNull();
  });
});

describe("E · 四个 scope 同一套写入提示", () => {
  test("agent scope 缺 Why 也会回提示", async () => {
    const tool = new MemoryTool(new MemoryStore(tmpHome), "code-review");
    const r = await tool.execute({
      key: "review_gotcha",
      value: "评审时先看测试",
      type: "feedback",
      scope: "agent",
    });
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("写入质量提示");
  });

  test("reference 无 URL → 提示改类型", () => {
    const h = memoryWriteHints("登录方案在 docs-research/xxx.md", "reference");
    expect(h.some((x) => x.includes("没有 URL"))).toBe(true);
  });

  test("进度快照形态 → 提示只留洞察", () => {
    const h = memoryWriteHints(
      "截至 2026-10-14：PR-2 已合入",
      "project",
      "login_closure_pr_status",
    );
    expect(h.some((x) => x.includes("快照"))).toBe(true);
  });
});

describe("F · memory_write 埋点", () => {
  test("写入成功发一条，字段是枚举/布尔，不含 key 与内容", async () => {
    const seen = capture();
    const tool = new MemoryTool(new MemoryStore(tmpHome));
    await tool.execute({
      key: "secret_project_name",
      value: "分支策略为什么这样我也说不清",
      type: "project",
      _agentId: "forked-agent",
    });
    const w = seen.filter((e) => e.name === EVENT_NAMES.MEMORY_WRITE);
    expect(w.length).toBe(1);
    const m = w[0]!.meta;
    expect(m.memory_type).toBe("project" as any);
    expect(m.memory_scope).toBe("project" as any);
    expect(m.write_via).toBe("forked" as any);
    expect(m.missing_why).toBe(true);
    expect(m.missing_how).toBe(true);
    expect(m.hint_count).toBeGreaterThan(0);
    const flat = JSON.stringify(m);
    expect(flat).not.toContain("secret_project_name");
    expect(flat).not.toContain("分支策略");
  });

  test("被 secret 闸门拒绝的写入不发 memory_write（分母只算真落盘）", async () => {
    const seen = capture();
    const tool = new MemoryTool(new MemoryStore(tmpHome));
    await tool.execute({
      key: "t",
      value: "token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      type: "reference",
    });
    expect(seen.some((e) => e.name === EVENT_NAMES.MEMORY_WRITE)).toBe(false);
  });
});
