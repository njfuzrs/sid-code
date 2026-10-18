---
Status: implemented
Date: 2026-10-18
---
# CLI 入口不再写 process.env.FORCE_COLOR；完整 ANSI 序列不计入二进制判定

## 决定了什么

事故：后台任务 `bun install | tail -3` 写进 `.output` 的 122 字节里有 17 个 ESC（13.9%），
read 工具按「不可打印占比 > 10%」判成二进制拒读。根因是 `packages/cli/src/cli.ts` 自
2026-03-12（`968ce163`）起写 `process.env.FORCE_COLOR = "3"`，被所有子进程继承。

1. **根因**：删掉入口的 env 注入，新增 `packages/cli/src/ui/terminal-color.ts`，只在
   stdout 是 TTY、用户未设 `FORCE_COLOR` / `NO_COLOR` 时改进程内 `chalk.level`
   （经 `adjustColorLevel`，tmux 降 256 色等规则与旧版一致）。子进程 env 与用户 shell 完全一致。
2. **依赖旧 env 的两处同步改掉**（否则会静默退化）：
   - `ui/utils/terminalUtils.ts` 的 `getColorDepth()`：Bun 的 `stdout.getColorDepth()` 读
     `FORCE_COLOR`，旧版恒报 24；改为强制颜色时直接报 24，`HalfLinePaddedBox` 不切低色深背景。
   - `ui/statusline/run-statusline.ts`：状态栏脚本 stdout 是管道、输出原样进彩色 TUI，旧版
     靠继承的 `FORCE_COLOR=3` 上色；改为在这一个 spawn 点显式声明（取当前 chalk 级别）。
3. **检测侧**：`tool/binary-detect.ts` 新增 `scanControlChars`，结构完整的 CSI / OSC 序列
   整段跳过不计数；孤立 ESC、截断序列、其它 C0 照旧计数，NUL 一票否决不变。
   `tool/bash.ts` 的 `isBinaryOutput` 复用同一扫描（原来是第二份手写计数，30% 阈值同样会误伤
   进度条重绘输出）。这是独立的正确性修复：用户自己设了 `FORCE_COLOR` 时彩色日志仍是文本。
4. `adjustColorLevel` 经 `ui/render-port/text.ts` 转出（render-port 边界规则），端口面文档同步。

## 放弃了什么（以及为什么不选）

- **在各 spawn 点擦掉 `FORCE_COLOR`**（参照 cc `subprocessEnv()` 的形态）：`packages/core/src`
  有 23 处 spawn，新增 spawn 点漏一处就复发；更致命的是子代理（`agent/sub-agent.ts`）把整份
  env 传给子 sid-code，子进程分不清它是用户设的还是父进程注入的，会当用户意图透传，跨一层就失效。
- **read 时剥掉 ANSI 再返回**：read 结果进 `readFileState`、是 edit 的匹配基准，剥掉会让模型
  看到的内容与磁盘不一致。cc `OutputLine.tsx` 的注释也记录了全剥导致格式丢失的用户反馈。
- **学 cc 去掉 read 的内容检测**（cc 只按扩展名拦）：内容检测是 2026-07-30 为源码里混入真 NUL
  的事故专门加的，去掉会让那类文件重新静默截断。
- **保留入口注入、只在非 TTY 时跳过**：TTY 下注入同样被所有子进程继承（工具输出接管道），
  事故正是在交互模式里发生的。

行为变化（已点破）：`sc -p … | cat` 这类管道输出不再带颜色，交互界面不变。牺牲的是管道里的颜色，
换来子进程输出干净（更准：少一次误拒读与重试）。

## 拿什么证明它生效了

- 真 pty（`TERM=xterm-256color`）加载入口后，main vs 本分支：
  - xterm：main `{"chalk":3,"depth":24,"child":"3"}` → 分支 `{"chalk":3,"depth":24,"child":"<unset>"}`
  - tmux：main `chalk 3` → 分支 `chalk 2`。这是探针时序差异，不是行为变化：探针只 import
    `cli.ts`，main 的静态依赖图里没有 `tui/colorize.ts`，它的模块级 tmux 降级（`colorize.ts:60`）
    要到 UI 加载时才跑；本分支 `terminal-color.ts` 经端口静态加载它，入口处即得到 2。
    main 运行到 UI 后同样是 2（按代码推断，未在 main 上实跑完整 TUI 核对）。
  - 用户 `FORCE_COLOR=1` / `NO_COLOR=1`：两边完全一致，用户值原样透传
  - 管道非 TTY：main `chalk 3, child 3` → 分支 `chalk 0, child <unset>`
- 事故链路端到端（真 pty，入口加载后 `spawnShellTask("bun install 2>&1 | tail -3")` → read）：
  main `.output` 161 字节含 16 个 ESC；分支 96 字节、0 个 ESC，read 首行 `bun install v1.4.2 (…)`。
- 新测试 `packages/cli/tests/ui/terminal-color.test.ts`（12 条，含 import 真实入口后经
  `Bun.spawn(env: process.env)` 与 `node:child_process.spawn` 两条泄漏路径的端到端断言、
  以及「源码零处写 `process.env.FORCE_COLOR`」静态门禁）与
  `packages/core/tests/tool/binary-detect-ansi.test.ts`（13 条，含事故同形 123 字节原样样本）。
- 变异自证：把入口改回写 env → 端到端 `env/bunChild/nodeChild` 三字段全变 `"3"`、静态门禁指到
  `cli.ts:15`；关掉 ANSI 跳过 → 事故样本、read、bash 彩色输出等 6 条变红。两处均已恢复。
- 写测试时踩到的坑：不传 `env` 的 `Bun.spawnSync` **不继承运行时对 `process.env` 的修改**，
  第一版端到端断言因此是假阴性（变异后仍显示 `<unset>`），已改为覆盖两条真实 spawn 写法。
