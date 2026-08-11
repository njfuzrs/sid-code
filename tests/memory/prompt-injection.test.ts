/**
 * 记忆系统提示词注入测试（Task 7）
 */

import { describe, test, expect } from "bun:test";
import { buildMemoryInstructions, buildMemorySystemPrompt } from "@sid-code/core/memory/prompt.ts";
import { normalizeMemoryDesc } from "@sid-code/core/memory/store.ts";
import {
  generateRecalledMemoryAttachment,
  generateSessionMemoryAttachment,
  PRIORITY,
} from "@sid-code/core/config/attachments.ts";
import { buildSystemPrompt } from "@sid-code/core/config/system-prompt.ts";

describe("buildMemoryInstructions", () => {
  test("包含 4 类分类法", () => {
    const instr = buildMemoryInstructions();
    expect(instr).toContain("user");
    expect(instr).toContain("feedback");
    expect(instr).toContain("project");
    expect(instr).toContain("reference");
  });

  test("包含敏感信息排除规则", () => {
    const instr = buildMemoryInstructions();
    expect(instr).toContain("API Key");
  });
});

describe("buildMemorySystemPrompt", () => {
  test("无索引时只有指令", () => {
    const prompt = buildMemorySystemPrompt(null);
    expect(prompt).toContain("记忆系统");
    expect(prompt).not.toContain("MEMORY.md");
  });

  test("有索引时附加索引内容", () => {
    const index = "# Memory Index\n- [coding_style](feedback_coding-style.md) — 用 4 空格";
    const prompt = buildMemorySystemPrompt(index);
    expect(prompt).toContain("MEMORY.md");
    expect(prompt).toContain("coding_style");
  });

  test("E.11：团队索引被注入且与私有索引区分", () => {
    const priv = "# Memory Index\n- [my_pref](feedback_my-pref.md) — 个人偏好";
    const team = "# 团队共享记忆\n- [pr_convention](project_pr.md) — PR 规范";
    const prompt = buildMemorySystemPrompt(priv, team);
    expect(prompt).toContain("团队共享记忆索引");
    expect(prompt).toContain("pr_convention");
    expect(prompt).toContain("my_pref"); // 私有索引仍在
  });

  test("E.11：仅团队索引（无私有索引）也注入", () => {
    const team = "# 团队共享记忆\n- [arch](project_arch.md) — 架构决策";
    const prompt = buildMemorySystemPrompt(null, team);
    expect(prompt).toContain("团队共享记忆索引");
    expect(prompt).toContain("arch");
    expect(prompt).not.toContain("已保存的记忆索引"); // 私有 section 不出现
  });

  test("E.11：团队索引为 null 时向后兼容（不注入团队 section）", () => {
    const priv = "# Memory Index\n- [my_pref](feedback_my-pref.md) — 个人偏好";
    const prompt = buildMemorySystemPrompt(priv);
    expect(prompt).not.toContain("团队共享记忆索引");
    expect(prompt).toContain("my_pref");
  });
});

/**
 * P0-b①：记忆索引去陈述句化。
 *
 * 事故（2026-07-29，轨迹 20260729-180624-b8ae8e78）：用户只输入 `/commit`，模型却把
 * system prompt 记忆索引里的一条 `## 负收益防线审计第 2 版完成（2026-07-30）` 当成
 * "用户刚说的话"，第一轮直接去 glob 那条记忆文件。`## 陈述句` 与用户输入在语义上
 * 无法区分，而索引每个会话都注入 → 这是"模型误抓内容"的唯一来源。
 *
 * 根治点在写入端（store.ts normalizeMemoryDesc），这里守的是**渲染端兜底**：
 * 修复前写入的旧 MEMORY.md 文件里已经躺着大量 `— ## 标题` 行，且索引只在
 * save_memory / 同步时才重建，兜底必须存在。
 */
