/**
 * import-trajectory-platform.ts 单测（B6-1 适配器）
 *
 * 覆盖：
 *  - 白名单 lint：5 个 contamination 关键词全部命中即 reject
 *  - secret 扫描：private_key 命中 → reject；email/api_key 仅 warning
 *  - 路径相对化：/project/<repo>/ 通用匹配，绝对 repoRoot 替换
 *  - grader_type 推断：has must_modify_files_in → execution_test，否则 rubric_5d
 *  - buildCaseYaml：白名单字段提取，黑名单字段不外溢
 *  - importTask 端到端：dry-run 不落盘 / target 已存在 + 无 force → reject
 *
 * 不依赖网络 / 真实 LLM；仅依赖 node:fs。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as yamlLib from "yaml";
import {
  scanContamination,
  scanSecrets,
  rewritePaths,
  inferGraderType,
  buildCaseYaml,
  importTask,
  type ImportConfig,
} from "../../evals/scripts/import-trajectory-platform.ts";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = join(tmpdir(), `sid-importer-test-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("scanContamination - §9.1.1 黑名单关键词", () => {
  test("clean 文本 → 0 violations", () => {
    expect(scanContamination("instruction: 修复 logger.ts").length).toBe(0);
  });

  test("命中 5 个 contamination 关键词", () => {
    const dirty = `
foo: bar
tool_result_content: "上一轮答案"
response_content: "..."
patch_content: "diff --git ..."
observation_content: "..."
completion_text: "..."
`;
    const v = scanContamination(dirty);
    expect(v.length).toBe(5);
    // 每条 violation 含 "@line:" 定位
    for (const item of v) expect(item).toMatch(/@line:\d+/);
  });

  test("关键词出现在注释中也命中（保守扫描）", () => {
    const v = scanContamination("# tool_result_content 这个字段是 trajectory 的");
    expect(v.length).toBe(1);
  });
});

describe("scanSecrets - private_key / api_key / email / ip", () => {
  test("private key 必命中", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END...";
    const hits = scanSecrets(text);
    expect(hits.some((h) => h.kind === "private_key")).toBe(true);
  });

  test("email 命中", () => {
    const hits = scanSecrets("contact: dev@example.com");
    expect(hits.some((h) => h.kind === "email")).toBe(true);
  });

  test("api_key 命中（key=value 形式）", () => {
    const hits = scanSecrets('api_key: "sk-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"');
    expect(hits.some((h) => h.kind === "api_key")).toBe(true);
  });

  test("无 secret 时返回空", () => {
    const hits = scanSecrets("hello world\nfoo: bar");
    expect(hits.length).toBe(0);
  });
});

describe("rewritePaths - /project/<repo>/ 通用匹配", () => {
  test("替换 /project/sid-code/", () => {
    const out = rewritePaths("path: /project/sid-code/src/foo.ts", "");
    expect(out).toBe("path: ${REPO_ROOT}/sid-code/src/foo.ts");
  });

  test("替换 /project/claude-code/（多 repo mount 场景）", () => {
    const out = rewritePaths("see /project/claude-code/src/agent.ts", "");
    expect(out).toBe("see ${REPO_ROOT}/claude-code/src/agent.ts");
  });

  test("替换 /project/docs/", () => {
    const out = rewritePaths("doc: /project/docs/spec.md", "");
    expect(out).toContain("${REPO_ROOT}/docs/spec.md");
  });

  test("命中 repoRoot 绝对路径（防机器名泄露）", () => {
    const repoRoot = "/Users/alice/work/sid-code";
    const out = rewritePaths(`abs: ${repoRoot}/src/x.ts`, repoRoot);
    expect(out).toBe("abs: ${REPO_ROOT}/src/x.ts");
  });

  test("不影响普通文本", () => {
    const out = rewritePaths("普通需求描述", "/some/root");
    expect(out).toBe("普通需求描述");
  });
});

describe("inferGraderType - has must_modify_files_in → execution_test", () => {
  test("expected.must_modify_files_in 非空 → execution_test", () => {
    const t = { expected: { must_modify_files_in: ["foo.ts"] } };
    expect(inferGraderType(t)).toBe("execution_test");
  });

  test("expected.must_modify_files_in 空数组 → rubric_5d", () => {
    const t = { expected: { must_modify_files_in: [] } };
    expect(inferGraderType(t)).toBe("rubric_5d");
  });

  test("无 expected → rubric_5d", () => {
    expect(inferGraderType({})).toBe("rubric_5d");
  });

  test("顶层 must_modify_files_in（旧 schema 兼容）→ execution_test", () => {
    const t = { must_modify_files_in: ["bar.ts"] };
    expect(inferGraderType(t)).toBe("execution_test");
  });
});

describe("buildCaseYaml - 白名单字段提取，黑名单字段不外溢", () => {
  test("丢弃 contamination 字段", () => {
    const src = {
      id: "T0042",
      instruction: { text: "修 bug" },
      expected: { must_modify_files_in: ["src/foo.ts"], outcome: "fix" },
      // 这些字段绝对不能出现在输出 yaml 中
      tool_result_content: "上一轮答案",
      response_content: "答案",
      patch_content: "diff",
    };
    const cfg: ImportConfig = {
      source_path: "/tmp/T0042",
      target_dir: "evals/real-tasks/bug-fix",
      category: "bug-fix",
      do_path_rewrite: true,
      do_secret_scan: true,
      do_holdout: false,
    };
    const out = buildCaseYaml(src, cfg);
    expect(out).not.toContain("tool_result_content");
    expect(out).not.toContain("response_content");
    expect(out).not.toContain("patch_content");
    expect(out).toContain("real_T0042");
    expect(out).toContain("grader_type: execution_test");
    expect(out).toContain("修 bug");
  });

  test("无 must_modify_files_in → rubric_5d + holdout 标记生效", () => {
    const src = { id: "T0001", instruction: { text: "写文档" } };
    const cfg: ImportConfig = {
      source_path: "/tmp/T0001",
      target_dir: "evals/real-tasks/docs",
      category: "docs",
      do_path_rewrite: false,
      do_secret_scan: false,
      do_holdout: true,
    };
    const out = buildCaseYaml(src, cfg);
    expect(out).toContain("grader_type: rubric_5d");
    expect(out).toContain("holdout: true");
    expect(out).toContain("imported via B6-1 adapter");
  });
});

describe("importTask - 端到端", () => {
  test("dry-run 不落盘 + 返回 ok", async () => {
    const sourceDir = join(tmpRoot, "T0900");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "task.yaml"),
      yamlLib.stringify({
        id: "T0900",
        instruction: { text: "写一个 hello world" },
        expected: { outcome: "done" },
      }),
      "utf-8",
    );

    const targetDir = join(tmpRoot, "real-tasks/docs");
    const res = await importTask({
      source_path: sourceDir,
      target_dir: targetDir,
      category: "docs",
      do_path_rewrite: true,
      do_secret_scan: true,
      do_holdout: false,
      dry_run: true,
    });
    expect(res.status).toBe("ok");
    expect(existsSync(join(targetDir, "real_T0900.yaml"))).toBe(false);
  });

  test("contamination 关键词命中 → reject 不落盘", async () => {
    const sourceDir = join(tmpRoot, "T0901");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "task.yaml"),
      `id: T0901
instruction:
  text: "test"
tool_result_content: "应该被拦截"
`,
      "utf-8",
    );

    const targetDir = join(tmpRoot, "real-tasks/leaked");
    const res = await importTask({
      source_path: sourceDir,
      target_dir: targetDir,
      category: "test",
      do_path_rewrite: false,
      do_secret_scan: false,
      do_holdout: false,
    });
    expect(res.status).toBe("rejected");
    expect(res.reject_reasons?.[0]).toBe("CONTAMINATION_DETECTED:");
    expect(existsSync(join(targetDir, "real_T0901.yaml"))).toBe(false);
  });

  test("source 不存在 → reject", async () => {
    const res = await importTask({
      source_path: join(tmpRoot, "nonexistent"),
      target_dir: tmpRoot,
      category: "x",
      do_path_rewrite: false,
      do_secret_scan: false,
      do_holdout: false,
      dry_run: true,
    });
    expect(res.status).toBe("rejected");
    expect(res.reject_reasons?.[0]).toContain("task.yaml not found");
  });

  test("target 已存在且无 --force → reject", async () => {
    const sourceDir = join(tmpRoot, "T0902");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "task.yaml"),
      yamlLib.stringify({ id: "T0902", instruction: { text: "x" } }),
      "utf-8",
    );

    const targetDir = join(tmpRoot, "real-tasks/conflict");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "real_T0902.yaml"), "id: existing\n", "utf-8");

    const res = await importTask({
      source_path: sourceDir,
      target_dir: targetDir,
      category: "test",
      do_path_rewrite: false,
      do_secret_scan: false,
      do_holdout: false,
    });
    expect(res.status).toBe("rejected");
    expect(res.reject_reasons?.[0]).toContain("already exists");
    // 原文件未被覆盖
    expect(readFileSync(join(targetDir, "real_T0902.yaml"), "utf-8")).toBe("id: existing\n");
  });

  test("正常落盘 + setup 脚本生成 + force 覆盖", async () => {
    const sourceDir = join(tmpRoot, "T0903");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "task.yaml"),
      yamlLib.stringify({
        id: "T0903",
        instruction: { text: "fix /project/sid-code/src/foo.ts" },
        expected: { must_modify_files_in: ["src/foo.ts"], outcome: "fix" },
        repo_url: "https://github.com/example/repo.git",
        repo_commit: "abc123",
      }),
      "utf-8",
    );

    const targetDir = join(tmpRoot, "real-tasks/landed");
    const res = await importTask({
      source_path: sourceDir,
      target_dir: targetDir,
      category: "bug-fix",
      do_path_rewrite: true,
      do_secret_scan: false,
      do_holdout: false,
    });

    expect(res.status).toBe("ok");
    const yamlPath = join(targetDir, "real_T0903.yaml");
    expect(existsSync(yamlPath)).toBe(true);
    const content = readFileSync(yamlPath, "utf-8");
    // 路径相对化生效
    expect(content).toContain("${REPO_ROOT}/sid-code/src/foo.ts");
    expect(content).not.toContain("/project/");
    // grader_type 推断生效
    expect(content).toContain("grader_type: execution_test");

    // force 覆盖
    const res2 = await importTask({
      source_path: sourceDir,
      target_dir: targetDir,
      category: "bug-fix",
      do_path_rewrite: true,
      do_secret_scan: false,
      do_holdout: false,
      force: true,
    });
    expect(res2.status).toBe("ok");
  });

  test("private_key 命中 → reject", async () => {
    const sourceDir = join(tmpRoot, "T0904");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "task.yaml"),
      `id: T0904
instruction:
  text: |
    leaked key:
    -----BEGIN RSA PRIVATE KEY-----
    MIIEpAIBAAKCAQEA...
    -----END RSA PRIVATE KEY-----
`,
      "utf-8",
    );

    const res = await importTask({
      source_path: sourceDir,
      target_dir: tmpRoot,
      category: "test",
      do_path_rewrite: false,
      do_secret_scan: true,
      do_holdout: false,
      dry_run: true,
    });
    expect(res.status).toBe("rejected");
    expect(res.reject_reasons?.some((r) => r.includes("PRIVATE_KEY_DETECTED"))).toBe(true);
  });
});
