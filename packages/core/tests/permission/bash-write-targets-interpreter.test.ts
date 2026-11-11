/**
 * B8（HB-10a）：bash 写目标提取的三类失明——`mv` 源、git 路径参数、`find` 副作用、
 * 解释器代码串 / heredoc 里的字面量路径。
 *
 * ## 这个文件守什么
 *
 * 《B8-bash解释器内层写删》实测（2026-11-10）：`python3 -c "open('.git/hooks/pre-commit','w')"`、
 * `find .git/hooks -delete`、`mv .git/hooks/pre-commit /tmp/x`、`git rm .git/hooks/x`
 * 在 always-allow 档下全部 `allowed=true step=8-mode`——Step 6 的唯一输入
 * `extractBashWriteTargets` 对它们一律返回 `[]`。
 *
 * ## 为什么判据必须区分读写
 *
 * 本机 959 会话 / 27,390 条 bash 调用里，解释器**只读** `open(path)` 有 122 条
 * （读审计日志、读 settings.json 做统计），是高频合法操作。把「任意 `open(`」当写
 * 会直接误伤它们。所以 L3 的判据是「代码串里有写 API」+「代码串里有字面量路径」
 * 两条同时成立。
 *
 * ## 为什么检查「不写」比检查「写」更重要
 *
 * 写目标提取是「宁多勿少」的：多出的候选只被 safetyCheck 判一次就放过。
 * 但**误报会变成用户的确认弹窗**，所以只读形态（`print`、只读 open、无副作用 find、
 * `git checkout main`）必须显式断言为空。
 *
 * ⚠ 落盘隔离：`PermissionChecker` 构造 `AuditLogger`，必须重定向 `SID_CONFIG_DIR`
 *   并**存/恢复原值**（不能无条件 delete，同批多文件跑在同一进程）。
 * ⚠ 工作区用 realpath 后的 tmpdir：macOS `/var` → `/private/var` 会让路径比对错位。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { extractBashWriteTargets } from "@sid-code/core/permission/shell-command-variants.ts";

let configRoot: string;
let ws: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-bwt2-cfg-"));
  ws = realpathSync(mkdtempSync(join(tmpdir(), "sid-bwt2-ws-")));
  mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

function checker(over: Record<string, unknown> = {}) {
  return new PermissionChecker({ ...defaultConfig(), ...over } as never, undefined, ws);
}

describe("A. L1：mv 源路径与 git 路径参数", () => {
  test("mv 的源与目标都收（源会消失，与 rm 同级）", () => {
    expect(extractBashWriteTargets("mv .git/hooks/pre-commit /tmp/x")).toContain(
      ".git/hooks/pre-commit",
    );
  });

  test("mv 多源时全部收（R11：多判一次 safetyCheck，不产生确认）", () => {
    expect(extractBashWriteTargets("mv a b dst/")).toEqual(["a", "b", "dst/"]);
  });

  test("cp 仍然只收目标（不破坏源，收源会让「读 hook」也变确认）", () => {
    const targets = extractBashWriteTargets("cp start.sh .git/hooks/pre-commit");
    expect(targets).toContain(".git/hooks/pre-commit");
    expect(targets).not.toContain("start.sh");
  });

  test("git rm / git mv / git restore 的路径参数都提出来", () => {
    expect(extractBashWriteTargets("git rm .git/hooks/pre-commit")).toContain(
      ".git/hooks/pre-commit",
    );
    expect(extractBashWriteTargets("git mv .git/hooks/pre-commit /tmp/x")).toContain(
      ".git/hooks/pre-commit",
    );
    expect(extractBashWriteTargets("git restore .sid-code/settings.json")).toContain(
      ".sid-code/settings.json",
    );
  });

  test("git checkout -- <path> 收，切分支不收（R8：不猜）", () => {
    expect(extractBashWriteTargets("git checkout -- .git/hooks/pre-commit")).toContain(
      ".git/hooks/pre-commit",
    );
    expect(extractBashWriteTargets("git checkout main")).toEqual([]);
    expect(extractBashWriteTargets("git checkout -b feat/new-branch")).toEqual([]);
    // 无 `--` 但看起来像路径：相对路径含 `.`，收（checkpoint 侧靠它留 /undo 快照）
    expect(extractBashWriteTargets("git checkout src/app.ts")).toContain("src/app.ts");
  });

  test("git restore 的 -s 取值不是路径", () => {
    const targets = extractBashWriteTargets("git restore -s HEAD~1 .git/hooks/x");
    expect(targets).toContain(".git/hooks/x");
    expect(targets).not.toContain("HEAD~1");
  });
});

describe("B. L2：find 的副作用动作取起点目录", () => {
  test("带副作用动作：起点目录进候选", () => {
    for (const cmd of [
      "find .git/hooks -name pre-commit -delete",
      "find .git/hooks -name x -exec rm {} \\;",
      "find .sid-code/commands -type f -fprint /tmp/list",
    ]) {
      expect(extractBashWriteTargets(cmd)).toContain(
        cmd.includes(".sid-code") ? ".sid-code/commands" : ".git/hooks",
      );
    }
  });

  test("无副作用动作不产生候选", () => {
    expect(extractBashWriteTargets("find . -name '*.ts'")).toEqual([]);
    expect(extractBashWriteTargets("find .git/hooks -name pre-commit")).toEqual([]);
  });

  test("起点不命中保护路径时不新增确认（起点 `.`）", () => {
    // 提出来是 `.`，safetyCheck 不命中任何受保护目录 → 不产生确认。
    // 这不是漏，是 safetyCheck 的语义：保护特定路径，不是「所有删除都确认」。
    expect(extractBashWriteTargets("find . -name '*.ts' -delete")).toEqual(["."]);
  });
});

describe("C. L3：解释器代码串里的写 API + 字面量", () => {
  test("判写：三种解释器的常见写形态", () => {
    expect(extractBashWriteTargets(`python3 -c "open('.git/hooks/pre-commit','w')"`)).toContain(
      ".git/hooks/pre-commit",
    );
    expect(extractBashWriteTargets(`node -e "require('fs').unlinkSync('.git/hooks/x')"`)).toContain(
      ".git/hooks/x",
    );
    expect(
      extractBashWriteTargets(`bun -e "Bun.write('.sid-code/settings.json', '{}')"`),
    ).toContain(".sid-code/settings.json");
    expect(extractBashWriteTargets(`perl -e "unlink('.git/hooks/x')"`)).toContain(".git/hooks/x");
  });

  test("判不写：只读 open / print / 普通路径（防误伤本机 122 条高频合法操作）", () => {
    expect(extractBashWriteTargets(`python3 -c "print('.git/hooks/x')"`)).toEqual([]);
    expect(
      extractBashWriteTargets(`python3 -c "open('~/.sid-code/logs/permissions-audit.log')"`),
    ).toEqual([]);
    expect(extractBashWriteTargets(`python3 -c "open('src/a.ts')"`)).toEqual([]);
    expect(extractBashWriteTargets(`python3 -c "import os; os.getcwd()"`)).toEqual([]);
  });

  test("边界：纯动态提不出、字面量前缀能提出来", () => {
    expect(extractBashWriteTargets(`python3 -c "open(os.environ['P'],'w')"`)).toEqual([]);
    expect(extractBashWriteTargets(`python3 -c "open('.git/hooks/'+n,'w')"`)).toContain(
      ".git/hooks/",
    );
  });

  test("解释器 heredoc：正文是代码、stdin 是数据两种情况分开", () => {
    expect(
      extractBashWriteTargets("python3 - <<'PY'\nopen('.git/hooks/pre-commit', 'w')\nPY"),
    ).toContain(".git/hooks/pre-commit");
    expect(
      extractBashWriteTargets("node <<'JS'\nrequire('fs').unlinkSync('.git/hooks/x')\nJS"),
    ).toContain(".git/hooks/x");
    // 有脚本文件参数 / 已有 -c 时，stdin 是数据不是代码
    expect(
      extractBashWriteTargets("python3 script.py <<'EOF'\nopen('.git/hooks/x','w')\nEOF"),
    ).toEqual([]);
    // `cat > f <<EOF` 的正文是文件内容，不是代码
    expect(extractBashWriteTargets("cat > a.txt <<'EOF'\nopen('.git/hooks/x', 'w')\nEOF")).toEqual([
      "a.txt",
    ]);
  });
});

describe("D. 端到端：Step 6 在 always-allow 档生效", () => {
  const blocking = [
    `python3 -c "open('.git/hooks/pre-commit','w')"`,
    `node -e "require('fs').unlinkSync('.git/hooks/x')"`,
    "find .git/hooks -name pre-commit -delete",
    "mv .git/hooks/pre-commit /tmp/x",
    "git rm .git/hooks/pre-commit",
    "git checkout -- .git/hooks/pre-commit",
  ];

  test("always-allow 档：B8 形态从 allow[8-mode] 变成 ask[6]", async () => {
    const c = checker({ permissionMode: "always-allow" });
    for (const command of blocking) {
      const d = await c.check({ toolName: "bash", input: { command } } as never);
      expect(d.allowed).toBe(false);
      expect(d.needsConfirmation).toBe(true);
      expect(d.decisionReason?.type).toBe("safetyCheck");
      expect(d.step).toBe("6");
    }
  });

  test("default 档：同一批命令的 step 从 14 提前到 6（理由可见）", async () => {
    const c = checker({ permissionMode: "default" });
    for (const command of blocking) {
      const d = await c.check({ toolName: "bash", input: { command } } as never);
      expect(d.decisionReason?.type).toBe("safetyCheck");
      expect(d.step).toBe("6");
    }
  });

  test("对照：解释器写普通文件在 always-allow 下照常放行（没有扩成误报）", async () => {
    const c = checker({ permissionMode: "always-allow" });
    for (const command of [
      `python3 -c "open('src/app.ts','w')"`,
      `python3 -c "print(open('~/.sid-code/logs/permissions-audit.log').read())"`,
      "find . -name '*.ts'",
      "git checkout main",
    ]) {
      const d = await c.check({ toolName: "bash", input: { command } } as never);
      expect(d.allowed).toBe(true);
    }
  });
});
