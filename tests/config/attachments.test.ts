/**
 * 附件系统测试
 */

import { describe, test, expect } from "bun:test";
import {
  PRIORITY,
  generateClaudeMdAttachment,
  generateGitStatusAttachment,
  clearGitStatusCache,
  PERMISSION_MODE_DESCRIPTIONS,
  generateDiagnosticsAttachment,
  generateTodoListAttachment,
} from "@sid-code/core/config/attachments.ts";

describe("PRIORITY", () => {
  test("优先级数值正确排序", () => {
    expect(PRIORITY.CRITICAL_REMINDER).toBeLessThan(PRIORITY.MODE_REMINDER);
    expect(PRIORITY.MODE_REMINDER).toBeLessThan(PRIORITY.CLAUDE_MD);
    expect(PRIORITY.CLAUDE_MD).toBeLessThan(PRIORITY.DIAGNOSTICS);
    expect(PRIORITY.DIAGNOSTICS).toBeLessThan(PRIORITY.IDE_SELECTION);
    expect(PRIORITY.IDE_SELECTION).toBeLessThan(PRIORITY.GIT_STATUS);
    expect(PRIORITY.GIT_STATUS).toBeLessThan(PRIORITY.APPEND_PROMPT);
    expect(PRIORITY.APPEND_PROMPT).toBeLessThan(PRIORITY.FILE_PROMPT);
  });
});

describe("generateClaudeMdAttachment", () => {
  test("生成正确的附件结构", () => {
    const attachment = generateClaudeMdAttachment("# 项目规则\n使用 TypeScript");
    expect(attachment.type).toBe("claudeMd");
    expect(attachment.priority).toBe(PRIORITY.CLAUDE_MD);
    expect(attachment.content).toContain("<system-reminder>");
    expect(attachment.content).toContain("使用 TypeScript");
    expect(attachment.content).toContain("覆盖任何默认行为");
    expect(attachment.content).toContain("</system-reminder>");
  });

  test("包含来源路径标注", () => {
    const attachment = generateClaudeMdAttachment("内容", "/project/CLAUDE.md");
    expect(attachment.content).toContain("Contents of /project/CLAUDE.md");
  });

  test("无来源路径时使用默认标注", () => {
    const attachment = generateClaudeMdAttachment("内容");
    expect(attachment.content).toContain("Project rules");
  });
});

describe("generateGitStatusAttachment", () => {
  test("在 Git 仓库中返回附件", () => {
    // 当前项目就是 Git 仓库
    const attachment = generateGitStatusAttachment(process.cwd());
    expect(attachment).not.toBeNull();
    expect(attachment!.type).toBe("gitStatus");
    expect(attachment!.priority).toBe(PRIORITY.GIT_STATUS);
    expect(attachment!.content).toContain("<git-status>");
    // 保留稳定部分：branch（会话内极少变）。
    expect(attachment!.content).toContain("Current branch:");
    // 首行仍显式声明"这是启动快照、不会更新"（弱模型的锚点）。
    expect(attachment!.content).toContain("snapshot in time");
    expect(attachment!.content).toContain("will not update during the conversation");
  });

  // ★第一层·预防 防死锁哨兵（根治-git快照冻结死循环）：
  // 冻结快照里唯一会过期、唯一制造"净/脏"矛盾的就是 `Status:` 文件状态列表。
  // 它必须被**物理移除**——上下文里不再有一个"权威"的 clean/dirty 状态去和实时
  // `git status` 打架，弱模型才不会陷入"到底做完没有"的认知死锁。
  // 若有人重新加回 `Status:` 块（哪怕带"以实时为准"措辞），此测试即回归失败——
  // 因为历史证明"加措辞让模型别信"治不住弱模型（151220/164407 两次复发）。
  test("★不含会过期的 Status 文件状态列表（防死锁根治）", () => {
    const attachment = generateGitStatusAttachment(process.cwd());
    expect(attachment).not.toBeNull();
    // 绝不能出现 "Status:" 标签块（这是 volatile 矛盾源）。
    expect(attachment!.content).not.toContain("Status:");
    // 也不能出现 "(clean)" 这类会与实时状态打架的断言。
    expect(attachment!.content).not.toContain("(clean)");
    // 必须有明确引导：文件状态未包含在快照中，需实时 git status 获取。
    expect(attachment!.content).toContain("git status");
    expect(attachment!.content).toContain("未包含在此快照中");
  });

  test("非 Git 仓库返回 null", () => {
    const attachment = generateGitStatusAttachment("/tmp");
    // /tmp 通常不是 Git 仓库
    // 注意：如果 /tmp 碰巧是 Git 仓库，这个测试可能失败
    expect(attachment).toBeNull();
  });

  // ★缺口 3 补强：构造脏工作区，断言快照确实不含文件状态列表。
  //
  // 上一条"★不含会过期的 Status"测试依赖当前项目目录的 git 状态——若 CI 环境恰好 clean，
  // 无法验证"工作区确实脏时，快照也确实不含文件列表"这一核心场景。本用例创建临时 git 仓库、
  // 制造脏状态（untracked + modified 文件），断言：
  //   (1) 这些脏文件名绝不泄漏进 <git-status>（volatile 矛盾源物理移除）；
  //   (2) 仍含稳定部分 branch / 引导语。
  test("★脏工作区下快照仍不含文件状态列表（构造脏仓库验证）", () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("node:fs");
    const { execSync } = require("node:child_process");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");

    // 创建临时 git 仓库并制造脏状态。
    const dirtyRepo = mkdtempSync(join(tmpdir(), "sid-dirty-"));
    try {
      execSync("git init -q", { cwd: dirtyRepo });
      execSync('git config user.email "t@t.com"', { cwd: dirtyRepo });
      execSync('git config user.name "t"', { cwd: dirtyRepo });
      // 先 commit 一个文件（让仓库有 HEAD，branch 可读）
      writeFileSync(join(dirtyRepo, "committed.txt"), "v1");
      execSync("git add committed.txt && git commit -q -m init", { cwd: dirtyRepo });
      // 制造两类脏状态：untracked + modified
      writeFileSync(join(dirtyRepo, "untracked-new.txt"), "new");
      writeFileSync(join(dirtyRepo, "committed.txt"), "v2-dirty"); // 已提交文件被改
      mkdirSync(join(dirtyRepo, "subdir"));
      writeFileSync(join(dirtyRepo, "subdir", "nested.txt"), "nested");

      // 确认工作区确实脏（自检：git status --short 有输出）
      const dirtyOutput = execSync("git status --short", { cwd: dirtyRepo }).toString().trim();
      expect(dirtyOutput.length).toBeGreaterThan(0);
      expect(dirtyOutput).toContain("untracked-new.txt");

      // 清缓存避免上一个测试残留干扰（generateGitStatusAttachment 有 30s TTL 缓存）
      clearGitStatusCache();
      const attachment = generateGitStatusAttachment(dirtyRepo);
      expect(attachment).not.toBeNull();
      const content = attachment!.content;

      // (1) 脏文件名绝不泄漏进 <git-status>——这是第一层根治的核心断言。
      expect(content).not.toContain("untracked-new.txt");
      expect(content).not.toContain("committed.txt");
      expect(content).not.toContain("nested.txt");
      expect(content).not.toContain("Status:");
      expect(content).not.toContain("(clean)");
      expect(content).not.toContain("M ");
      expect(content).not.toContain("??");

      // (2) 仍含稳定部分 + 引导语。
      expect(content).toContain("Current branch:");
      expect(content).toContain("未包含在此快照中");
      expect(content).toContain("git status");
    } finally {
      rmSync(dirtyRepo, { recursive: true, force: true });
    }
  });
});

