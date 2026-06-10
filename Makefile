BINARY=sid-code
BUN=bun

.PHONY: build run test clean deps lint

build:
	$(BUN) run scripts/bump-version.ts
	$(BUN) run scripts/embed-builtin-skills.ts
	$(BUN) build --compile --outfile $(BINARY) src/entrypoints/bootstrap.ts

run:
	$(BUN) run src/cli.ts

test:
	$(BUN) test

clean:
	rm -f $(BINARY)

deps:
	$(BUN) install

lint:
	$(BUN) run lint

check-tavily:
	bun run scripts/check-tavily.ts
