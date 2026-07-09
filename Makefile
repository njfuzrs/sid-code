BINARY=sid-code
BUN=bun

.PHONY: build rebuild release run test test-providers clean deps lint canary stability-test stress-test provider-health

build:
	$(BUN) run scripts/bump-version.ts
	$(BUN) run scripts/embed-builtin-skills.ts
	-$(BUN) run scripts/fetch-ripgrep.ts --as-embed
	$(BUN) build --compile --outfile $(BINARY) src/entrypoints/bootstrap.ts

# 本地快速重建：跳过 bump-version，保持当前版本号不变
# 适用场景：拉取最新代码后只需更新二进制，不想改变版本号
rebuild:
	$(BUN) run scripts/embed-builtin-skills.ts
	-$(BUN) run scripts/fetch-ripgrep.ts --as-embed
	$(BUN) build --compile --outfile $(BINARY) src/entrypoints/bootstrap.ts

# 跨平台发布构建：macOS + Linux（arm64/x64 共 4 个目标），打包 + sha256 校验文件到 dist/release/
# 加 --upload 上传到服务器（需要 DEPLOY_SSH_USER 环境变量），详见 scripts/release.sh 头部注释
release:
	./scripts/release.sh $(ARGS)

run:
	$(BUN) run src/cli.ts

test:
	$(BUN) test

# Provider 层一致性测试快速入口（方案 §8.3）。
# make test 已通过 bun test 全量覆盖这些用例，此 target 用于聚焦 provider 层回归。
test-providers:
	$(BUN) test tests/llm/provider-conformance.test.ts \
		tests/llm/provider-anthropic-conformance.test.ts \
		tests/llm/provider-protocol-contract.test.ts \
		tests/llm/openai-protocol-edge.test.ts \
		tests/llm/fallback.test.ts

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
