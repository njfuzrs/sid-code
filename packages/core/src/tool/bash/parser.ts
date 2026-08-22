/**
 * Bash 命令结构化解析器（启发式）
 * 不追求完整的 Bash 语法解析，只处理 90% 的常见命令模式
 * 对于无法解析的复杂命令，回退到正则匹配
 */

/**
 * 重定向操作符。
 *
 * ⚠️ **这个联合类型必须与 {@link WRITE_REDIRECT_MODES} 保持同步**，否则会重演
 * 2026-08-22 修掉的那个权限绕过：`collectRedirects` 当时按
 * `mode === ">" || mode === ">>"` 白名单收集目标，于是 `2>` 虽然被解析成了
 * redirect 节点、却在收集阶段被静默丢弃 → `isReadOnlyCommand` 误判只读 →
 * `bash.ts` 的 `checkPermissions` 直接 `behavior:"allow"` 免确认放行
 * （实测 `ls 2> ~/.ssh/authorized_keys` 被判 allow，而 `ls > 同一路径` 会被拦）。
 *
 * 所以这里不再用字面量白名单判断"是不是写"，改为 {@link WRITE_REDIRECT_MODES} 集合，
 * 新增操作符时**只有一处**需要改，不会出现"解析认识、收集不认识"的错配。
 */
export type RedirectMode =
  | ">" // stdout 覆盖写
  | ">>" // stdout 追加写
  | ">|" // stdout 覆盖写（忽略 noclobber）
  | "&>" // stdout+stderr 覆盖写
  | "&>>" // stdout+stderr 追加写
  | "n>" // 指定 fd 覆盖写（1> / 2> / 3> …，规范化后保留原文见 rawMode）
  | "n>>" // 指定 fd 追加写
  | "<" // 读入
  | "<<<" // here-string（读）
  | "n<"; // 指定 fd 读入

/** Bash 命令 AST 节点类型 */
export type BashASTNode =
  | { type: "simple"; command: string; args: string[]; envPrefix?: Record<string, string> }
  | { type: "pipeline"; commands: BashASTNode[] }
  | { type: "sequence"; operator: "&&" | "||" | ";"; commands: BashASTNode[] }
  | {
      type: "redirect";
      target: BashASTNode;
      file: string;
      mode: RedirectMode;
      /** 原始操作符文本（`2>`、`3>>` 等）。规范化 mode 会丢掉 fd 号，排查时需要它。 */
      rawMode?: string;
    }
  | { type: "unknown"; raw: string };

/**
 * 会**写入**目标文件的重定向操作符集合。
 *
 * `extractRedirectTargets` 只按这个集合收集——它是"哪些重定向算写盘"的**唯一事实源**。
 * 读类操作符（`<` / `<<<` / `n<`）刻意不在内：把它们算成写会让 `cat < f`、
 * `grep x <in` 这类纯读命令开始白弹确认，那是拿"更安全"伤"更快"的净退步。
 */
const WRITE_REDIRECT_MODES: ReadonlySet<RedirectMode> = new Set<RedirectMode>([
  ">",
  ">>",
  ">|",
  "&>",
  "&>>",
  "n>",
  "n>>",
]);

/** 包装命令前缀（需要剥离以获取实际命令） */
const WRAPPER_COMMANDS = new Set([
  "timeout",
  "env",
  "nice",
  "nohup",
  "time",
  "strace",
  "ionice",
  "taskset",
  "chrt",
  "numactl",
]);

/**
 * 解析 Bash 命令为 AST
 */
