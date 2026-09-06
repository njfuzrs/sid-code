/**
 * 流式中「这条输入能不能直送」的唯一判据（P0-1 / P0-2）。
 *
 * 背景：修复前 `App.tsx` 的 handleSubmit 里写的是 `if (busy && !text.startsWith("/"))`
 * —— 那个否定条件让**所有**斜杠命令在流式中一律穿透直送，只有普通文本入队。
 * 后果不是"少一个便利功能"，是一条数据正确性缺陷：
 *
 *   t0 模型流式输出，持续往 ctxMgr 追加消息
 *   t1 用户敲 /compact         → 直送（无 busy 守卫）
 *   t2 compact 读 getMessages() → 拿到快照 S
 *   t3 模型又追加若干消息        → ctxMgr 实为 S + ΔM
 *   t4 compact 调模型生成摘要（秒级，期间 t3 反复发生）
 *   t5 compact setMessages(基于 S 的结果) → ΔM 全部丢失
 *
 * `ctxMgr.acquireCompactLock()` 防不住它：那把锁防的是「压缩 vs 压缩」，
 * 流式写入那一侧根本不查这把锁。窗口是"调一次模型"的时长，很容易撞上。
 *
 * 而 `immediate` 字段本来就是为"哪些命令可以插队"设计的：27 条命令声明了它，
 * 修复前 0 处生产代码读取。恰好三条**不**标 immediate 的命令
 * （`/compact`、`/btw`、`/loop`）共同点是它们会改动"模型正在读写的那份状态"。
 * 所以修复不是新增一套规则，是**让既有声明真正生效**。
 */

/**
 * 判定所需的最小命令形状（与 TUIState.commands 的轻量结构对齐）。
 *
 * 刻意**不导出**：没有外部消费者时导出一个符号就是给自己造一条死导出
 * （命令体系门禁 G1 会数它）。调用方靠结构类型传入即可，测试直接写对象字面量。
 */
interface StreamingGateCommand {
  name: string;
  aliases?: string[];
  /** 显式标注可插队；未标注 = 不可插队（fail-closed） */
  immediate?: boolean;
  /** 命令类型；prompt 型一律不许插队，见下 */
  type?: string;
}

/**
 * 前置拦截的命令：它们在 dispatchInput 里就被直接处理掉（`triggerQuit()`），
 * 不走命令注册表，因此不受本判据影响 —— 列在这里是为了让判定与注释自洽，
 * 避免下一个人以为 `/exit` 需要标 immediate。
 */
const PRE_INTERCEPTED_COMMANDS = ["exit", "quit"] as const;

/**
 * 从一条用户输入里取出命令名（不含前导 `/`，不含参数）。内部工具，不导出。
 * 与 `parseSlashCommand` 的口径保持一致：按空白切分取第一段。
 * 非斜杠输入返回 null。
 */
function extractCommandName(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const first = trimmed.slice(1).split(/\s+/)[0];
  return first ? first : null;
}

/**
 * 流式进行中，这条输入是否允许**直送**（true）还是应当**入队**（false）。
 *
 * 判定顺序（每一条都刻意 fail-closed —— 拿不准就入队，入队最坏是晚几秒执行，
 * 直送最坏是用户消息凭空丢失，两者代价不对称）：
 *
 * 1. 普通文本 → 入队（原有行为，不变）
 * 2. `/exit` `/quit` → 直送（dispatchInput 前置拦截，本就不经注册表）
 * 3. 命令表里查不到 → 入队（可能是路径 passthrough 或未知命令，
 *    两者都不该在流式中抢道）
 * 4. `prompt` 型命令 → 一律入队，**即使标了 immediate**。它的动作就是往对话里
 *    塞消息，而对话正在被写 —— 类型层做硬限（机械可查），命令声明做细化，两层都要
 * 5. 其余：只有显式 `immediate === true` 才直送
 */
export function canRunDuringStreaming(
  text: string,
  commands: readonly StreamingGateCommand[],
): boolean {
  const name = extractCommandName(text);
  // 1. 普通文本：入队接续
  if (!name) return false;

  // 2. 前置拦截命令：不经注册表，直送
  if ((PRE_INTERCEPTED_COMMANDS as readonly string[]).includes(name)) return true;

  // 3. 查不到 → 入队（fail-closed）
  const cmd =
    commands.find((c) => c.name === name) ?? commands.find((c) => c.aliases?.includes(name));
  if (!cmd) return false;

  // 4. prompt 型硬限：往对话塞消息的命令永不插队
  if (cmd.type === "prompt") return false;

  // 5. 只有显式声明 immediate 的才直送
  return cmd.immediate === true;
}
