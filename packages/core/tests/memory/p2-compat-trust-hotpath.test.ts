/**
 * P2-13 / P2-14 / P2-15 防复发：frontmatter 兼容性 / 团队记忆信任边界 / 热路径开销
 *
 * 三条缺陷互不相干，合在一个文件里是因为它们共享同一个「不会红」的性质 ——
 * 修复前**三条的症状都不是失败，而是静默的错值 / 静默的放行 / 静默的变慢**：
 *
 * | 缺陷 | 修复前的形态 | 为什么测试测不出 |
 * | --- | --- | --- |
 * | P2-13 | cc 嵌套 `metadata:` 下的 `type` 恒读不到 | 落到 `inferMemoryType` 启发式猜，**猜出来的也是合法值** |
 * | P2-14 | 共享目录内容不扫 secret，直接落本地 | 同步「成功」，凭证进了本地索引也没人报错 |
 * | P2-15 | 每次 write/edit fork 一个 git 进程 | 功能完全正确，只是慢 —— 慢不会让断言变红 |
 *
 * ⚠️ 变异自证：下面每条断言都确认过「把对应修复回退就变红」，逐条记在各 describe 头部。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseFrontmatter,
  readFrontmatterFields,
  readMemoryFrontmatter,
} from "@sid-code/core/memory/scan.ts";
import { syncTeamMemory } from "@sid-code/core/memory/team/sync.ts";
import { getTeamMemPath } from "@sid-code/core/memory/team/paths.ts";
import {
  isAnyPrivateMemPath,
  getAutoMemPath,
  resolveProjectRoot,
  clearProjectRootCache,
} from "@sid-code/core/memory/paths.ts";
import { checkPrivateMemSecrets } from "@sid-code/core/memory/write-guard.ts";
import { rebuildTeamIndex } from "@sid-code/core/memory/team/store.ts";

/** 真实形态的 GitHub PAT（不带 EXAMPLE/FAKE 标记，否则会被占位符守卫放行） */
const PAT = "ghp_" + "a".repeat(36);

let tmpHome: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-p2-home-"));
  // 存原值再改：`bun test` 同批多文件跑在同一进程里，无条件 delete 会把
  // preload 的落盘隔离兜底一起抹掉（CONTRIBUTING.md 测试约定第 1 条）。
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
  // 配置根变了 → 项目根缓存的 key 里含 sidHome，但显式清一次更稳
  clearProjectRootCache();
});

afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  clearProjectRootCache();
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ───────────────────────── P2-13 ─────────────────────────
//
// 变异自证：把 `readFrontmatterFields` 换回「逐行 `^(\w+):` 只认顶层」，
// 「cc 嵌套格式读得到 type」与「ISO 时间戳不被截断」两条变红。
// 换回 `indexOf(":")` 那种写法，「顶层 name 不被 metadata.name 覆盖」变红。