export function parseBashCommand(command: string): BashASTNode {
  const trimmed = command.trim();
  if (!trimmed) return { type: "simple", command: "", args: [] };

  try {
    // 1. 处理复合命令（&&、||、;）— 在引号外拆分
    const seqParts = splitOutsideQuotes(trimmed, /\s*(&&|\|\||;)\s*/);
    if (seqParts.parts.length > 1) {
      const commands = seqParts.parts.map((p) => parseBashCommand(p));
      return {
        type: "sequence",
        operator: (seqParts.separators[0] || "&&") as "&&" | "||" | ";",
        commands,
      };
    }

    // 2. 处理管道（|）— 在引号外拆分
    //
    // ⚠️ `(?<!>)` 不可省：`>|`（noclobber 覆盖写）里的 `|` **不是管道符**。
    // 少了这个后顾断言，`echo hi >| /tmp/f` 会被切成 `echo hi >` 与 `/tmp/f`
    // 两条管道命令，重定向扫描（第 3 步）根本轮不到 → 目标提不到 → 判只读 →
    // 免确认放行。这与 2026-08-22 修的那个绕过同源：
    // **问题出在"轮不到"，而不是"扫得不对"**。
    //
    // 后顾断言能生效，依赖 splitOutsideQuotes 用**粘性匹配 + 完整串**
    // （见该函数内注释）；若改回 `slice(i).match()`，断言会在切片首位恒真而静默失效。
    const pipeParts = splitOutsideQuotes(trimmed, /\s*(?<!>)\|\s*(?!\|)/);
    if (pipeParts.parts.length > 1) {
      return { type: "pipeline", commands: pipeParts.parts.map((p) => parseBashCommand(p)) };
    }

    // 3. 处理重定向
    //
    // ⚠️ 这里**必须扫描全部重定向**，不能只匹配尾部一个。旧实现用
    // `/^(.+?)\s+(>>|2>|>)\s*(\S+)\s*$/` 单次匹配，三个缺陷叠在一起造成权限绕过：
    //   ① 操作符白名单缺 `1>` `3>` `&>` `&>>` `>|` —— 整条命令直接失配，退化成 simple；
    //   ② `\s+` 强制前导空白 —— `echo x> f` 连写失配；
    //   ③ `$` 锚死行尾 —— `echo x > f &`、`echo x >f <in` 尾部还有 token 就失配。
    // 且 `cat f 1>/tmp/out 2>/tmp/err` 有**两个**目标，单次匹配结构上只能拿到一个。
    // 改为 scanRedirects 一次剥离全部，并保留引号/转义感知（`echo "a > b"` 不算重定向）。
    const scanned = scanRedirects(trimmed);
    if (scanned.redirects.length > 0) {
      // 由内向外套 redirect 节点：最外层是最后一个重定向，target 链最终落到剥离后的命令体。
      // 命令体可能为空（如 `> f` 这种纯重定向），交给 parseSimpleCommand 得到空 command。
      let node: BashASTNode = parseBashCommand(scanned.command);
      for (const r of scanned.redirects) {
        node = {
          type: "redirect",
          target: node,
          file: unquote(r.file),
          mode: r.mode,
          rawMode: r.rawMode,
        };
      }
      return node;
    }

    // 4. 解析简单命令
    return parseSimpleCommand(trimmed);
  } catch {
    return { type: "unknown", raw: trimmed };
  }
}

/**
 * 解析简单命令（无管道、无复合）
 */
function parseSimpleCommand(cmd: string): BashASTNode {
  const tokens = tokenize(cmd);
  if (tokens.length === 0) return { type: "simple", command: "", args: [] };

  // 提取环境变量前缀（VAR=value）
  const envPrefix: Record<string, string> = {};
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
    const eqIdx = tokens[i].indexOf("=");
    envPrefix[tokens[i].slice(0, eqIdx)] = tokens[i].slice(eqIdx + 1);
    i++;
  }

  if (i >= tokens.length) {
    // 只有环境变量赋值，没有命令
    return { type: "simple", command: "", args: [], envPrefix };
  }

  // 剥离包装命令（timeout 10 cmd → cmd）
  let command = tokens[i];
  let argsStart = i + 1;

  if (WRAPPER_COMMANDS.has(command)) {
    // 跳过包装命令及其参数
    argsStart = i + 1;
    // timeout 的参数：跳过数字参数和 -k 等选项
    while (argsStart < tokens.length) {
      const arg = tokens[argsStart];
      if (arg.startsWith("-") || /^\d+(\.\d+)?[smhd]?$/.test(arg)) {
        argsStart++;
      } else {
        break;
      }
    }
    if (argsStart < tokens.length) {
      command = tokens[argsStart];
      argsStart++;
    }
  }

  const args = tokens.slice(argsStart);
  const result: BashASTNode = { type: "simple", command, args };
  if (Object.keys(envPrefix).length > 0) {
    (result as any).envPrefix = envPrefix;
  }
  return result;
}

/**
 * 提取命令前缀（用于权限规则匹配）
 * "git commit -m 'fix'" → "git commit"
 * "timeout 10 npm test" → "npm test"
 * "VAR=1 make build"    → "make build"
 */
export function getCommandPrefix(command: string): string {
  const ast = parseBashCommand(command);
  return getFirstCommand(ast);
}

/** 从 AST 中提取第一个实际命令 */
function getFirstCommand(node: BashASTNode): string {
  switch (node.type) {
    case "simple":
      // 对于 git 等多级命令，返回 "git subcommand"
      if (node.args.length > 0 && !node.args[0].startsWith("-")) {
        return `${node.command} ${node.args[0]}`;
      }
      return node.command;
    case "pipeline":
    case "sequence":
      return node.commands.length > 0 ? getFirstCommand(node.commands[0]) : "";
    case "redirect":
      return getFirstCommand(node.target);
    case "unknown":
      return node.raw.split(/\s+/)[0] || "";
  }
}