describe("P0-b①：记忆索引渲染去陈述句化", () => {
  /** 复刻事故里那条真实索引 */
  const ACCIDENT_INDEX =
    "# Memory Index\n" +
    "- [negative-return-audit-v2-completed-20260730](project_negative-return-audit-v2-completed-20260730.md) — ## 负收益防线审计第 2 版完成（2026-07-30）";

  test("索引段落头声明「这些不是用户输入」", () => {
    const prompt = buildMemorySystemPrompt(ACCIDENT_INDEX);
    expect(prompt).toContain("不是用户输入");
    // 明确否掉"待办/当前任务"这两种最容易被误读成行动指令的身份
    expect(prompt).toContain("不是待办事项");
    expect(prompt).toContain("不是当前任务");
  });

  test("剥离摘要里的 markdown 标题标记（`## 标题` → `标题`）", () => {
    const prompt = buildMemorySystemPrompt(ACCIDENT_INDEX);
    expect(prompt).not.toContain("— ## 负收益防线审计");
    expect(prompt).not.toContain("## 负收益防线审计");
    // 内容本身必须保留（去的是结构标记，不是信息）
    expect(prompt).toContain("负收益防线审计第 2 版完成");
  });

  test("` — ` 分隔符换成 `：`，让「链接 → 摘要」的从属关系明确", () => {
    const prompt = buildMemorySystemPrompt(ACCIDENT_INDEX);
    expect(prompt).toContain(
      "[negative-return-audit-v2-completed-20260730](project_negative-return-audit-v2-completed-20260730.md)：负收益防线审计第 2 版完成",
    );
  });

  test("剥离列表/引用/强调标记，非索引行原样保留", () => {
    const index = [
      "# Memory Index",
      "",
      "- [a](project_a.md) — > 引用式摘要",
      "- [b](feedback_b.md) — **强调**式摘要",
      "- [c](user_c.md) — 普通摘要",
      "> ⚠️ 索引已截断（超过 200 行 / 25KB 上限），部分记忆未列出。",
    ].join("\n");
    const prompt = buildMemorySystemPrompt(index);
    expect(prompt).toContain("[a](project_a.md)：引用式摘要");
    expect(prompt).toContain("[b](feedback_b.md)：强调式摘要");
    expect(prompt).toContain("[c](user_c.md)：普通摘要");
    // 段标题与截断警告不是索引条目，原样保留
    expect(prompt).toContain("# Memory Index");
    expect(prompt).toContain("索引已截断");
  });

  test("空摘要条目不残留裸分隔符", () => {
    const prompt = buildMemorySystemPrompt("# Memory Index\n- [empty](project_empty.md) — ");
    expect(prompt).toContain("[empty](project_empty.md)");
    expect(prompt).not.toContain("project_empty.md)：");
  });

  test("团队索引同样去陈述句化（走同一条渲染路径）", () => {
    const team = "# 团队共享记忆\n- [pr](project_pr.md) — ## PR 规范已定稿";
    const prompt = buildMemorySystemPrompt(null, team);
    expect(prompt).not.toContain("## PR 规范已定稿");
    expect(prompt).toContain("[pr](project_pr.md)：PR 规范已定稿");
    expect(prompt).toContain("不是用户输入");
  });
});

describe("generateRecalledMemoryAttachment", () => {
  test("空数组返回 null", () => {
    expect(generateRecalledMemoryAttachment([])).toBeNull();
  });

  test("生成召回附件，优先级正确", () => {
    const att = generateRecalledMemoryAttachment([
      { filename: "user_role.md", content: "后端工程师" },
    ]);
    expect(att).not.toBeNull();
    expect(att!.priority).toBe(PRIORITY.MEMORY_RECALLED);
    expect(att!.content).toContain("user_role.md");
    expect(att!.content).toContain("后端工程师");
  });
});

describe("generateSessionMemoryAttachment", () => {
  test("空内容返回 null", () => {
    expect(generateSessionMemoryAttachment(null)).toBeNull();
    expect(generateSessionMemoryAttachment("   ")).toBeNull();
  });

  test("生成会话笔记附件", () => {
    const att = generateSessionMemoryAttachment("# Current State\n进行中");
    expect(att).not.toBeNull();
    expect(att!.priority).toBe(PRIORITY.SESSION_MEMORY);
    expect(att!.content).toContain("session-memory");
  });
});

describe("buildSystemPrompt — 记忆注入集成", () => {
  test("memorySystemPrompt 被注入核心部分", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      memorySystemPrompt: "## 记忆系统\n4 类分类法说明",
    });
    expect(prompt).toContain("记忆系统");
    expect(prompt).toContain("4 类分类法说明");
  });

  test("recalledMemories 被注入", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      recalledMemories: [{ filename: "user_role.md", content: "后端工程师，Go 专家" }],
    });
    expect(prompt).toContain("后端工程师，Go 专家");
    expect(prompt).toContain("recalled-memory");
  });

  test("sessionMemoryContent 被注入", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      sessionMemoryContent: "# Worklog\n- 完成 Task 7",
    });
    expect(prompt).toContain("完成 Task 7");
    expect(prompt).toContain("session-memory");
  });

  test("无记忆字段时不注入记忆内容", () => {
    const prompt = buildSystemPrompt({ tools: [] });
    expect(prompt).not.toContain("recalled-memory");
    expect(prompt).not.toContain("session-memory");
  });
});

