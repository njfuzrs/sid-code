BINARY=sid-code
BUN=bun

.PHONY: build run test clean deps lint

build:
	$(BUN) build --compile --outfile $(BINARY) src/cli.ts

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
