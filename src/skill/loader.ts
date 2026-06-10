/**
 * Skill 加载器
 * 从 ~/.sid-code/skills/ 和 {project}/.sid-code/skills/ 加载 Skill 定义
 */

import { dirname } from "node:path";
import { ExtensionLoader } from "../extension/loader.ts";
import { parseFrontmatter } from "../extension/frontmatter.ts";
import type { ScanOptions, ParsedExtensionFile } from "../extension/types.ts";
import { getLogger } from "../debug/logger.ts";
import type { SkillDefinition } from "./types.ts";
import { EMBEDDED_BUILTIN_SKILLS } from "./builtin-embedded.generated.ts";

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
    const files = await this.extensionLoader.scan(
      "skills",
      projectDir,
      scanOptions,
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
   * 从编译期嵌入的清单加载 builtin Skill（编译二进制回退路径）。
   *
   * 背景：`bun build --compile` 不会把 fs.readFile 读盘的 SKILL.md 嵌入二进制，
   * 编译二进制运行时磁盘上没有 builtin 目录 → 磁盘扫描返回空。此方法用
   * builtin-embedded.generated.ts（编译期由 scripts/embed-builtin-skills.ts 生成、
   * 会被 --compile 打进二进制的真实 TS 模块）解析出 builtin Skill 定义。
   *
   * 源码运行（bun run）时磁盘扫描已能命中，调用方应优先用磁盘结果，仅在磁盘为空时回退到此。
   */
  loadFromEmbedded(): SkillDefinition[] {
    const log = getLogger();
    const skills: SkillDefinition[] = [];

    for (const entry of EMBEDDED_BUILTIN_SKILLS) {
      if (skills.length >= MAX_SKILLS) break;
      const { frontmatter, body } = parseFrontmatter(entry.rawContent);
      // 嵌入场景没有真实磁盘路径：用标识性虚拟路径（仅用于日志/调试，
      // bug-fix 等 builtin skill 不依赖 ${SKILL_DIR} 资源目录）。
      const virtualPath = `<embedded>/builtin/${entry.name}/SKILL.md`;
      const file: ParsedExtensionFile = {
        name: entry.name,
        filePath: virtualPath,
        source: "builtin",
        rawContent: entry.rawContent,
        frontmatter,
        body,
      };
      const skill = this.buildSkillDefinition(file);
      if (skill) skills.push(skill);
    }

    if (skills.length > 0) {
      log.info("SKILL", `从嵌入清单加载了 ${skills.length} 个 builtin Skill`, {
        names: skills.map(s => s.name),
      });
    }

    return skills;
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
      whenToUse: fm["when-to-use"] as string ?? fm["whenToUse"] as string,
      argumentHint: fm["argument-hint"] as string ?? fm["argumentHint"] as string,
      model: fm.model as string,
      disableModelInvocation: fm["disable-model-invocation"] === true || fm["disableModelInvocation"] === true,
      mode,
      context,
      maxTurns,
      timeoutMins,
      prompt: file.body,
      source: file.source,
      loadedFrom: file.source === "builtin" ? "builtin" : "skills",
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
