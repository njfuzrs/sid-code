/**
 * Skill 运行时激活协调器（P1-2 条件激活 + P2-2 动态发现 + P3-2 增量 listing）
 *
 * 把三个此前的死模块接成一条链，挂到 query loop 的工具调用后回调：
 *
 *   工具调用（write/edit/read/glob/...）产生受影响文件路径
 *     │
 *     ├─ P1-2 ConditionalSkillStore.activateForPaths(paths)
 *     │      带 paths frontmatter 的 skill，路径匹配则激活（gate 解除 → 进 listing）
 *     │
 *     └─ P2-2 discoverSkillDirsForPaths(paths)
 *            沿目录链找 .sid-code/skills/ 子目录，发现新 skill 目录则加载其中 skill
 *     │
 *     ▼
 *   新激活/新发现的 skill 名 → drainNewlyActivated()
 *     由 query loop 经 reminderParts 增量注入（P3-2，cache-friendly：走 user reminder，
 *     不碰 system prompt 静态前缀，不击穿 prompt cache）。
 *
 * 线程模型：单会话内串行调用 onToolResults（query loop 每轮工具执行后一次），无并发。
 */

import { getLogger } from "../debug/logger.ts";
import type { SkillManager } from "./manager.ts";
import type { SkillDefinition } from "./types.ts";
import { ConditionalSkillStore } from "./conditional.ts";
import { extractAffectedPaths, discoverSkillDirsForPaths } from "./dynamic-discovery.ts";

export interface ActivationCoordinatorOptions {
  manager: SkillManager;
  /** 工作目录（动态发现的边界 + 条件路径匹配的基准） */
  cwd: string;
  /** 是否启用动态发现（P2-2）。默认 true。 */
  enableDynamicDiscovery?: boolean;
}

export class SkillActivationCoordinator {
  private manager: SkillManager;
  private cwd: string;
  private enableDynamic: boolean;
  private conditional = new ConditionalSkillStore();
  /** 动态发现已扫过的 skills 目录（去重，避免重复加载） */
  private discoveredDirs = new Set<string>();
  /** 待增量注入 listing 的新激活 skill 名（drain 后清空） */
  private pendingActivated: string[] = [];
  /** P3-2：已发送进 listing 的 skill 名（小写），用于首轮全量 + 后续增量去重 */
  private sentSkillNames = new Set<string>();

  constructor(opts: ActivationCoordinatorOptions) {
    this.manager = opts.manager;
    this.cwd = opts.cwd;
    this.enableDynamic = opts.enableDynamicDiscovery ?? true;
  }

  /**
   * 初始化：把带 paths 的条件 skill 分离出来并 gate（从初始 listing 隐藏）。
   * 无条件 skill 保持可见。返回被 gate 的条件 skill 名（用于日志/测试）。
   */
  init(allSkills: SkillDefinition[]): string[] {
    const unconditional = this.conditional.separate(allSkills);
    const gatedNames = allSkills.filter((s) => !unconditional.includes(s)).map((s) => s.name);
    this.manager.setGatedSkills(gatedNames);
    if (gatedNames.length > 0) {
      getLogger().info(
        "SKILL",
        `${gatedNames.length} 个条件激活 skill 待触发: ${gatedNames.join(", ")}`,
      );
    }
    // 列表注入基线对齐 reinit()（审计第 10 条）：冷启动时当前可见（无条件）skill
    // 已由 collectSkillListingEntries 经 system prompt 静态附件注入一轮，若不设基线，
    // drainListingDelta 首轮会因 sentSkillNames 为空再全量注入一次 → 首轮两份重复。
    // 设基线后 drainListingDelta 名副其实只做增量：首轮返回 null，后续仅新激活的走增量。
    this.sentSkillNames = new Set(
      this.manager.getListableSkills().map((s) => s.name.toLowerCase()),
    );
    this.pendingActivated = [];
    return gatedNames;
  }

