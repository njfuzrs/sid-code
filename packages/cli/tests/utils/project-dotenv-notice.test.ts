/**
 * 运行目录 .env 提示（PR-A1）。
 * 核心约束：只打键名不打值、每目录只提示一次、无敏感键不提示。
 * state 文件一律落 tmpdir，不碰真实 ~/.sid-code/。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectProjectDotenvKeys,
  maybeNotifyProjectDotenv,
} from "../../src/utils/project-dotenv-notice.ts";

let work: string;
let repo: string;
let stateFile: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "dotenv-notice-"));
  repo = join(work, "repo");
  Bun.spawnSync(["mkdir", "-p", repo]);
  stateFile = join(work, "state", "dotenv-notice.json");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("运行目录 .env 提示", () => {
  test("三个文件都扫，只收 SID_CODE_* 与 *_API_KEY，其他键不收", () => {
    writeFileSync(join(repo, ".env"), "SID_CODE_LLM_BASE_URL=http://x\nFOO=bar\n# SID_CODE_X=1\n");
    writeFileSync(join(repo, ".env.local"), "export OPENAI_API_KEY=sk-secret-value\n");
    writeFileSync(join(repo, ".env.production"), "DATABASE_URL=postgres://u:p@h/db\n");
    expect(detectProjectDotenvKeys(repo)).toEqual([
      { file: ".env", keys: ["SID_CODE_LLM_BASE_URL"] },
      { file: ".env.local", keys: ["OPENAI_API_KEY"] },
    ]);
  });

  test("提示只含键名，绝不含值；每个目录只提示一次", () => {
    writeFileSync(join(repo, ".env"), "ANTHROPIC_API_KEY=sk-ant-very-secret-123\n");
    const out: string[] = [];
    // 变异自证：把 formatDotenvNotice 改成带值 → 第一条 not.toContain 红
    expect(maybeNotifyProjectDotenv(repo, stateFile, (s) => out.push(s))).toBe(true);
    expect(out.join("")).toContain("ANTHROPIC_API_KEY");
    expect(out.join("")).not.toContain("sk-ant-very-secret-123");
    // 变异自证：删掉 seen 判断 → 第二次也返回 true → 红
    expect(maybeNotifyProjectDotenv(repo, stateFile, (s) => out.push(s))).toBe(false);
    expect(out.length).toBe(1);
  });

  test("没有 .env 或没有敏感键时不提示、不写 state", () => {
    const out: string[] = [];
    expect(maybeNotifyProjectDotenv(repo, stateFile, (s) => out.push(s))).toBe(false);
    writeFileSync(join(repo, ".env"), "PORT=3000\n");
    expect(maybeNotifyProjectDotenv(repo, stateFile, (s) => out.push(s))).toBe(false);
    expect(out).toEqual([]);
    expect(Bun.file(stateFile).size).toBe(0);
  });

  test("state 文件损坏时当作没提示过，不抛错", () => {
    writeFileSync(join(repo, ".env"), "SID_CODE_TRACE=1\n");
    Bun.spawnSync(["mkdir", "-p", join(work, "state")]);
    writeFileSync(stateFile, "{not json");
    const out: string[] = [];
    expect(maybeNotifyProjectDotenv(repo, stateFile, (s) => out.push(s))).toBe(true);
  });
});
