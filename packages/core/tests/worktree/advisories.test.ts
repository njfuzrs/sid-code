/**
 * Worktree 创建期告警单测（advisories.ts）
 *
 * 覆盖两条告警的「真阳性」与「零噪音」两面：
 * - 依赖一致性：只在 symlink 了 node_modules 且 lockfile 不一致时告警
 * - DB migration：只在检测到标记文件时告警
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkDependencyConsistency,
  checkDatabaseUsage,
} from "@sid-code/core/worktree/advisories.ts";

let main: string;
let wt: string;

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sid-adv-")));
  main = join(base, "main");
  wt = join(base, "wt");
  mkdirSync(main, { recursive: true });
  mkdirSync(wt, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(main, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

describe("checkDependencyConsistency", () => {
  it("未 symlink node_modules → 不告警（依赖各自独立，无风险）", () => {
    writeFileSync(join(main, "pnpm-lock.yaml"), "a: 1\n");
    writeFileSync(join(wt, "pnpm-lock.yaml"), "b: 2\n"); // 不一致但没 symlink
    expect(checkDependencyConsistency(wt, main, [])).toBeNull();
  });

  it("symlink 了 node_modules 且 lockfile 一致 → 不告警（零噪音）", () => {
    writeFileSync(join(main, "pnpm-lock.yaml"), "same\n");
    writeFileSync(join(wt, "pnpm-lock.yaml"), "same\n");
    expect(checkDependencyConsistency(wt, main, ["node_modules"])).toBeNull();
  });

  it("symlink 了 node_modules 且 lockfile 不一致 → 告警（真阳性）", () => {
    writeFileSync(join(main, "pnpm-lock.yaml"), "main-version\n");
    writeFileSync(join(wt, "pnpm-lock.yaml"), "branch-version\n");
    const w = checkDependencyConsistency(wt, main, ["node_modules"]);
    expect(w).not.toBeNull();
    expect(w).toContain("pnpm-lock.yaml");
    expect(w).toContain("依赖不一致");
  });

  it("两边缺同名 lockfile → 不告警（无从比对）", () => {
    // 主仓有 npm lock，worktree 没有任何 lock
    writeFileSync(join(main, "package-lock.json"), "{}\n");
    expect(checkDependencyConsistency(wt, main, ["node_modules"])).toBeNull();
  });

  it("优先命中的 lockfile 一致即放行，不因后序 lockfile 触发", () => {
    // pnpm（优先）一致，yarn（靠后）不一致 → 以 pnpm 为准，不告警
    writeFileSync(join(main, "pnpm-lock.yaml"), "same\n");
    writeFileSync(join(wt, "pnpm-lock.yaml"), "same\n");
    writeFileSync(join(main, "yarn.lock"), "x\n");
    writeFileSync(join(wt, "yarn.lock"), "y\n");
    expect(checkDependencyConsistency(wt, main, ["node_modules"])).toBeNull();
  });
});

describe("checkDependencyConsistency：monorepo 子包 node_modules", () => {
  it("子包 node_modules 被 symlink 且包级 lockfile 不一致 → 告警（旧实现只认顶层，此处漏报）", () => {
    mkdirSync(join(main, "packages/app"), { recursive: true });
    mkdirSync(join(wt, "packages/app"), { recursive: true });
    writeFileSync(join(main, "packages/app/package-lock.json"), "main\n");
    writeFileSync(join(wt, "packages/app/package-lock.json"), "branch\n");
    const w = checkDependencyConsistency(wt, main, ["packages/app/node_modules"]);
    expect(w).not.toBeNull();
    expect(w).toContain(join("packages/app", "package-lock.json"));
  });

  it("子包无 lockfile → 向上用 workspace 根 lockfile 判定", () => {
    mkdirSync(join(main, "packages/app"), { recursive: true });
    mkdirSync(join(wt, "packages/app"), { recursive: true });
    writeFileSync(join(main, "bun.lock"), "main\n");
    writeFileSync(join(wt, "bun.lock"), "branch\n");
    const w = checkDependencyConsistency(wt, main, ["packages/app/node_modules"]);
    expect(w).toContain("bun.lock");
  });

  it("非 node_modules 的 symlink 目录（如 .venv）不参与 lockfile 比对", () => {
    writeFileSync(join(main, "bun.lock"), "main\n");
    writeFileSync(join(wt, "bun.lock"), "branch\n");
    expect(checkDependencyConsistency(wt, main, [".venv"])).toBeNull();
  });
});

describe("checkDependencyConsistency：workspace 依赖可解析性（A2）", () => {
  /** 在 worktree 里造一个 monorepo：packages/cli 依赖 @sid-code/tui（workspace:*） */
  function seedMonorepo(): void {
    mkdirSync(join(wt, "packages/cli"), { recursive: true });
    writeFileSync(
      join(wt, "packages/cli/package.json"),
      JSON.stringify({
        name: "@sid-code/cli",
        dependencies: { "@sid-code/tui": "workspace:*", zod: "^3.0.0" },
      }),
    );
  }

  /** 造 root node_modules 目录（并标记为 symlink 自主仓） */
  function seedRootModules(): string {
    const nm = join(wt, "node_modules");
    mkdirSync(nm, { recursive: true });
    return nm;
  }

  it("根 node_modules 是软链 + lockfile 一致 + 缺 workspace 依赖 → 告警（真阳性）", () => {
    writeFileSync(join(main, "bun.lock"), "same\n");
    writeFileSync(join(wt, "bun.lock"), "same\n"); // lockfile 一致：旧逻辑完全静默
    seedMonorepo();
    seedRootModules(); // 存在但没有 @sid-code/tui

    const w = checkDependencyConsistency(wt, main, ["node_modules"]);
    expect(w).not.toBeNull();
    expect(w).toContain("@sid-code/tui");
    // 修复命令必须指到主仓，并给出对应包目录名
    expect(w).toContain(join(main, "node_modules", "@sid-code/tui"));
    expect(w).toContain("ln -sfn ../../packages/tui");
  });

  it("workspace 依赖通过 <wt>/node_modules 可解析 → 不告警（零噪音：根 hoist 路径）", () => {
    writeFileSync(join(main, "bun.lock"), "same\n");
    writeFileSync(join(wt, "bun.lock"), "same\n");
    seedMonorepo();
    const nm = seedRootModules();
    mkdirSync(join(nm, "@sid-code/tui"), { recursive: true });
    expect(checkDependencyConsistency(wt, main, ["node_modules"])).toBeNull();
  });

  it("workspace 依赖通过包内 node_modules 可解析 → 不告警（零噪音：包内路径）", () => {
    writeFileSync(join(main, "bun.lock"), "same\n");
    writeFileSync(join(wt, "bun.lock"), "same\n");
    seedMonorepo();
    seedRootModules(); // 根没有 tui
    mkdirSync(join(wt, "packages/cli/node_modules/@sid-code/tui"), { recursive: true });
    expect(checkDependencyConsistency(wt, main, ["node_modules"])).toBeNull();
  });

  it("整棵 node_modules 不存在 → 只报一条「未安装依赖」，不逐个列包名", () => {
    writeFileSync(join(main, "bun.lock"), "same\n");
    writeFileSync(join(wt, "bun.lock"), "same\n");
    seedMonorepo();
    // 不建 wt/node_modules

    const w = checkDependencyConsistency(wt, main, ["node_modules"]);
    expect(w).not.toBeNull();
    expect(w).toContain("未安装依赖");
    expect(w).not.toContain("@sid-code/tui");
    expect(w).not.toContain("ln -sfn");
  });

  it("没有 symlink 根 node_modules → 不做可解析性检查（worktree 自己的安装可靠）", () => {
    writeFileSync(join(main, "bun.lock"), "same\n");
    writeFileSync(join(wt, "bun.lock"), "same\n");
    seedMonorepo();
    seedRootModules(); // node_modules 在，但没被 symlink（symlinkedDirs 为空）
    expect(checkDependencyConsistency(wt, main, [])).toBeNull();
  });
});

describe("checkDatabaseUsage", () => {
  it("无 DB 标记 → 不告警", () => {
    expect(checkDatabaseUsage(wt)).toBeNull();
  });

  it("检测到 prisma/schema.prisma → 告警", () => {
    mkdirSync(join(wt, "prisma"), { recursive: true });
    writeFileSync(join(wt, "prisma", "schema.prisma"), "datasource db {}\n");
    const w = checkDatabaseUsage(wt);
    expect(w).not.toBeNull();
    expect(w).toContain("migration");
    expect(w).toContain("prisma/schema.prisma");
  });

  it("检测到 drizzle.config.ts → 告警", () => {
    writeFileSync(join(wt, "drizzle.config.ts"), "export default {}\n");
    expect(checkDatabaseUsage(wt)).toContain("drizzle.config.ts");
  });
});
