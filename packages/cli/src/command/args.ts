/**
 * 命令参数解析器
 * 支持位置参数、--flag 选项、类型转换和验证
 *
 * 示例：
 *   "add server --scope user --timeout=5000"
 *   => positional: ["add", "server"]
 *   => options: { scope: "user", timeout: "5000" }
 */

export class ArgParser {
  private positional: string[] = [];
  private options = new Map<string, string | boolean>();

  constructor(argsStr: string) {
    const parts = argsStr.trim().split(/\s+/).filter(Boolean);

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      if (part.startsWith("--")) {
        // 处理 --key=value 或 --key value 或 --flag
        const eq = part.indexOf("=");
        if (eq > 0) {
          // --key=value
          const key = part.slice(2, eq);
          const value = part.slice(eq + 1);
          this.options.set(key, value);
        } else {
          // --key value 或 --flag
          const key = part.slice(2);
          const next = parts[i + 1];
          if (next && !next.startsWith("--")) {
            // --key value
            this.options.set(key, next);
            i++;
          } else {
            // --flag (布尔标志)
            this.options.set(key, true);
          }
        }
      } else {
        // 位置参数
        this.positional.push(part);
      }
    }
  }

  /** 获取位置参数（从 0 开始） */
  get(index: number): string | undefined {
    return this.positional[index];
  }

  /** 获取所有位置参数 */
  getAll(): string[] {
    return [...this.positional];
  }

  /** 获取从指定索引开始的所有位置参数，用空格连接 */
  getRest(fromIndex: number): string {
    return this.positional.slice(fromIndex).join(" ");
  }

  /** 获取选项值（字符串或布尔） */
  option(name: string): string | boolean | undefined;
  option(name: string, defaultValue: string): string;
  option(name: string, defaultValue: boolean): boolean;
  option(name: string, defaultValue?: string | boolean): string | boolean | undefined {
    const value = this.options.get(name);
    return value !== undefined ? value : defaultValue;
  }

  /** 获取布尔标志（--flag 存在返回 true） */
  flag(name: string): boolean {
    const value = this.options.get(name);
    return value === true || value === "true";
  }

  /** 获取字符串选项 */
  string(name: string, defaultValue?: string): string | undefined {
    const value = this.options.get(name);
    if (value === undefined) return defaultValue;
    if (typeof value === "boolean") return defaultValue;
    return value;
  }

  /** 获取数字选项 */
  number(name: string, defaultValue?: number): number | undefined {
    const value = this.options.get(name);
    if (value === undefined) return defaultValue;
    if (typeof value === "boolean") return defaultValue;
    const num = parseInt(value, 10);
    return isNaN(num) ? defaultValue : num;
  }

  /** 检查选项是否存在 */
  has(name: string): boolean {
    return this.options.has(name);
  }

  /** 获取位置参数数量 */
  get length(): number {
    return this.positional.length;
  }
}
