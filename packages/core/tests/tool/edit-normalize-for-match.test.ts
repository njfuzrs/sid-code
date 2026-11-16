/**
 * T1：edit 字形归一化扩表 + 归一化歧义检查。
 *
 * 为什么需要这层测试：`normalizeForMatch` 的字符表从「只映射弯引号」扩到
 * 「破折号 / Unicode 空格 / 全角 ASCII」，扩表本身只是让更多 old_string 能命中，
 * 但**归一化是多对一的**（`—`/`–`/`-` 都归一成 `-`），不同原文撞车时旧实现
 * 只按 `indexOf` 的第一处替换，另一处会被无声漏掉。所以本文件分两半：
 *
 * - 命中侧：每一类字形变体都能命中（表里有的类各一条，防「加了表却忘了接进路径」）；
 * - 歧义侧：撞车时必须报错或全替换，不许静默只改一处。
 *
 * 1:1 长度不变量用**固定边界样例**（`…`、连字、emoji、组合字符）而不是随机串：
 * 随机串几乎不可能命中 NFKC 类变长缺陷，那种断言是恒绿的假门禁。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  EditTool,
  normalizeForMatch,
  MATCH_NORMALIZE_GROUPS,
  setEditMatchSink,
} from "@sid-code/core/tool/edit.ts";
import { FileReadTracker } from "@sid-code/core/tool/file-read-tracker.ts";

const TMP = join(os.tmpdir(), "sid-code-edit-normalize-for-match-test");

const created: string[] = [];

function writeFixture(name: string, content: string): string {
  const file = join(TMP, name);
  writeFileSync(file, content);
  created.push(file);
  return file;
}

function readBack(file: string): string {
  return readFileSync(file, "utf8");
}

beforeEach(() => {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  for (const f of created) {
    try {
      unlinkSync(f);
    } catch {
      /* 忽略 */
    }
  }
  created.length = 0;
  setEditMatchSink(null);
});

// ─── 命中侧：每类字形变体 ────────────────────────────────────────────────────

describe("归一化扩表：每类字形变体都能命中", () => {
  test("弯引号（原有行为保持）：文件是弯引号，old_string 写直引号", async () => {
    const file = writeFixture("curly.ts", "const s = “inherit”;\n");
    const r = await new EditTool().execute({
      file_path: file,
      old_string: 'const s = "inherit";',
      new_string: 'const s = "x";',
    });
    expect(r.isError).toBeFalsy();
    expect(readBack(file)).toBe('const s = "x";\n');
    expect(r.output).toContain("归一化匹配");
  });

  test("破折号：文件是长破折号，old_string 写半角连字符", async () => {
    const file = writeFixture("dash.ts", "const range = 1—2;\n");
    const r = await new EditTool().execute({
      file_path: file,
      old_string: "const range = 1-2;",
      new_string: "const range = 1-3;",
    });
    expect(r.isError).toBeFalsy();
    expect(readBack(file)).toBe("const range = 1-3;\n");
  });

  test("Unicode 空格：文件是不间断空格，old_string 写普通空格", async () => {
    const file = writeFixture("nbsp.ts", "const a\u00A0= 1;\n");
    const r = await new EditTool().execute({
      file_path: file,
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });
    expect(r.isError).toBeFalsy();
    expect(readBack(file)).toBe("const a = 2;\n");
  });

  test("全角 ASCII：文件是全角冒号/括号，old_string 写半角", async () => {
    const file = writeFixture("fullwidth.ts", "注意（重要）请读：第一行\n");
    const r = await new EditTool().execute({
      file_path: file,
      old_string: "注意(重要)请读:第一行",
      new_string: "注意(重要)请读:第二行",
    });
    expect(r.isError).toBeFalsy();
    expect(readBack(file)).toBe("注意(重要)请读:第二行\n");
  });
});

// ─── 1:1 长度不变量 ──────────────────────────────────────────────────────────

describe("归一化 1:1 长度不变量", () => {
  test("表内每条 key 与映射目标都是单字符（下标可直接映射回原文的前提）", () => {
    expect(MATCH_NORMALIZE_GROUPS.length).toBeGreaterThan(0);
    for (const group of MATCH_NORMALIZE_GROUPS) {
      expect(group.chars.length).toBe(group.mapTo.length);
      for (const ch of group.chars) expect(ch.length).toBe(1);
      for (const ch of group.mapTo) expect(ch.length).toBe(1);
    }
  });

  test("固定边界样例归一化前后长度相同（NFKC 会变长的字符必须原样保留）", () => {
    // `…` 被 NFKC 拆成 `...`、`ﬁ` 被拆成 `fi`、emoji 是代理对、`e\u0301` 是组合字符。
    // 这条断言的作用是挡住「图省事换成 NFKC」的实现。
    const samples = ["…", "ﬁ", "🙂", "é", "e\u0301", "\u201C\u2014\u3000\uFF01", "a\r\nb"];
    for (const s of samples) {
      expect(normalizeForMatch(s).length).toBe(s.length);
    }
  });

  test("表外字符不被改写：省略号 / 连字 / emoji / 组合字符原样返回", () => {
    const s = "…ﬁ🙂e\u0301";
    expect(normalizeForMatch(s)).toBe(s);
  });
});

