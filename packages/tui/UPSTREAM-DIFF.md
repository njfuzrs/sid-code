# 相对上游 ink 的差异日志

新渲染底座 `packages/tui/` 以上游 [`vadimdemedes/ink`](https://github.com/vadimdemedes/ink) 为起点（B9 / D-1）。

## 上游基线

| 项 | 值 |
| --- | --- |
| 版本 | `ink@7.1.1`（MIT，许可全文见同目录 `LICENSE`，原样保留） |
| tag 对象 | `46db5c7499a414e40799f18258a90c4fb1d01cb2`（`refs/tags/v7.1.1`，annotated） |
| 指向的 commit | `70af033dbd2b126a16f144164685612b2c1fd554`（`refs/tags/v7.1.1^{}`） |
| 导入范围 | 上游 `src/` 全部 62 个文件 → `packages/tui/src/`；`license` → `LICENSE` |

导入提交里 `packages/tui/src/` 与上游 tag 的 `src/` 逐字节一致，可复核：

```bash
git clone --depth 1 --branch v7.1.1 https://github.com/vadimdemedes/ink.git /tmp/ink-v711
diff -r /tmp/ink-v711/src packages/tui/src   # 导入提交上应无输出
```

`packages/tui/src` 已从 oxfmt 与本仓 `.editorconfig` 风格中排除（上游是 xo / tab 风格），
否则 pre-commit 一格式化，就不再和上游一致。

## 差异表

每个相对上游的改动记一行。契约 ID 见 `SPEC.md`（T1.1 时仍在 `packages/cli/src/ui/render-port/SPEC.md`）。

| 提交 | 文件 | 改了什么 | 为什么 | 契约 ID |
| --- | --- | --- | --- | --- |
| T2.1 | `src/text/width.ts`（新增） | 列宽 = `Bun.stringWidth(…, {ambiguousIsNarrow: true})`；`widestLine` | 全码位对拍旧底座一致；npm `string-width` 有 478 个码位不同（天城文连字等，终端实占 2 格） | T1 |
| T2.1 | `src/text/slice.ts`（新增） | 按列切 ANSI 文本：宽字符不劈半、零宽字符跟随前一个字符、样式开头补齐结尾关闭 | 截断的基础操作；上游没有等价物（`slice-ansi` 在零宽字符与 OSC 8 关闭上行为不同） | T2 |
| T2.1 | `src/text/truncate.ts`（新增） | 换行走 `Bun.wrapAnsi`；四种截断自写，省略号在样式之外、保留 `\t` / `\n` | 上游 `wrap-ansi@10` 在 CJK / ZWJ / `\t` 上与旧底座不同；`cli-truncate` 把省略号放进 SGR 内、吞掉零宽字符 | T2 |
| T2.1 | `src/text/bidi.ts`（新增） | 只在 win32 / `WT_SESSION` / VS Code 下用 `bidi-js` 做 UAX #9 重排，按字符簇翻转 | 上游无 bidi；这几类终端不自己重排 RTL | T3 |
| T2.1 | `src/wrap-text.ts` | 实现改为调用 `text/truncate.ts` 的 `wrapText`，保留缓存 | 让 `<Text wrap>` 走对齐旧底座的语义 | T2 |
| T2.1 | `src/measure-text.ts`、`src/render-node-to-output.ts` | `widest-line` 换成 `text/width.ts` 的 `widestLine` | 测量与换行必须用同一把尺子，否则布局按一种宽度、换行按另一种 | T1 |
| T2.2 | `src/colorize.ts`（整文件改写） | 颜色名必须带 `ansi:` 前缀，只认 16 色名单（`ansi:gray` 等原样返回）；新增 `applyColor` / `applyTextStyles`（六个布尔样式按固定顺序叠加，颜色在外、背景最外）；模块加载时按终端修正进程级 `chalk.level`（vscode 256→真彩，非空 `TMUX` 真彩→256，`SID_CODE_TMUX_TRUECOLOR` / 旧名 `CLAUDE_CODE_TMUX_TRUECOLOR` 跳过降级） | 端口 `Color` 类型就是 `ansi:` 前缀形式；叠加顺序决定字节序列，差分测试逐字节比；tmux 默认不透传真彩 | T6、O5 |
| T2.2 | `src/text/styled-chars.ts`（新增） | styled-chars 五函数：宽度按 `stringWidth` 而非 tokenizer 的 `fullWidth`；只有空格和 `\t` 算空白；换行丢行首 / 断点处空白、超宽词硬折 | TableRenderer 依赖；上游没有等价物 | T6 |
| T2.2 | `package.json` | `chalk` 5.6.2 → 6.0.0，新增 `@sid-code/shared` | 与 CLI 共用同一个 chalk 实例（markdown 渲染也改它的 level），两个版本就是两个单例；`Color` 类型在 shared | T6 |
| T2.3 | `src/terminal/osc.ts`（新增） | `OSC` 编号表、`osc()`（kitty 用 ST、其余 BEL，加载时判定）、`wrapForMultiplexer()`（调用时读环境，`TMUX` 优先于 `STY`） | 上游没有 OSC 工具；CLI 的标题 / 通知 / 剪贴板都要用 | O6 |
| T2.3 | `src/terminal/clipboard.ts`（新增） | `setClipboard()`：返回 OSC 52 序列；本机剪贴板 fire-and-forget（跳过 SSH，linux 试探链带缓存）；tmux 等 `load-buffer` 2s，成功才包裹且里层固定 BEL；执行器可注入 | `/copy`、`/bug`、`/export`、`/debug` 依赖；上游没有 | O6、M3 |
| T2.3 | `src/terminal/hyperlinks.ts`（新增） | `supportsHyperlinks()`：库判定为真即真，否则按 6 个终端名（`TERM_PROGRAM` / `LC_TERMINAL` 精确）或 `TERM` 含小写 `kitty` 补判 | markdown 渲染的 OSC 8 链接依赖；npm `supports-hyperlinks` 不认识这几个终端 | O4、O6 |
| T2.3 | `package.json` | 新增 `supports-hyperlinks@4.5.0`（与根 package.json 同版本） | 同上 | O4 |
| T3.1 | `src/screen/`（新增：`screen.ts`、`pools.ts`、`serialize.ts`） | cell 级屏幕缓冲：每格 = 字形簇 + 列宽（宽 / 窄 / spacer）+ 样式 id + 超链接 id；样式池缓存 `(from, to)` 的 SGR 切换序列；可改写的超链接（`OSC 8 ;; url BEL`）改成 `id=<url 的 Java 式 hash>`，其余链接码当样式原样保留；覆盖写入劈开宽字符时剩下的半格还原成默认空白；tab 推到屏幕绝对列的 8 的倍数；序列化时默认空白用 `CSI n C` 跳过、含 U+FE0F 的宽字形簇做宽度补偿 | 帧 diff（T3.2）要逐格比较；规则全部对拍旧底座首帧（`tests/fixtures/screen-vectors.json`） | R3、R9、T3、T4 |
| T3.1 | `src/output.ts` | `get()` 改为先落 `Screen` 再转纯文本；新增 `getScreen()`；`slice-ansi` 换成 `text/slice.ts` 的 `sliceColumns`，右裁剪边界交给 Screen（压边界的宽字符整个丢掉） | 同上 | R3、T4 |
| T3.1 | `src/renderer.ts`、`src/render-to-string.ts` | 渲染结果多带一个 `screen`；新增 `renderToScreen()` | 对拍测试与 T3.2 的 diff 都要拿屏幕缓冲 | R3 |
| T3.1 | `src/sanitize-ansi.ts` | 带冒号子参数的 SGR（`ESC[4:3m`）整条丢弃 | ansi-tokenize 不认识，会把 `[4:3m` 当可见字符落格；旧底座丢弃 | R3 |
| T3.1 | `src/dom.ts` | 文本测量：换行后仍比可用宽度宽的行，按 `ceil(行宽 / 可用宽)` 计行数 | 宽字符被挤到 1 列、VS16 宽字符压在行尾时，旧底座的布局高度就是这样算的（多出来的是空行） | T4 |
| T3.3 | `src/ink.tsx`（resize） | resize 事件不当场出帧：尺寸与上一次事件相同就丢掉；否则当场重算布局，出帧交给一条独立的 `FrameScheduler(…, alwaysThrottle)`，同 tick 多次只出 leading + trailing（测试环境也一样）；相对**上一帧出帧时的视口**变宽 / 变窄 / 变矮 → full reset（原因 resize，空帧也算），只变高照常 diff；卸载时丢掉排队的 resize 帧 | 上游 resize 当场擦屏重画、不合并；旧底座的口径来自黑盒对拍（`frame-vectors.json` 的 resize 条目、E8） | R7 |
| T3.3 | `src/ink.tsx`（`forceRedraw`，新增） | 写 `2J H`（不清 scrollback、不进同步包裹），前一帧作废，当场按首帧画；保留「上一帧出帧时的视口」，同 tick 的 resize 照样判 full reset；非 TTY / debug / 挂起 / 卸载中不做 | 上游没有；CLI 的 Ctrl+L 走端口 `RenderInstance.forceRedraw` | R8、X7 |
| T3.3 | `src/ink.tsx`（SIGCONT、`setAltScreenActive`，新增） | 交互模式挂 `SIGCONT`、卸载摘掉；主屏：前一帧作废但不写字节，下一帧走 `redrawAfterSuspend`；`<AlternateScreen>` 挂着时写 `?1049h 2J H`，开过鼠标的补 `?1000/1002/1003/1006/1007h`。`setAltScreenActive` 只记状态，离开 alt 后下一帧 full reset。alt-screen 的出帧本身（绝对定位）归 T6.1 | 上游没有 SIGCONT 处理 | R10 |
| T3.3 | `src/frame/main-screen.ts` | 新增 `resetMainScreen`（R7 判定在 ink.tsx）、`redrawAfterSuspend`（SIGCONT 后第一帧：第一个变化行之前每行只写 `\r\n`，之后按首帧写整行；新帧变矮或宽度变了就退回首帧整帧）；1 行收缩到空帧时用 `\r` 代替 `eraseLines(1)` | 对拍旧底座逐帧字节 | R7、R10、R3 |
| T3.3 | `src/frame/scheduler.ts` | 构造参数 `alwaysThrottle`：测试环境也走 microtask + 16ms 窗口 | 旧底座的 resize 合并不受测试环境同步出帧影响 | R7、R13 |
| T3.4 | `src/dom.ts`、`src/reconciler.ts` | 节点新增 `renderDirty` / `renderCache`；文本、子节点增删、样式、属性、transform、显隐的每个变更入口把节点及全部祖先标脏 | 节点级输出缓存的失效信号 | P3 |
| T3.4 | `src/render-node-to-output.ts`、`src/output.ts` | 节点级输出缓存：子树没标脏、横坐标 / 尺寸 / 外层 transformer / skipStatic 都没变时，回放上次的输出操作（按纵向位移平移），不再遍历子树、不读 yoga；`Output` 新增 `mark` / `since` / `replay` | 历史越长、每帧全树遍历越贵（P3）；横坐标要比，因为 `\t` 对齐屏幕绝对列 | P3 |
| T3.4 | `src/screen/screen.ts`、`src/screen/serialize.ts`、`src/frame/main-screen.ts` | 单元字形簇改存整数 id（`Uint32Array`，进程级驻留表，0 = 空格、1 = spacer），`charAt` 取字符串；帧 diff 的行比较直接比四个平铺数组 | 整屏分配从逐格字符串数组变成一次清零；diff 去掉每格函数调用 | P3 |
| T3.4 | `src/renderer.ts`、`src/ink.tsx` | TTY 交互帧不生成纯文本 `output`（只有 debug / 非 TTY / 读屏路径要） | 交互路径只比屏幕缓冲，纯文本是整屏再序列化一遍，没人读 | P3 |
| T3.4 | `src/hooks/use-animation-frame.ts` | 离屏暂停：渲染时按上一次提交的布局判断 ref 盒是否在主屏视口内（帧的最后 H - 1 行），不在就不订阅时钟 | 旧底座行为（黑盒扫描 105 组位置得出），滚进 scrollback 的动画不再每 tick 重渲出帧 | P5 |
| T4.1 | `src/components/Text.tsx` | 样式叠加改走 `applyTextStyles`（inverse → strikethrough → underline → italic → bold → dim → 前景 → 背景）；新增 `dim` prop；`dimColor` 只留名字不出 SGR；嵌套 `<Text>` 经 context 继承外层样式，内层把合并后的整套样式重新编码 | 对拍旧底座首帧字节：叠加顺序决定字节；旧底座 `<Text dimColor>` 不出 SGR；`<Text inverse>a<Text underline>b` 里 b 的关闭顺序只有「内层重编整套样式」才对得上 | L1、T5 |
| T4.1 | `src/components/Ansi.tsx`（新增） | 解析 ANSI 为片段再按 Text 的叠加顺序重编码：认 0–9 / 21–29 / 30–49 / 90–107 / 38·48 扩展色（含冒号形式与 `4:n`），其余码丢弃；参数不够的 38 / 48 只跳过本身；`22` 同时关粗体与暗；暗开着时粗体不出 SGR；`dimColor` 整段变暗；OSC 8 在终端支持时统一写成 `OSC 8 ;; url BEL`（原 id / 参数不保留），不支持时丢掉；`ESC[0m` 不关链接 | CLI 的 Markdown / 预览渲染依赖；上游没有等价物 | T5 |
| T4.1 | `src/components/RawAnsi.tsx`（新增）、`src/render-node-to-output.ts`、`src/global.d.ts` | `RawAnsi`：一个 `ink-text` 叶子，尺寸固定为 `width × lines.length`、不伸缩，带 `internal_raw` 标记，渲染时不换行不截断；`lines` 为空不渲染 | DiffRenderer 的终端就绪行直写；对拍得出行比 `width` 宽时照写、被后面的兄弟盖住 | T5 |
| T4.1 | `src/index.ts` | 导出 `Ansi` / `RawAnsi` | 端口 next 接上 | T5 |
| T4.2 | `src/components/History.tsx`（新增）、`src/index.ts` | `History`：浅比较 memo（`items` / `children` / `style`）包住的竖排 Box，项是普通子树，内容变了照常 reconcile；不补 key、不去重。上游 `<Static>` 原样保留但端口不用 | D-3 定案 A：执行中的工具项放在历史区里，完成时原地变成终态；上游 print-once 会让它永远停在执行中。改名是为了不让人按上游文档理解它 | R11 |
| T4.2 | `src/screen/pools.ts`、`src/screen/serialize.ts` | 「看不见的空格」：整行输出（首帧 / 追加 / full reset）且屏幕 ≥ 2 行时，样式与当前画笔相同、而该样式下空格看不出来的空格按默认空白用 `CUF` 跳过（`StylePool.isSpaceInvisible`：背景色、反显、下划线、删除线、上划线、样式内链接码以外都算看不见）；行首第一个这样的空格因为要切样式照写；增量帧变化的单元照写 | S3 在 next 上的唯一差异就在这里（与 History 无关，任何两行以上的有色文本都会撞上）；单行屏照写空格是对拍出来的 | R3 |
| T4.2 | `src/frame/main-screen.ts`、`src/screen/serialize.ts` | 帧 diff 的多个变化段共用一支笔：段间只移光标，样式 / 链接不关，最后一段写完才收（收缩时在回到第 n 行之后收）；`serializeRowDiff` 可传入 `Pen`，新增 `closePen` | 对拍旧底座逐帧字节：两行同色都改时旧底座只开一次色 | R3 |
| T4.3 | `src/render-node-to-output.ts`、`src/styles.ts` | `overflow` / `overflowX` / `overflowY` 加 `scroll`；单轴取值优先于 `overflow`（上游是「任一为 hidden 即裁剪」）。纵向 `scroll` 只画第一个子节点（内容盒）的子项，按其在内容盒里的位置与视口（内框高）求交剔除，内容盒自身背景 / 边框 / 裁剪不画 | VirtualizedList 的 `overflowY="scroll"`；对拍旧底座屏幕：负 `marginTop` 滚上去的行被裁掉、底部留空，`overflow="hidden" overflowY="visible"` 纵向不裁 | L3 |
| T4.3 | `src/measure/`（新增）、`src/index.ts` | `getBoundingBox`（布局树绝对坐标，已移除节点 `null`）、轮询式 `ResizeObserver`（16ms、unref、只比宽高、同轮合并） | ScrollProvider 命中测试、VirtualizedList / MaxSizedBox 测高；上游只有 `useBoxMetrics` hook，形状对不上 | L4 |
| T4.3 | `src/reconciler.ts` | 移除节点释放 yoga 后把整棵子树的 `yogaNode` 置空 | 组件握着的 ref 读到已释放的 WASM 节点会崩；置空后 measure 得 0×0、getBoundingBox 得 null，与旧底座一致 | L4 |
| T5.1b | `src/parse-keypress.ts` | 整体重写：一个输入单元直接解成 `(input, key)`；key 字段集合改成旧底座的 20 个（加 `fn` / `wheelUp` / `wheelDown`，去掉 `hyper` / `capsLock` / `numLock` / `eventType`）；修饰位只认 shift / alt（报 meta）/ ctrl / super；kitty CSI u 与 modifyOtherKeys（`CSI 27;m;cp~`）共用码位解码，带事件类型 / 关联文本的 CSI u 出空事件；SGR 鼠标只有滚轮出事件、X10 鼠标一律出事件；焦点报告与单独的 ST 不出事件；不认识的 CSI / SS3 去掉 ESC 原样交出 | 规则全部从旧底座黑盒向量（`tests/fixtures/input-vectors.json`，1227 条）与 xterm ctlseqs / kitty 协议文档归纳，没读旧代码（D-5）；上游的 enquirer 派生解析在 675 条上与旧底座不同 | I8 |
| T5.1b | `src/input-parser.ts` | 分词改按 ECMA-48：CSI 第一个 0x40–0x7E 即终止（`ESC [ [` 是完整序列）、中途遇 ESC 在其前切断、遇其它非法字节吞到下一个 ESC；`ESC [ M` 再取 3 字节；`ESC ESC` 拆成两个；多于一个码位的普通文本整段一个事件（不再拆 DEL / BS）；新增 `{text}` 事件类型 | 同上 | I8 |
| T5.1b | `src/hooks/use-input.ts`、`src/components/App.tsx` | `input` 事件带第二个参数 `raw`：多字符文本与粘贴内容不经按键解码；`useInput` 回调抛错只 `console.error('[ink:error]', …)`；ESC 冲刷延迟 20ms → 50ms | 旧底座：粘贴里的 `\r` / `\t` / `ESC [A` 原样交出；抛错不退出不摘监听；冲刷发生在 40–60ms 之间 | I8 |
| T5.1c | `src/components/App.tsx` | raw mode 计数改为普通整数：0→1 同步 `ref` + `setRawMode(true)` + 挂 `readable`，1→0 同步关（去掉上游的 `pendingDisableRawMode` 微任务延迟），多余的 `false` 可压成负数；计数归零只关 raw mode、摘 `readable`，不清解析器 / 不取消 ESC 冲刷（退出与卸载才清）；`readable` 回调整体 try/catch，抛错打 `[ink:error]` 并在监听被摘掉时重挂；`input` 事件改发 `InputEvent` 对象、逐个调监听者以支持 `stopImmediatePropagation`；Tab 焦点导航不再挂在 emitter 上 | 对拍旧底座探针：关 raw mode 同步生效、负计数、同一提交换组件出现一次关→开且半截转义交给新组件；回调抛错后同块剩余事件作废；emitter 上只有使用方监听 | I1b / I9 / I10 / I11 |
| T5.1c | `src/hooks/use-input.ts` | raw mode 开关移到 layout effect（订阅仍在 passive effect）；解码挪到 App；回调抛错不再就地吞掉 | 旧底座：停用期间缓冲的字节在重新启用时被丢弃（readable 早于 handler 订阅） | I9 / I10 |
| T5.1c | `src/input-event.ts`（新增） | `InputEvent`：自有字段 `_didStopImmediatePropagation / keypress / key / input`，原型上 `stopImmediatePropagation()`；`keypress` 只提供 `kind / ctrl / meta / shift / super / fn / sequence / raw / isPasted` | 旧底座 `internal_eventEmitter` 的事件形状 | I11 |
| T5.1c | `src/input-parser.ts` | 块尾的 `ESC` + 中间字节（0x20–0x2F）或 `ESC _` 挂起等冲刷超时 | 旧底座：这类序列 10ms 内不出、冲刷后才出 | I8 |
| T5.1d | `src/drain-stdin.ts`（新增） | `drainStdin`：非 TTY 不动；`read()` 到 null；原本不在 raw mode 的补一次 `setRawMode(true/false)`；全程吞错，不经 fd 直读 | 端口 `drainStdin` 的 next 实现；规则来自旧底座探针（D-5） | I5 |
| T5.1d | `src/ink.tsx` | 新增 `detachForShutdown()`：置 `isUnmounted`、取消两条帧调度、drain、关 raw mode；不经 React 卸载、不写字节、不摘监听、不结算 exit promise | 端口 RenderInstance 的信号退出路径；旧底座探针 | X4 |
| T5.1d | `src/components/App.tsx`、`src/ink.tsx` | `readable` 每轮第一块记时间戳，距上一块（或挂载）严格大于 5000ms 时回调 `onStdinResume`；Ink 只在 alt-screen 且开了鼠标跟踪时重写鼠标跟踪全套，不擦屏 | 外部程序可能关掉终端模式；旧底座探针 | I1c |
| T5.1e | `src/components/App.tsx` | 解码后的 Ctrl+Z 不交给监听者：写关模式序列、关 raw mode + `unref` + 摘 `readable`、挂一次性 SIGCONT 后自发 SIGSTOP；SIGCONT 时按计数重开 raw mode 再写重开序列；挂起期间 `setRawMode` 只记账、卸载不碰 stdin，`readable` 循环在挂起后停读 | 旧底座探针：TTY / 非 TTY 两套字节、kitty / modifyOtherKeys 也认、release 与文本块不认、挂起时卸载零 stdin 调用 | I7 |
| T5.2b | `src/terminal-probe.ts`（新增）、`src/components/App.tsx` | raw mode 计数 0 → 1 与 SIGCONT 恢复（计数 > 0）时用 `setImmediate` 排一次 XTVERSION + DA1 探查；进程级 `setSuppressTerminalProbe` 在排队时判定 | 上游 ink 不探查终端；旧底座黑盒探针：时机、抑制判定点、排了就发、不等回复 | I2 |
| T7.2a | `src/hooks/use-terminal-title.ts`（新增） | `useTerminalTitle`：`strip-ansi` 去 ANSI 后先写 OSC 2 再写 OSC 0，直写渲染所用的 stdout（不擦屏重绘、不包裹）；`null` 不写；win32 改写 `process.title` | 上游无此 hook；规则来自旧底座探针（D-5），去 ANSI 的结果在 9 组样本上与旧底座逐字一致 | O1 |
| T7.2a | `src/hooks/use-tab-status.ts`（新增）、`package.json` | `useTabStatus`：OSC 21337 三字段（busy / idle / waiting 颜色与文案固定），按 tmux / screen 包裹；`null` 只在写过之后写清除；`SID_DISABLE_TAB_STATUS` 每次变化时读；新增依赖 `strip-ansi@7.2.0`（根已有同版本） | 上游无此 hook；规则来自旧底座探针 | O2 |
| T7.2b | `src/components/TerminalWriteContext.ts`（新增）、`src/ink.tsx` | `render` 给子树套一层 `TerminalWriteContext`，值是实例上身份稳定的 `writeRaw`（直写 stdout）；TTY 卸载时恢复光标之后写 OSC 9;4 进度清除（固定 BEL、不包裹）与 tab 状态清除（`SID_DISABLE_TAB_STATUS` 非空时不写） | 上游无此 Context 与清除；规则来自旧底座探针（10 种环境逐字节一致），CLI 的 BEL / OSC 777 通知靠它落地 | O3 |
| T6.1a | `src/components/AlternateScreen.tsx`（新增）、`src/terminal/modes.ts`（新增） | `<AlternateScreen mouseTracking>`：insertion effect 里直写 `?1049h 2J H`（+ 鼠标全套），卸载逆序关；子树包进高 = 视口行数的纵向 Box；通知**同一 stdout** 上的实例 `setAltScreenActive` | 上游只有 render 选项 `alternateScreen`，CLI 用的是组件；字节来自旧底座探针。旧底座只通知 `process.stdout` 上的实例，这里改成同一 stdout（CLI 只用 process.stdout，生产上无差别） | M1 |
| T6.1a | `src/frame/alt-screen.ts`（新增）、`src/ink.tsx` | alt 下出帧走 `renderAltScreenFrame`：绝对定位 diff、裁到视口、视口变化 `2J` 重画、`onFrame` 的 flickers 恒空；alt 下 resize 当场重开鼠标跟踪；SIGCONT 作废 alt 前帧 | alt-screen 没有 scrollback，主屏的相对移动 diff 不适用；旧底座探针 | R14 |
| T6.1a | `src/terminal/sync-output.ts`（新增） | DEC 2026 能力判定，只用于 alt 帧是否包同步输出（主屏照旧一律包） | 旧底座 alt 帧按终端能力决定包不包；`env -i` 单变量探针得出规则 | R14 |
| T5.3a | `src/terminal/extended-keys.ts`（新增）、`src/components/App.tsx` | raw mode 计数 0 → 1（含 SIGCONT 恢复且计数 > 0）在 `ref` + `setRawMode(true)` 之后逐段写 `?2004h` `?1004h`，扩展键开着再写 `>1u` `>4;2m`；归零 / 挂起时先写 `>4m <u ?1004l ?2004l` 再关 raw mode；stdout 非 TTY 也写。扩展键只看环境变量、模块加载时判定一次 | 上游只有 opt-in 的 `kittyKeyboard` 选项（自动探测、语义不同），不用；规则来自旧底座探针（1576 组环境 0 不一致） | I4 |
| T5.3a | `src/ink.tsx` | stdin 静默 > 5s 后的第一块输入：扩展键开着时整段重申 `<u >1u >4;2m`（主屏也写），之后照旧重开 alt 鼠标；TTY 卸载时恢复光标之前把输入模式再关一次（一次写入） | 旧底座探针；卸载时的相对顺序归 X3（T7.1b） | I4 / I1c |
