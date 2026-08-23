/**
 * 权限/Shell 确认弹窗的**选项集构建**（纯函数，便于单测）。
 *
 * 为什么单独抽一个模块：确认框的选项集不是固定三项——它随工具类型（Bash 才有持久档）
 * 和危险性（破坏性命令去掉持久档、并把「拒绝」提到首位当安全默认）变化。这套分支逻辑
 * 原先散在两份组件副本里各写一遍（DialogManager 的 PermissionDialog 与 PermissionPrompt），
 * 结果两份的选项集长期不一致：线上那份缺了 `always-persist`，而 app.ts 已经把整条持久化
 * 链路（persistBashAllowRule）实现完了，用户按不出来。抽成纯函数后只有一份判定，且可单测。
 *
 * 本模块**刻意不 import theme**：颜色是渲染层的事，纯模块只给「语义色角色」(tone)，
 * 由组件映射到 theme 语义 token。这样单测不需要拉起 themeManager。
 */

/** 权限决策结果（与 app.ts setTUIConfirmCallback 的回调签名同值） */
export type PermissionAnswer = "yes" | "no" | "always" | "always-persist";

/**
 * 是否为「会执行 shell 命令」的工具——只有这类工具的持久档能归一成 `Bash(<command>)` 规则。
 *
 * 判定放宽到正则而不是 `toolName === "bash"`：原先那份硬编码等值判断，在工具改名或
 * 出现 `shell` 之类别名时会静默失去持久档（不报错，只是选项少一个，没人发现）。
 * 口径与 danger-detect.ts 的 isShellTool 保持一致。
 */
export function isBashLikeTool(toolName: string): boolean {
  return /bash|shell|exec|command/i.test(toolName);
}

/**
 * 选项语义色角色。映射到 theme 的规则见 HotkeyChoiceList 的 TONE_COLOR：
 * allow=success 绿 / deny=error 红 / session=warning 黄 / persist=品牌蓝。
 */
export type ChoiceTone = "allow" | "deny" | "session" | "persist";

/** 通用「带快捷键的选项」——HotkeyChoiceList 消费的最小形状 */
export interface HotkeyChoice<T> {
  /** 选中后回灌的值 */
  value: T;
  /**
   * 快捷键字母。**大小写有意义**：小写=裸按该键；大写=需按 Shift（如 `A` = Shift+A）。
   * 匹配逻辑在 matchHotkey，不要在组件里另写一份。
   */
  hotkey: string;
  /** 选项文案 */
  label: string;
  /** 语义色角色 */
  tone: ChoiceTone;
  /** 补充说明（仅光标所在行展示），可选 */
  description?: string;
}

export type PermissionChoice = HotkeyChoice<PermissionAnswer>;

/**
 * 构建权限确认的选项集。
 *
 * - 危险操作（破坏性命令）：`[拒绝, 允许, 本会话始终允许]`——「拒绝」提到首位，
 *   配合 initialPermissionChoiceIndex 把光标默认落在它上面（src/ui/CLAUDE.md L4-E 安全默认）。
 *   **危险操作不提供持久档**：一键把破坏性命令永久放行，代价远大于省下的确认次数。
 * - 普通 Bash：`[允许, 拒绝, 本会话始终允许, 持久化到项目配置]`——持久档由
 *   app.ts persistBashAllowRule 写进 project settings（精确匹配整条命令，不自动加 `*`）。
 * - 其它工具：`[允许, 拒绝, 本会话始终允许]`——文件编辑类不给持久档（对齐 CC「Edit always 仅会话」）。
 */
export function buildPermissionChoices(opts: {
  toolName: string;
  isDangerous: boolean;
}): PermissionChoice[] {
  const { toolName, isDangerous } = opts;
  const allow: PermissionChoice = {
    value: "yes",
    hotkey: "y",
    label: isDangerous ? "确认执行" : "允许",
    tone: "allow",
    description: "仅本次放行",
  };
  const deny: PermissionChoice = {
    value: "no",
    hotkey: "n",
    label: isDangerous ? "拒绝（推荐）" : "拒绝",
    tone: "deny",
    description: "模型会知道被拒，换个思路继续",
  };
  const session: PermissionChoice = {
    value: "always",
    hotkey: "a",
    label: "本会话始终允许",
    tone: "session",
    description: "退出后失效",
  };

  if (isDangerous) {
    // 安全默认：拒绝在前，且不给持久档
    return [deny, allow, session];
  }

  // 持久档仅 Bash 提供：归一为 Bash(<command>) 规则才有意义，其它工具无对应规则形态
  if (isBashLikeTool(toolName)) {
    return [
      allow,
      deny,
      session,
      {
        value: "always-persist",
        hotkey: "A",
        label: "持久化到项目配置",
        tone: "persist",
        description: "写入 project settings，跨会话生效（Shift+A）",
      },
    ];
  }
  return [allow, deny, session];
}

/**
 * 光标初始落点。
 *
 * 危险操作落在「拒绝」上——手滑回车不造成破坏（src/ui/CLAUDE.md L4-E）。
 * 这里按 value 反查而不是硬写 0：选项顺序将来若再调整，安全默认不会跟着漂。
 */