  /**
   * P2-3：热重载后重新初始化条件门控。
   *
   * 与 init 的差异——保留已激活语义（只进不退）：
   *   - 重载前已激活（不在 conditional，即已 ungate 或本就无条件）的 skill，重载后**不再 gate**；
   *   - 只把「重载后新出现的条件 skill」且「重载前未激活过」的 gate 起来。
   * 并重置 listing 增量游标：把当前可 listing 的 skill 视为「已发送」基线，
   * 只有后续新激活/新增的 skill 才走增量注入，避免重载即全量重发冲垮 cache。
   *
   * @param allSkills 重载后的全量 skill
   * @param previouslyActivatedNames 重载前已激活（已 ungate）的 skill 名（小写不敏感）
   */
  reinit(allSkills: SkillDefinition[], previouslyActivatedNames: string[]): string[] {
    const activatedLc = new Set(previouslyActivatedNames.map((n) => n.toLowerCase()));
    // 重新分离：conditional 内部 Map 会被 separate 覆盖式重建
    this.conditional.reset();
    this.conditional.separate(allSkills);

    // 已激活过的条件 skill 立即重新激活（只进不退），其余保持 gate
    const gatedNames: string[] = [];
    for (const s of allSkills) {
      const isConditional = s.paths && s.paths.length > 0;
      if (!isConditional) continue;
      if (activatedLc.has(s.name.toLowerCase())) {
        // 重载前已激活 → 保持激活（从 conditional 移到 dynamic，不 gate）
        this.conditional.forceActivate(s.name);
        this.manager.ungateSkill(s.name);
      } else {
        gatedNames.push(s.name);
      }
    }
    this.manager.setGatedSkills(gatedNames);

    // 重置 listing 基线：当前可见 skill 视为已发送，避免重载后重发全量。
    this.sentSkillNames = new Set(
      this.manager.getListableSkills().map((s) => s.name.toLowerCase()),
    );
    this.pendingActivated = [];

    getLogger().info(
      "SKILL",
      `热重载重建门控：${gatedNames.length} 个条件 skill 待触发，保留 ${activatedLc.size} 个已激活`,
    );
    return gatedNames;
  }

  /** P2-3：当前已 ungate（可 listing）的 skill 名，供热重载前快照「已激活」态。 */
  getActivatedNames(): string[] {
    return this.manager.getListableSkills().map((s) => s.name);
  }

  /**
   * P2-4：登记「启动后才出现」的 skill（如 MCP 连接完成后发现的 skill），
   * 走 listing 增量注入路径。
   *
   * 与 reinit 的区别——reinit 会把当前全部 skill 视为已发送基线（配合 rebuildSystemPrompt
   * 全量重建 system prompt 使用）；而此方法只把新 skill 压入 pendingActivated，
   * 让 drainListingDelta 在下一轮把它们作为**增量**注入（system prompt 已在启动时建好、
   * 来不及包含这些迟到 skill，故必须走增量提醒，否则模型看不到）。
   *
   * @param names 新出现且应进入模型 listing 的 skill 名
   */
  enqueueListingForNewSkills(names: string[]): void {
    for (const n of names) {
      // 已发送过的不重复入队；被 gate 的（条件未触发）不入队
      if (this.sentSkillNames.has(n.toLowerCase())) continue;
      if (this.manager.isGated(n)) continue;
      this.pendingActivated.push(n);
    }
  }

