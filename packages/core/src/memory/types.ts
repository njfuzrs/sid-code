/**
 * 记忆类型定义（对齐 Claude Code memdir/memoryTypes.ts）
 *
 * 封闭分类法：只用 4 种记忆类型，模型不需要在无限分类空间里做选择。
 * 4 种类型覆盖了"不可从代码推导的信息"的所有维度。
 */

/** 封闭分类法：4 种记忆类型 */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** 判断字符串是否为合法记忆类型 */
export function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === "string" && (MEMORY_TYPES as readonly string[]).includes(v);
}

/** 各类型的简短说明（用于提取/召回提示词） */
export const MEMORY_TYPE_DESCRIPTIONS: Record<MemoryType, string> = {
  user: "用户画像（角色、目标、知识水平、长期偏好）",
  feedback: "行为反馈（用户的纠正与确认，含 Why / How to apply）",
  project: "项目上下文（进行中的工作、决策、截止日期，无法从代码推导）",
  reference: "外部引用（外部系统的指针：URL、dashboard、ticket）",
};

/** 记忆文件 frontmatter 结构 */
export interface MemoryFrontmatter {
  /** 记忆名称（kebab-case slug，唯一标识） */
  name: string;
  /** 一行描述（用于相关性判断，注入 MEMORY.md 索引） */
  description: string;
  /** 记忆类型 */
  type: MemoryType;
}

/**
 * 扫描后的记忆头信息（不含完整正文，用于索引和召回初筛）
 */
export interface MemoryHeader {
  /** 文件名（不含路径，如 user_role.md） */
  filename: string;
  /** 完整路径 */
  filePath: string;
  /** 最后修改时间（毫秒） */
  mtimeMs: number;
  /** 一行描述（解析失败时为 null） */
  description: string | null;
  /** 记忆名称（frontmatter name，解析失败时回退文件名） */
  name: string | null;
  /** 记忆类型（解析失败时为 undefined） */
  type: MemoryType | undefined;
}

/** 召回的记忆（包含完整正文 + 新鲜度信息） */
export interface RelevantMemory {
  /** 完整路径 */
  path: string;
  /** 文件名 */
  filename: string;
  /** 最后修改时间（毫秒） */
  mtimeMs: number;
  /** 完整正文（含 frontmatter 之后的内容） */
  content: string;
}

/** 记忆存储限制（对齐 Claude Code） */
export const MEMORY_LIMITS = {
  /** MEMORY.md 索引最大行数 */
  INDEX_MAX_LINES: 200,
  /** MEMORY.md 索引最大字节数 */
  INDEX_MAX_BYTES: 25_000,
  /** 单条记忆正文最大字符数 */
  ENTRY_MAX_CHARS: 10_000,
  /** 扫描时最多处理的记忆文件数（防目录膨胀） */
  SCAN_MAX_FILES: 200,
  /** 单次召回最多返回的记忆数 */
  RECALL_MAX: 5,
} as const;
