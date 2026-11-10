/**
 * B32：用户级 CLAUDE.md 的 `## Allowed Tools` 必须生效（2026-11-10）。
 *
 * 这条缺陷的成因全在**时序**：`preApproved` 在 `PermissionChecker` 构造时从
 * `config.allowedTools` 快照一次（checker.ts 构造函数），而 CLAUDE.md 的名单由
 * `app.ts` `applyProjectRules` 在构造**之后**才追加进 config（cli.ts 建 checker →
 * app.init → doInit 加载 CLAUDE.md）。修前实测：`preApproved=[]`、`allowed=false step=14`，
 * 而 config.allowedTools 里明明有那两条规则。
 *
 * 三条断言各自钉一层：① 构造后补入必须放行（核心行为）；② 重复补入幂等（热重载 /
 * 切 worktree 会带着同一份名单反复走到这里）；③ 接线不靠人记——静态扫描 app.ts，
 * 漏调 `addPreApprovedRules` 或退回「只追加 config」的旧写法都要变红。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";

const RULE = "Bash(git remote add *)";
const REQ = { toolName: "bash", input: { command: "git remote add origin https://x/y.git" } };

let dir: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  // check() 会落权限审计日志：重定向到 tmpdir，别写进真实 ~/.sid-code
  dir = mkdtempSync(join(tmpdir(), "sid-b32-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = dir;
});

afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

function makeChecker(): { checker: PermissionChecker; config: Config } {
  const config = { ...defaultConfig(), permissionMode: "default" } as Config;
  return { checker: new PermissionChecker(config, undefined, process.cwd()), config };
}

describe("B32 用户级 CLAUDE.md ## Allowed Tools", () => {
  test("构造后补入（= applyProjectRules 的真实时序）放行 Step 12", async () => {
    const { checker, config } = makeChecker();

    // 对照：名单还没进来 → 走默认 ask，证明放行不是别的路径给的
    const before = await checker.check(REQ);
    expect(before.allowed).toBe(false);
    expect(before.step).toBe("14");

    // app.ts applyProjectRules 的等价动作：写 config（供计数/其它消费方）+ 同步给 checker
    config.allowedTools = [...config.allowedTools, RULE];
    checker.addPreApprovedRules([RULE]);

    const after = await checker.check(REQ);
    expect(after.allowed).toBe(true);
    expect(after.step).toBe("12");
  });

  test("重复补入同一份名单（热重载 / 切 worktree）幂等", async () => {
    const { checker } = makeChecker();
    checker.addPreApprovedRules([RULE]);
    checker.addPreApprovedRules([RULE, ` ${RULE} `]);
    const d = await checker.check(REQ);
    expect(d.allowed).toBe(true);
    expect(d.step).toBe("12");
  });

  test("接线：app.ts applyProjectRules 同步给 checker，且合并去重", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/app.ts"), "utf8");
    const start = src.indexOf("private applyProjectRules(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, start + 2000);

    expect(body).toContain("addPreApprovedRules?.(rules.allowedTools)");
    // 旧写法（整句）：只把名单裸追加进 config，checker 的 preApproved 看不见。
    // 要带上前缀与分号整句比对——单看 `[...a, ...b]` 会误伤 new Set(...) 里的同名片段。
    expect(body).not.toContain(
      "this.config.allowedTools = [...this.config.allowedTools, ...rules.allowedTools];",
    );
    // 去重：否则热重载每触发一次就重复追加一遍
    expect(body).toContain("new Set(");
  });
});