/**
 * 从 AST 中提取所有**写入类**重定向的目标文件。
 *
 * ⚠️ 这个函数是三道安全判定的共同上游（`read-only-validation.isReadOnlyCommand`、
 * `path-validation.extractPathsFromCommand`、`checkpoint/bash-affected-files`），
 * 而 `isReadOnlyCommand` 的结果直接决定 `bash.ts` 的 `checkPermissions` 是否
 * `behavior:"allow"`（免确认放行）。**漏一个目标就是一次权限确认绕过**，
 * 且是静默的——不报错、命令照跑、用户看不到确认框。
 *
 * 所以判"是不是写"一律走 {@link WRITE_REDIRECT_MODES}，不要在这里再写一遍字面量白名单。
 */
export function extractRedirectTargets(node: BashASTNode): string[] {
  const targets: string[] = [];
  collectRedirects(node, targets);
  return targets;
}

/**
 * 丢弃型重定向目标 —— 写进去不产生任何持久副作用，不算"写盘"。
 *
 * 为什么必须豁免：修完重定向漏提取后，`cat f 2>/dev/null`、`cmd >/dev/null 2>&1`
 * 这类**极常见的纯读命令**会第一次被判成"有写入重定向"→ 非只读 → 白弹确认。
 * 那是拿"更安全"伤"更快"的净退步（北极星自检第 3 问），且量大到用户立刻能感知。
 *
 * 这不是本次新造的特例，仓里已有两处同型认知：
 * - `permission/bash-security.ts:123 stripSafeRedirections` 把 `>/dev/null` 归为安全重定向
 * - `tool/jit-affected-paths.ts:144` 对 `/dev/` 前缀直接 return
 *
 * ⚠️ **必须整段精确相等，不能用 startsWith**。这条是 `bash-security.ts:119` 记下的
 * 踩坑：`/dev/nullo` 会前缀命中 `/dev/null`，于是一个真实文件被当成丢弃目标放行。
 */
const DISCARD_TARGETS: ReadonlySet<string> = new Set(["/dev/null", "/dev/zero"]);

function collectRedirects(node: BashASTNode, targets: string[]): void {
  switch (node.type) {
    case "redirect":
      // 只收写入类；读类（`<` / `<<<` / `n<`）不算写盘目标，见 WRITE_REDIRECT_MODES 注释。
      if (WRITE_REDIRECT_MODES.has(node.mode) && !DISCARD_TARGETS.has(node.file)) {
        targets.push(node.file);
      }
      collectRedirects(node.target, targets);
      break;
    case "pipeline":
    case "sequence":
      for (const cmd of node.commands) collectRedirects(cmd, targets);
      break;
    default:
      break;
  }
}

/**
 * 从 AST 中提取所有简单命令节点
 */
export function extractSimpleCommands(
  node: BashASTNode,
): Array<{ command: string; args: string[] }> {
  const commands: Array<{ command: string; args: string[] }> = [];
  collectSimpleCommands(node, commands);
  return commands;
}

function collectSimpleCommands(
  node: BashASTNode,
  out: Array<{ command: string; args: string[] }>,
): void {
  switch (node.type) {
    case "simple":
      if (node.command) out.push({ command: node.command, args: node.args });
      break;
    case "pipeline":
    case "sequence":
      for (const cmd of node.commands) collectSimpleCommands(cmd, out);
      break;
    case "redirect":
      collectSimpleCommands(node.target, out);
      break;
    default:
      break;
  }
}

// ===== 内部工具函数 =====

/**
 * 把分隔符正则转成粘性（`y`）变体并缓存。
 *
 * 缓存的原因是 `splitOutsideQuotes` 在热路径上（每条命令、每个字符都可能试匹配），
 * 每次 `new RegExp` 会反复编译同一个 pattern。key 用 source + 原 flags，
 * 所以两个 source 相同但 flags 不同的正则不会串味。
 *
 * 分隔符写成 `\x00` 转义而不是裸字节：裸 NUL 会让 grep 把整个文件当二进制静默跳过，
 * 于是全文件符号都搜不到，而 `exit=1` 与"真的没匹配"不可区分——排查时极易误判成死代码
 * （pre-commit 有门禁拦这个，本函数第一版就被拦下来过）。
 */
