---
Status: implemented
Date: 2026-11-10
---
# 系统提示新增 `<waiting-capability>`，把「每次发生都要通知」映射到 monitor（FIX-3：D4）

## 决定了什么

`monitor` 是延迟工具（`shouldDefer=true`），首轮只有名字可见；系统提示里有 `<scheduling-capability>`
把「定时 / 轮询」意图映射到 `schedule_wakeup` / `cron_create`，却没有任何一段把「等外部状态」映射到 monitor。
方案文档（20261109 §D4）记录的历史快照是 940 会话 monitor 自然调用 0 次、`schedule_wakeup` 18 次。

改动：

- `packages/core/src/config/system-prompt.ts` 新增 `buildWaitingSection()`，`prompt-sections-en.ts` 新增
  `buildWaitingSectionEn()`。只写**选择边界**四条：只要一次通知 → bash 后台 + `wait_until_seconds`；
  每次发生都要通知 → `monitor`（过滤要覆盖失败 / 取消 / 超时）；挂上之后不手动复查、结束本轮；
  同一件事不要同时挂 monitor 又排 `schedule_wakeup`。
- 注入门禁：`ctx.tools` 里有 `monitor` 才注入。生产两处 `buildSystemPrompt` 都传 `toolRegistry.enabled()`
  （`app.ts` 首轮构建与 `rebuildSystemPrompt`），`settings.monitor.enabled=false` 时 `MonitorTool.isEnabled()`
  把它滤掉，所以按名查找就同时覆盖了「已注册」与「策略允许」。
- 延迟时带 `select:monitor` 激活说明，措辞与 `<scheduling-capability>` 的 L3 修法一致（不直呼未加载名字）。
- 验收基建 `scripts/verify-monitor.ts`：
  - 新增 `D4-discovery-checks`：本地 CI 模拟（四项检查依次从 pending 变 pass/fail，第三项 fail），prompt 用用户的说法
    「每个检查跑完都告诉我它的结果」，不出现「监控 / 盯 / 每出现一行」；**只认实际调用**，前台读状态文件次数写进 detail。
  - D4 系列改在**非 git 工作目录**跑（`startHeadless` 新增 `cwd` 参数，D1/D2 系列保持仓库根）。

北极星方向：**更准**（该用 monitor 的场景不用前台轮询扛）。牺牲的是**更省**：每个注册了 monitor 的会话首轮多约
293 input token（实测，见下），落在静态前缀区，命中 prompt cache 后只付缓存读价。

## 放弃了什么（以及为什么不选）

- **`alwaysLoad = true`（去掉延迟）**：每会话多付整份 schema + description（monitor 描述含两个脚本示例，
  远大于 293 token），且违背 `tool/monitor.ts` 「长尾、低频，与 schedule_wakeup 同档」的设计判断。
  **若上线两周后真实会话里 monitor 自然调用仍为 0，再回来评估**（方案 §D4 方案 B 的复评条件，原样保留）。
- **在段里复述 monitor 描述的细节**（`--line-buffered`、轮询间隔、脚本示例）：激活后经 `tools[].description`
  就能拿到，写两遍是纯常驻成本。段内只放「什么时候选它」这一件延迟加载给不了的信息。
- **把 D6（所有延迟工具的 guidance 注册表）/ D7（选择正确率度量）/ D8（选择负担）塞进本 PR**：
  它们是机制 / 度量 / 架构，与 monitor 文案不是同一关注点，方案 §四 要求各占一个 PR。
  FIX-5（D6）与本 PR 共改 `system-prompt.ts` 的拼装处，须排在本 PR 之后。
- **FIX-6 的选择度量基线未在本 PR 前采集**：方案要求「FIX-6 基线在 FIX-3 合入前跑」，但 FIX-6 的脚本
  （`scripts/tool-selection-audit.ts`）尚不存在，本次由用户指定先做 FIX-3。补救依据：本 PR 的修复前二进制
  已用 D4 两个 case 采过对照组（见下），且全量历史轨迹在 `~/.sid-code/trajectories` 里按会话时间可切分，
  FIX-6 落地后可以按本 PR 合入时刻把历史会话切成前后两段，不依赖「合入前现跑」。

## 拿什么证明它生效了

### 1. 段落真的进了请求体（真实入口，不是单测）

