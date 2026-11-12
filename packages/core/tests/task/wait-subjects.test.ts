/**
 * R2：等待对象签名（subject）的抽取口径。
 *
 * 这一层是「同一个对象只允许一个等待」的事实来源，判错的后果是双向的：
 * - 抽不出 → 不参与去重（回到改动前的样子，多起一个进程）；
 * - 抽错 → 把两个无关的等待判成重复，模型真正想要的第二个等待被拒。
 *
 * 所以每条正向用例都配一条反例，尤其是「宁可抽不出也不产伪签名」那组
 * （`gh pr checks "$pr"` 在 `pr` 无赋值时不许产生 `gh:pr:$pr`）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  collectWaitScriptBodies,
  extractWaitSubjectsFor,
  hashScriptBodies,
  normalizeWaitCommand,
} from "../../src/task/wait-subjects.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sid-wait-subjects-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("R2 命令行抽取", () => {
  test("命令表命中的查询抽成对象签名", () => {
    expect(extractWaitSubjectsFor({ command: "gh pr checks 779 --watch" }).subjects).toEqual([
      "gh:pr:779",
    ]);
    expect(extractWaitSubjectsFor({ command: "gh run view 12345 --log-failed" }).subjects).toEqual([
      "gh:run:12345",
    ]);
  });

  test("过滤器 / 复合命令里的查询段也能抽出来（复用 P1 的切片）", () => {
    expect(extractWaitSubjectsFor({ command: "gh pr checks 779 | head -30" }).subjects).toEqual([
      "gh:pr:779",
    ]);
    expect(
      extractWaitSubjectsFor({ command: "for i in 1 2 3; do gh pr view 780; sleep 30; done" })
        .subjects,
    ).toEqual(["gh:pr:780"]);
  });

  // 反例：抽不出对象的命令一律返回空数组，让调用方放行（R2 修法 4）
  test("没有对象 / 含写操作的命令抽不出签名", () => {
    for (const command of [
      "bun test",
      "git push",
      "gh pr merge 779 --squash",
      "npm run build",
      "sleep 30",
    ]) {
      expect(extractWaitSubjectsFor({ command }).subjects).toEqual([]);
    }
  });
});

describe("R2 脚本正文展开", () => {
  test("bash <绝对路径>：从脚本里抽到变量赋值的对象（b0aa0f1e 的形态）", () => {
    const dir = tempDir();
    const script = join(dir, "wait-pr-779.sh");
    writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "pr=779",
        "while true; do",
        '  s=$(gh pr checks "$pr" --json name,bucket 2>&1)',
        '  echo "$s"',
        "  sleep 30",
        "done",
        "",
      ].join("\n"),
    );

    expect(extractWaitSubjectsFor({ command: `bash ${script}`, cwd: dir }).subjects).toEqual([
      "gh:pr:779",
    ]);
    // 命令行本身只有一句 `bash xxx.sh`，不读脚本就抽不到任何对象
    expect(
      extractWaitSubjectsFor({ command: `bash ${script}`, scriptBodies: [], cwd: dir }).subjects,
    ).toEqual([]);
  });

  test("cd <dir> && bash <相对路径>：相对路径按 cd 之后的工作目录解析", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "wait.sh"), 'pr=757\ngh pr view "$pr" --json state\n');

    const extracted = extractWaitSubjectsFor({
      command: "cd /tmp && cd " + dir + " && bash wait.sh",
    });
    expect(extracted.subjects).toEqual(["gh:pr:757"]);
  });

  test("chmod +x 之后再执行（ca8d7e5c 的写法）", () => {
    const dir = tempDir();
    const script = join(dir, "wait-pr-780.sh");
    writeFileSync(script, 'pr=780\ngh pr checks "$pr"\n');

    expect(
      extractWaitSubjectsFor({ command: `chmod +x ${script} && bash ${script}`, cwd: dir })
        .subjects,
    ).toEqual(["gh:pr:780"]);
  });

  test("读不到的脚本静默跳过（不是错误，也不产伪签名）", () => {
    expect(
      extractWaitSubjectsFor({ command: "bash /nonexistent/wait-pr-779.sh", cwd: "/tmp" }).subjects,
    ).toEqual([]);
  });

  test("collectWaitScriptBodies 只认脚本参数，不把命令行 flag 当文件", () => {
    expect(collectWaitScriptBodies("bash -eux /nonexistent/a.sh", "/tmp")).toEqual([]);
    expect(collectWaitScriptBodies("bun test", "/tmp")).toEqual([]);
  });

  // 反例：变量抽不出值时**不许**把 `$pr` 原样带进签名（`gh:pr:$pr` 与任何真实 subject
  // 都不相等，留着只会污染回执与审计）。命令表对「没写 PR 号」的既有口径是
  // `gh:pr:current`（当前分支的 PR），这里跟随它——两套口径分叉比退化更糟。
  test("变量无赋值时退化为 current 口径，不产 $ 伪签名", () => {
    for (const command of ['gh pr checks "$pr"', "gh pr checks $pr"]) {
      const subjects = extractWaitSubjectsFor({ command }).subjects;
      expect(subjects).toEqual(["gh:pr:current"]);
      expect(subjects.some((s) => s.includes("$"))).toBe(false);
    }
  });
});

describe("R2 自然语言抽取（唤醒 prompt）", () => {
  test("prompt 里的 PR 号抽成签名", () => {
    expect(extractWaitSubjectsFor({ prompt: "看看 PR #780 的 CI 过了没有" }).subjects).toEqual([
      "gh:pr:780",
    ]);
    expect(extractWaitSubjectsFor({ prompt: "继续等 CI，" }).subjects).toEqual([]);
  });
});

describe("R2 命令归一化", () => {
  test("去掉 cd / chmod 前缀，合并空白", () => {
    expect(normalizeWaitCommand("cd /tmp && bash wait.sh")).toBe("bash wait.sh");
    expect(normalizeWaitCommand("cd /a && cd /b && bash x.sh")).toBe("bash x.sh");
    expect(normalizeWaitCommand("chmod +x /tmp/wait.sh && bash /tmp/wait.sh")).toBe(
      "bash /tmp/wait.sh",
    );
    expect(normalizeWaitCommand("  gh   pr   checks  779 ")).toBe("gh pr checks 779");
  });

  test("不改写参数顺序与语义（判不出就让它走 replace）", () => {
    expect(normalizeWaitCommand("bash a.sh --flag x")).toBe("bash a.sh --flag x");
    expect(normalizeWaitCommand("bash a.sh --flag x")).not.toBe(
      normalizeWaitCommand("bash a.sh --flag y"),
    );
  });
});

describe("R2 脚本正文哈希", () => {
  test("同内容稳定、不同内容可区分、无脚本为 undefined", () => {
    expect(hashScriptBodies([])).toBeUndefined();
    const a = hashScriptBodies(["pr=779\ngh pr checks 779\n"]);
    expect(a).toBe(hashScriptBodies(["pr=779\ngh pr checks 779\n"]));
    expect(a).not.toBe(hashScriptBodies(["pr=779\ngh pr checks 779 --watch\n"]));
  });
});