// generatePermissionModeAttachment 的 describe 已删除（2026-07-30，重复注入根因修复 P0）：
// 该函数随 system 附件通道一起删除，权限模式文案现在只走 user reminder 通道。
// 但下面那条「键对齐」守卫**必须保留**——它保护的消费方从"附件 + reminder"变成了
// 只剩 reminder（buildPermissionModeReminder 取不到键会 return null 静默不注入，
// 比回退到 default 更隐蔽）。断言主体从函数改为直接查常量表。
describe("PERMISSION_MODE_DESCRIPTIONS — 键与运行时 mode 对齐", () => {
  // 键盘 Shift+Tab 循环会切到 acceptEdits / auto / always-allow，这些模式必须有专属描述，
  // 否则 buildPermissionModeReminder 取不到键会返回 null → 整条提醒静默丢失，
  // 模型收到的约束与实际模式不符。
  test("键盘循环涉及的模式均有专属描述（非 default 回退）", () => {
    for (const mode of ["acceptEdits", "auto", "always-allow"]) {
      const description = PERMISSION_MODE_DESCRIPTIONS[mode];
      expect(description).toBeDefined();
      expect(description).not.toBe(PERMISSION_MODE_DESCRIPTIONS.default);
    }
  });

  // 非 default / 非 plan 的运行时 mode 都会走 reminder 通道（loop.ts 只排除 default 与 plan），
  // 每一个都必须有键，否则该 mode 下模型完全收不到约束文案。
  test("除 default/plan 外的全部运行时 mode 都有键", () => {
    for (const mode of ["always-allow", "acceptEdits", "deny-write", "dontAsk", "auto", "dangerously-skip-permissions"]) {
      expect(PERMISSION_MODE_DESCRIPTIONS[mode]).toBeDefined();
    }
  });

  // plan 键已随附件通道一起删除：它的唯一消费方被 loop.ts 的 `mode !== "plan"` 排除，
  // 文案已并入 plan/prompt.ts 的 buildPlanModeReminder full 档（单一事实源）。
  // 这条守卫防止有人"看到少个 mode 就补回来"，导致两份 plan 文案再次独立漂移。
  test("plan 键不得复活（文案单一事实源在 plan/prompt.ts）", () => {
    expect(PERMISSION_MODE_DESCRIPTIONS.plan).toBeUndefined();
  });
});

describe("generateDiagnosticsAttachment", () => {
  test("生成正确的附件", () => {
    const attachment = generateDiagnosticsAttachment("Error: 类型不匹配");
    expect(attachment.type).toBe("diagnostics");
    expect(attachment.priority).toBe(PRIORITY.DIAGNOSTICS);
    expect(attachment.content).toContain("类型不匹配");
    expect(attachment.content).toContain("<diagnostics>");
  });
});

// generateIDESelectionAttachment / generateIDEMentionAttachment 的用例已删除：
// 两个 generator 已移除（IDE 选区/@提及改走 delta 消息通道，不再进 system prompt）。
// PRIORITY.IDE_SELECTION 的序关系断言保留在文件开头的优先级用例里。

describe("generateTodoListAttachment", () => {
  test("生成正确的附件", () => {
    const attachment = generateTodoListAttachment("- [ ] 修复 bug\n- [x] 写测试");
    expect(attachment.type).toBe("todoList");
    expect(attachment.priority).toBe(PRIORITY.TODO_LIST);
    expect(attachment.content).toContain("修复 bug");
  });
});
