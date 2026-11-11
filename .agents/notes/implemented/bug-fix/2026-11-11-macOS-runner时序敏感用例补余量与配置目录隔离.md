---
Status: implemented
Date: 2026-11-11
Source: macOS runner 时序敏感度已超出「偶发」：量化证据与第三档定夺（2026-11-10）
---
# 四处 macOS 时序敏感用例：三处补余量，一处是配置目录未隔离

## 决定了什么

改 4 个测试文件，不动任何生产代码。每处都是「把判据从『等多久』换成『等到什么』，
或把不可控的外部输入隔离掉」，**不是放宽断言**。

1. `packages/core/tests/lsp/lsp-tool-filters.test.ts` —— G10 的两条 onProgress 接线用例：
   - fixture 的 `lsp.json` 给 mock 服务器加 `startupTimeout: 500`（默认 30000）。
   - 两条用例加显式超时 `STARTUP_PROBE_TIMEOUT_MS = 30_000`。
   - 原因：`openFile → ensureStarted → client.sendRequest("initialize")` 在 mock
     `command: "true"` 起不来时**要等到 startupTimeout 才返回**。CI macOS 实测这两条
     各跑 5000.67 / 5001.13 / 5000.78 / 5000.76ms —— 恰好是 bun 默认 5s 单测超时，
     用例被计时器杀掉而不是断言失败。压小 startupTimeout 后最坏等待有界。

2. `packages/cli/tests/ui/components/McpDialog-disable.test.tsx` —— `press` 后的固定
   sleep 换成轮询到目标后果：
   - 新增 `waitFor(cond, ms)`；`KEY.down` 后轮询「选中标记 `ARROW_PROMPT` 落在『禁用』项」，
     `KEY.enter` 后轮询「菜单翻成『启用』」。
   - 原因：`press` 默认等待是 `ESC_TIMEOUT * 2 = 100ms`，macOS 共享 runner 上一次 event
     loop 抢占就能吃掉。失败形态是 `down` 没被消费完 → 紧随的 `enter` 命中第一项
     「重新连接」，失败帧里多出「重连成功，注册 1 个工具」（PR #725 实测）。

3. `packages/core/tests/llm/healthy-slow-stream-no-defense.test.ts` —— 第一个用例的
   两侧余量同时拉宽，**保持「总时长远超阈值」这个前提**：
   - `CHUNKS` 30 → 60、`GAP_MS` 保持 10、`IDLE` 60 → 120、`CONTENT_PROGRESS` 80 → 120。
   - 间隔余量 8x → 12x；总时长 300ms → 600ms（对阈值 5x，原 3.75x）。
   - 断言 `elapsed > 80` 改为 `elapsed > CONTENT_PROGRESS_MS`，让前提判据跟随阈值，
     避免两处数字漂移。

4. `packages/core/tests/config/rules-layered.test.ts` —— **这一处不是余量问题，是测试隔离缺陷**：
   - `beforeEach` / `afterEach` 存/恢复 `CLAUDE_CONFIG_DIR` 与 `SID_CONFIG_DIR`，都指向
     `proj` 下的子目录。
   - 原因：`loadAllCLAUDEmd` 会**递归**读 `<CLAUDE_CONFIG_DIR>/rules/**/*.md` 与
     `<SID_CONFIG_DIR>/rules/**/*.md`（`loadUserRulesDir` → `loadRulesFromDir` 的
     `**/*.md` 扫描）。不隔离时这两个目录是进程级共享的（preload 只把 `SID_CONFIG_DIR`
     设成一个全进程共用的 tmpdir），同分片内别的测试留下的 `rules/**/ui/CLAUDE.md`
     会混进 `loadedPaths`，`:212` 的「loadedPaths 只含实际注入的文件」就红。
   - CI macOS 2026-11-10 那条失败是 13.18ms（**不是**超时），与 ubuntu 的差别只是同进程
     相邻的测试文件组合不同。

## 放弃了什么（以及为什么不选）

- **macOS 单平台 `--retry 1`（第三档方案 1）**：本 PR 不做。它能兜住所有漏网 flake，
  但代价是「可能掩盖真回归」，需要配套「重试次数进遥测」才敢上 —— 那是 CI 基础设施
  决策，应由维护者单独拍板，不该随一次测试加固顺手改。
- **只把阈值放大（`CONTENT_PROGRESS` 80 → 500 这类）**：否决。`done/20261107` §3.5
  记过同样的教训 —— 直接放宽阈值已经这么改过三次，每次只是把下一次失败推后。更要命的是
  它会让「绝对计时」的旧实现在这条用例下**也不超时**，用例从「验证不误杀」退化成
  「什么都不会红」，验证力归零。所以做法是**间隔和总时长两侧同时按比例涨**。
