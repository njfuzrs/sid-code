/**
 * 附件系统测试
 */

import { describe, test, expect } from "bun:test";
import {
  PRIORITY,
  generateClaudeMdAttachment,
  generateGitStatusAttachment,
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
    expect(attachment!.content).toContain("当前分支:");
  });

  test("非 Git 仓库返回 null", () => {
    const attachment = generateGitStatusAttachment("/tmp");
    // /tmp 通常不是 Git 仓库
    // 注意：如果 /tmp 碰巧是 Git 仓库，这个测试可能失败
    expect(attachment).toBeNull();
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