export function initialPermissionChoiceIndex(
  choices: readonly PermissionChoice[],
  isDangerous: boolean,
): number {
  if (!isDangerous) return 0;
  const denyIndex = choices.findIndex((c) => c.value === "no");
  return denyIndex >= 0 ? denyIndex : 0;
}

/** Shell 命令确认的选项集（值是 boolean：true=执行）。危险时同样把取消提到首位。 */
export function buildShellConfirmChoices(isDangerous: boolean): Array<HotkeyChoice<boolean>> {
  const run: HotkeyChoice<boolean> = {
    value: true,
    hotkey: "y",
    label: "确认执行",
    tone: "allow",
  };
  const cancel: HotkeyChoice<boolean> = {
    value: false,
    hotkey: "n",
    label: isDangerous ? "取消（推荐）" : "取消",
    tone: "deny",
  };
  return isDangerous ? [cancel, run] : [run, cancel];
}

/** Shell 确认的光标初始落点：危险时落在「取消」。 */
export function initialShellChoiceIndex(
  choices: ReadonlyArray<HotkeyChoice<boolean>>,
  isDangerous: boolean,
): number {
  if (!isDangerous) return 0;
  const cancelIndex = choices.findIndex((c) => c.value === false);
  return cancelIndex >= 0 ? cancelIndex : 0;
}

/**
 * 按快捷键查选项。
 *
 * 大小写敏感的那半是关键：`A`（持久档）与 `a`（会话档）是两个不同决策，
 * 终端上报 Shift+A 时 `key.name` 仍是 `"a"`、靠 `key.shift` 区分——所以必须
 * **同时**比对字母与 shift 修饰，不能只看 name（否则裸 a 会把 Shift+A 截胡，
 * 或者反过来把持久档误触发成会话档）。
 */
export function matchHotkey<T extends { hotkey: string }>(
  choices: readonly T[],
  keyName: string,
  shift: boolean,
): T | undefined {
  return choices.find((c) => {
    const needShift = c.hotkey !== c.hotkey.toLowerCase();
    return c.hotkey.toLowerCase() === keyName && needShift === shift;
  });
}

/**
 * 按键 → 动作的**纯决策函数**（HotkeyChoiceList 的键盘处理全部走这里）。
 *
 * 为什么非要抽出来：这次修的缺陷本身就是**判定顺序**错了——原实现在导航判定**之前**写了
 * `if (!key.insertable) return false`，方向键不是可插入字符，于是在第一步就被挡掉，
 * ↑↓ 永远不生效。这种 bug 只有「喂一个 up 键、断言得到 move 而不是 ignore」才能锁住；
 * 把决策留在组件里、只单测选项集，是测不到它的（选项集全对、方向键照样死）。
 *
 * 返回值语义：
 * - `{ kind: "move", index }`  移动光标到 index（已做环绕）
 * - `{ kind: "select", index }` 选定该项（数字/字母直达会同时移动光标再选定）
 * - `{ kind: "escape" }`        Esc 出口（由调用方映射到保守选项）
 * - `{ kind: "ignore" }`        不消费，交给下一个 handler
 */
export type ChoiceKeyAction =
  | { kind: "move"; index: number }
  | { kind: "select"; index: number }
  | { kind: "escape" }
  | { kind: "ignore" };

/** resolveChoiceKey 需要的按键形状（Key 的最小子集，便于单测构造） */
export interface ChoiceKeyInput {
  name: string;
  shift: boolean;
  ctrl: boolean;
  insertable: boolean;
  sequence: string;
}

export function resolveChoiceKey(
  choices: ReadonlyArray<{ hotkey: string }>,
  cursor: number,
  key: ChoiceKeyInput,
  hasEscape: boolean,
): ChoiceKeyAction {
  const total = choices.length;
  if (total === 0) return { kind: "ignore" };

  // ── 导航必须先判：方向键 insertable=false，放在 insertable 门禁之后就永远不生效 ──
  if (key.name === "up" || (key.ctrl && key.name === "p")) {
    return { kind: "move", index: (cursor - 1 + total) % total };
  }
  // ctrl+n 是「下移」的 emacs 键位；裸 n 是「拒绝」的字母直达，两者靠 ctrl 区分
  if (key.name === "down" || (key.ctrl && key.name === "n")) {
    return { kind: "move", index: (cursor + 1) % total };
  }
  if (key.name === "escape" && hasEscape) {
    return { kind: "escape" };
  }
  if (key.name === "enter" || key.name === "return") {
    return { kind: "select", index: cursor };
  }

  if (!key.insertable) return { kind: "ignore" };

  // 数字直达：1..n 对应可见顺序（与 BaseSelectionList 既有约定一致）
  if (/^[1-9]$/.test(key.sequence)) {
    const idx = Number(key.sequence) - 1;
    if (idx < total) return { kind: "select", index: idx };
    return { kind: "ignore" };
  }

  // 字母直达：保留 y/n/a 肌肉记忆
  const hit = matchHotkey(choices, key.name, key.shift);
  if (hit) return { kind: "select", index: choices.indexOf(hit) };
  return { kind: "ignore" };
}
