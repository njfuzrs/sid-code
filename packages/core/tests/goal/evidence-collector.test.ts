/**
 * Evidence Collector 单测
 *
 * 验证自动证据提取逻辑：从工具调用结果中识别 test_result、build_result、
 * command_output、file_change 四种证据类型。
 */

import { describe, test, expect } from "bun:test";
import {
  collectEvidence,
  collectEvidenceFromTurn,
} from "@sid-code/core/goal/evidence-collector.ts";

describe("collectEvidence", () => {
  test("从 bash 测试输出提取 test_result 证据", () => {
    const result = collectEvidence(
      "bash",
      "$ bun test\n✓ 40 tests passed\n✗ 2 failures\n  FAIL auth/login.test.ts",
      5,
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("test_result");
    expect(result!.turn).toBe(5);
    expect(result!.summary).toBeDefined();
    expect(result!.raw).toContain("2 failures");
  });

  test("测试全通过也提取 test_result", () => {
    const result = collectEvidence("bash", "bun test v1.0.0\n42 tests passed\n0 failures", 3);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("test_result");
    expect(result!.summary).toContain("42");
  });

  test("从 tsc 输出提取 build_result 证据", () => {
    const result = collectEvidence(
      "bash",
      "$ tsc --noEmit\nerror TS2345: Argument of type 'string' is not assignable",
      3,
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("build_result");
    expect(result!.summary).toContain("TS2345");
  });

  test("构建成功也提取 build_result", () => {
    const result = collectEvidence(
      "Bash",
      "$ esbuild src/index.ts --bundle\nBuild success, 1 file built in 0.3s",
      4,
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("build_result");
  });

  test("普通命令输出提取 command_output", () => {
    const result = collectEvidence("bash", "$ ls\nfile1.ts\nfile2.ts", 2);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("command_output");
    expect(result!.summary).toContain("file1.ts");
  });

  test("Write 工具提取 file_change 证据", () => {
    const result = collectEvidence("Write", "Wrote 42 lines to src/foo.ts", 4);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("file_change");
    expect(result!.summary).toContain("文件修改");
  });

  test("Edit 工具提取 file_change 证据", () => {
    const result = collectEvidence("Edit", "Updated src/bar.ts", 6);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("file_change");
  });

  test("空输出返回 null", () => {
    const result = collectEvidence("bash", "", 1);
    expect(result).toBeNull();
  });

  test("非 bash/Write/Edit 工具返回 null", () => {
    const result = collectEvidence("Read", "file content here", 1);
    expect(result).toBeNull();
  });

  test("raw 字段截断超长输出", () => {
    const longOutput = "x".repeat(5000) + "\n10 tests passed";
    const result = collectEvidence("bash", longOutput, 1);
    expect(result).not.toBeNull();
    expect(result!.raw!.length).toBeLessThanOrEqual(2000);
  });
});

describe("collectEvidenceFromTurn", () => {
  test("批量提取多个工具结果的证据", () => {
    const results = collectEvidenceFromTurn(
      [
        { toolName: "bash", result: "bun test v1.0.0\n42 tests passed\n0 failures" },
        { toolName: "Write", result: "Wrote 10 lines to src/fix.ts" },
        { toolName: "Read", result: "some content" },
      ],
      7,
    );
    expect(results.length).toBe(2); // bash + Write，Read 被过滤
    expect(results[0].type).toBe("test_result");
    expect(results[1].type).toBe("file_change");
  });

  test("空列表返回空数组", () => {
    const results = collectEvidenceFromTurn([], 1);
    expect(results).toEqual([]);
  });
});
