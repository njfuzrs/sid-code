/**
 * PR-3（B5）：只读命令的读路径工作区校验
 *
 * 修的是两个方向都和 CC 不一致的行为：
 * - `cat /etc/hosts`（工作区外）在 Step 5.5 被自动放行，静默越界读；
 * - `cat ../README.md`（cwd=`<ws>/packages`，目标在工作区内）反被 Step 2 的
 *   「路径遍历」文本正则拦成危险确认。
 *
 * 两层用例：
 * - **纯逻辑**（本文件）：提取器认哪些参数是路径、按哪段 cwd 解析、哪些路径豁免；
 * - **接入**（`readonly-read-paths-integration.test.ts`）：真实 `PermissionChecker`
 *   在 default / acceptEdits 下的完整矩阵。
 *
 * 落盘全部重定向到 tmpdir（CONTRIBUTING 测试约定）。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectReadOnlyReadPaths,
  createSidSelfReadPathFilter,
} from "@sid-code/core/permission/readonly-read-paths.ts";
import { extractBashReadTargets } from "@sid-code/core/permission/shell-command-variants.ts";

let configRoot: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  configRoot = mkdtempSync(join(tmpdir(), "sid-pr3-cfg-"));
  // `sidPaths.*` 由 SID_CONFIG_DIR 派生 → 豁免判定才不会读用户真实的 ~/.sid-code
  process.env.SID_CONFIG_DIR = configRoot;
});

afterAll(async () => {
  // 落盘走 import().then() 的场景先让微任务跑干再恢复 env（CONTRIBUTING 测试约定）
  await new Promise((r) => setTimeout(r, 0));
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
});

describe("extractBashReadTargets：哪些参数是路径", () => {
  test("文件查看命令取全部非选项参数", () => {
    expect(extractBashReadTargets("cat a b")).toEqual(["a", "b"]);
    expect(extractBashReadTargets("head -n 5 f")).toEqual(["f"]);
    expect(extractBashReadTargets("tail -c 100 f")).toEqual(["f"]);
    expect(extractBashReadTargets("wc -l f")).toEqual(["f"]);
    expect(extractBashReadTargets("ls -la dir")).toEqual(["dir"]);
    expect(extractBashReadTargets("file -b f")).toEqual(["f"]);
    expect(extractBashReadTargets("du -d 2 dir")).toEqual(["dir"]);
  });

  test("grep/rg 跳过模式与 -e/-f 的值", () => {
    expect(extractBashReadTargets("grep -rn foo ../scripts")).toEqual(["../scripts"]);
    expect(extractBashReadTargets("grep -e foo f")).toEqual(["f"]);
    expect(extractBashReadTargets("rg foo src")).toEqual(["src"]);
    expect(extractBashReadTargets("grep -A 3 pattern f")).toEqual(["f"]);
  });

  test("sed/awk/jq 跳过脚本或 filter", () => {
    expect(extractBashReadTargets("sed -n 1,5p f")).toEqual(["f"]);
    expect(extractBashReadTargets("sed -e s/a/b/ f")).toEqual(["f"]);
    expect(extractBashReadTargets("jq .a f.json")).toEqual(["f.json"]);
  });

  test("find 取起点、diff 取两个操作数", () => {
    expect(extractBashReadTargets("find src -name x")).toEqual(["src"]);
    expect(extractBashReadTargets("diff a b")).toEqual(["a", "b"]);
  });

  test("git 不提取（由只读 git 的边界判定管）", () => {
    expect(extractBashReadTargets("git log --oneline")).toEqual([]);
    expect(extractBashReadTargets("git show HEAD:README.md")).toEqual([]);
  });

  test("非读类命令不提取：`echo /etc/passwd` 只是打印一个字符串", () => {
    expect(extractBashReadTargets("echo /etc/passwd")).toEqual([]);
    expect(extractBashReadTargets("printf x")).toEqual([]);
  });

  test("输入重定向的目标也算读路径（`<<`/`<<<` 不是文件）", () => {
    expect(extractBashReadTargets("cat < /etc/passwd")).toEqual(["/etc/passwd"]);
    expect(extractBashReadTargets("cat <<< hello")).toEqual([]);
  });

  test("sh -c 内层同样被看到", () => {
    expect(extractBashReadTargets("sh -c 'cat /etc/hosts'")).toEqual(["/etc/hosts"]);
  });
});

describe("collectReadOnlyReadPaths：相对路径按有效 cwd 解析", () => {
  test("无 cd：按 startCwd 解析", () => {
    expect(
      collectReadOnlyReadPaths({ command: "cat ../README.md", startCwd: "/ws/packages" }),
    ).toEqual([{ raw: "../README.md", abs: "/ws/README.md" }]);
  });

  test("cd 复合：按该段 cwd 解析（不是整条命令的起始 cwd）", () => {
    // `cd sub && cat ../README.md`：`../` 的基准是 /ws/sub，不是 /ws
    expect(
      collectReadOnlyReadPaths({
        command: "cd sub && cat ../README.md",
        startCwd: "/ws",
        stages: [{ unit: "cat ../README.md", cwds: ["/ws/sub"] }],
      }),
    ).toEqual([{ raw: "../README.md", abs: "/ws/README.md" }]);
  });

  test("`;` 造成多个 cwd 候选时，每个候选各解析一次（宁多问一次）", () => {
    const targets = collectReadOnlyReadPaths({
      command: "cd sub; cat a",
      startCwd: "/ws",
      stages: [{ unit: "cat a", cwds: ["/ws", "/ws/sub"] }],
    });
    expect(targets.map((t) => t.abs).sort()).toEqual(["/ws/a", "/ws/sub/a"]);
  });

  test("绝对路径不受 cwd 影响；~ 展开", () => {
    const targets = collectReadOnlyReadPaths({ command: "cat /etc/hosts", startCwd: "/ws" });
    expect(targets[0]!.abs).toBe("/etc/hosts");
    const home = collectReadOnlyReadPaths({ command: "cat ~/x", startCwd: "/ws" });
    expect(home[0]!.abs.startsWith("/")).toBe(true);
    expect(home[0]!.abs.endsWith("/x")).toBe(true);
  });
});

describe("createSidSelfReadPathFilter：J4 豁免范围", () => {
  test("sid 自己让模型去读的路径放行", () => {
    const filter = createSidSelfReadPathFilter();
    const sidHome = configRoot;
    expect(filter(join(sidHome, "tasks", "abc.output"))).toBe(true);
    expect(filter(join(sidHome, "plans", "proj", "p.md"))).toBe(true);
    expect(filter(join(sidHome, "trajectories", "sessions", "s1", "tool-outputs", "x.txt"))).toBe(
      true,
    );
  });

  test("不豁免整个 ~/.sid-code：settings.json / 账本照旧要确认", () => {
    const filter = createSidSelfReadPathFilter();
    const sidHome = configRoot;
    expect(filter(join(sidHome, "settings.json"))).toBe(false);
    expect(filter(join(sidHome, "usage-ledger.jsonl"))).toBe(false);
    expect(filter(join(sidHome, "tasks"))).toBe(true); // 目录自身
    expect(filter(join(sidHome, "tasks-evil", "x"))).toBe(false); // 前缀不能误伤
  });
});
