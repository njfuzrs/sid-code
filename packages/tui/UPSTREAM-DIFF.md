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
