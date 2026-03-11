BINARY=sid-code
MODULE=gitlab.example.com/zhourusheng/sdddd

.PHONY: build run test clean

build:
	go build -o $(BINARY) ./cmd/sid-code

run: build
	./$(BINARY)

test:
	go test ./...

clean:
	rm -f $(BINARY)

deps:
	go mod tidy

.PHONY: lint
lint:
	golangci-lint run ./...