/**
 * 基础设施坐标脱敏（2026-07-30，文档「独立立项 B」）。
 *
 * 事故：一条 `reference` 记忆把生产发布服务器的公网 IP 和 `（root）` 写进了 frontmatter
 * 的 `description`，于是它随 MEMORY.md 索引进入**每一个会话**的 system prompt
 * （索引常驻 core 区，见 config/system-prompt.ts:372）。凭证类 secret 有
 * tool/memory.ts 的 detect 拦着，但"公网 IP + root"不在 secret 模式里，畅通无阻。
 *
 * 这里守两件事：
 *   1. 真实的服务器坐标被抹（写入端 normalizeMemoryDesc + 渲染端 normalizeIndexContent 双层）；
 *   2. **误报不能扩散** —— 版本号、私网地址、域名必须原样保留。索引脱敏是有损改写，
 *      误伤可读性比漏一条更糟（模型据 `<地址已省略>` 的版本号会做出错误判断）。
 */
describe("索引摘要脱敏：基础设施坐标", () => {
  /**
   * 复刻事故里那条真实记忆的 description。
   *
   * IP 用 RFC 5737 文档保留段 `203.0.113.0/24`，不写真实服务器地址：
   * 这个测试的语义是「公网 IP 形态会被抹掉」，被抹的是**形态**不是某个具体地址，
   * 用文档段一样能验证（实测占位符与 root 标注行为完全一致），
   * 而写真地址等于把基建坐标留在公开仓库里 —— 恰好是本测试要防的那件事。
   */
  const ACCIDENT_DESC =
    "sid-code 生产发布服务器：203.0.113.7（root），制品路径 " +
    "/var/www/html/releases/sid-code/，nginx 对外暴露 http://203.0.113.7/releases/";

  test("写入端：公网 IP 与特权账号标注被抹，其余信息保留", () => {
    const desc = normalizeMemoryDesc(ACCIDENT_DESC, "");
    expect(desc).not.toContain("203.0.113.7");
    expect(desc).not.toContain("（root）");
    expect(desc).toContain("<地址已省略>");
    // 抹的是坐标，不是这条记忆的用途——路径等指路信息必须留着
    expect(desc).toContain("生产发布服务器");
    expect(desc).toContain("/var/www/html/releases/sid-code/");
  });

  test("渲染端兜底：旧索引文件里的坐标同样不进 system prompt", () => {
    // 索引只在 save_memory / 同步时重建，磁盘上的旧值要等下次重建才更新，
    // 注入路径必须自己兜住，否则"已修复"只对新写入的记忆成立。
    const staleIndex = `# Memory Index\n- [production-deploy-server](reference_production-deploy-server.md) — ${ACCIDENT_DESC}`;
    const prompt = buildMemorySystemPrompt(staleIndex);
    expect(prompt).not.toContain("203.0.113.7");
    expect(prompt).not.toContain("（root）");
    expect(prompt).toContain("<地址已省略>");
    expect(prompt).toContain("production-deploy-server");
  });

  test("脱敏发生在 150 字符截断之前（不留半截 IP）", () => {
    // 截断先行会把 IP 切成 `203.0.11` 这种残留：既没抹干净又匹配不上。
    const padded = "生产服务器部署说明。".repeat(12) + "地址 203.0.113.7（root）";
    const desc = normalizeMemoryDesc(padded, "");
    expect(desc).not.toContain("203.0.113");
  });

  test.each([
    ["四段版本号", "版本号从 1.2.3.4 升到 1.2.3.5"],
    ["部署语境里的版本号", "部署脚本要求 node 版本 18.20.4.1 以上"],
    ["带前缀的版本号", "发布时 app@1.2.3.4 与 v2.0.1.3 都是版本"],
    ["环回地址", "本地起服务在 127.0.0.1:3000，用 curl 验证"],
    ["私网地址", "内网 gitlab 部署在 192.168.1.50，走 172.16.3.9 跳板"],
    ["域名", "网关地址 git.internal.example.com，服务器不带 /v1"],
    ["超范围八位组", "部署机 10.15.2.300 不是合法 IP"],
    ["无语境词的裸数字", "四段数字 203.0.113.9 没有任何基础设施语境"],
    ["孤立的账号标注", "服务器上单独出现 (root) 不该被抹"],
  ])("不误伤：%s", (_label, input) => {
    expect(normalizeMemoryDesc(input, "")).toBe(input);
  });

  test("同句混合：真地址被抹、版本号保留", () => {
    const desc = normalizeMemoryDesc("服务器：203.0.113.9 部署后 node 版本 18.20.4.1", "");
    expect(desc).not.toContain("203.0.113.9");
    expect(desc).toContain("18.20.4.1");
  });
});
