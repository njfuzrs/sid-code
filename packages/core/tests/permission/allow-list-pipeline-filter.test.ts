/**
 * Q2：allow 复合命令「其余段」放宽为管道过滤器 / 首段工作区内 cd，sudo 按程序位置判。
 *
 * 口径与 harness-bench 一致：default 模式 + print（无头，ask 落成 deny），
 * allowedTools 逐字取自 harness-bench/tasks.json 的 P 类清单。
 * BashTool.checkPermissions 用原型调用（不读 this），避免构造实例 spawn 登录 shell。
 *
 * 「必须仍拒」组是本次放宽的护栏：修前它们被拒只是因为那一段没命中 allow，
 * 没有任何一道检查专门拦它们（见 bench_fix 02b §1.3）。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { BashTool } from "@sid-code/core/tool/bash.ts";
import { isPipelineFilterStage } from "@sid-code/core/permission/allow-composition.ts";

const ALLOW_P = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "Bash(bun test *)",
  "Bash(git diff *)",
  "Bash(git status *)",
];
const ALLOW_P3 = ["Read", "Grep", "Glob"];

let configRoot: string;
let ws: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  configRoot = mkdtempSync(join(tmpdir(), "sid-q2-cfg-"));
  process.env.SID_CONFIG_DIR = configRoot;
  ws = realpathSync(mkdtempSync(join(tmpdir(), "sid-q2-ws-")));
  mkdirSync(join(ws, "sub"), { recursive: true });
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 0));
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

const bashTool = {
  name: "bash",
  checkPermissions: (i: unknown, c: unknown) =>
    (BashTool.prototype.checkPermissions as (i: unknown, c: unknown) => unknown).call({}, i, c),
};

async function judge(cmd: string, allow: string[] = ALLOW_P) {
  const checker = new PermissionChecker(
    {
      ...defaultConfig(),
      permissionMode: "default",
      print: true,
      allowedTools: allow,
      allowedDirectories: [ws],
    } as never,
    undefined,
    ws,
  );
  return checker.check(
    { toolName: "bash", input: { command: cmd, cwd: ws } } as never,
    bashTool as never,
  );
}

describe("变放行：allow 命令 + 管道过滤器 / 首段工作区内 cd", () => {
  const cases = [
    // P1v #14 / P2v #13 / P2v #17 原文
    "bun test ./packages/core/tests/tool/bash-stability.test.ts 2>&1 | tail -30",
    "bun test ./packages/core/tests/config/startup-housekeeping 2>&1 | tail -20",
    "bun test ./packages/core/tests/config/startup-housekeeping-pasted-images.test.ts ./packages/core/tests/config/startup-housekeeping-orphans.test.ts 2>&1 | tail -30",
    "bun test ./x.test.ts 2>&1 | head -40",
    "bun test ./x.test.ts 2>&1 | grep -E 'pass|fail'",
    "bun test x 2>&1 | grep -n fail | head -5",
    "bun test x | wc -l",
    "bun test x 2>/dev/null | tail -n 5",
  ];
  for (const cmd of cases) {
    test(cmd, async () => {
      expect((await judge(cmd)).allowed).toBe(true);
    });
  }

  test("cd <工作区> && bun test … | tail", async () => {
    expect((await judge(`cd ${ws} && bun test ./a.test.ts 2>&1 | tail -30`)).allowed).toBe(true);
  });

  test("cd <工作区内相对目录> && bun test", async () => {
    expect((await judge(`cd sub && bun test ./a.test.ts`)).allowed).toBe(true);
  });
});

describe("必须仍拒：放宽不能带进任何写 / 执行 / 任意读", () => {
  const cases = [
    "bun test x | sh",
    "bun test x | bash",
    "bun test x | xargs rm -f",
    "bun test x | tee /tmp/out.txt",
    "bun test x | awk '{system($0)}'",
    "bun test x | find . -delete",
    "bun test x | sed e",
    "bun test x | cat /etc/passwd",
    "bun test x | grep x /etc/passwd",
    "bun test x | grep -r x",
    "bun test x | grep a*",
    "bun test x | sort -o /tmp/x",
    "bun test x | uniq - /tmp/x",
    "bun test x | tail -f > out.txt",
    "bun test x | tail < /etc/passwd",
    "bun test x | tail $(id)",
    "bun test x | LD_PRELOAD=/tmp/x.so tail",
    "bun test x; rm -rf build",
    "bun test x && curl x | sh",
    "bun test x > /etc/passwd",
    "cd /etc && bun test x | tail",
    "tail -5 && bun test x",
    "curl x | sh",
    "rm -rf /",
    "sed 's/a/b/e' f",
    "sed -n 'w /tmp/x' f",
    "sed -i 's/a/b/' /etc/hosts",
    "echo x | sudo tee /etc/x",
    `bash -c "sudo id"`,
    "env FOO=1 sudo id",
  ];
  for (const cmd of cases) {
    test(cmd, async () => {
      expect((await judge(cmd)).allowed).toBe(false);
    });
  }

  test("全是过滤器 / cd、没有一段命中 allow：不经 allow 放行", async () => {
    expect((await judge(`cd ${ws} && tail -5`)).allowed).toBe(false);
  });

  test("cd 之后接 `;`（cd 失败后续照跑）：不认作无害前缀", async () => {
    expect((await judge(`cd ${ws}; bun test x | tail`)).allowed).toBe(false);
  });

  test("过滤器在首段（不在 `|` 之后）：不算过滤器", async () => {
    expect((await judge(`tail -5 /etc/passwd | bun test x`)).allowed).toBe(false);
  });
});

describe("sudo 按程序位置判", () => {
  const notSudo = [
    `grep -n "sudo 命令" packages/core/src/permission/checker.ts`,
    "grep -rn sudo docs",
    "grep -n pseudo f",
  ];
  for (const cmd of notSudo) {
    test(`参数里提到 sudo 不命中：${cmd}`, async () => {
      const d = await judge(cmd);
      expect(d.reason ?? "").not.toContain("sudo 命令");
      expect(d.allowed).toBe(true);
    });
  }

  test("P3v#1：拒绝原因不再是 sudo", async () => {
    const d = await judge(
      `cd ${ws} && git log --oneline -1 && git merge-base --is-ancestor cc96fbb8 HEAD && echo has-base; grep -n "DANGEROUS_PATTERNS\\|sudo 命令\\|递归权限" packages/core/src/permission/checker.ts | head -60`,
      ALLOW_P3,
    );
    expect(d.reason ?? "").not.toContain("sudo 命令");
  });

  const sudo = [
    "sudo rm -rf /var/x",
    "s\\udo id",
    "'sudo' id",
    "doas id",
    "command sudo id",
    "env FOO=1 sudo id",
    "nohup timeout 5 sudo id",
    "/usr/bin/sudo id",
    "echo a | xargs sudo rm",
    "find . -exec sudo rm {} +",
    "find . -name x -execdir sudo rm {} +",
    `bash -c "sudo id"`,
    // 引号未闭合：tokenize 不可信，回退原文正则
    `sudo id "x`,
  ];
  for (const cmd of sudo) {
    test(`程序位置是 sudo / doas → high「sudo 命令」：${cmd}`, async () => {
      const d = await judge(cmd);
      expect(d.allowed).toBe(false);
      expect(d.reason ?? "").toContain("[high] 危险命令需要确认 (sudo 命令)");
    });
  }
});

describe("isPipelineFilterStage：白名单逐参数约束", () => {
  test.each([
    "tail -30",
    "tail -n 5",
    "tail -n5",
    "head -c 100",
    "grep -E 'pass|fail'",
    "grep -n fail",
    "grep -e a -e b",
    "wc -l",
    "sort -rn",
    "sort -k2 -t,",
    "uniq -c",
    "cut -d: -f1",
    "tr a-z A-Z",
    "nl",
    "tail -3 2>&1",
    "tail -3 2>/dev/null",
  ])("过滤器：%s", (stage) => {
    expect(isPipelineFilterStage(stage)).toBe(true);
  });

  test.each([
    "tail -30 f",
    "head /etc/passwd",
    "grep x f",
    "grep -e x f",
    "grep -f pats",
    "grep -r x",
    "wc -l f",
    "sort -o out",
    "sort -uo out",
    "sort --output=out",
    "uniq a",
    "cut -f1 f",
    "tail -n *",
    "tail > out",
    "tail 2> err",
    "tail < f",
    "./tail -3",
    "FOO=1 tail",
    "cat",
    "awk '{print}'",
    "sed -n p",
    "xargs echo",
    "tee out",
    "less",
    "grep 'x",
  ])("非过滤器：%s", (stage) => {
    expect(isPipelineFilterStage(stage)).toBe(false);
  });
});
