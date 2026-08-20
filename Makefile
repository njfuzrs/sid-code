BINARY=sid-code
BUN=bun

# ─────────────────────────────────────────────────────────────────────────────
# 编译期必须把 NODE_ENV 定死为 production（别删，删了会让 React 报错刷用户的屏）
#
# `bun build --compile` **不会**自动设置 NODE_ENV，产物运行时 process.env.NODE_ENV
# 恒为 Bun 的默认值 "development"。而 react-reconciler/index.js 是按运行时
# NODE_ENV 分支加载 build 的：
#
#   NODE_ENV === 'production' ? react-reconciler.production.js
#                             : react-reconciler.development.js
#
# 于是发布出去的二进制一直跑的是 React **development build**。其中
# getRootForUpdatedFiber() 有一句 console.error("Maximum update depth exceeded.
# ...setState inside useEffect...")——嵌套 passive update 超 50 次就打一次，且是
# console.error（不是 throw），所以：错误边界抓不到、进程不崩、agent 主循环照跑、
# debug.log 里也没有记录，只有终端被反复刷屏。这正是 2026-08-04 同事机器上报的现象
# （慢机器一帧渲染久、更容易把嵌套 update 堆到 50）。该文案**只存在于 development
# build**，production build 里一次都没有——这是定性根因的决定性证据。
#
# 实测（bun build --compile 后 strings 二进制）：
#   不加 --define：'Maximum update depth' 命中 2 次，DEV-only 符号命中 3 次
#   加了 --define：两者都归零，产物还小 ~280KB
#
# 另外 src/ink/reconciler.ts:33 的 `NODE_ENV === 'development'` 分支会去 import
# react-devtools-core，其注释原文就写着「DCE'd in production」——本就假设构建期会
# define NODE_ENV，此前一直没接上。
#
# 新增构建入口（新 target / 新脚本）必须带上这个变量，否则那条产物又会退回
# development build。防漂移门禁见 tests/build/node-env-define.test.ts。
# ─────────────────────────────────────────────────────────────────────────────
BUILD_DEFINES=--define process.env.NODE_ENV='"production"'

.PHONY: help build rebuild build-bump release run test test-providers clean deps lint canary stability-test stress-test provider-health

# ─────────────────────────────────────────────────────────────────────────────
# 构建目标命名约定（2026-07-31 调整，别再改回去）
#
#   make build       ← 日常开发就用这个。不动版本号，安全、可重复。
#   make build-bump  ← 只有"想构建一个带新版本号的二进制来本地自测"才用。会 +1 版本号。
#
# 为什么这么排：`build` 是所有项目里"编译一下"的通用词，人和模型都会条件反射地敲它。
# 旧设计把 `build` 绑成"bump 版本号 + 编译"、把不 bump 的日常构建叫 `rebuild`，语义
# 正好反了——于是本地开发反复误敲 `make build`，静默把 package.json 的版本号 +1，后面
# 再跑 release.sh 就一次跳两个版本。现在把最容易被敲到的词绑到最安全的行为上：敲错
# 也只是白编译一次，不会污染版本号。
# ─────────────────────────────────────────────────────────────────────────────

help:
	@echo "sid-code 常用目标："
	@echo "  make build       本地开发构建（不改版本号）← 日常就用这个"
	@echo "  make build-bump  构建并把版本号 +1（仅本地自测带新版本号的产物时用）"
	@echo "  make release     正式发布：4 平台制品 + 上传（ARGS='--upload'）"
	@echo "  make test        全量单测"
	@echo ""
	@echo "验证本地改动请跑 sc-dev（不是 sc，sc 指向线上稳定版）。"

# 日常开发构建：不动版本号，跑多少次都一样。
# 拉完代码、改完代码都用它——CLAUDE.md §0 的"改完必须验证构建"指的就是这个。
build:
	$(BUN) run scripts/embed-builtin-skills.ts
	-$(BUN) run scripts/fetch-ripgrep.ts --as-embed
	-$(BUN) run scripts/gen-model-catalog-snapshot.ts
	$(BUN) build --compile $(BUILD_DEFINES) --outfile $(BINARY) packages/cli/src/entrypoints/bootstrap.ts
	@./$(BINARY) --self-check

# 兼容旧习惯与历史文档里的 `make rebuild`：与 `make build` 完全等价。
# 保留而不删，是因为散落在 ADR / 评估报告 / 外部笔记里的 `make rebuild` 不该突然报错。
rebuild:
	@echo "提示：make rebuild 已与 make build 等价，日常直接敲 make build 即可。"
	@$(MAKE) build

# 构建 + 版本号 +1。**日常开发不要用这个**，用 make build。
# 唯一适用场景：想在本地跑一个携带新版本号的二进制做自测。
# 注意：发布走 ./scripts/release.sh，它内部自己会 bump——先跑本目标再发布会让版本号 +2。
build-bump:
	$(BUN) run scripts/bump-version.ts
	@$(MAKE) build

# 跨平台发布构建：macOS + Linux（arm64/x64 共 4 个目标），打包 + sha256 校验文件到 dist/release/
# 加 --upload 上传到服务器（需要 DEPLOY_SSH_USER 环境变量），详见 scripts/release.sh 头部注释
release:
	./scripts/release.sh $(ARGS)

run:
	$(BUN) run packages/cli/src/cli.ts

test:
	$(BUN) test

# Provider 层一致性测试快速入口（方案 §8.3）。
# make test 已通过 bun test 全量覆盖这些用例，此 target 用于聚焦 provider 层回归。
test-providers:
	$(BUN) test packages/core/tests/llm/provider-conformance.test.ts \
		packages/core/tests/llm/provider-anthropic-conformance.test.ts \
		packages/core/tests/llm/provider-protocol-contract.test.ts \
		packages/core/tests/llm/openai-protocol-edge.test.ts \
		packages/core/tests/llm/fallback.test.ts

clean:
	rm -f $(BINARY)

deps:
	$(BUN) install

lint:
	$(BUN) run lint

check-tavily:
	bun run scripts/check-tavily.ts

# ─── Provider 稳定性 / 健康度（T9.2 / T9.3 / T9.4）───

# L2 冒烟：每个已配置 provider 发一个极简请求，验证流式消费正常完成
canary:
	$(BUN) run scripts/provider-canary.ts --verbose

# T9.2 L4 长时间稳定性测试：连续 1h、每 30s 一次请求；成功率 <95% 或内存增长 >20MB 判失败
# 退出码：0=通过 1=成功率不达标 2=内存增长超阈值
stability-test:
	$(BUN) run scripts/provider-stress.ts --mode stability --duration 3600 --interval 30 --verbose

# T9.4 压力 / 混沌测试：并发 10 请求 + 随机注入 abort/超时/并发突增
stress-test:
	$(BUN) run scripts/provider-stress.ts --mode stress --concurrency 10 --rounds 5 --verbose
	$(BUN) run scripts/provider-stress.ts --mode chaos --duration 120 --verbose

# T15 Provider 健康度看板：从 events.jsonl 聚合成功率/延迟/超时/重试
provider-health:
	$(BUN) run scripts/provider-health.ts --period 24h
