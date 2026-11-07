---
Status: implemented
Date: 2026-11-07
---
# 无头模式按形态放行 `/compact` 与 `/loop`，并补上长驻形态缺失的定时注入通道

## 决定了什么

方案《20261106-无头模式斜杠命令放行》的 T6。原拍板只写「按形态放行」，落地时回源码
核实发现**放行 loop 的前提不存在**，所以这次一并做了四件事：

1. **`/compact` 与 `/loop` 声明 `headless: { modes: ["stream-json", "bridge"] }`**
   （`compact/index.ts` / `loop/index.ts`）。`-p` 单轮拒绝，长驻形态放行。
   拒绝文案带上命令自己的理由（`HeadlessAllowlist.reason`，新增字段，只进文案不参与判定）：
   「-p 单轮没有后续轮消费压缩结果……」/「-p 单轮建完即退出：定时任务是会话级的……」。

2. **修正 `resolveHeadlessModality` 的形态判定口径（T4b 遗留的偏差）**：只有
   `--input-format stream-json` 才算多轮。原实现把 `--output-format stream-json` 也算多轮，
   但 `app.ts` 的 `runHeadlessSDK` 只在前者把 `process.stdin` 交给 StructuredIO，否则喂
   已结束的空流、跑完初始 prompt 就退出——**输出流式 ≠ 多轮**。不改这一条，`/compact`
   会在 `-p "x" --output-format stream-json` 下被放行，正是方案 D4 说的净亏场景。
   判定入参同时删掉 `outputFormat`（不再参与）。

3. **补无头长驻形态的定时注入通道**（这条是 loop 放行的硬前提）。核实结论：
   `App.setPromptInjector` 原先**只有 TUI 的 onUserInput 一处调用**，于是 cron /
   `/loop` / `schedule_wakeup` 到点触发的 prompt 只会进 `App.scheduledPromptQueue`
   （`enqueueScheduledPrompt` 的 `if (this.busy || !this.promptInjector) push` 永远命中），
   命令却照样报「空闲时会自动触发」——长驻形态下**同样是假成功**，与方案假设相反。
   落地点三处：
   - `runHeadlessStreaming` 新增 `onInjectorReady`，交出「入队 + 唤醒」闭包
     （与宿主消息同一条 commandQueue，`priority: "next"`，不打断正在跑的一轮）；
   - `BridgeRunner.injectLocalMessage` 复用远程消息的同一条队列（另起一条必然漂移）；
   - `app.ts` 在 `runHeadlessSDK`（stream-json）与 `runBridge` 里注册成 `promptInjector`。
     `-p` 单轮不注册（没有下一次触发）。

4. **顺手修掉 `loop/index.ts` 的 `argumentHint` 缺右尖括号**——重新生成参考页时暴露，
   不修会让 `website/ref/slash-commands.md` 出现「参数提示不完整」的假变化。

T7（`CLI_ALTERNATIVES` 是否要扩）经核实是「确认不用做」：`bootstrap.ts` 的 CLI 快速路径
只有 `review` / `daemon` / `update` / `agents` / `hooks` / `mcp` / `plugin`(含 `plugins`) /
`auth`(含 `login` / `logout`) 8 个，映射表已覆盖其中能对应的 4 个，其余命令在斜杠命令侧
没有同名项要指向。

## 放弃了什么（以及为什么不选）

- **「loop 不放行，只做 compact」**（回源码核实后最保守的选项）。它会承认「无头下所有
  定时任务都执行不了」是既有缺口而不修。否决理由：放行判定的意义是「这个命令在该形态下
  有用」，而补注入器只改三条接线、不新增契约，比留一个「长驻也不成立」的结论更值。
  代价是范围从「加两行声明」扩大到一个跨 core/cli 的能力补齐，已在 PR 正文点破。
- **补无头 promptInjector 的替代路径：让注入器直接 `submitHeadlessInput` 并自行消费输出**。
  否决：stream-json 的输出是 `sdkRunHeadless` 逐条写 stdout 的 NDJSON，Bridge 的是
  `BridgeRunner.runTurn` 转发远端——另起一条消费链等于把两套输出映射复制一份，
  而且会和主循环抢同一个会话。走已有队列只多一个回调。
- **契约用谓词而不是结构体表达形态限制**。否决理由同 T4b：命令是数据，结构体可静态枚举、
  可进参数化门禁；谓词把判定藏进闭包，静态不可见。
- **`/compact` 在 `-p` 下放行但改退出码**（方案 §4.4-A）。否决：退出码只解决「CI 不知道
  失败」，没解决「钱白花」——照样付一次摘要费、往历史多写一条文本。
