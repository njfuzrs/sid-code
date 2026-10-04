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