describe("P2-13 frontmatter 解析：cc 嵌套格式兼容 + 值内冒号", () => {
  /** cc 真实落盘格式：type 在 `metadata:` 之下缩进两格 */
  const CC_NESTED = `---
name: agent-started-fourth-form-of-fake-zero
description: 卡死在启动里的题
metadata:
  node_type: memory
  type: project
  originSessionId: 57ea1b19-abc
  modified: 2026-09-03T03:38:42.648Z
---

正文`;

  test("cc 嵌套 metadata 下的 type 读得到（此前恒丢，落到启发式猜）", () => {
    expect(parseFrontmatter(CC_NESTED).type).toBe("project");
  });

  test("含冒号的值不被截断（ISO 时间戳取第一个冒号会截成 2026-09-03T03）", () => {
    expect(readMemoryFrontmatter(CC_NESTED).modified).toBe("2026-09-03T03:38:42.648Z");
  });

  test("description 里的冒号原样保留", () => {
    const text = `---
name: x
description: 结论: 有冒号也不截断
type: feedback
---
b`;
    expect(parseFrontmatter(text).description).toBe("结论: 有冒号也不截断");
  });

  test("顶层键**不被**同名子键覆盖 —— name 是 P0-1 的去重键，改错它会把两条记忆并成一条", () => {
    const text = `---
name: toplevel-name
type: user
metadata:
  name: nested-name
  type: project
---
b`;
    const fm = parseFrontmatter(text);
    expect(fm.name).toBe("toplevel-name");
    expect(fm.type).toBe("user");
  });

  test("非白名单父键下的嵌套一律丢弃（未知结构的语义我们不知道，猜它等于读错）", () => {
    const text = `---
name: y
custom:
  type: reference
---
b`;
    expect(parseFrontmatter(text).type).toBeUndefined();
  });

  test("嵌套块由下一个顶层键正确终止", () => {
    const text = `---
metadata:
  type: project
description: 顶层描述
---
b`;
    const fm = parseFrontmatter(text);
    expect(fm.description).toBe("顶层描述");
    expect(fm.type).toBe("project");
  });

  test("正文里的 `name:` 行不入账（团队索引侧曾用裸 /^name:/m 全文匹配）", () => {
    const text = `---
name: real
---

name: 正文里的假 name`;
    expect(readMemoryFrontmatter(text).name).toBe("real");
  });

  test("无 frontmatter 块 → 空对象，不抛", () => {
    expect(readMemoryFrontmatter("普通 markdown，没有 frontmatter")).toEqual({});
  });

  test("readFrontmatterFields 收块内容，空块 → 空对象", () => {
    expect(readFrontmatterFields("")).toEqual({});
  });

  test("团队索引重建复用同一口径：正文假 name 不进索引", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sid-p2-team-idx-"));
    try {
      writeFileSync(
        join(dir, "a.md"),
        `---\nname: 真名\ndescription: 真描述\n---\n\nname: 假名\ndescription: 假描述\n`,
        "utf8",
      );
      await rebuildTeamIndex(dir);
      const idx = readFileSync(join(dir, "MEMORY.md"), "utf8");
      expect(idx).toContain("真名");
      expect(idx).not.toContain("假名");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────── P2-14 ─────────────────────────
//
// 变异自证：把 shared 侧的 `readEntries(sharedDir, true, ...)` 改回 `false`，
// 本 describe 下四条全红。只删 `quarantined` 那段而保留扫描，
// 「隔离的 key 不删本地」与「不替对方覆盖共享」两条变红（因为剔除后
// 该 key 在合并循环里长得像"共享侧已删除"，会走删除传播）。

describe("P2-14 团队记忆 pull 侧 secret 闸门（防凭证反向流入）", () => {
  let cwd: string;
  let shared: string;
  let local: string;

  function opts() {
    return { enabled: true, dir: shared };
  }

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), "sid-p2-cwd-"));
    shared = mkdtempSync(join(tmpdir(), "sid-p2-shared-"));
    local = getTeamMemPath(cwd);
    mkdirSync(local, { recursive: true });
  });

  afterAll(() => {
    for (const d of [cwd, shared]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  test("共享侧含 secret 的新条目：拒绝拉取，不进本地、不进本地索引", async () => {
    writeFileSync(join(shared, "poison.md"), `---\nname: poison\n---\n\ntoken: ${PAT}\n`, "utf8");
    writeFileSync(join(shared, "clean.md"), `---\nname: clean\n---\n\n干净内容\n`, "utf8");

    const r = await syncTeamMemory(opts(), cwd);
    expect(r.success).toBe(true);
    expect(r.blockedIncomingSecrets.map((s) => s.path)).toEqual(["poison.md"]);
    expect(r.blockedIncomingSecrets[0].ruleId).toBe("github-pat");

    expect(existsSync(join(local, "poison.md"))).toBe(false);
    // 干净条目不受影响 —— 一个中毒文件不该让整轮同步停摆
    expect(existsSync(join(local, "clean.md"))).toBe(true);
    expect(readFileSync(join(local, "MEMORY.md"), "utf8")).not.toContain("poison");
  });

  test("结果里只记 ruleId 与 label，不回显明文", async () => {
    const r = await syncTeamMemory(opts(), cwd);
    expect(JSON.stringify(r.blockedIncomingSecrets)).not.toContain("a".repeat(36));
  });

  test("被隔离的 key **不**触发删除传播 —— 中毒的共享文件没有删我本地记忆的权力", async () => {
    // 先让 mine.md 两端一致
    writeFileSync(join(local, "mine.md"), `---\nname: mine\n---\n\n我的正文\n`, "utf8");
    await syncTeamMemory(opts(), cwd);
    expect(existsSync(join(shared, "mine.md"))).toBe(true);

    // 有人往共享侧那份塞了凭证
    writeFileSync(join(shared, "mine.md"), `---\nname: mine\n---\n\ntoken: ${PAT}\n`, "utf8");
    const r = await syncTeamMemory(opts(), cwd);

    expect(r.blockedIncomingSecrets.map((s) => s.path)).toContain("mine.md");
    // 本地那份完好、内容未被污染
    expect(existsSync(join(local, "mine.md"))).toBe(true);
    expect(readFileSync(join(local, "mine.md"), "utf8")).not.toContain(PAT);
    expect(r.deleted).toBe(0);
    // 也不该记成冲突：这不是内容分歧，是一侧被隔离
    expect(r.conflicts).toBe(0);
  });

  test("被隔离的 key 也不 push —— 不替对方「修好」他的文件", async () => {
    // 承接上一条：共享侧 mine.md 仍含 secret，我方版本不得覆盖它
    expect(readFileSync(join(shared, "mine.md"), "utf8")).toContain(PAT);
  });

  test("对方清理掉 secret 后正常规则接上，且不造出假冲突", async () => {
    writeFileSync(join(shared, "mine.md"), `---\nname: mine\n---\n\n对方清理后的正文\n`, "utf8");
    const r = await syncTeamMemory(opts(), cwd);
    expect(r.blockedIncomingSecrets.map((s) => s.path)).not.toContain("mine.md");
    expect(r.conflicts).toBe(0);
    expect(readFileSync(join(local, "mine.md"), "utf8")).toContain("对方清理后");
  });

  test("push 侧闸门未被削弱（两个方向各自独立记账）", async () => {
    writeFileSync(join(local, "myleak.md"), `---\nname: myleak\n---\n\ntoken: ${PAT}\n`, "utf8");
    const r = await syncTeamMemory(opts(), cwd);
    expect(r.skippedSecrets.map((s) => s.path)).toContain("myleak.md");
    expect(existsSync(join(shared, "myleak.md"))).toBe(false);
  });
});

// ───────────────────────── P2-15 ─────────────────────────
//
// 变异自证：删掉 `isAnyPrivateMemPath` 里那段 sidHome 前缀捷径，
// 「普通源码路径不 fork git 进程」变红（耗时回到 5ms 量级）。
// 删掉 `projectRootCache`，「重复解析走缓存」变红。

describe("P2-15 write/edit 热路径不再每次 fork git 进程", () => {
  test("非记忆路径的判定不碰 git —— **每次都清缓存**仍然快", () => {
    // ⚠️ 这里必须每轮清缓存，否则这条断言测不到捷径。
    // 第一版写成「预热一次 + 循环 40 次」，结果**删掉捷径也照样绿** ——
    // 因为热缓存下 `resolveProjectRoot` 本来就不 fork git，于是这条断言
    // 实际只证明了缓存生效，而捷径被删这件事完全没人拦（典型的 false gate，
    // 见 CLAUDE.md「门禁隐蔽失效」）。清缓存后两个修复各自独立可证：
    // 缓存管「重复解析」，捷径管「首次解析也不该发生」。
    const target = "/tmp/definitely-not-a-memory-file.ts";
    const N = 20;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      clearProjectRootCache();
      isAnyPrivateMemPath(target, process.cwd());
    }
    const elapsed = performance.now() - t0;
    // 单次 execSync 实测 5.4ms ⇒ 无捷径时 20 次冷解析 ≈ 108ms。
    // 阈值取 40ms：远低于无捷径的量级，又给慢 runner 留足余量（实测 <1ms）。
    expect(elapsed).toBeLessThan(40);
  });

  test("捷径不牺牲正确性：记忆目录仍被判为记忆路径", () => {
    clearProjectRootCache();
    const memFile = join(getAutoMemPath(process.cwd()), "reference_x.md");
    expect(isAnyPrivateMemPath(memFile, process.cwd())).toBe(true);
  });

  test("捷径不牺牲正确性：记忆路径里的 secret 仍被拦", () => {
    const memFile = join(getAutoMemPath(process.cwd()), "reference_creds.md");
    expect(checkPrivateMemSecrets(memFile, `凭证 ${PAT}`, process.cwd())).not.toBeNull();
  });

  test("配置根之外的路径一律放行（含形似前缀的兄弟目录，防 startsWith 漏判）", () => {
    // `<home>-evil` 与 `<home>` 共享前缀但不是它的子目录 —— 必须放行
    const sibling = `${tmpHome}-evil/memory/x.md`;
    expect(isAnyPrivateMemPath(sibling, process.cwd())).toBe(false);
  });

  test("resolveProjectRoot 重复解析走缓存（同一 cwd + 同一配置根）", () => {
    clearProjectRootCache();
    const cold = resolveProjectRoot(process.cwd());
    const t0 = performance.now();
    for (let i = 0; i < 40; i++) resolveProjectRoot(process.cwd());
    const elapsed = performance.now() - t0;
    expect(resolveProjectRoot(process.cwd())).toBe(cold);
    expect(elapsed).toBeLessThan(50);
  });

  test("缓存 key 含配置根：改 SID_CONFIG_DIR 后不会读到上一个配置根的结果", () => {
    clearProjectRootCache();
    const saved = process.env.SID_CONFIG_DIR;
    try {
      // cwd 落在配置根内时，防御逻辑要回退到 homedir()。
      // 若 key 只用 cwd，这一条会读到上面用别的配置根算出的结果。
      const first = resolveProjectRoot(process.cwd());
      process.env.SID_CONFIG_DIR = process.cwd();
      const second = resolveProjectRoot(process.cwd());
      expect(second).not.toBe(first);
    } finally {
      if (saved === undefined) delete process.env.SID_CONFIG_DIR;
      else process.env.SID_CONFIG_DIR = saved;
      clearProjectRootCache();
    }
  });
});