const STICKY_CACHE = new Map<string, RegExp>();
function getStickyVariant(re: RegExp): RegExp {
  const key = `${re.source}\x00${re.flags}`;
  let sticky = STICKY_CACHE.get(key);
  if (!sticky) {
    sticky = new RegExp(re.source, re.flags.replace(/[gy]/g, "") + "y");
    STICKY_CACHE.set(key, sticky);
  }
  return sticky;
}

/** 扫出来的单个重定向 */
interface ScannedRedirect {
  /** 规范化后的操作符（fd 号收敛成 `n>` / `n>>` / `n<`） */
  mode: RedirectMode;
  /** 原始操作符文本，如 `2>`、`3>>` */
  rawMode: string;
  /** 目标（尚未 unquote，交由调用方处理） */
  file: string;
}

/**
 * 从命令里剥离**全部**重定向，返回剩余命令体 + 重定向列表。
 *
 * 为什么要自己扫而不用正则一把梭（这一段是 2026-08-22 那个权限绕过的直接教训）：
 *
 * 1. **一条命令可以有多个重定向**：`cat f 1>/tmp/out 2>/tmp/err` 有两个目标，
 *    单次 `match` 结构上只能拿到一个。
 * 2. **重定向不一定在结尾**：`echo x > f &`、`echo x >f <in`、`echo x > f 2>&1`
 *    后面都还有 token，任何 `$` 锚定的正则都会整条失配（失配 → 退化成 simple →
 *    目标一个都提不到 → 判只读 → 免确认放行）。
 * 3. **必须引号感知**：`echo "a > b"` / `echo 'x >> y'` 里的 `>` 是字面量，
 *    不是重定向。正则做不到这件事，而误判成重定向会把 `b` 当写盘目标 → 无谓的确认弹窗。
 *
 * 刻意**不**处理的两类（属于近似解析的能力边界，本函数只服务权限判定）：
 * - here-doc（`<<EOF`）：多行结构，单行解析器覆盖不了；它是读操作，漏了不影响写盘判定。
 * - 进程替换 `>(cmd)` / `<(cmd)`：目标不是文件路径。见下方 `isFdDup` 附近的处理。
 */
function scanRedirects(str: string): { command: string; redirects: ScannedRedirect[] } {
  const redirects: ScannedRedirect[] = [];
  let command = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let i = 0;

  while (i < str.length) {
    const ch = str[i];

    if (escaped) {
      command += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      command += ch;
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      command += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      command += ch;
      i++;
      continue;
    }
    if (inSingle || inDouble) {
      command += ch;
      i++;
      continue;
    }

    const op = matchRedirectOperator(str, i);
    if (!op) {
      command += ch;
      i++;
      continue;
    }

    // 命中操作符。先跳过它，再读目标。
    let j = i + op.len;
    while (j < str.length && (str[j] === " " || str[j] === "\t")) j++;

    // `2>&1` / `1>&2` / `>&2`：fd 复制，不是文件目标。整段吞掉、不产生重定向记录。
    // 若把 `&1` 当成文件名，`ls 2>&1` 会被判成"写入名为 &1 的文件"→ 无谓确认。
    if (str[j] === "&") {
      const dup = /^&(\d+|-)/.exec(str.slice(j));
      if (dup) {
        i = j + dup[0].length;
        continue;
      }
    }

    // 进程替换 `>(cmd)`：目标不是路径，跳过整个括号组（按深度配对，容忍嵌套）。
    if (str[j] === "(") {
      let depth = 0;
      let k = j;
      for (; k < str.length; k++) {
        if (str[k] === "(") depth++;
        else if (str[k] === ")") {
          depth--;
          if (depth === 0) {
            k++;
            break;
          }
        }
      }
      i = k;
      continue;
    }

    const target = readRedirectTarget(str, j);
    if (!target.text) {
      // 操作符后面没有目标（命令被截断，如结尾就是 `echo x >`）。
      // 保留原文进命令体：既不凭空造一个空目标，也不静默吞掉这段文本。
      command += str.slice(i, j);
      i = j;
      continue;
    }

    // 目标末尾可能紧跟命令分隔符（`echo x >f;`）。前两步已在 splitOutsideQuotes
    // 里拆过 `;` `&&` `||`，走到这里通常不会有；留着是为了单独调用本函数时也正确。
    redirects.push({ mode: op.mode, rawMode: op.raw, file: target.text });
    i = target.end;
    // 剥掉重定向后，命令体两侧可能出现连续空格，最后统一 trim + 折叠。
    command += " ";
  }

  return { command: command.replace(/\s+/g, " ").trim(), redirects };
}