`make build` 后 `-p` 起会话，读 `raw.jsonl`：修复后会话 `20261110-143743-ffbc9f4c` 含 `waiting-capability` 5 处、
`select:monitor` 存在；修复前二进制的会话 `20261110-142813-85a0dd12` 为 0 处。

首轮 input token（`raw.jsonl` 首个 `usage.input_tokens`，同一 case、同一模型 `origin-deepseek-v4-1-flash`）：

```text
D4-discovery-checks  修复前 19915 / 19912 / 19914   修复后 20205 / 20205 / 20205   → +291~293
D4-discovery         修复前 19872 / 19871 / 19873   修复后 20166 / 20165 / 20166   → +293~294
```

### 2. 单测 + 变异自证

新增 `packages/core/tests/config/deferred-tools-in-prompt.test.ts` 的 FIX-3 describe（5 条）与
`packages/core/tests/config/waiting-capability-policy.test.ts`（3 条，真实 `MonitorTool` + 真实 `Registry.enabled()`
+ 真实 settings 文件，覆盖企业级 / 用户级 `monitor.enabled=false`）。三种改坏方式：

```text
M1 去掉注入（if (false && monitorTool)）     → 4 fail
M2 门禁恒注入（忽略 monitor 是否 enabled）   → 3 fail（未注册 / 企业关闭 / 用户关闭）
M3 延迟标记恒 false（丢激活说明）            → 3 fail
恢复      → 32 pass / 0 fail
```

### 3. 行为验收（端到端，3 次样本）——**如实记录：这组数据证明不了段落提升了调用率**

修复前二进制 `/tmp/sid-code-fix3-before`（`origin/main` @ `aaef2c27`）与修复后二进制各跑 3 次，
非 git 工作目录（排除分支名泄漏，见第 4 节）：

```text
    修复前     修复后
D4-discovery-checks      3/3 called（前台读 2/2/1 次）   3/3 called（前台读 1/2/2 次）
D4-discovery      3/3 called 3/3 called
schedule_wakeup 与 monitor 同时出现        0/6（修复后会话 events 无 schedule_wakeup）
```

- 方案 §D4 验收 B（3 次至少 2 次命中）：**PASS**。
- 方案 §D4 验收 D（删段后回落到 0）：**不成立**——修复前就是 3/3，天花板在两个场景上都已打满。
  FIX-0 的 Note 已发现 `D4-discovery` 修复前 3/3；本 PR 新增的更强场景 `D4-discovery-checks`（CI 逐项、只认调用）
  修复前**同样 3/3**。样本量 3，只能证伪不能证实；结论是：**在 deepseek-v4-1-flash + 本地文件场景下，
  段落对「是否调用 monitor」没有可测的增量**。可测到的是成本（+293 token）与「同时挂 monitor 和唤醒」为 0。
- 方案 §一 的「940 会话 0 次」与本次 6/6 的差异，可能原因：历史会话里「等外部状态」的意图大多夹在真实任务中段、
  不像验收 prompt 这样单一明确；或者模型 / 工具描述已变。**真正的判据是上线后两周的真实会话调用率**，
  不是这组 `-p` 样本——复评时用 FIX-6 的脚本按本 PR 合入时刻切分历史会话。

### 4. 发现并修掉的验收污染：分支名泄漏提示

第一轮采基线时（工作目录 = 仓库 worktree，分支 `fix/monitor-waiting-capability`），修复前会话
`20261110-140743-a17f940f` 的思考里原话：「分支名是 `fix/monitor-waiting-capability`，提示用 monitor 工具」。
仓库根的 git 快照会把当前分支名与最近提交写进系统提示，发现性 case 在 monitor 相关分支上跑就会被污染。
已改为 D4 系列在 `tmpdir` 下的新目录跑（`git -C $TMPDIR rev-parse` 报「不是 Git 仓库」），重跑后 12 个会话
`raw.jsonl` 里 `fix/monitor` 命中均为 0。**以后在 monitor 相关分支上做发现性验收，这条是前提。**

### 5. 门禁

```text
bun run affected-tests:run       2919 pass / 0 fail（config + tests/ 两个目标）
读 system-prompt 的跨域测试 13 个文件    197 pass / 0 fail（选测按目录映射选不到）
bun test（全量）   20614 pass / 0 fail（1466 文件）
make build  自检通过
bun run smoke      22 例：22 通过
bun run docs:gen-reference       无漂移
lint / format:check / lint:boundary / lint:command-system / lint:legacy-tool / typecheck:gate  全部通过
```