// ─── 歧义侧：不同原文归一后撞车 ──────────────────────────────────────────────

describe("归一化歧义：不同原文归一后撞车", () => {
  test("两处原文不同 + replace_all=false → 报错且不改文件", async () => {
    const file = writeFixture("ambiguous.ts", "const a = 1—2;\nconst b = 1-2;\n");
    const before = readBack(file);
    const r = await new EditTool().execute({
      file_path: file,
      old_string: "1–2", // en dash：归一化后同时命中 `1—2` 与 `1-2`
      new_string: "x",
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("2 种不同的原文写法");
    expect(r.output).toContain("replace_all=true");
    // 文案不能复用「模糊匹配歧义」：old_string 字形上是准的，该建议的是 replace_all / 补上下文
    expect(r.output).not.toContain("模糊匹配歧义");
    expect(readBack(file)).toBe(before);
  });

  test("多处字面完全相同 + replace_all=false → 仍报「找到 N 处匹配」（不能误报成歧义）", async () => {
    const file = writeFixture("same-twice.ts", 'a "foo" b\nc "foo" d\n');
    const r = await new EditTool().execute({
      file_path: file,
      old_string: "“foo”",
      new_string: "“bar”",
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("找到 2 处匹配");
    expect(r.output).not.toContain("不同的原文写法");
  });

  test("多处字面完全相同 + replace_all=true → 全部替换", async () => {
    const file = writeFixture("same-all.ts", 'a "foo" b\nc "foo" d\n');
    const r = await new EditTool().execute({
      file_path: file,
      old_string: "“foo”",
      new_string: '"bar"',
      replace_all: true,
    });
    expect(r.isError).toBeFalsy();
    expect(readBack(file)).toBe('a "bar" b\nc "bar" d\n');
  });

  test("两处原文不同 + replace_all=true → 全部替换（不许只换一种形态）", async () => {
    // 文档 §T1 风险第 2 条的实跑反例：旧实现返回 `x_zy and x-y`（只换 1 处）且不报错。
    const file = writeFixture("variant-all.ts", "x—y and x-y\n");
    const r = await new EditTool().execute({
      file_path: file,
      old_string: "x–y",
      new_string: "x_z",
      replace_all: true,
    });
    expect(r.isError).toBeFalsy();
    expect(readBack(file)).toBe("x_z and x_z\n");
    expect(r.output).toContain("替换了 2 处");
  });

  test("未读文件 + 归一化歧义：报歧义（normalized 与 exact 同权放行），且不回显文件片段", async () => {
    const tracker = new FileReadTracker();
    const tool = new EditTool(tracker);
    const file = writeFixture("unread-ambiguous.ts", "x—y and x-y\n");
    const r = await tool.execute({
      file_path: file,
      old_string: "x–y",
      new_string: "x_z",
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("2 种不同的原文写法");
    // 未读文件不该借报错把文件内容回显出来
    expect(r.output).not.toContain("文件里命中的");
  });
});

// ─── 事件与已知缺口 ──────────────────────────────────────────────────────────

describe("扩表后的可观测性与已知缺口", () => {
  test("扩表后的命中仍发 EditLenientMatch{strategy=normalized}", async () => {
    const events: Array<Record<string, unknown>> = [];
    setEditMatchSink((d) => events.push(d));
    const file = writeFixture("event-dash.ts", "const range = 1—2;\n");
    const r = await new EditTool().execute({
      file_path: file,
      old_string: "const range = 1-2;",
      new_string: "const range = 1-3;",
    });
    expect(r.isError).toBeFalsy();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      strategy: "normalized",
      file_ext: "ts",
      occurrences: 1,
      match_start_line: 1,
      match_end_line: 1,
    });
  });

  // ⚠️ 这是 T1 的**已知缺口**，不是期望行为：归一化命中后写入的是模型给的 new_string 原文，
  // 所以文件里的中文全角标点会被半角化（文档 §T1 风险第 3 条实跑复现）。
  // T2「归一化命中后保留原风格」落地后，这条断言要反过来——改成断言仍是全角。
  test("已知缺口（T2 才修）：全角标点命中后写入模型的半角 new_string", async () => {
    const file = writeFixture("fullwidth-side-effect.ts", "后端返回错误：文件过大\n");
    const r = await new EditTool().execute({
      file_path: file,
      old_string: "错误:文件过大",
      new_string: "错误!文件过大",
    });
    expect(r.isError).toBeFalsy();
    expect(readBack(file)).toBe("后端返回错误!文件过大\n");
  });
});