  /**
   * query loop 每轮工具执行后调用：从工具输入提取受影响路径，
   * 跑条件激活 + 动态发现，累积新激活 skill 名到 pendingActivated。
   *
   * @param toolInputs 本轮各工具的 input 对象数组
   */
  async onToolResults(toolInputs: unknown[]): Promise<void> {
    if (toolInputs.length === 0) return;

    // 汇集本轮所有受影响文件路径
    const paths: string[] = [];
    for (const input of toolInputs) {
      paths.push(...extractAffectedPaths(input));
    }
    if (paths.length === 0) return;

    // ── P1-2：条件激活 ──
    try {
      const activated = this.conditional.activateForPaths(paths, this.cwd);
      for (const name of activated) {
        this.manager.ungateSkill(name);
        this.pendingActivated.push(name);
      }
    } catch (err) {
      getLogger().warn(
        "SKILL",
        `条件激活异常（忽略）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── P2-2：动态发现 ──
    if (this.enableDynamic) {
      try {
        const newDirs = discoverSkillDirsForPaths(paths, this.cwd, this.discoveredDirs);
        for (const dir of newDirs) this.discoveredDirs.add(dir);
        if (newDirs.length > 0) {
          await this.loadDiscoveredDirs(newDirs);
        }
      } catch (err) {
        getLogger().warn(
          "SKILL",
          `动态发现异常（忽略）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** 加载动态发现的 skills 目录，新 skill 追加进 manager 并标记待注入。 */
  private async loadDiscoveredDirs(dirs: string[]): Promise<void> {
    const { ExtensionLoader } = await import("../extension/loader.ts");
    const { SkillLoader } = await import("./loader.ts");
    const extLoader = new ExtensionLoader();
    const skillLoader = new SkillLoader(extLoader);
    const newSkills: SkillDefinition[] = [];

    for (const dir of dirs) {
      let files;
      try {
        files = await extLoader.scanSingleDir(dir, "project");
      } catch {
        continue;
      }
      for (const file of files) {
        // 动态发现的 skill 无命名空间前缀（本地项目 skill），但已存在同名则跳过
        const skill = skillLoader.buildNamespacedSkill(file, "", "skills");
        if (skill && !this.manager.getSkill(skill.name)) {
          newSkills.push(skill);
        }
      }
    }

    if (newSkills.length > 0) {
      this.manager.addPluginSkills(newSkills); // 复用 precedence 追加逻辑
      for (const s of newSkills) {
        if (!s.disableModelInvocation) this.pendingActivated.push(s.name);
      }
      getLogger().info(
        "SKILL",
        `动态发现 ${newSkills.length} 个 skill: ${newSkills.map((s) => s.name).join(", ")}`,
      );
    }
  }

  /**
   * P3-2：排空待注入的 skill 摘要（增量）。query loop 每轮开始调用一次。
   *
   * - 首轮（sentSkillNames 为空）：返回全部可 listing 的 skill（全量）。
   * - 后续轮：只返回**新激活/新发现**且尚未发送过的 skill（增量）。
   *
   * 返回的文本块由 loop 放进 reminderParts（user 消息，cache-friendly），
   * 不写进 system prompt 静态前缀，避免击穿 prompt cache。
   *
   * @returns system-reminder 文本块；无新增时返回 null。
   */
  drainListingDelta(): string | null {
    const listable = this.manager.getListableSkills();

    let toSend: SkillDefinition[];
    if (this.sentSkillNames.size === 0) {
      // 首轮全量
      toSend = listable;
    } else {
      // 增量：只发新激活且未发送过的
      const pendingSet = new Set(this.pendingActivated.map((n) => n.toLowerCase()));
      toSend = listable.filter(
        (s) =>
          pendingSet.has(s.name.toLowerCase()) && !this.sentSkillNames.has(s.name.toLowerCase()),
      );
    }

    // 清空 pending（无论首轮还是增量，都已消费）
    this.pendingActivated = [];

    if (toSend.length === 0) return null;

    for (const s of toSend) this.sentSkillNames.add(s.name.toLowerCase());

    const lines = toSend.map((s) => `- ${s.name}: ${(s.whenToUse || s.description || "").trim()}`);
    const isFirst = this.sentSkillNames.size === toSend.length;
    const header = isFirst
      ? "以下 Skill 现可通过 Skill 工具调用："
      : "以下 Skill 因你的文件操作已被激活，现可通过 Skill 工具调用：";
    return `<system-reminder>\n${header}\n${lines.join("\n")}\n</system-reminder>`;
  }

  /** 测试/诊断用：已发送 listing 的 skill 名快照。 */
  getSentNames(): string[] {
    return [...this.sentSkillNames];
  }
}