- **改压缩持久化让 `-p "/compact"` 能落盘**（§4.4-C）。否决：与「resume 永不丢失真实历史」
  这条踩坑换来的不变量冲突（B2 方案A）。
- **只放行 `/loop` 的无参形态**（列出任务，只读）。机制上表达不了：`subcommands: []`
  会被「空对象等价 true」的反漂移断言拦下，而该断言本身是必要的（防「声明了粒度但等于
  没声明」）。为它加第三个契约维度不值。

## 拿什么证明它生效了

**单测**（worktree，`bun test`）：

- `packages/cli/tests/command/headless-allowed-commands.test.ts` → 102 pass。新增
  T6 用例：`-p` 拒绝（断言文案含「仅支持：stream-json 多轮 / Bridge 长驻」与命令自己的
  理由关键词）、`stream-json` / `bridge` 放行、放行后不产出 `dialog`/`confirm`/`clear`/`quit`
  且不碰注入表外字段、`modes` 必须恰好是长驻两形态（加回 `"p"` 即红）。
- `packages/core/tests/sdk/headless-injector.test.ts` → 2 pass。注入器真的把 prompt 投进
  主循环并产出 `result`（断言回执文本 = `收到: <注入的 prompt>`，证明这一轮真的跑了模型）；
  text 单轮不注册注入器。
- `packages/core/tests/bridge/bridge-runner-local-inject.test.ts` → 2 pass。`injectLocalMessage`
  与远端消息**串行**（顺序断言 `start/end` 四段），不并发抢会话。
- `packages/cli/tests/command/headless-injector-wiring.test.ts` → 5 pass。静态锁三个文件的接线：
  app 两处长驻路径注册、core 真消费 `onInjectorReady`（入队 + notify）、Bridge 复用同队列、
  透传点必须在 `runHeadlessStreaming` 调用块内（不泄漏给 `-p`）。
- `headless-dispatch.test.ts` 同步修正 T4b 的两条形态断言（契约被有意变更）。

**变异自证（四轮，均确认报出了正确对象后恢复）**：

1. `compact` 的 `modes` 加回 `"p"` → `/compact 在 -p 单轮被拒绝` + `modes 声明必须恰好是长驻两形态` 两条红；
2. `headlessRefusal` 的 modes 判定短路 → compact 与 loop 的 `-p` 拒绝用例红；
3. 摘掉 `runHeadlessStreaming` 的 `options.onInjectorReady?.(...)` → core 注入器测试
   `expect(inject).not.toBeNull()` 得到 `null`；
4. 摘掉 `app.ts` 的 Bridge 注入接线 → 静态接线门禁报 `Expected to contain:
   "this.setPromptInjector(async (text) => bridgeRunner.injectLocalMessage(text));"`。

**选测**（`bun run affected-tests:run`）：3302 pass / 9 skip / 1 fail。唯一失败是
`render-port/rss.test.ts` 的峰值 RSS 判据，三条举证与本次改动无关：①该测试只 spawn
渲染底座 fixture，不 import 本次改动的模块；②单跑该文件 2 pass / 0 fail；③失败发生于
整包并行跑（该文件注释自述「同一实现 3 次峰值差 ±7MB」，且串行采样是为了避免内存争用），
重跑即绿。

**八道门禁 + 参考页 + 构建**：`lint` 0 error、`format:check`、`lint:boundary`、
`lint:command-system`、`lint:legacy-tool`、`typecheck:gate`（无新增，比基线少 1 项）、
`docs:gen-reference --check`（重新生成后一致）、`make build` 通过且产物自检全绿。

**端到端**（worktree 构建产物 + 隔离 `SID_CONFIG_DIR`）：

| 命令 | 期望 | 实测 |
| --- | --- | --- |
| `-p "/doctor"` | 退 0（A 档回归） | exit 0 |
| `-p "/compact"` | 非 0 + 形态/原因 | exit 1，文案含「-p 单轮形态下不可用…没有后续轮」 |
| `-p "/loop 5m 检查部署"` | 非 0 + 原因 | exit 1，文案含「进程一退就丢」 |
| `-p "/compact" --output-format stream-json` | **非 0**（关键修正点） | exit 1，`result.errors` 同上 |
| stream-json（`/doctor` + `/compact`） | 退 0 | exit 0，第二轮 `result: "对话历史太短，无需压缩"` |
| stream-json `/loop`（无参） | 退 0 | exit 0，返回任务列表/用法 |

注：注入通道的端到端验证（等 1 分钟看定时任务真的触发）需要真实模型调用，隔离配置下
没有可用 provider，故该链路由 core 侧单测覆盖（真投递 + 真产出 result）；接线本身由静态门禁锁。
