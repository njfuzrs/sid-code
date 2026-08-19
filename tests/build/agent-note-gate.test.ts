/**
 * Agent Note 形态门禁的自证测试（P1-4，2026-08-19）。
 *
 * ## 为什么门禁自己需要测试
 *
 * CLAUDE.md 有一条踩出来的铁律：**新增门禁必做变异自证**。一个恒绿的门禁比没有门禁更危险 ——
 * 它会让人以为有保护。本仓已经有过实例：`static-scan-misses-indirect-disk-writes`
 * （静态扫描抓不到间接落盘）、`s2-cooldown-clear-test-is-false-gate`（等满冷却→自然过期，
 * 删掉被测代码仍恒绿）。
 *
 * 所以这里的重点不是"合规样本能过"（那只证明它没瞎报），而是**每一类违规都真的被抓到**。
 * 下面每组 `expect(...).not.toHaveLength(0)` 就是一次变异：拿一份合规 Note，
 * 只破坏一个维度，断言校验器报红。
 *
 * ## 第二组断言治的是另一个病灶：建好未接线
 *
 * 脚本写好了、hook 没挂 → 门禁一次都不触发，且没有任何信号。
 * 见 `harness-defenses-built-but-zero-triggered`（代码全在但调用全 0）。
 * 所以另一组断言直接读 `pre-commit.sh` 与 `package.json`，确认接线存在。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLASSES,
  LIFECYCLES,
  REQUIRED_SECTIONS,
  checkNote,
} from "../../scripts/verify-agent-note.ts";

const ROOT = join(import.meta.dir, "../..");
const NOTES_DIR = join(ROOT, ".agents/notes");

/** 一份形态完全合规的 Note，作为全部变异的基准。 */
const GOOD_PATH = "notes/implemented/process/2026-08-19-示例决策.md";
const GOOD_TEXT = `---
Status: implemented
Date: 2026-08-19
---
# 示例决策

## 决定了什么

改了 A，让 B 成立。

## 放弃了什么（以及为什么不选）

放弃 C，因为实测 D。

## 拿什么证明它生效了

跑了 \`bun test\`，看到 E。
`;

describe("Agent Note 校验器：合规样本不瞎报", () => {
  test("基准样本零违规（否则后面每一条变异断言都失去意义）", () => {
    expect(checkNote(GOOD_PATH, GOOD_TEXT)).toEqual([]);
  });

  test("仓库里已入库的 Note 全部合规", () => {
    // 这一条是"仓库当前状态"的守卫：任何人新增一份不合规的 Note，
    // 即使他跳过了 pre-commit（--no-verify），也会在 CI 的 bun test 上被拦住。
    const files = new Bun.Glob("**/*.md").scanSync({ cwd: NOTES_DIR, absolute: false });
    const violations: string[] = [];
    let checked = 0;
    for (const rel of files) {
      const base = rel.split("/").pop() ?? "";
      if (base === "README.md" || base.startsWith("_")) continue; // 说明页与模板不是 Note 本体
      checked += 1;
      const text = readFileSync(join(NOTES_DIR, rel), "utf8");
      violations.push(...checkNote(`notes/${rel}`, text).map((v) => `${v.file}: ${v.reason}`));
    }
    expect(violations).toEqual([]);
    // 分母也断一下：迁移的 6 份否决记录 + 2 份实施记录（本机制本身 + 顺带修的安装器 bug）。
    // 数字只降不升是有意义的信号（有人删了 Note），所以用 >=。
    expect(checked).toBeGreaterThanOrEqual(8);
  });
});

