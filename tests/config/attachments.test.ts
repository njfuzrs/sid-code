/**
 * 附件系统测试
 */

import { describe, test, expect } from "bun:test";
import {
  PRIORITY,
  generateClaudeMdAttachment,
  generateGitStatusAttachment,
  clearGitStatusCache,
  generatePermissionModeAttachment,
  generateDiagnosticsAttachment,
  generateIDESelectionAttachment,
  generateTodoListAttachment,
} from "../../src/config/attachments.ts";

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

describe("generatePermissionModeAttachment", () => {
  test("默认模式", () => {
    const attachment = generatePermissionModeAttachment("default");
    expect(attachment.type).toBe("permissionMode");
    expect(attachment.priority).toBe(PRIORITY.MODE_REMINDER);
    expect(attachment.content).toContain("默认");
  });

  test("plan 模式", () => {
    const attachment = generatePermissionModeAttachment("plan");
    expect(attachment.content).toContain("计划模式已激活");
    expect(attachment.content).toContain("绝对不能");
  });

  test("未知模式回退到默认", () => {
    const attachment = generatePermissionModeAttachment("unknown_mode");
    expect(attachment.content).toContain("默认");
  });

  // 键盘 Shift+Tab 循环会切到 acceptEdits / auto / always-allow，这些模式必须有专属描述，
  // 否则 generatePermissionModeAttachment / buildPermissionModeReminder 会静默回退到 default，
  // 导致模型收到的约束与实际模式不符。
  test("键盘循环涉及的模式均有专属描述（非 default 回退）", () => {
    for (const mode of ["acceptEdits", "auto", "always-allow"]) {
      const attachment = generatePermissionModeAttachment(mode);
      // 专属描述的标题含模式自身语义，且不等同于 default 的“执行以下操作前必须请求用户确认”
      expect(attachment.content).not.toBe(generatePermissionModeAttachment("default").content);
    }
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

describe("generateIDESelectionAttachment", () => {
  test("生成正确的附件", () => {
    const attachment = generateIDESelectionAttachment("const x = 1;");
    expect(attachment.type).toBe("ideSelection");
    expect(attachment.priority).toBe(PRIORITY.IDE_SELECTION);
    expect(attachment.content).toContain("const x = 1;");
  });
});

describe("generateTodoListAttachment", () => {
  test("生成正确的附件", () => {
    const attachment = generateTodoListAttachment("- [ ] 修复 bug\n- [x] 写测试");
    expect(attachment.type).toBe("todoList");
    expect(attachment.priority).toBe(PRIORITY.TODO_LIST);
    expect(attachment.content).toContain("修复 bug");
  });
});
