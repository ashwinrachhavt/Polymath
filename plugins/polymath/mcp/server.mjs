import { createInterface } from "node:readline";
import { setTimeout as sleepFor } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createClient, PolymathError } from "../lib/client.mjs";
import { defaultExec } from "../lib/git.mjs";
import manifest from "../.claude-plugin/plugin.json" with { type: "json" };
import { failure, tools } from "./tools.mjs";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

/** @param {{ env?: Record<string, string | undefined>, fetch?: typeof globalThis.fetch, exec?: (file: string, args: string[], options: { cwd: string }) => Promise<string>, sleep?: (ms: number) => Promise<unknown> }} [options] */
export function createServer({ env, fetch, exec = defaultExec, sleep = sleepFor } = {}) {
  const client = createClient({ env, fetch });
  const ctx = { client, exec, sleep };

  async function callTool({ name, arguments: args = {} }) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) return null;
    try {
      client.assertConfigured();
      return await tool.run(ctx, args);
    } catch (error) {
      const message = error instanceof PolymathError ? error.message : String(error?.message ?? error).split("\n")[0];
      return failure(message);
    }
  }

  async function handle(message) {
    const id = message?.id;
    if (typeof message?.method !== "string") return id === undefined ? null : rpcError(id, -32600, "Invalid request");
    if (id === undefined) return null;
    switch (message.method) {
      case "initialize": {
        const requested = message.params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: manifest.name, version: manifest.version },
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case "tools/call": {
        const result = await callTool(message.params ?? {});
        return result ? rpcResult(id, result) : rpcError(id, -32602, `Unknown tool: ${message.params?.name}`);
      }
      default:
        return rpcError(id, -32601, `Method not found: ${message.method}`);
    }
  }

  async function serve(input, output) {
    const pending = new Set();
    const write = (response) => output.write(`${JSON.stringify(response)}\n`);
    for await (const line of createInterface({ input })) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write(rpcError(null, -32700, "Parse error"));
        continue;
      }
      const task = handle(message).then((response) => response && write(response));
      pending.add(task);
      task.finally(() => pending.delete(task));
    }
    await Promise.all(pending);
  }

  return { handle, serve };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await createServer().serve(process.stdin, process.stdout);
}