describe("Agent Note 校验器：变异自证（每类违规都必须报红）", () => {
  const mutate = (path: string, text: string) => checkNote(path, text);

  test("路径不合形态 → 报红", () => {
    expect(mutate("notes/随手写的决策.md", GOOD_TEXT)).not.toHaveLength(0);
    expect(mutate("notes/implemented/2026-08-19-缺了class层.md", GOOD_TEXT)).not.toHaveLength(0);
    expect(mutate("notes/implemented/process/没有日期前缀.md", GOOD_TEXT)).not.toHaveLength(0);
  });

  test("lifecycle 不在闭集内 → 报红", () => {
    const v = mutate("notes/done/process/2026-08-19-示例决策.md", GOOD_TEXT);
    expect(v.some((x) => x.reason.includes("lifecycle"))).toBe(true);
  });

  test("class 不在闭集内 → 报红（拦住自由发明目录名）", () => {
    const v = mutate("notes/implemented/perf/2026-08-19-示例决策.md", GOOD_TEXT);
    expect(v.some((x) => x.reason.includes("class"))).toBe(true);
  });

  test("缺 frontmatter → 报红", () => {
    const v = mutate(GOOD_PATH, GOOD_TEXT.replace(/^---\n[\s\S]*?\n---\n/, ""));
    expect(v.some((x) => x.reason.includes("frontmatter"))).toBe(true);
  });

  test("Status 不在枚举内 → 报红", () => {
    const v = mutate(GOOD_PATH, GOOD_TEXT.replace("Status: implemented", "Status: wip"));
    expect(v.some((x) => x.reason.includes("Status"))).toBe(true);
  });

  test("Status 与所在 lifecycle 目录不一致 → 报红", () => {
    // 这是最值得拦的一条：一份声称 implemented 却躺在 rejected/ 的 Note
    // 比没有 Note 更坏 —— 它会让读者以为某个已否决的方案已经落地。
    const v = mutate("notes/rejected/process/2026-08-19-示例决策.md", GOOD_TEXT);
    expect(v.some((x) => x.reason.includes("不一致"))).toBe(true);
  });

  test("Date 与文件名日期不一致 → 报红", () => {
    const v = mutate(GOOD_PATH, GOOD_TEXT.replace("Date: 2026-08-19", "Date: 2026-08-01"));
    expect(v.some((x) => x.reason.includes("不一致"))).toBe(true);
  });

  test("形态合法但不存在的日期（2026-02-31）→ 报红", () => {
    const text = GOOD_TEXT.replace("Date: 2026-08-19", "Date: 2026-02-31");
    const v = mutate("notes/implemented/process/2026-02-31-示例决策.md", text);
    expect(v.some((x) => x.reason.includes("真实日期") || x.reason.includes("合法"))).toBe(true);
  });

  test("缺一级标题 → 报红", () => {
    const v = mutate(GOOD_PATH, GOOD_TEXT.replace("# 示例决策\n", ""));
    expect(v.some((x) => x.reason.includes("一级标题"))).toBe(true);
  });

  test.each(REQUIRED_SECTIONS.map((s) => [s]))("缺章节 %s → 报红", (section) => {
    const v = mutate(GOOD_PATH, GOOD_TEXT.replace(section, "## 别的标题"));
    expect(v.some((x) => x.reason.includes("缺章节"))).toBe(true);
  });

  test("三段都在但某段是空的 → 报红（空段落是形态问题，不是内容问题）", () => {
    const text = GOOD_TEXT.replace("跑了 `bun test`，看到 E。\n", "");
    const v = mutate(GOOD_PATH, text);
    expect(v.some((x) => x.reason.includes("是空的"))).toBe(true);
  });

  test("段落里只有格式提示的括号说明 → 仍判空", () => {
    // 模板里的 `（跑了什么命令…）` 这类提示不算内容 —— 否则直接提交模板就能过闸。
    const text = GOOD_TEXT.replace("跑了 `bun test`，看到 E。", "（跑了什么命令、看到什么输出）");
    const v = mutate(GOOD_PATH, text);
    expect(v.some((x) => x.reason.includes("是空的"))).toBe(true);
  });
});

describe("Agent Note：闭集与文档同步", () => {
  test("lifecycle / class 闭集就是 README 写的那几个（防文档与代码分叉）", () => {
    const readme = readFileSync(join(NOTES_DIR, "README.md"), "utf8");
    for (const l of LIFECYCLES) expect(readme).toContain(l);
    for (const c of CLASSES) expect(readme).toContain(c);
  });

  test("模板文件存在且自身满足三段结构", () => {
    const tpl = join(NOTES_DIR, "_template.md");
    expect(existsSync(tpl)).toBe(true);
    const text = readFileSync(tpl, "utf8");
    for (const s of REQUIRED_SECTIONS) expect(text).toContain(s);
  });
});

describe("Agent Note：门禁真的接线了（治「建好未接线」）", () => {
  const HOOK = readFileSync(join(ROOT, "scripts/git-hooks/pre-commit.sh"), "utf8");
  const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  test("pre-commit 按 .agents/notes 路径触发", () => {
    // 锚点写错（比如漏了转义的点、或写成 agents/notes）会让这道对账**静默不再触发** ——
    // 这个仓库已经踩过一次：P2-2 分包后 `^src/` 锚点失效，参考页对账悄悄停了。
    expect(HOOK).toContain("\\.agents/notes/");
  });

  test("pre-commit 真的调了校验脚本，且失败时 exit 1", () => {
    expect(HOOK).toContain("scripts/verify-agent-note.ts");
    const seg = HOOK.slice(HOOK.indexOf("STAGED_NOTES="));
    expect(seg).toContain("exit 1");
  });

  test("package.json 有手动入口 verify:agent-note", () => {
    expect(PKG.scripts["verify:agent-note"]).toContain("scripts/verify-agent-note.ts");
  });

  test("install-git-hooks.sh 的摘要提到了这道门禁（否则装完没人知道它在）", () => {
    const installer = readFileSync(join(ROOT, "scripts/install-git-hooks.sh"), "utf8");
    expect(installer).toContain("Agent Note");
  });

  test("安装器用 --git-common-dir 定位 hooks 目录（否则在 worktree 里装不上）", () => {
    // 本次落地时实测到的真 bug：安装器原本拼 `$REPO_ROOT/.git/hooks`，
    // 而 worktree 里 `.git` 是**文件**（`gitdir: …`），mkdir 直接失败、整个安装退 1。
    // 后果不是"少装一次"——本仓日常就在 worktree 里干活（当时同时有 7 个），
    // 于是 hook 门禁在 worktree 里从来没装上过，而错误信息很容易被划过去。
    //
    // 这条断言存在的意义：本 PR 新增的门禁**要靠这个安装器才能生效**，
    // 安装器一坏，门禁就回到"建好未接线"。
    const installer = readFileSync(join(ROOT, "scripts/install-git-hooks.sh"), "utf8");
    expect(installer).toContain("--git-common-dir");
    expect(installer).not.toMatch(/DST_DIR="\$REPO_ROOT\/\.git\/hooks"/);
  });
});
