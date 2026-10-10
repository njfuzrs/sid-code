/**
 * 「帮助文本列了、代码里没人读」的环境变量门禁（B27）。
 *
 * 背景：`SID_CODE_DEBUG` 在 `help.ts` 里、被 `docs:gen-reference` 生成进 `ref/env.md`、
 * 排障页还在教用户用它开调试 —— 三处一致，而主程序里没有一行代码读它。
 * 生成式文档门禁（pre-commit `--check`）保证的是「文档 = 帮助文本」，
 * 保证不了「帮助文本 = 行为」。本测试补的就是后一格：帮助文本里的每个变量名，
 * 在生产源码里至少要出现一次。
 *
 * 口径边界（刻意的）：
 * - 只查「有没有消费者」，不查「作用是否与描述一致」——后者要语义判断，交 review。
 * - **扫描范围排除 `tui-renderer`**：`SID_CODE_DEBUG` 恰好被 ink 渲染层读（只打 stderr、
 *   不开 debug.log），把它算进来，这条门禁当场就会漏掉它当初要抓的那个变量。
 *   只在 tui-renderer 生效的变量走 `TUI_ONLY` 白名单，且白名单本身要被核验（见下）。
 * - **匹配前先剥注释**：变异自证时撤掉接线、只留注释里的变量名，门禁照样绿 ——
 *   注释写着「这里读 X」不等于代码读了 X。
 * - 「出现」包括写入：Hook 运行时注入的 `SID_CODE_HOOK_EVENT` 等是 core 写给子进程的，
 *   对用户来说那就是它的消费者。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { parseHelpEnvVars } from "../../scripts/docs-gen-reference.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const HELP_PATH = join(REPO_ROOT, "packages/cli/src/help.ts");

/** 主程序源码根：不含 tui-renderer（理由见文件头） */
const MAIN_SRC_DIRS = ["shared", "core", "cli"].map((p) => join(REPO_ROOT, "packages", p, "src"));
const TUI_SRC_DIR = join(REPO_ROOT, "packages", "tui-renderer", "src");

/**
 * 只在 tui-renderer 里被读、且 help 描述的正是渲染层行为的变量。
 * 新增一项必须写理由；描述与渲染层行为对不上的变量不许进这里（那正是 SID_CODE_DEBUG 的形态）。
 */
const TUI_ONLY: Record<string, string> = {
  SID_DISABLE_TAB_STATUS: "termio/osc.ts 读，控制终端 Tab 状态指示（OSC），help 描述一致",
  SID_CODE_DISABLE_MOUSE_CLICKS: "_vendor/fullscreen.ts 读，控制鼠标点击，help 描述一致",
};

function loadSources(dirs: string[], exclude: (path: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  const glob = new Glob("**/*.{ts,tsx}");
  for (const dir of dirs) {
    for (const file of glob.scanSync(dir)) {
      const full = join(dir, file);
      if (exclude(full)) continue;
      out.set(full, stripComments(readFileSync(full, "utf8")));
    }
  }
  return out;
}

/**
 * 粗粒度剥注释：块注释整段去掉，行注释只认「行首或空白后的 //」，
 * 避免误伤字符串里的 `https://`。宁可少剥（偏向判「有消费者」）也不误删代码。
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

/**
 * 纯函数：返回在 sources 里一次都没出现的变量名。
 * 用 `\b` 词边界：`SID_CODE_DEBUG` 不会被 `SID_CODE_DEBUG_SSE` 冒名顶替（`_` 是词字符）。
 */
export function findWithoutConsumer(names: string[], sources: Iterable<string>): string[] {
  const all = [...sources];
  return names.filter((n) => {
    const re = new RegExp(`\\b${n}\\b`);
    return !all.some((s) => re.test(s));
  });
}

const helpSrc = readFileSync(HELP_PATH, "utf8");
const helpNames = parseHelpEnvVars(helpSrc).map((v) => v.name);
const mainSources = loadSources(MAIN_SRC_DIRS, (p) => p === HELP_PATH);
const tuiSources = loadSources([TUI_SRC_DIR], () => false);

describe("help 环境变量段 × 源码消费者", () => {
  test("防空转：解析到的变量与源码文件数都在合理量级", () => {
    // 解析器或源码根写坏时两者会静默归零，下面的断言就变成恒绿
    expect(helpNames.length).toBeGreaterThan(100);
    expect(helpNames).toContain("SID_CODE_DEBUG");
    expect(mainSources.size).toBeGreaterThan(500);
    expect(tuiSources.size).toBeGreaterThan(50);
  });

  test("help 里每个变量在主程序源码里都有读取点（tui-only 白名单除外）", () => {
    const missing = findWithoutConsumer(
      helpNames.filter((n) => !(n in TUI_ONLY)),
      mainSources.values(),
    );
    // 红了：要么接线，要么从 help.ts 删掉再跑 `bun run docs:gen-reference`
    expect(missing).toEqual([]);
  });

  test("TUI_ONLY 白名单不陈旧：每项仍在 help 里、仍被 tui-renderer 读、且主程序确实不读", () => {
    for (const name of Object.keys(TUI_ONLY)) {
      expect(helpNames).toContain(name);
      expect(findWithoutConsumer([name], tuiSources.values())).toEqual([]);
      // 主程序也读了就该移出白名单，回到常规断言
      expect(findWithoutConsumer([name], mainSources.values())).toEqual([name]);
    }
  });

  test("自证：判定函数能抓住假变量，且不被同前缀长名、注释冒充", () => {
    expect(
      findWithoutConsumer(
        ["SID_CODE_DEBUG"],
        [stripComments("// 读 SID_CODE_DEBUG\n/* SID_CODE_DEBUG */")],
      ),
    ).toEqual(["SID_CODE_DEBUG"]);
    expect(stripComments('const u = "https://x"; // SID_X')).toBe('const u = "https://x"; ');
    expect(findWithoutConsumer(["SID_CODE_B27_FAKE_VAR"], mainSources.values())).toEqual([
      "SID_CODE_B27_FAKE_VAR",
    ]);
    expect(
      findWithoutConsumer(["SID_CODE_DEBUG"], ['process.env.SID_CODE_DEBUG_SSE === "1"']),
    ).toEqual(["SID_CODE_DEBUG"]);
  });
});
