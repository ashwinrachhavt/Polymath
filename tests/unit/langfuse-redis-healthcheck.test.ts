import { execFile, spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/*
 * The langfuse-redis healthcheck must verify auth, not just liveness:
 * redis-cli exits 0 even on server error replies (NOAUTH, WRONGPASS), so
 * ["CMD", "redis-cli", "ping"] against a requirepass'd server is false-healthy
 * (langgenius/dify#24806). The shipped check authenticates via the REDISCLI_AUTH
 * environment variable (keeps the password out of ps-visible argv) and asserts
 * the reply is exactly PONG. Evidence layers:
 *   1. structural — the compose file carries the auth env + exact-PONG command
 *   2. controlled redis-cli stub — exit-code matrix, runs everywhere
 *   3. real redis-server — ground truth, skipped where the binary is absent
 * Docker boot of the compose stack itself remains unverified (no Docker in CI
 * sandboxes); these tests verify the healthcheck semantics, not a live boot.
 */

const HEALTHCHECK_LINE = "redis-cli ping | grep -qx PONG";

function serviceBlock(source: string, service: string): string {
  // Exactly-two-space indentation distinguishes the service definition from
  // deeper-indented depends_on references to the same name.
  const start = source.indexOf(`\n  ${service}:\n`);
  expect(start, `service ${service} found`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/^  [\w-]+:\s*$/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("langfuse-redis healthcheck (compose structure)", () => {
  const compose = readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "../../compose.langfuse.yaml"),
    "utf8",
  );
  const appCompose = readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "../../compose.yaml"),
    "utf8",
  );
  const redis = serviceBlock(compose, "langfuse-redis");

  it("authenticates the ping and asserts an exact PONG reply", () => {
    expect(redis).toContain(`test: ["CMD-SHELL", "${HEALTHCHECK_LINE}"]`);
    expect(redis).toContain("REDISCLI_AUTH: langfuse");
  });

  it("does not keep the vacuous unauthenticated check", () => {
    expect(redis).not.toContain('"CMD", "redis-cli"');
  });

  it("leaves the app compose untouched", () => {
    expect(appCompose).not.toContain("langfuse-redis");
  });
});

describe("langfuse-redis healthcheck exit codes (controlled redis-cli stub — canned output, no server)", () => {
  let stubDir: string;

  beforeAll(() => {
    stubDir = mkdtempSync(join(tmpdir(), "langfuse-redis-stub-"));
    // Emits one canned stdout line; the failure modes of redis-cli are stdout
    // error replies, stderr-only connection errors (empty stdout), or PONG.
    writeFileSync(
      join(stubDir, "redis-cli"),
      "#!/bin/sh\nprintf '%s\\n' \"$LANGFUSE_STUB_PING_OUTPUT\"\n",
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  });

  const cases: Array<[string, string, number]> = [
    ["authenticated success", "PONG", 0],
    ["NOAUTH error reply", "(error) NOAUTH Authentication required.", 1],
    ["WRONGPASS error reply", "(error) WRONGPASS invalid username-password pair or user is disabled.", 1],
    ["connection failure (empty stdout, error on stderr)", "", 1],
    ["non-PONG partial match", "PONGS", 1],
  ];

  for (const [label, output, expected] of cases) {
    it(`${label} -> exit ${expected}`, async () => {
      const result = await new Promise<{ code: number | null }>((resolve) => {
        execFile(
          "sh",
          ["-c", HEALTHCHECK_LINE],
          {
            env: {
              ...process.env,
              PATH: `${stubDir}:${process.env.PATH ?? ""}`,
              REDISCLI_AUTH: "langfuse",
              LANGFUSE_STUB_PING_OUTPUT: output,
            },
          },
          (err) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0 }),
        );
      });
      expect(result.code, `stub output: ${JSON.stringify(output)}`).toBe(expected);
    });
  }
});

// Ground truth requires BOTH binaries: the scratch server and the client
// whose exit-code semantics are under test.
const hasBinary = (name: string) => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0;
const realRedisAvailable = hasBinary("redis-server") && hasBinary("redis-cli");

describe.skipIf(!realRedisAvailable)("langfuse-redis healthcheck (real redis-server; skipped where the binary is unavailable)", () => {
  const PORT = 6390;
  let server: ReturnType<typeof spawn> | undefined;
  let serverLogFile = "";
  let ready = false;

  beforeAll(async () => {
    // Capture the server's stderr so a startup failure (port already in use,
    // config error) is named in the assertion instead of surfacing as an
    // opaque connection failure in the first test.
    serverLogFile = join(tmpdir(), `langfuse-redis-server-${process.pid}.log`);
    const log = openSync(serverLogFile, "a");
    try {
      server = spawn(
        "redis-server",
        ["--port", String(PORT), "--requirepass", "langfuse", "--save", "", "--appendonly", "no"],
        { stdio: ["ignore", "ignore", log] },
      );
      // A PONG here requires an established, correctly authenticated
      // connection; delay between probes instead of tight-spinning.
      for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
        if (server.exitCode !== null) break;
        ready =
          (await run(`redis-cli -p ${PORT} ping | grep -qx PONG`, { ...process.env, REDISCLI_AUTH: "langfuse" }))
            .code === 0;
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const serverStderr = readFileSync(serverLogFile, "utf8").trim();
      const versions = [
        spawnSync("redis-server", ["--version"]).stdout?.toString().trim(),
        spawnSync("redis-cli", ["--version"]).stdout?.toString().trim(),
      ]
        .filter(Boolean)
        .join(" | ");
      expect(
        ready,
        `scratch redis-server became ready (alive=${server && server.exitCode === null}; ${versions}; server stderr: ${serverStderr || "none"})`,
      ).toBe(true);
    } finally {
      closeSync(log);
    }
  });

  afterAll(() => {
    server?.kill();
  });

  it("passes with the correct password", async () => {
    const result = await run(`redis-cli -p ${PORT} ping | grep -qx PONG`, { ...process.env, REDISCLI_AUTH: "langfuse" });
    expect(result.code, `redis-cli output: ${result.output}`).toBe(0);
  });

  it("fails on a wrong password", async () => {
    const result = await run(`redis-cli -p ${PORT} ping | grep -qx PONG`, { ...process.env, REDISCLI_AUTH: "wrongpass" });
    expect(result.code, `redis-cli output: ${result.output}`).toBe(1);
  });

  it("fails when no credentials are provided (NOAUTH)", async () => {
    const env = { ...process.env };
    delete env.REDISCLI_AUTH;
    const result = await run(`redis-cli -p ${PORT} ping | grep -qx PONG`, env);
    expect(result.code, `redis-cli output: ${result.output}`).toBe(1);
  });

  it("fails on a connection failure", async () => {
    const result = await run(`redis-cli -p 6399 ping | grep -qx PONG`, { ...process.env, REDISCLI_AUTH: "langfuse" });
    expect(result.code, `redis-cli output: ${result.output}`).toBe(1);
  });

  function run(line: string, env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      execFile("sh", ["-c", line], { env: { ...env, PATH: process.env.PATH } }, (err, stdout, stderr) =>
        // ExecFileException.code is string | number; any spawn/exec failure is nonzero.
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          output: `${stdout}${stderr}`.trim(),
        }),
      );
    });
  }
});