/**
 * 判断 `str[i]` 处是否是重定向操作符，返回规范化 mode / 原文 / 消耗长度。
 *
 * 顺序敏感：**长操作符必须先试**（`&>>` 先于 `&>`，`>>` 先于 `>`），
 * 否则 `&>>` 会被当成 `&>` 再留一个孤立 `>`。
 */
function matchRedirectOperator(
  str: string,
  i: number,
): { mode: RedirectMode; raw: string; len: number } | null {
  // fd 前缀：`1>` `2>>` `3<`。fd 号必须紧贴操作符（bash 语义），且它前面不能是
  // 命令名的一部分——`grep -c 2> f` 里的 `2` 是独立 token，而 `foo2> f` 的 `2`
  // 属于 `foo2`，此时整体仍是 stdout 重定向。用"fd 前必须是行首或空白"区分。
  const fd = /^(\d+)(>>|>\||>|<)/.exec(str.slice(i));
  if (fd) {
    const prev = i === 0 ? "" : str[i - 1];
    if (i === 0 || prev === " " || prev === "\t") {
      const sym = fd[2];
      const mode: RedirectMode = sym === "<" ? "n<" : sym === ">>" ? "n>>" : "n>";
      return { mode, raw: fd[0], len: fd[0].length };
    }
    // fd 号粘在前一个词上（`foo2> f`）：不吃掉数字，从符号处继续按普通操作符解析。
  }

  // 无 fd 前缀。长的先试。
  const TABLE: Array<[string, RedirectMode]> = [
    ["&>>", "&>>"],
    ["&>", "&>"],
    ["<<<", "<<<"],
    [">>", ">>"],
    [">|", ">|"],
    [">", ">"],
    ["<", "<"],
  ];
  for (const [lit, mode] of TABLE) {
    if (!str.startsWith(lit, i)) continue;
    // `<<` 是 here-doc，不在本函数职责内（见函数头注释）。`<<<` 已在上面先匹配掉，
    // 所以走到这里的 `<` + `<` 一定是 here-doc，交给命令体原样保留。
    if (lit === "<" && str[i + 1] === "<") return null;
    // `&>` 的 `&` 也可能是"后台执行 + 重定向"（`cmd & > f`），但那种写法里
    // `&` 与 `>` 之间有空白，不会命中 startsWith("&>")，无需额外区分。
    return { mode, raw: lit, len: lit.length };
  }
  return null;
}

/** 读取重定向目标（引号感知，遇未被引号包裹的空白或命令分隔符即止） */
function readRedirectTarget(str: string, start: number): { text: string; end: number } {
  let text = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let i = start;

  while (i < str.length) {
    const ch = str[i];
    if (escaped) {
      text += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      text += ch;
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      text += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      text += ch;
      i++;
      continue;
    }
    if (!inSingle && !inDouble) {
      // 空白、命令分隔符、后台符、再一个重定向 —— 目标到此为止。
      if (/[\s;&|]/.test(ch)) break;
      if (ch === ">" || ch === "<") break;
    }
    text += ch;
    i++;
  }

  return { text, end: i };
}

/**
 * 在引号外按分隔符拆分字符串
 */
function splitOutsideQuotes(
  str: string,
  sepRegex: RegExp,
): { parts: string[]; separators: string[] } {
  const parts: string[] = [];
  const separators: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let i = 0;

  while (i < str.length) {
    const ch = str[i];

    if (escaped) {
      current += ch;
      escaped = false;
      i++;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      current += ch;
      i++;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    if (!inSingle && !inDouble) {
      // 尝试匹配分隔符。
      //
      // ⚠️ 必须用**粘性匹配（`y` flag）在完整串上**匹配，不能用
      // `str.slice(i).match(sepRegex)`。后者会让分隔符正则里的**后顾断言恒真**——
      // 切片的首位前面什么都没有，`(?<!>)` 永远成立。管道拆分正则
      // `/\s*(?<!>)\|\s*(?!\|)/` 正是靠这个断言把 `>|` 排除在管道符之外，
      // 用 slice 就会静默失效（不报错、只是又切错，见 parseBashCommand 第 2 步注释）。
      const sticky = getStickyVariant(sepRegex);
      sticky.lastIndex = i;
      const match = sticky.exec(str);
      if (match) {
        parts.push(current);
        separators.push(match[1] || match[0].trim());
        current = "";
        i += match[0].length;
        continue;
      }
    }

    current += ch;
    i++;
  }

  parts.push(current);
  return { parts, separators };
}

/**
 * 简单的 shell 词法分析（处理引号和转义）
 */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

/** 去除引号 */
function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
