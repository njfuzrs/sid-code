/**
 * Skill 加载器
 * 从 ~/.sid-code/skills/ 和 {project}/.sid-code/skills/ 加载 Skill 定义
 */

import { dirname } from "node:path";
import { ExtensionLoader } from "../extension/loader.ts";
import type { ScanOptions, ParsedExtensionFile } from "../extension/types.ts";
import { getLogger } from "../debug/logger.ts";
import type { SkillDefinition } from "./types.ts";

/** 解析字符串列表字段（支持数组 / 逗号或空白分隔字符串） */
function parseStringList(raw: unknown): string[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) {
    const list = raw.map(String).map((s) => s.trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  if (typeof raw === "string") {
    const list = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}

/** 最大 Skill 数量（避免工具列表膨胀，支持更多自定义 Skill） */
const MAX_SKILLS = 50;

export class SkillLoader {
  private extensionLoader: ExtensionLoader;

  constructor(extensionLoader?: ExtensionLoader) {
    this.extensionLoader = extensionLoader ?? new ExtensionLoader();
  }

  /** P2-3：暴露底层 ExtensionLoader，供热重载清缓存（否则命中 5min TTL 旧结果）。 */
  getExtensionLoader(): ExtensionLoader {
    return this.extensionLoader;
  }

  /**
   * 加载所有 Skill 定义
   *
   * 加载来源（按优先级从低到高）：
   * - builtin（仅当 scanOptions.builtinDir 提供时）：sid-code 自带 Skill,从 builtinDir/<name>/SKILL.md 加载
   * - user：~/.sid-code/skills/
   * - project：{projectDir}/.sid-code/skills/
   *
   * 注意:builtinDir 不会被当作 projectDir,而是直接作为 builtin 来源传给 ExtensionLoader。
   */
  async loadAll(
    projectDir?: string,
    scanOptions?: ScanOptions,
  ): Promise<SkillDefinition[]> {
    const log = getLogger();
    // P2-1：默认注入企业 managed skills 目录候选（调用方未显式指定时）。
    // managed 层最高优先级，覆盖同名 user/project；SID_CODE_DISABLE_POLICY_SKILLS=1 时 loader 内部跳过。
    const { sidPaths } = await import("../config/paths.ts");
    const effectiveOptions: ScanOptions = {
      ...scanOptions,
      managedDirs: scanOptions?.managedDirs ?? sidPaths.managedExtensionDirs("skills"),
    };
    const files = await this.extensionLoader.scan(
      "skills",
      projectDir,
      effectiveOptions,
    );
    const skills: SkillDefinition[] = [];

    for (const file of files) {
      if (skills.length >= MAX_SKILLS) {
        log.warn("SKILL", `已达到最大 Skill 数量 (${MAX_SKILLS})，跳过剩余文件`);
        break;
      }

      const skill = this.buildSkillDefinition(file);
      if (skill) skills.push(skill);
    }

    if (skills.length > 0) {
      log.info("SKILL", `加载了 ${skills.length} 个 Skill`, {
        names: skills.map(s => s.name),
      });
    }

    return skills;
  }

  /**
   * P0-4：把一个已解析的扩展文件转成 SkillDefinition，并施加命名空间前缀。
   *
   * 插件 skills 复用此入口：先走标准 buildSkillDefinition（frontmatter 解析、校验），
   * 再把 name 改写为 `<prefix>:<name>`。关键——前缀在 sanitize 之后施加，绕开
   * sanitizeName 会把 `:` 替成 `-`、validateName 会拒 `:` 的问题（否则命名空间被破坏）。
   *
   * @param prefix 命名空间前缀（如插件名）；空则等价于 buildSkillDefinition
   * @param loadedFrom 覆盖 loadedFrom（插件传 "plugin"）
   */
  buildNamespacedSkill(
    file: ParsedExtensionFile,
    prefix: string,
    loadedFrom?: SkillDefinition["loadedFrom"],
  ): SkillDefinition | null {
    const skill = this.buildSkillDefinition(file);
    if (!skill) return null;
    if (prefix) skill.name = `${prefix}:${skill.name}`;
    if (loadedFrom) skill.loadedFrom = loadedFrom;
    return skill;
  }

  /**
   * 把一个已解析的扩展文件（frontmatter + body）转成 SkillDefinition。
   * 磁盘扫描与嵌入回退两条路径共用此逻辑，保证两种来源的解析结果一致。
   * 校验不通过（disabled / 名称非法 / 缺 description）时返回 null。
   */
  private buildSkillDefinition(file: ParsedExtensionFile): SkillDefinition | null {
    const log = getLogger();
    const fm = file.frontmatter;

    // 检查 disabled 字段
    if (fm.disabled === true) {
      log.debug("SKILL", `跳过已禁用的 Skill: ${file.name}`);
      return null;
    }

    // 名称清理和验证
    const rawName = (fm.name as string) || file.name;
    const sanitizedName = this.sanitizeName(rawName);

    if (!this.validateName(sanitizedName)) {
      log.warn("SKILL", `跳过无效名称的 Skill: ${rawName}`);
      return null;
    }

    // 验证 description 非空
    const description = (fm.description as string) || "";
    if (!description.trim()) {
      log.warn("SKILL", `跳过缺少 description 的 Skill: ${sanitizedName}`);
      return null;
    }

    // 解析 allowed-tools（支持逗号分隔字符串或数组）
    let allowedTools: string[] | undefined;
    const rawTools = fm["allowed-tools"] ?? fm["allowedTools"] ?? fm["tools"];
    if (typeof rawTools === "string") {
      allowedTools = rawTools.split(",").map(s => s.trim()).filter(Boolean);
    } else if (Array.isArray(rawTools)) {
      allowedTools = rawTools.map(String);
    }

    // 解析 mode 字段
    const rawMode = fm.mode as string;
    const mode: "activate" | "delegate" | undefined =
      rawMode === "activate" || rawMode === "delegate" ? rawMode : undefined;

    // 解析 context 字段（优先级高于 mode；未指定时由 mode 推导）
    const rawContext = fm.context as string;
    let context: "inline" | "fork" | undefined =
      rawContext === "inline" || rawContext === "fork" ? rawContext : undefined;
    if (!context && mode) {
      context = mode === "activate" ? "inline" : "fork";
    }

    // 解析 maxTurns 和 timeoutMins
    const maxTurns = typeof fm["max-turns"] === "number" ? fm["max-turns"] :
                     typeof fm["maxTurns"] === "number" ? fm["maxTurns"] : undefined;
    const timeoutMins = typeof fm["timeout-mins"] === "number" ? fm["timeout-mins"] :
                        typeof fm["timeoutMins"] === "number" ? fm["timeoutMins"] : undefined;

    // user-invocable（默认 true）
    const rawUserInvocable = fm["user-invocable"] ?? fm["userInvocable"];
    const userInvocable = rawUserInvocable === false ? false : true;

    // 条件激活路径模式
    const paths = parseStringList(fm["paths"]);
    // 命名参数列表
    const argumentNames = parseStringList(fm["arguments"]);
    // 生命周期钩子
    const hooks =
      fm["hooks"] && typeof fm["hooks"] === "object" && !Array.isArray(fm["hooks"])
        ? (fm["hooks"] as SkillDefinition["hooks"])
        : undefined;

    const skillRoot = dirname(file.filePath);

    return {
      name: sanitizedName,
      description,
      allowedTools,
      // P1-3 变量/字段兼容：CC 权威字段是 when_to_use（下划线，frontmatterParser.ts），
      // sid 原生用 when-to-use/whenToUse。三写法兼容，避免从 CC 迁移的 skill 静默丢 whenToUse。
      whenToUse: (fm["when_to_use"] as string) ?? (fm["when-to-use"] as string) ?? (fm["whenToUse"] as string),
      argumentHint: fm["argument-hint"] as string ?? fm["argumentHint"] as string,
      model: fm.model as string,
      disableModelInvocation: fm["disable-model-invocation"] === true || fm["disableModelInvocation"] === true,
      mode,
      context,
      maxTurns,
      timeoutMins,
      prompt: file.body,
      source: file.source,
      loadedFrom: file.source === "builtin" ? "builtin" : file.source === "managed" ? "managed" : "skills",
      filePath: file.filePath,
      skillRoot,
      userInvocable,
      version: fm["version"] as string,
      effort: fm["effort"] as string,
      agent: fm["agent"] as string,
      shell: fm["shell"] as string,
      argumentNames,
      paths,
      hooks,
    };
  }

  /**
   * 清理 Skill 名称：替换非法字符为 -
   */
  private sanitizeName(name: string): string {
    return name.replace(/[:\\/<>*?"|]/g, "-");
  }

  /**
   * 验证 Skill 名称：非空、slug 格式
   */
  private validateName(name: string): boolean {
    if (!name) return false;
    // slug 格式：小写字母、数字、连字符、下划线，首字符必须是字母或数字
    return /^[a-z0-9][a-z0-9-_]*$/i.test(name);
  }
}
