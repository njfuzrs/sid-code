/**
 * UserIntentLedger —— auto 档分类器能看见的「用户亲手说过的话」
 *
 * 背景（B1）：auto 档此前的判据是「这个动作有没有副作用」，于是用户明确要求
 * 「创建 PR」之后，`git push` / `gh pr create` 仍然每次必弹。分类器缺的不是更多上下文，
 * 是**授权范围**：同一个命令，用户要求过就在范围内，没人提过就越界。
 * 判据从「有没有副作用」改成「是否超出用户授权」，`<user_intent>` 就是授权依据。
 *
 * 为什么不从 `messages` 反推：消息历史里的 user 角色混着任务通知
 * （`_meta.origin = "task-notification"`）、系统提醒、tool_result、压缩摘要、hook 的
 * additionalContext —— 它们都不是用户说的，而且大多是 agent 或外部内容能影响的通道。
 * 把它们混进「用户授权」等于给 agent 一条自己给自己授权的路。
 * 所以只认唯一写入点：`QueryEngine.submitMessage`（用户提示被接受、且未被 hook 阻塞之后）。
 *
 * 收 / 不收：
 * - 收：TUI 输入、无头 `-p` 的提示、bridge/IDE 转来的用户输入；
 * - 不收：斜杠命令**展开后的模板正文**（模板来自仓库文件、agent 可改写；只收用户键入的
 *   命令行本身，即 `displayCommand`）；定时任务触发的提示（可能由 agent 经 cron 工具创建，
 *   `scheduled`）；子代理的任务提示（由主 agent 撰写）。
 *
 * 作用域：会话。`reset()` 由 `/clear` 触发。派生 checker（子代理）按引用共享父会话的账本
 * —— 子代理做的事，授权仍然来自主会话里的用户。
 */

/** 账本里的一条用户发言 */
export interface UserIntentEntry {
  /** 用户原话（已按长度上限裁剪） */
  text: string;
  /** 会话内自增序号，从 1 开始。让分类器知道先后顺序，也方便轨迹定位 */
  seq: number;
  /** 记录时刻（ISO 8601） */
  at: string;
}

/** 送进分类器提示的账本快照 */
export interface UserIntentSnapshot {
  entries: UserIntentEntry[];
  /** 因「首条 + 最近 4 条」上限被挤出的条数 */
  omitted: number;
}

/**
 * 保留的条数上限：会话首条 + 最近 4 条。
 * 首条通常承载任务陈述（「修这个文档里的问题」），最近 4 条承载「现在在做什么」。
 * 更多条对判定的边际收益很低，却会线性推高每一轮里**每一条** bash 分类请求的输入。
 */
export const USER_INTENT_MAX_ENTRIES = 5;
/**
 * 单条字符上限。
 * 超长提示（贴进来的整份文档 / 长日志）里与授权相关的通常只有头尾的任务描述，
 * 中间是待处理的数据。1500 字符是「一眼能读完一整条任务陈述」的量级。
 */
export const USER_INTENT_MAX_CHARS = 1500;
/** 超长时保留的头 / 尾字符数 */
const CLIP_HEAD_CHARS = 1000;
const CLIP_TAIL_CHARS = 500;

/**
 * 按上限裁剪单条文本：保留首尾、中间标注省略量。
 * 为什么保留两端：任务陈述在首部，约束条件（「不要动 X」「必须自动合并」）常在尾部。
 */
export function clipUserIntentText(text: string): string {
  if (text.length <= USER_INTENT_MAX_CHARS) return text;
  const omitted = text.length - CLIP_HEAD_CHARS - CLIP_TAIL_CHARS;
  return `${text.slice(0, CLIP_HEAD_CHARS)}…[省略 ${omitted} 字]…${text.slice(-CLIP_TAIL_CHARS)}`;
}

export class UserIntentLedger {
  private entries: UserIntentEntry[] = [];
  private seqCounter = 0;
  private omittedCount = 0;

  /**
   * 记录一条用户原话。
   * **只应由 `QueryEngine.submitMessage` 调用**——其它调用点都会让「用户授权」失去意义
   * （见文件头：这是 agent 唯一无法写入的通道）。
   */
  record(text: string): void {
    const trimmed = text.trim();
    // 空输入不算授权。engine 侧已保证有内容，这里再挡一次是因为「空 <user_intent> 条目」
    // 在提示里会显得像用户说过话，白白占一条配额。
    if (!trimmed) return;
    this.seqCounter += 1;
    this.entries.push({
      text: clipUserIntentText(trimmed),
      seq: this.seqCounter,
      at: new Date().toISOString(),
    });
    // 挤出时保留首条（索引 0）：任务陈述通常在第一条，丢它等于把授权依据整个丢掉。
    while (this.entries.length > USER_INTENT_MAX_ENTRIES) {
      this.entries.splice(1, 1);
      this.omittedCount += 1;
    }
  }

  /** 取快照。返回副本——分类器请求不应看到账本之后的改动。 */
  snapshot(): UserIntentSnapshot {
    return {
      entries: this.entries.map((e) => ({ ...e })),
      omitted: this.omittedCount,
    };
  }

  /** 清空（`/clear` 时调用：新会话不该继承旧会话的授权）。 */
  reset(): void {
    this.entries = [];
    this.seqCounter = 0;
    this.omittedCount = 0;
  }

  /** 当前条数（诊断与测试用） */
  get size(): number {
    return this.entries.length;
  }
}
