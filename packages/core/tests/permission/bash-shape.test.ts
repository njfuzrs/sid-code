/**
 * B12：bash 命令形状分类（`classifyBashShape`）单测。
 *
 * 五个桶的判据与附录 A.3 的分桶脚本一致 —— 那份脚本算出了基线数字（§1.4），
 * 判据不同就无法对拍，所以这里逐桶钉死，包括「工作区前缀匹配」这个刻意粗糙的
 * 上界估计（不看 git 仓库身份）。
 *
 * 为什么这个分类不放在 digest 里重算：`events.jsonl` 里存的是**截断后**的命令文本，
 * 从截断文本重跑判据会把长命令整段误判成「非只读其他」。分类必须在决策时算。
 */
import { describe, test, expect } from "bun:test";
import { classifyBashShape } from "@sid-code/core/permission/bash-shape.ts";

const WS = "/Users/x/proj";

describe("classifyBashShape：五个形状桶", () => {
  test("危险命令优先于一切形状（与 A.3 的 reason_type 判序一致）", () => {
    // 危险判定已经是决策结论，即使命令形如 `cd ws && rm -rf x` 也归 dangerous
    expect(
      classifyBashShape({
        command: `cd ${WS} && rm -rf build`,
        workspacePath: WS,
        dangerous: true,
      }),
    ).toBe("dangerous");
  });

  test("无 cd 前缀 → no_cd_prefix（含普通只读命令）", () => {
    expect(classifyBashShape({ command: "git status", workspacePath: WS, dangerous: false })).toBe(
      "no_cd_prefix",
    );
    expect(classifyBashShape({ command: "ls -la", workspacePath: WS, dangerous: false })).toBe(
      "no_cd_prefix",
    );
  });

  test("cd 到工作区外 → cd_outside_workspace（哪怕主体是只读）", () => {
    expect(
      classifyBashShape({ command: "cd /tmp && ls", workspacePath: WS, dangerous: false }),
    ).toBe("cd_outside_workspace");
    expect(
      classifyBashShape({ command: "cd /etc && cat passwd", workspacePath: WS, dangerous: false }),
    ).toBe("cd_outside_workspace");
    // 已知粗糙点（与 A.3 的裸 startsWith 一致，**刻意不改**）：`/Users/x/proj2` 以
    // `/Users/x/proj` 开头，会被算成工作区内。这是「上界估计」的一部分——
    // 只影响统计桶，不影响权限判定；PR-2 之后由精确的 cd 目标解析取代。
    expect(
      classifyBashShape({
        command: "cd /Users/x/proj2 && ls",
        workspacePath: WS,
        dangerous: false,
      }),
    ).toBe("cd_workspace_readonly");
  });

  test("工作区内 cd + 只读主体 → cd_workspace_readonly", () => {
    expect(
      classifyBashShape({ command: `cd ${WS} && git status`, workspacePath: WS, dangerous: false }),
    ).toBe("cd_workspace_readonly");
    expect(
      classifyBashShape({
        command: `cd ${WS} && ls -la packages`,
        workspacePath: WS,
        dangerous: false,
      }),
    ).toBe("cd_workspace_readonly");
  });

  test("工作区内 cd + 非只读主体 → cd_workspace_nonreadonly", () => {
    expect(
      classifyBashShape({
        command: `cd ${WS} && bun install`,
        workspacePath: WS,
        dangerous: false,
      }),
    ).toBe("cd_workspace_nonreadonly");
    expect(
      classifyBashShape({
        command: `cd ${WS} && rm -rf dist`,
        workspacePath: WS,
        dangerous: false,
      }),
    ).toBe("cd_workspace_nonreadonly");
  });

  test("env 前缀与引号：cd 目标仍按首段正则解析", () => {
    // A.3 的 LEADING_CD 只看开头是不是 `cd <non-space> &&`，env 前缀在它之前时算 no_cd_prefix
    expect(
      classifyBashShape({ command: "FOO=1 cd /tmp && ls", workspacePath: WS, dangerous: false }),
    ).toBe("no_cd_prefix");
    // 剥离 env 前缀后主体只读：分类仍落在 readonly（主体判据用 stripLeadingCdAndEnv）
    expect(
      classifyBashShape({
        command: `cd ${WS} && FOO=1 git status`,
        workspacePath: WS,
        dangerous: false,
      }),
    ).toBe("cd_workspace_readonly");
  });

  test("空命令 / 纯空白不产生形状（调用方据此不落字段）", () => {
    expect(classifyBashShape({ command: "", workspacePath: WS, dangerous: false })).toBeUndefined();
    expect(
      classifyBashShape({ command: "   ", workspacePath: WS, dangerous: false }),
    ).toBeUndefined();
  });
});
