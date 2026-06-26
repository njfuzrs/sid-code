BINARY=sid-code
BUN=bun

.PHONY: build run test test-providers clean deps lint

build:
	$(BUN) run scripts/bump-version.ts
	$(BUN) run scripts/embed-builtin-skills.ts
	$(BUN) build --compile --outfile $(BINARY) src/entrypoints/bootstrap.ts

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
