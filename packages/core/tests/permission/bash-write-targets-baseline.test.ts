/**
 * bash 写目标推断的「不误拦」基线（2026-11-07）。
 *
 * ## 这个文件守什么
 *
 * 缺陷文档《20261103-04H2-执行边界-两个已核实缺陷》§2 记了 12 条
 * 「[安全检查] sid-code 配置目录」的 headless deny，归因是「bash 没有 `file_path`，
 * checker 从命令文本推断写目标，把文本里出现的 `.sid-code` 路径当成写目标」。
 *
 * 2026-11-07 回审计日志复核时发现：那批原始记录已不可考 —— 探针会话跑在
 * `SID_CONFIG_DIR=/tmp/sidprobe-cfg` 下，临时目录早已清理；本机默认日志里 10-27 的
 * 104 条 deny 没有一条是「安全检查」理由（真实分布是「破坏性命令需要确认」，
 * 且那批命令是探针自己构造的危险字符串，判需确认是对的）。当前 HEAD 也不再复现。
 *
 * 所以这里守的**不是「某个已修的 bug」**，而是当前正确行为的基线：
 *
 * - 写目标只来自重定向操作符与写程序参数（`extractBashWriteTargets`）；
 * - 只读命令里出现的路径**不**算写目标；
 * - 真的写 `.sid-code` / `.git/hooks` 仍然被 safetyCheck 拦。
 *
 * 谁把推断改回「命令里出现的所有路径」，A 组会红。
 *
 * ## 为什么两条只读命令要分开断言
 *
 * 第一条含 `> p7.js`（真有写目标，只是不在受保护路径下），第二条完全只读。
 * 合成一条只能证明「至少有一种形态不误拦」，分不开「重定向目标解析正确」与
 * 「纯只读命令不产生写目标」这两个独立条件。
 *
 * ⚠ 落盘隔离：`PermissionChecker` 构造 `AuditLogger`，必须重定向 `SID_CONFIG_DIR`
 *   并**存/恢复原值**（不能无条件 delete，`bun test` 同批多文件同进程）。
 * ⚠ 工作区用 realpath 后的 tmpdir：macOS `/var` → `/private/var` 会让路径比对错位。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { explainDecision } from "@sid-code/core/permission/explainer.ts";
import { extractBashWriteTargets } from "@sid-code/core/permission/shell-command-variants.ts";
import type { Config } from "@sid-code/core/config/config.ts";

let configRoot: string;
let ws: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-bwt-cfg-"));
  ws = realpathSync(mkdtempSync(join(tmpdir(), "sid-bwt-ws-")));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

/** 与轨迹一致的配置：`--print` + `acceptEdits`（headless 会把 ask 落成 deny）。 */
function makeHeadlessChecker(): PermissionChecker {
  const config = {
    ...defaultConfig(),
    print: true,
    maxTurns: 40,
    permissionMode: "acceptEdits",
    disallowedTools: [],
    allowedTools: [],
  } as Config;
  return new PermissionChecker(config, undefined, ws);
}

/** 模型实际看到的那段文本（与 `tool-executor.ts` 的拼法一致）。 */
async function whatTheModelSees(
  checker: PermissionChecker,
  toolName: string,
  input: Record<string, unknown>,
): Promise<string> {
  const decision = await checker.check({ toolName, input } as never);
  return explainDecision(decision);
}

describe("A. 写目标提取：只读命令不产生写目标", () => {
  test("文档点名的第 1 条：真写 p7.js，但只该有这一个目标", () => {
    // `cd` / `pwd` / `cat` 的参数都不是写目标；`~` 与命令文本里其它路径也不能进来。
    const cmd = `cd /tmp && pwd && printf '%s\\n' 'let a = "zz";' > p7.js && cat p7.js`;
    expect(extractBashWriteTargets(cmd)).toEqual(["p7.js"]);
  });

  test("文档点名的第 2 条：纯只读，写目标为空", () => {
    const cmd = `cd ~/.sid-code/logs && grep -c 'dangerousCommand' permissions-audit.log`;
    expect(extractBashWriteTargets(cmd)).toEqual([]);
  });

  test("读配置目录的命令：写目标为空（路径出现在命令里 ≠ 要写它）", () => {
    for (const cmd of [
      `cat ~/.sid-code/settings.json`,
      `ls -la ~/.sid-code`,
      `grep -rn sid-code ~/.sid-code/logs/permissions-audit.log | head -20`,
    ]) {
      expect(extractBashWriteTargets(cmd)).toEqual([]);
    }
  });

  test("反向：真写受保护路径时目标必须提出来（防护不能一起被放宽）", () => {
    expect(extractBashWriteTargets(`echo x > .git/hooks/pre-commit`)).toContain(
      ".git/hooks/pre-commit",
    );
    expect(extractBashWriteTargets(`cp start.sh .git/hooks/pre-commit`)).toContain(
      ".git/hooks/pre-commit",
    );
    expect(extractBashWriteTargets(`tee .git/hooks/pre-commit < payload`)).toContain(
      ".git/hooks/pre-commit",
    );
  });
});

describe("B. 端到端：headless 下只读命令的拒绝理由不含「安全检查」", () => {
  test("文档点名的两条命令", async () => {
    const checker = makeHeadlessChecker();
    for (const command of [
      `cd /tmp && pwd && printf '%s\\n' 'let a = "zz";' > p7.js && cat p7.js`,
      `cd ~/.sid-code/logs && grep -c 'dangerousCommand' permissions-audit.log`,
    ]) {
      const text = await whatTheModelSees(checker, "bash", { command });
      // 仍然会被 bash 自身的「需确认」拦（headless 落成 deny）——那是另一条规则，
      // 本用例只要求它**不是**被 safetyCheck 的错误前提拦的。
      expect(text).not.toContain("安全检查");
    }
  });

  test("对照：真的写配置目录仍然命中「安全检查」", async () => {
    const checker = makeHeadlessChecker();
    // 工作区内写 `.sid-code/settings.json`：路径校验放行，只剩 safetyCheck 这道。
    const text = await whatTheModelSees(checker, "write", {
      file_path: join(ws, ".sid-code", "settings.json"),
      content: "{}",
    });
    expect(text).toContain("安全检查");
  });

  test("对照：bash 写配置目录同样命中「安全检查」", async () => {
    const checker = makeHeadlessChecker();
    const text = await whatTheModelSees(checker, "bash", {
      command: `cp /tmp/x ${ws}/.sid-code/settings.json`,
    });
    expect(text).toContain("安全检查");
  });
});
