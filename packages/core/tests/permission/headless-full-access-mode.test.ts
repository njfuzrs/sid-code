/**
 * headless 全放行的唯一正确写法 —— 哨兵测试。
 *
 * ## 为什么单独一个文件
 *
 * 这些事实是 `evals/external-benchmarks/swe-bench/exec-swebench.sh` 的**前提**：
 * 评测在 headless 容器里跑，agent 必须能跑 pytest、能往 /tmp 写复现脚本。
 * 前提错了不会报错，只会让分数变差 —— 实测 smoke-8（acceptEdits）10 条实例
 * 113 次权限拒绝，三条过半轮次白烧，然后被记成「40 轮预算用尽」，
 * 读起来像能力不够。**非能力原因混进了能力账。**
 *
 * 更糟的是修它时踩的第二个坑：改成 `--permission-mode bypassPermissions`，
 * 而那不是合法模式名 —— 比它要修的 acceptEdits 还差（连工作区内 write 都拒），
 * 而评测侧的门禁写的是 `expect(sh).toContain("bypassPermissions")`，
 * **把错误取值锁定成了正确行为**，躲过全量 11033 个测试。
 *
 * 所以这里锁的不是"权限层怎么实现"，而是三条**跨层事实**：
 *   1. `bypassPermissions` 不是合法模式名（别再有人凭直觉写它）；
 *   2. `always-allow` 绕不过路径验证（工作区外写入仍被拦）；
 *   3. 只有 `skipPermissions` 布尔态是全放行，且**只能由布尔 flag 置位**。
 *
 * ⚠️ 这三条任何一条变了，评测的必控变量就变了，分数不可与历史 run 并排。
 * 所以它们该在这里红，而不是在下一轮跑完之后从分数里猜。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { validateConfig } from "@sid-code/core/config/schema.ts";

/** 工作区根。用真实 tmpdir：路径验证会做 symlink 解析，不存在的路径判据不同。 */
const WS = mkdtempSync(join(tmpdir(), "sid-perm-ws-"));
/** 工作区**外**的写入目标（模型写复现脚本的标准动作） */
const OUTSIDE = join(mkdtempSync(join(tmpdir(), "sid-perm-out-")), "repro.py");

function checkerFor(mode: string, skipPermissions = false) {
  return new PermissionChecker(
    { ...defaultConfig(), permissionMode: mode, skipPermissions },
    undefined,
    WS,
  );
}

/** 做题必需的三个动作：跑测试 / 探环境 / 写工作区外的复现脚本 */
async function probe(c: PermissionChecker) {
  const bash = await c.check({
    toolName: "bash",
    input: { command: "python3 -m pytest lib/tests/test_image.py" },
  });
  const writeOutside = await c.check({
    toolName: "write",
    input: { file_path: OUTSIDE, content: "x = 1" },
  });
  const writeInside = await c.check({
    toolName: "write",
    input: { file_path: join(WS, "fix.py"), content: "x = 1" },
  });
  return {
    bash: bash.allowed,
    writeOutside: writeOutside.allowed,
    writeInside: writeInside.allowed,
  };
}

describe("headless 全放行：评测必控变量的三条前提", () => {
  test("bypassPermissions 不是合法模式名，且只 warn 不报错", () => {
    // 这是那个 bug 的源头：传进去只得到一条校验 warn，程序照常跑，
    // 然后 checker 的 `=== "always-allow"` 精确匹配不命中 → 落默认 ask。
    // **不报错**这一点比"不合法"更关键 —— 报错的话当场就发现了。
    const v = validateConfig({ ...defaultConfig(), permissionMode: "bypassPermissions" });
    const hit = v.errors.find((e) => e.path === "permissionMode");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("无效值");
    // 顺带锁住合法值集合：少了 dangerously-skip-permissions 评测就没有可用取值了
    expect(hit!.message).toContain("dangerously-skip-permissions");
    expect(hit!.message).toContain("always-allow");
    expect(hit!.message).toContain("acceptEdits");
  });

  test("bypassPermissions 在 checker 里等于什么都没设 —— 连工作区内 write 都拒", async () => {
    // 实测形态：它比要修的 acceptEdits 更差。acceptEdits 至少放行工作区内的
    // write/edit（做题的核心动作），这个连那个都没有。
    expect(await probe(checkerFor("bypassPermissions"))).toEqual({
      bash: false,
      writeOutside: false,
      writeInside: false,
    });
    // 与 default 完全一致 —— 也就是说那个"修复"是个空操作
    expect(await probe(checkerFor("bypassPermissions"))).toEqual(
      await probe(checkerFor("default")),
    );
  });

  test("acceptEdits 拒掉 pytest —— smoke-8 那 113 次拒绝的成因", async () => {
    // 只放行 FILE_TOOLS 与 cwd 内 7 个 fs 命令（ACCEPT_EDITS_FS_COMMANDS），
    // python / pytest / git log 全落默认 ask → headless 无交互 → 直接拒绝。
    expect(await probe(checkerFor("acceptEdits"))).toEqual({
      bash: false,
      writeOutside: false,
      writeInside: true,
    });
  });

  test("always-allow 不够：路径验证在 bypass **之前**，工作区外写入仍被拦", async () => {
    // checker 的顺序是 `… → Step 4 路径验证 → … → Step 8 bypass/always-allow`。
    // smoke-8 那 113 次里有 5 次正是 `write(/tmp/repro.py) → 写入路径在工作区外`。
    // ⚠️ 这条是"看着够但不够"的那种 —— bash 放行了，很容易让人以为搞定了。
    expect(await probe(checkerFor("always-allow"))).toEqual({
      bash: true,
      writeOutside: false,
      writeInside: true,
    });
  });

  test("只有 skipPermissions 布尔态三项全通（评测唯一可用取值）", async () => {
    expect(await probe(checkerFor("dangerously-skip-permissions", true))).toEqual({
      bash: true,
      writeOutside: true,
      writeInside: true,
    });
  });

  test("`--permission-mode dangerously-skip-permissions` 不生效 —— 必须用布尔 flag", async () => {
    // cli.ts 把布尔 flag 映射到 config.skipPermissions，而 checker 的早退判据
    // 就是 `this.config.skipPermissions`；只设 permissionMode 字符串碰不到它。
    // ⚠️ 反向映射会掩盖这件事：布尔 flag 会让 config.ts 顺带把 permissionMode
    // 同步成同名字符串，所以状态栏/run-meta 里两者看起来一样，
    // **但只有布尔 flag 那条真的放行**。评测脚本按字符串写就会静默跑成 default。
    expect(await probe(checkerFor("dangerously-skip-permissions", false))).toEqual({
      bash: false,
      writeOutside: false,
      writeInside: false,
    });
  });
});
