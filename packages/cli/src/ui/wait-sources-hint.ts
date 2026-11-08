/**
 * `Ctrl+T` 隐藏后台面板时的等待源兜底提示（§5.7.6）。
 *
 * 为什么不加这一行会出事：面板一藏，用户就看不见里面还有什么挂着。唤醒尤其危险——
 * 它到点会**自己**叫醒 agent，用户只觉得「没人说话，agent 突然开始干活」，
 * 正是 §2.4「凭空冒出来」的病灶。提示存在的唯一目的就是消除这个意外感。
 *
 * 三条判据（T-T1-6），任何一条写反都会让它变成噪音：
 * 1. **面板隐藏**才出——面板可见时那几行就摆在屏幕上，Footer 再写一遍是第二份
 *    （§5.7.2「面板 = 现在怎样，消息流 = 发生过什么」的同一口径）；
 * 2. **有等待源**才出——只报「有几个东西在等」，一个都没有时这行没有任何信息；
 * 3. 只数唤醒（PR 3 会加监控）：shell / agent 在面板里是「在跑」，随时有终态通知，
 *    用户不会「忘了」它们；唤醒是「在等」，没有任何东西会提醒用户它存在过。
 *
 * 抽成纯函数而不是塞在组件里：判据 1 是一条**极易写漏的**前提（MUT-15 就是删掉它，
 * 看 T-T1-6 是否变红），纯函数能直接对着这三条断言，不必渲染整棵底部区域。
 */
import type { TaskDisplayInfo } from "./App.tsx";

export interface WaitSourcesHint {
  /** 计数文案，如「1 个唤醒等待中」。PR 3 会加「N 个监控 · 」前缀。 */
  counts: string;
  /** 展开面板的键位显示名（用户可在 keybindings.json 重绑，缺省 Ctrl+T） */
  toggle: string;
}

export function deriveWaitSourcesHint(opts: {
  /** 面板数据源（已含唤醒行，见 state-bridge） */
  tasks: TaskDisplayInfo[];
  /** `Ctrl+T` 是否把面板藏起来了（useUIState 的 taskPanelHidden） */
  panelHidden: boolean;
  /** 键位显示名；缺省 `Ctrl+T` */
  toggleDisplay?: string;
}): WaitSourcesHint | null {
  if (!opts.panelHidden) return null;
  const wakeups = opts.tasks.filter((t) => t.kind === "wakeup").length;
  if (wakeups === 0) return null;
  return {
    counts: `${wakeups} 个唤醒等待中`,
    toggle: opts.toggleDisplay ?? "Ctrl+T",
  };
}