- **G10 改用可用的真实 language server（如 tsserver）**：否决。用例的意图是验证
  `onProgress` 三段接线，不需要真实服务器；引入 tsserver 会把 tester 依赖变成
  「装了 typescript-language-server 吗」，且启动更慢。
- **G10 只加显式超时、不动 `startupTimeout`**：否决。只加超时会把「5s 失败」变成
  「最坏 30s 的慢用例」，macOS 分片墙钟白涨；两者要配套。
- **给 `rules-layered` 加断言兜底（例如过滤掉 `rules/` 前缀）**：否决。那是掩盖污染源。
  污染来自「测试读了一个进程级共享目录却假定它干净」，正确出口是隔离读取源。

## 拿什么证明它生效了

**1. §3.4 的根因用变异自证坐实（不是"机理上讲得通"）**

构造外部污染 `<CLAUDE_CONFIG_DIR>/rules/ui/CLAUDE.md`，在**改动前**的
`rules-layered.test.ts` 上跑：

```bash
mkdir -p /tmp/pollute-home/.claude/rules/ui
printf '# Instructions\n外部污染规则\n' > /tmp/pollute-home/.claude/rules/ui/CLAUDE.md
CLAUDE_CONFIG_DIR=/tmp/pollute-home/.claude bun test ./packages/core/tests/config/rules-layered.test.ts
# → 17 pass, 2 fail
#   at .../rules-layered.test.ts:212:85   ← 与 CI 失败位置完全一致
#   at .../rules-layered.test.ts:222:28   (Expected: "user" / Received: "userRulesDir")
```

同一个污染场景在**加隔离之后**再跑：`19 pass, 0 fail`。隔离前红、隔离后绿，
且隔离前红在同一行 —— 机理与修复都被证到。

**2. 每处改动后单跑**

```bash
bun test ./packages/core/tests/lsp/lsp-tool-filters.test.ts
# 14 pass；两条 onProgress 用例 515.04ms / 341.55ms（改动前本地 8.70 / 1.30ms，
# CI 上 5000ms 被杀 —— 现在有界且断言完整跑完）

bun test ./packages/core/tests/llm/healthy-slow-stream-no-defense.test.ts
# 3 pass；第一条 698.08ms

env -u TERM_PROGRAM -u KITTY_WINDOW_ID -u WT_SESSION -u ZED_TERM -u VTE_VERSION -u TMUX \
    TERM=xterm-256color bun test ./packages/cli/tests/ui/components/McpDialog-disable.test.tsx
# 2 pass（347.72ms / 508.11ms）—— 按 CLAUDE.md 要求用 CI 同款终端环境变量跑
```

**3. 门禁**

```bash
bun run affected-tests:run   # 6418 pass / 9 skip / 1 fail（见下）
bun run lint                 # 0 warnings, 0 errors
bun run format:check         # All matched files use the correct format
bun run lint:boundary        # 四道门禁通过
bun run lint:command-system  # 通过（引用 LegacyTool 的生产文件 58 / 基线 58）
bun run lint:legacy-tool     # 工具接口棘轮通过
bun run typecheck:gate       # 当前 62 处错误 / 基线 64 → 无新增
make build                   # 见 PR 正文
```

选测里唯一的失败是 `packages/cli/tests/render-port/rss.test.ts` 的
「P4: 500 条历史下当前实现的峰值 RSS 不超过冻结基线的 1.2 倍」。按 CLAUDE.md
「判定失败与我无关必须举证」三条：

1. 该测试不 import 本次改动的任何模块（改动只在 4 个测试文件，与本文件无关）；
2. **在父仓 `main`（`e424f97e`）上单跑通过**：`2 pass`；
3. 环境成因明确：它是**同进程并行跑 499 个文件**时的峰值 RSS 比较，单跑 2 pass、
   选测里 2.83ms 就失败 —— RSS 峰值受同批次并发影响，属于测量抖动。

**4. 没有证明到的部分（如实登记）**

- 这几处改动是否真的降低了 CI 上的 macOS 失败密度，**本地无法证明**，
  只能靠后续 `gh api .../runs` 按 §八 口径观察。
- `rules-layered` 的污染源（哪个测试在共享 `SID_CONFIG_DIR/rules` 下留下了
  `ui/CLAUDE.md`）本次**没有定位到具体文件**：隔离之后不再受它影响，
  但根因链的最后一段仍是推断。审计判据是变异自证那一组实验。
