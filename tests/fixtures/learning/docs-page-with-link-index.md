> ## Documentation Index
> Fetch the complete documentation index at: https://docs.example.test/llms.txt
> Use this file to discover all available pages before exploring further.

# Example Servers

> A list of example servers and implementations

This page lists servers that show what the protocol can do. A server gives a language model safe access to tools and data: the model asks, the server checks the request against its own access rules, and only then does it act. Because every server speaks the same protocol, a client written once can use all of them without changes.

## Reference implementations

* **[Everything](https://github.com/example/servers/tree/main/src/everything)** - Reference / test server with prompts, resources, and tools
* **[Fetch](https://github.com/example/servers/tree/main/src/fetch)** - Web content fetching and conversion for efficient LLM usage
* **[Filesystem](https://github.com/example/servers/tree/main/src/filesystem)** - Secure file operations with configurable access controls
* **[Git](https://github.com/example/servers/tree/main/src/git)** - Tools to read, search, and manipulate Git repositories
* **[Memory](https://github.com/example/servers/tree/main/src/memory)** - Knowledge graph-based persistent memory system
* **[Sequential Thinking](https://github.com/example/servers/tree/main/src/sequentialthinking)** - Dynamic and reflective problem-solving through thought sequences
* **[Time](https://github.com/example/servers/tree/main/src/time)** - Time and timezone conversion capabilities

## Getting started

The reference servers run straight from their package registry, so nothing has to be installed first. The `npx` command downloads a TypeScript server and starts it in one step, and `uvx` does the same for a Python server. Each server reads its settings from command-line arguments, which is why the client configuration lists them one by one.

```bash
npx -y @example/server-memory
```

## On this page

1. Reference implementations
2. Getting started
3. Additional resources
4. Community servers
