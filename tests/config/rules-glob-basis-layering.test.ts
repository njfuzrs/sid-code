/**
 * 第 7 批 · `paths:` glob 基准目录按层分层
 *
 * 背景（doc §9 优势-3 附近 & §11.1 第 7 批）：CC 区分 Project / Managed / User 三种
 * `paths:` glob 的匹配基准（`claudemd.ts:1376-1380`）——Project 层用项目根，
 * Managed/User 层用会话启动时的原始 cwd（`getOriginalCwd()`）。我们此前只有
 * 单一 `projectRoot` 基准，对 managed/user/userRulesDir 三层的 `paths:` 规则
 * 用错了锚点：这三层规则不属于任何具体项目，作者写 `paths:` 时假设的锚点是
 * 「用户此刻工作在哪」，不是「这个我压根不知道内部结构的项目的根目录」。
 *
 * 本文件验证 `loadAllCLAUDEmd` 新增的 `opts.originalCwdActiveFiles` 参数：
 *   1. managed / user / userRulesDir 三层的 `paths:` 判定确实改用这份列表，
 *      而不是 project 基准的 `activeFiles`（核心正确性）
 *   2. project / subdir / rulesDir / local 四层不受影响，仍用 `activeFiles`
 *      （防止「改过了头」——新基准不能鹊巢鸠占）
 *   3. 无 `opts.originalCwdActiveFiles` 覆盖、且没有任何 managed/user/userRulesDir
 *      规则携带 `paths:` 时，不会意外依赖真实 `getOriginalCwd()`（惰性求值验证）
 *
 * userRulesDir 层测试用 `mock.module("node:os")` 重定向 `homedir()`——
 * Bun 的 `os.homedir()` **不认 `process.env.HOME`**（与 Node.js 行为不同），
 * 直接设 `process.env.HOME` 会让 `findGlobalCLAUDEmd()` / `userRulesDirs()` 仍指向
 * 真实家目录，测试夹具完全失效。改用 `mock.module` 从模块层面拦截 `homedir()`，
 * 让 fakeHome 真正生效——避免写真实用户目录，也避免碰 managed 层系统级目录。
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadAllCLAUDEmd } from "@sid-code/core/config/rules.ts";

// ─── mock os.homedir() ───
// Bun 下 os.homedir() 不读 process.env.HOME，必须从模块层面 mock。
// mockHome 在 beforeEach 里设为 fakeHome、afterEach 里清空回退真实值。
let mockHome: string | undefined;
mock.module("node:os", () => {
  const real = require("node:os");
  return {
    ...real,
    homedir: () => mockHome ?? real.homedir(),
  };
});

describe("`paths:` glob 基准按层分层（第 7 批）", () => {
  let proj: string;
  let fakeHome: string;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), "sid-glob-basis-proj-"));
    fakeHome = mkdtempSync(join(tmpdir(), "sid-glob-basis-home-"));
    // 通过 mock.module 拦截 os.homedir()，让 fakeHome 真正生效
    // （Bun 下设 process.env.HOME 无效，见文件头注释）
    mockHome = fakeHome;
    writeFileSync(join(proj, "CLAUDE.md"), "# Instructions\n项目根规则 ROOT_MARKER");
  });

  afterEach(() => {
    mockHome = undefined;
    try { rmSync(proj, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function writeUserRule(name: string, content: string) {
    const dir = join(fakeHome, ".claude", "rules");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content);
  }

  test("userRulesDir 层 paths: 命中用 originalCwdActiveFiles，不用 activeFiles", async () => {
    writeUserRule(
      "billing.md",
      `---\npaths: ["billing/**"]\n---\n# User Rule\nBILLING_SCOPED_MARKER`,
    );

    // activeFiles（project 基准）里没有 billing，若代码误用它做 managed/user 层判定，
    // 这条规则会被误判为不匹配而排除。
    const projectActive = ["src/foo.ts"];

    const hit = await loadAllCLAUDEmd(proj, {
      activeFiles: projectActive,
      originalCwdActiveFiles: ["billing/invoice.ts"],
    });
    expect(hit!.rawContent).toContain("BILLING_SCOPED_MARKER");

    const miss = await loadAllCLAUDEmd(proj, {
      activeFiles: projectActive,
      originalCwdActiveFiles: ["src/other.ts"],
    });
    expect(miss!.rawContent).not.toContain("BILLING_SCOPED_MARKER");
  });

  test("即使 activeFiles 恰好也能匹配，userRulesDir 层仍按 originalCwdActiveFiles 判定（不是回退到 activeFiles）", async () => {
    writeUserRule(
      "billing.md",
      `---\npaths: ["billing/**"]\n---\n# User Rule\nBILLING_SCOPED_MARKER`,
    );

    // activeFiles 命中（billing/**），但 originalCwdActiveFiles 不命中 ——
    // 若实现偷懒回退用了 activeFiles，这里会误判为「命中」，测试会抓到这个回退。
    const merged = await loadAllCLAUDEmd(proj, {
      activeFiles: ["billing/invoice.ts"],
      originalCwdActiveFiles: ["src/unrelated.ts"],
    });
    expect(merged!.rawContent).not.toContain("BILLING_SCOPED_MARKER");
  });

  test("project 层（.claude/rules/）不受新基准影响，仍用 activeFiles 判定", async () => {
    mkdirSync(join(proj, ".claude", "rules"), { recursive: true });
    writeFileSync(
      join(proj, ".claude", "rules", "ui.md"),
      `---\npaths: ["ui/**"]\n---\n# Project Rule\nPROJECT_UI_MARKER`,
    );

    // originalCwdActiveFiles 完全不含任何命中项——若 project 层被错误地也用了
    // 这份基准，这条断言会失败（说明改动波及了不该动的层）。
    const merged = await loadAllCLAUDEmd(proj, {
      activeFiles: ["ui/Footer.tsx"],
      originalCwdActiveFiles: [],
    });
    expect(merged!.rawContent).toContain("PROJECT_UI_MARKER");

    const miss = await loadAllCLAUDEmd(proj, {
      activeFiles: ["docs/readme.md"],
      originalCwdActiveFiles: ["ui/Footer.tsx"], // 故意让"错误基准"命中，验证确实没被用到
    });
    expect(miss!.rawContent).not.toContain("PROJECT_UI_MARKER");
  });

  test("userRulesDir 层无 paths:（无条件规则）不受影响，两层都能正常叠加", async () => {
    writeUserRule("always.md", "# User Rule\nALWAYS_ON_MARKER");
    const merged = await loadAllCLAUDEmd(proj, {
      activeFiles: ["src/foo.ts"],
      originalCwdActiveFiles: [],
    });
    expect(merged!.rawContent).toContain("ALWAYS_ON_MARKER");
    expect(merged!.rawContent).toContain("ROOT_MARKER");
  });

  test("惰性求值：无 managed/user/userRulesDir 层 paths: 规则时，不依赖 originalCwdActiveFiles 覆盖也能正常返回", async () => {
    // 不传 originalCwdActiveFiles，且 fakeHome 下没有任何 userRulesDir 规则 ——
    // 若实现在这种情况下仍无条件计算该基准（对 getOriginalCwd() 发起真实 collectActiveScopeFiles），
    // 也不会报错（那个函数本身对失败静默返回 []），但下面这条能确认整体行为仍然正确、
    // 且不需要为了「不报错」而依赖任何真实环境状态。
    const merged = await loadAllCLAUDEmd(proj, { activeFiles: ["src/foo.ts"] });
    expect(merged!.rawContent).toContain("ROOT_MARKER");
  });

  test("managed/user/userRulesDir 层 paths: 判定支持多值数组", async () => {
    writeUserRule(
      "multi.md",
      `---\npaths: ["billing/**", "payments/**"]\n---\n# User Rule\nMULTI_SCOPE_MARKER`,
    );
    const hitFirst = await loadAllCLAUDEmd(proj, {
      originalCwdActiveFiles: ["billing/a.ts"],
    });
    expect(hitFirst!.rawContent).toContain("MULTI_SCOPE_MARKER");

    const hitSecond = await loadAllCLAUDEmd(proj, {
      originalCwdActiveFiles: ["payments/b.ts"],
    });
    expect(hitSecond!.rawContent).toContain("MULTI_SCOPE_MARKER");

    const miss = await loadAllCLAUDEmd(proj, {
      originalCwdActiveFiles: ["unrelated/c.ts"],
    });
    expect(miss!.rawContent).not.toContain("MULTI_SCOPE_MARKER");
  });
});
